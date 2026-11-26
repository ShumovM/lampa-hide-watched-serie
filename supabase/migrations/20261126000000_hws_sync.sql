-- Extend the existing HideWatchedSeries tables in place.
-- This migration preserves legacy rows/columns (id, profile_id, hash/road, marked_at,
-- deleted_at, device_id, torrent_hash) and adds isolated sync scope plus a conflict clock.
-- It intentionally does not create/drop tables or delete any rows.

do $$
declare
    target_table text;
begin
    foreach target_table in array array['episode_progress', 'movie_watched_marks', 'series_torrent_resume']
    loop
        if to_regclass(format('public.%I', target_table)) is null then
            raise exception 'Required existing table public.% does not exist', target_table;
        end if;
    end loop;

    if not exists (
        select 1 from information_schema.columns
        where information_schema.columns.table_schema = 'public' and information_schema.columns.table_name = 'movie_watched_marks'
          and column_name = 'marked_at' and data_type = 'bigint'
    ) then
        raise exception 'movie_watched_marks.marked_at must remain BIGINT';
    end if;

    if not exists (
        select 1 from information_schema.columns
        where information_schema.columns.table_schema = 'public' and information_schema.columns.table_name = 'episode_progress'
          and information_schema.columns.column_name = 'hash'
    ) or not exists (
        select 1 from information_schema.columns
        where information_schema.columns.table_schema = 'public' and information_schema.columns.table_name = 'episode_progress'
          and information_schema.columns.column_name = 'road'
    ) then
        raise exception 'episode_progress.hash and road are required legacy columns';
    end if;

    if not exists (
        select 1 from information_schema.columns
        where information_schema.columns.table_schema = 'public'
          and information_schema.columns.table_name = 'episode_progress'
          and information_schema.columns.column_name = 'client_updated_at'
          and information_schema.columns.data_type = 'bigint'
    ) then
        raise exception 'episode_progress.client_updated_at must remain BIGINT';
    end if;
end;
$$;

alter table public.episode_progress
    add column if not exists sync_id text not null default 'default',
    add column if not exists sync_updated_at timestamptz not null default to_timestamp(0);
alter table public.movie_watched_marks
    add column if not exists sync_id text not null default 'default',
    add column if not exists sync_updated_at timestamptz not null default to_timestamp(0);
alter table public.series_torrent_resume
    add column if not exists sync_id text not null default 'default',
    add column if not exists sync_updated_at timestamptz not null default to_timestamp(0);

-- Ensure inserts work with the existing id and required legacy metadata columns.
-- Existing sequence/identity/default definitions are kept unchanged.
do $$
declare
    config record;
    id_type text;
    id_default text;
    id_identity text;
    id_sequence text;
    max_id bigint;
    legacy_default text;
    legacy_required boolean;
    legacy_type text;
