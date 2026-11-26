-- Additive sync schema that preserves the pre-sync Lampa tables and their rows.
-- Legacy episode_progress.hash/road and movie_watched_marks.marked_at BIGINT remain intact.
-- Review, then apply manually. This migration never drops tables or row data.

create table if not exists public.episode_progress (
    hash text not null,
    road jsonb not null default '{}'::jsonb,
    sync_id text not null default 'default',
    profile_id text not null default '0',
    timeline_hash text,
    percent double precision not null default 0,
    time double precision not null default 0,
    duration double precision not null default 0,
    profile bigint not null default 0,
    card text,
    season integer,
    episode integer,
    updated_at timestamptz not null default to_timestamp(0)
);

create table if not exists public.movie_watched_marks (
    sync_id text not null default 'default',
    profile_id text not null default '0',
    source text not null,
    movie_id text not null,
    title text not null default '',
    marked_at bigint,
    updated_at timestamptz not null default to_timestamp(0),
    is_deleted boolean not null default false
);

create table if not exists public.series_torrent_resume (
    sync_id text not null default 'default',
    profile_id text not null default '0',
    source text not null,
    series_id text not null,
    title text not null default '',
    magnet text not null,
    season_number integer not null default 1,
    episode_number integer not null default 1,
    updated_at timestamptz not null default to_timestamp(0)
);

-- Retain legacy required columns. Add only sync fields; IF NOT EXISTS intentionally
-- leaves existing column types (notably marked_at BIGINT) untouched.
alter table public.episode_progress add column if not exists hash text;
alter table public.episode_progress add column if not exists road jsonb;
alter table public.episode_progress add column if not exists sync_id text not null default 'default';
alter table public.episode_progress add column if not exists profile_id text not null default '0';
alter table public.episode_progress add column if not exists timeline_hash text;
alter table public.episode_progress add column if not exists percent double precision not null default 0;
alter table public.episode_progress add column if not exists time double precision not null default 0;
alter table public.episode_progress add column if not exists duration double precision not null default 0;
alter table public.episode_progress add column if not exists profile bigint not null default 0;
alter table public.episode_progress add column if not exists card text;
alter table public.episode_progress add column if not exists season integer;
alter table public.episode_progress add column if not exists episode integer;
alter table public.episode_progress add column if not exists updated_at timestamptz not null default to_timestamp(0);

alter table public.movie_watched_marks add column if not exists sync_id text not null default 'default';
alter table public.movie_watched_marks add column if not exists profile_id text not null default '0';
alter table public.movie_watched_marks add column if not exists source text;
alter table public.movie_watched_marks add column if not exists movie_id text;
alter table public.movie_watched_marks add column if not exists title text not null default '';
alter table public.movie_watched_marks add column if not exists marked_at bigint;
alter table public.movie_watched_marks add column if not exists updated_at timestamptz not null default to_timestamp(0);
alter table public.movie_watched_marks add column if not exists is_deleted boolean not null default false;

alter table public.series_torrent_resume add column if not exists sync_id text not null default 'default';
alter table public.series_torrent_resume add column if not exists profile_id text not null default '0';
alter table public.series_torrent_resume add column if not exists source text;
alter table public.series_torrent_resume add column if not exists series_id text;
alter table public.series_torrent_resume add column if not exists title text not null default '';
alter table public.series_torrent_resume add column if not exists magnet text;
alter table public.series_torrent_resume add column if not exists season_number integer not null default 1;
alter table public.series_torrent_resume add column if not exists episode_number integer not null default 1;
alter table public.series_torrent_resume add column if not exists updated_at timestamptz not null default to_timestamp(0);

-- Copy old Timeline rows into the normalized projection. Preserve hash and road
-- for existing clients; backfill the normalized columns from their JSON road.
update public.episode_progress
set timeline_hash = coalesce(nullif(timeline_hash, ''), hash),
    percent = coalesce(nullif(road->>'percent', '')::double precision, percent, 0),
    time = coalesce(nullif(road->>'time', '')::double precision, time, 0),
    duration = coalesce(nullif(road->>'duration', '')::double precision, duration, 0),
    profile = coalesce(nullif(road->>'profile', '')::bigint, profile, 0),
    card = coalesce(card, nullif(road->>'card', '')),
    season = coalesce(season, nullif(road->>'season', '')::integer),
    episode = coalesce(episode, nullif(road->>'episode', '')::integer),
    updated_at = case
        when coalesce(road->>'updated', '') ~ '^[0-9]+([.][0-9]+)?$'
            then to_timestamp((road->>'updated')::double precision / 1000.0)
        else coalesce(updated_at, to_timestamp(0))
    end