begin
    for config in
        select * from (values
            ('episode_progress', 'client_updated_at'),
            ('movie_watched_marks', null::text),
            ('series_torrent_resume', 'torrent_hash')
        ) as v(table_name, legacy_column)
    loop
        select format_type(a.atttypid, a.atttypmod), d.adbin::text, a.attidentity
        into id_type, id_default, id_identity
        from pg_attribute a
        left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
        where a.attrelid = format('public.%I', config.table_name)::regclass
          and a.attname = 'id' and not a.attisdropped;

        if id_type is null then
            raise exception 'Required id column missing from public.%', config.table_name;
        end if;

        if id_default is null and coalesce(id_identity, '') = '' then
            if id_type = 'uuid' then
                execute format('alter table public.%I alter column id set default gen_random_uuid()', config.table_name);
            elsif id_type = 'text' or id_type like 'character varying%' then
                execute format('alter table public.%I alter column id set default gen_random_uuid()::text', config.table_name);
            elsif id_type = 'bigint' then
                id_sequence := 'hws_' || config.table_name || '_id_seq';
                execute format('lock table public.%I in access exclusive mode', config.table_name);
                execute format('create sequence if not exists public.%I as bigint', id_sequence);
                execute format('alter sequence public.%I owned by public.%I.id', id_sequence, config.table_name);
                execute format(
                    'alter table public.%I alter column id set default nextval(%L::regclass)',
                    config.table_name, format('public.%I', id_sequence)
                );
                execute format('select max(id) from public.%I', config.table_name) into max_id;
                if max_id is null then
                    execute format('select setval(%L::regclass, 1, false)', format('public.%I', id_sequence));
                else
                    execute format('select setval(%L::regclass, $1, true)', format('public.%I', id_sequence)) using max_id;
                end if;
            else
                raise exception 'public.%.id has no generated default; refusing unsafe id generation', config.table_name;
            end if;
        end if;

        if config.legacy_column is not null then
            select format_type(a.atttypid, a.atttypmod), d.adbin::text, a.attnotnull
            into legacy_type, legacy_default, legacy_required
            from pg_attribute a
            left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
            where a.attrelid = format('public.%I', config.table_name)::regclass
              and a.attname = config.legacy_column and not a.attisdropped;

            if legacy_required and legacy_default is null then
                if config.legacy_column = 'client_updated_at' then
                    if legacy_type like 'timestamp%' then
                        execute 'alter table public.episode_progress alter column client_updated_at set default clock_timestamp()';
                    elsif legacy_type in ('bigint', 'integer', 'smallint', 'numeric') then
                        execute 'alter table public.episode_progress alter column client_updated_at set default floor(extract(epoch from clock_timestamp()) * 1000)';
                    elsif legacy_type = 'text' or legacy_type like 'character varying%' then
                        execute 'alter table public.episode_progress alter column client_updated_at set default clock_timestamp()::text';
                    else
                        raise exception 'Unsupported required episode_progress.client_updated_at type: %', legacy_type;
                    end if;
                elsif config.legacy_column = 'torrent_hash' and (legacy_type = 'text' or legacy_type like 'character varying%') then
                    execute $cmd$alter table public.series_torrent_resume alter column torrent_hash set default ''$cmd$;
                else
                    raise exception 'Required legacy column public.%.% has no default', config.table_name, config.legacy_column;
                end if;
            end if;
        end if;
    end loop;
end;
$$;

-- Backfill the sync conflict clock from the best timestamp already present.
-- client_updated_at may be TIMESTAMP, a Unix-millisecond integer, or ISO text.
do $$
declare
    source_type text;
    source_expr text;
begin
    select format_type(a.atttypid, a.atttypmod) into source_type
    from pg_attribute a
    where a.attrelid = 'public.episode_progress'::regclass
      and a.attname = 'client_updated_at' and not a.attisdropped;

    if source_type like 'timestamp%' then
        source_expr := 'client_updated_at::timestamptz';
    elsif source_type in ('bigint', 'integer', 'smallint', 'numeric') then
        source_expr := 'case when client_updated_at::numeric = 0 then null else to_timestamp(case when abs(client_updated_at::numeric) >= 100000000000 then client_updated_at::numeric / 1000 else client_updated_at::numeric end) end';
    elsif source_type = 'text' or source_type like 'character varying%' then
        source_expr := 'nullif(client_updated_at::text, '''')::timestamptz';
    else
        source_expr := 'null::timestamptz';
    end if;

    execute format(
        'update public.episode_progress set sync_updated_at = coalesce(%s, updated_at, to_timestamp(0)) where sync_updated_at = to_timestamp(0)',
        source_expr
    );
end;
$$;

update public.movie_watched_marks
set sync_updated_at = coalesce(
    case when marked_at <> 0 then to_timestamp(marked_at::numeric / 1000) end,
    updated_at,
    to_timestamp(0)
)
where sync_updated_at = to_timestamp(0);

update public.series_torrent_resume
set sync_updated_at = coalesce(updated_at, to_timestamp(0))
where sync_updated_at = to_timestamp(0);

-- Remove only legacy natural-key uniqueness that cannot represent sync_id.
-- id primary keys and all row data are retained. New scoped unique indexes follow.
do $$
declare
    config record;
    key_attnums smallint[];
    constraint_row record;
    index_row record;
begin
    for config in
        select * from (values
            ('episode_progress', array['hash']::text[]),
            ('episode_progress', array['profile_id', 'hash']::text[]),
            ('movie_watched_marks', array['source', 'movie_id']::text[]),
            ('movie_watched_marks', array['profile_id', 'source', 'movie_id']::text[]),
            ('series_torrent_resume', array['source', 'series_id']::text[]),
            ('series_torrent_resume', array['profile_id', 'source', 'series_id']::text[])
        ) as v(table_name, key_columns)
    loop
        select array_agg(attnum order by attnum)::smallint[] into key_attnums
        from pg_attribute
        where attrelid = format('public.%I', config.table_name)::regclass
          and attname = any(config.key_columns) and not attisdropped;

        if cardinality(key_attnums) <> cardinality(config.key_columns) then continue; end if;

        for constraint_row in
            select conname from pg_constraint
            where conrelid = format('public.%I', config.table_name)::regclass
              and contype in ('p', 'u')
              and cardinality(conkey) = cardinality(key_attnums)
              and conkey @> key_attnums
        loop
            execute format('alter table public.%I drop constraint %I', config.table_name, constraint_row.conname);
        end loop;

        for index_row in
            select indexrelid::regclass as index_name
            from pg_index
            where indrelid = format('public.%I', config.table_name)::regclass
              and indisunique and not indisprimary
              and indnkeyatts = cardinality(key_attnums)
              and not exists (select 1 from pg_constraint c where c.conindid = indexrelid)
              and indkey[0] = any(key_attnums)
              and (indnkeyatts < 2 or indkey[1] = any(key_attnums))
              and (indnkeyatts < 3 or indkey[2] = any(key_attnums))
        loop
            execute format('drop index %s', index_row.index_name);
        end loop;
    end loop;
end;
$$;

-- Fail safely instead of deleting or silently choosing among duplicate legacy rows.
do $$
begin
    if exists (select 1 from public.episode_progress group by sync_id, profile_id, hash having count(*) > 1)
       or exists (select 1 from public.movie_watched_marks group by sync_id, profile_id, source, movie_id having count(*) > 1)
       or exists (select 1 from public.series_torrent_resume group by sync_id, profile_id, source, series_id having count(*) > 1) then
        raise exception 'Duplicate legacy sync identities exist; no rows were changed or deleted';
    end if;
end;
$$;

create unique index if not exists episode_progress_sync_identity
    on public.episode_progress (sync_id, profile_id, hash);
create unique index if not exists movie_watched_sync_identity
    on public.movie_watched_marks (sync_id, profile_id, source, movie_id);
create unique index if not exists series_torrent_sync_identity
    on public.series_torrent_resume (sync_id, profile_id, source, series_id);

create index if not exists episode_progress_sync_page
    on public.episode_progress (sync_id, profile_id, sync_updated_at, hash);
create index if not exists movie_watched_sync_page
    on public.movie_watched_marks (sync_id, profile_id, sync_updated_at, source, movie_id);
create index if not exists series_torrent_sync_page
    on public.series_torrent_resume (sync_id, profile_id, sync_updated_at, source, series_id);

create or replace function public.hws_sync_apply(
    p_table text,
    p_sync_id text,
    p_profile_id text,
    p_device_id text,
    p_rows jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    row_data record;
    road_value jsonb;
    client_time timestamptz;
    marked_value bigint;
begin
    if p_table = 'episode_progress' then
        for row_data in
            select * from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as x(
                timeline_hash text, percent double precision, time double precision,
                duration double precision, profile bigint, card text, season integer,
                episode integer, updated_at timestamptz, is_deleted boolean
            )
        loop
            if row_data.timeline_hash is null or row_data.timeline_hash = '' then continue; end if;
            client_time := coalesce(row_data.updated_at, clock_timestamp());
            road_value := jsonb_strip_nulls(jsonb_build_object(
                'percent', coalesce(row_data.percent, 0), 'time', coalesce(row_data.time, 0),
                'duration', coalesce(row_data.duration, 0), 'profile', coalesce(row_data.profile, 0),
                'updated', floor(extract(epoch from client_time) * 1000),
                'card', row_data.card, 'season', row_data.season, 'episode', row_data.episode
            ));

            insert into public.episode_progress (
                profile_id, sync_id, hash, road, client_updated_at, deleted_at, device_id, updated_at, sync_updated_at
            ) values (
                p_profile_id, p_sync_id, row_data.timeline_hash, road_value,
                floor(extract(epoch from client_time) * 1000)::bigint,
                case when coalesce(row_data.is_deleted, false) then client_time else null end,
                p_device_id, clock_timestamp(), client_time
            )
            on conflict (sync_id, profile_id, hash) do update set
                road = coalesce(episode_progress.road, '{}'::jsonb) || excluded.road,
                client_updated_at = excluded.client_updated_at,
                deleted_at = excluded.deleted_at, device_id = excluded.device_id,
                updated_at = clock_timestamp(), sync_updated_at = excluded.sync_updated_at
            where excluded.sync_updated_at > episode_progress.sync_updated_at;
        end loop;
    elsif p_table = 'movie_watched_marks' then
        for row_data in
            select * from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as x(
                source text, movie_id text, title text, marked_at bigint,
                updated_at timestamptz, is_deleted boolean
            )
        loop
            if row_data.source is null or row_data.movie_id is null then continue; end if;
            client_time := coalesce(row_data.updated_at, clock_timestamp());
            marked_value := coalesce(row_data.marked_at, floor(extract(epoch from client_time) * 1000)::bigint);

            insert into public.movie_watched_marks (
                profile_id, sync_id, source, movie_id, title, marked_at, deleted_at, device_id, updated_at, sync_updated_at
            ) values (
                p_profile_id, p_sync_id, row_data.source, row_data.movie_id, coalesce(row_data.title, ''),
                marked_value, case when coalesce(row_data.is_deleted, false) then client_time else null end,
                p_device_id, clock_timestamp(), client_time
            )
            on conflict (sync_id, profile_id, source, movie_id) do update set
                title = excluded.title, marked_at = excluded.marked_at,
                deleted_at = excluded.deleted_at, device_id = excluded.device_id,
                updated_at = clock_timestamp(), sync_updated_at = excluded.sync_updated_at
            where excluded.sync_updated_at > movie_watched_marks.sync_updated_at;
        end loop;
    elsif p_table = 'series_torrent_resume' then
        for row_data in
            select * from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as x(
                source text, series_id text, title text, magnet text,
                season_number integer, episode_number integer, updated_at timestamptz
            )
        loop
            if row_data.source is null or row_data.series_id is null or row_data.magnet is null then continue; end if;
            client_time := coalesce(row_data.updated_at, clock_timestamp());

            insert into public.series_torrent_resume (
                profile_id, sync_id, source, series_id, title, magnet,
                season_number, episode_number, device_id, updated_at, sync_updated_at
            ) values (
                p_profile_id, p_sync_id, row_data.source, row_data.series_id, coalesce(row_data.title, ''),
                row_data.magnet, coalesce(row_data.season_number, 1), coalesce(row_data.episode_number, 1),
                p_device_id, clock_timestamp(), client_time
            )
            on conflict (sync_id, profile_id, source, series_id) do update set
                title = excluded.title, magnet = excluded.magnet,
                season_number = excluded.season_number, episode_number = excluded.episode_number,
                device_id = excluded.device_id, updated_at = clock_timestamp(),
                sync_updated_at = excluded.sync_updated_at
            where excluded.sync_updated_at > series_torrent_resume.sync_updated_at;
        end loop;
    else
        raise exception 'unsupported sync table';
    end if;
end;
$$;

revoke all on function public.hws_sync_apply(text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.hws_sync_apply(text, text, text, text, jsonb) to service_role;