where timeline_hash is null or timeline_hash = '' or updated_at = to_timestamp(0);

-- Replace legacy single-scope uniqueness with the same profile-scoped identities
-- used by the new API. Constraint/index removal preserves all rows and hash/road.
do $$
declare
    hash_attnum smallint;
    constraint_row record;
    index_row record;
begin
    select attnum into hash_attnum
    from pg_attribute
    where attrelid = 'public.episode_progress'::regclass and attname = 'hash' and not attisdropped;

    if hash_attnum is not null then
        for constraint_row in
            select conname from pg_constraint
            where conrelid = 'public.episode_progress'::regclass
              and contype in ('p', 'u')
              and conkey = array[hash_attnum]::smallint[]
        loop
            execute format('alter table public.episode_progress drop constraint %I', constraint_row.conname);
        end loop;

        for index_row in
            select indexrelid::regclass as index_name
            from pg_index
            where indrelid = 'public.episode_progress'::regclass
              and indisunique and not indisprimary and indnatts = 1
              and indkey[0] = hash_attnum
              and not exists (select 1 from pg_constraint c where c.conindid = indexrelid)
        loop
            execute format('drop index %s', index_row.index_name);
        end loop;
    end if;
end;
$$;

-- Older installations may have unique keys on (source, movie_id) or
-- (source, series_id). Replace those unscoped keys with scoped unique indexes.
do $$
declare
    identity_row record;
    attnums smallint[];
    constraint_row record;
    index_row record;
begin
    for identity_row in
        select 'movie_watched_marks'::text as table_name, array['source', 'movie_id']::text[] as columns
        union all
        select 'series_torrent_resume'::text, array['source', 'series_id']::text[]
    loop
        select array_agg(attnum order by attname)::smallint[] into attnums
        from pg_attribute
        where attrelid = format('public.%I', identity_row.table_name)::regclass
          and attname = any(identity_row.columns)
          and not attisdropped;

        if cardinality(attnums) <> cardinality(identity_row.columns) then
            continue;
        end if;

        for constraint_row in
            select conname from pg_constraint
            where conrelid = format('public.%I', identity_row.table_name)::regclass
              and contype in ('p', 'u')
              and cardinality(conkey) = cardinality(attnums)
              and conkey @> attnums
        loop
            execute format('alter table public.%I drop constraint %I', identity_row.table_name, constraint_row.conname);
        end loop;

        for index_row in
            select indexrelid::regclass as index_name
            from pg_index
            where indrelid = format('public.%I', identity_row.table_name)::regclass
              and indisunique and not indisprimary
              and indnkeyatts = cardinality(attnums)
              and indkey[0] = any(attnums)
              and indkey[1] = any(attnums)
              and not exists (select 1 from pg_constraint c where c.conindid = indexrelid)
        loop
            execute format('drop index %s', index_row.index_name);
        end loop;
    end loop;
end;
$$;

update public.movie_watched_marks
set updated_at = case
    when marked_at is not null then to_timestamp(marked_at::double precision / 1000.0)
    else coalesce(updated_at, to_timestamp(0))
end
where updated_at = to_timestamp(0);

create index if not exists episode_progress_legacy_hash_idx on public.episode_progress (hash);
create unique index if not exists episode_progress_sync_identity
    on public.episode_progress (sync_id, profile_id, timeline_hash);
create unique index if not exists movie_watched_sync_identity
    on public.movie_watched_marks (sync_id, profile_id, source, movie_id);
create unique index if not exists series_torrent_sync_identity
    on public.series_torrent_resume (sync_id, profile_id, source, series_id);

create or replace function public.hws_sync_apply(
    p_table text,
    p_sync_id text,
    p_profile_id text,
    p_rows jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    row_data record;
    road_value jsonb;
begin
    if p_table = 'episode_progress' then
        for row_data in
            select * from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as x(
                timeline_hash text, percent double precision, time double precision,
                duration double precision, profile bigint, card text, season integer,
                episode integer, updated_at timestamptz
            )
        loop
            if row_data.timeline_hash is null or row_data.timeline_hash = '' then
                continue;
            end if;

            road_value := jsonb_build_object(
                'percent', coalesce(row_data.percent, 0),
                'time', coalesce(row_data.time, 0),
                'duration', coalesce(row_data.duration, 0),
                'profile', coalesce(row_data.profile, 0),
                'updated', floor(extract(epoch from coalesce(row_data.updated_at, to_timestamp(0))) * 1000),
                'card', row_data.card,
                'season', row_data.season,
                'episode', row_data.episode
            );

            insert into public.episode_progress (
                hash, road, sync_id, profile_id, timeline_hash, percent, time, duration,
                profile, card, season, episode, updated_at
            ) values (
                row_data.timeline_hash, road_value, p_sync_id, p_profile_id, row_data.timeline_hash,
                coalesce(row_data.percent, 0), coalesce(row_data.time, 0),
                coalesce(row_data.duration, 0), coalesce(row_data.profile, 0),
                row_data.card, row_data.season, row_data.episode,
                coalesce(row_data.updated_at, to_timestamp(0))
            )
            on conflict (sync_id, profile_id, timeline_hash) do update set
                hash = excluded.hash, road = excluded.road,
                percent = excluded.percent, time = excluded.time, duration = excluded.duration,
                profile = excluded.profile, card = excluded.card, season = excluded.season,
                episode = excluded.episode, updated_at = excluded.updated_at
            where excluded.updated_at > episode_progress.updated_at;
        end loop;
    elsif p_table = 'movie_watched_marks' then
        for row_data in
            select * from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as x(
                source text, movie_id text, title text, marked_at bigint,
                updated_at timestamptz, is_deleted boolean
            )
        loop
            if row_data.source is null or row_data.movie_id is null then continue; end if;
            insert into public.movie_watched_marks (
                sync_id, profile_id, source, movie_id, title, marked_at, updated_at, is_deleted
            ) values (
                p_sync_id, p_profile_id, row_data.source, row_data.movie_id,
                coalesce(row_data.title, ''), coalesce(row_data.marked_at,
                    floor(extract(epoch from coalesce(row_data.updated_at, to_timestamp(0))) * 1000)::bigint),
                coalesce(row_data.updated_at, to_timestamp(0)), coalesce(row_data.is_deleted, false)
            )
            on conflict (sync_id, profile_id, source, movie_id) do update set
                title = excluded.title, marked_at = excluded.marked_at,
                updated_at = excluded.updated_at, is_deleted = excluded.is_deleted
            where excluded.updated_at > movie_watched_marks.updated_at;
        end loop;
    elsif p_table = 'series_torrent_resume' then
        for row_data in
            select * from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as x(
                source text, series_id text, title text, magnet text,
                season_number integer, episode_number integer, updated_at timestamptz
            )
        loop
            if row_data.source is null or row_data.series_id is null or row_data.magnet is null then continue; end if;
            insert into public.series_torrent_resume (
                sync_id, profile_id, source, series_id, title, magnet,
                season_number, episode_number, updated_at
            ) values (
                p_sync_id, p_profile_id, row_data.source, row_data.series_id,
                coalesce(row_data.title, ''), row_data.magnet,
                coalesce(row_data.season_number, 1), coalesce(row_data.episode_number, 1),
                coalesce(row_data.updated_at, to_timestamp(0))
            )
            on conflict (sync_id, profile_id, source, series_id) do update set
                title = excluded.title, magnet = excluded.magnet,
                season_number = excluded.season_number, episode_number = excluded.episode_number,
                updated_at = excluded.updated_at
            where excluded.updated_at > series_torrent_resume.updated_at;
        end loop;
    else
        raise exception 'unsupported sync table';
    end if;
end;
$$;

revoke all on function public.hws_sync_apply(text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.hws_sync_apply(text, text, text, jsonb) to service_role;
