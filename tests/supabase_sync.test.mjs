import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const calls = [];
let handler;
let databaseFailure = '';

const environment = {
    LAMPA_SYNC_CODE: 'test-sync-code',
    SUPABASE_URL: 'https://db.example.test',
    SUPABASE_SECRET_KEYS: JSON.stringify({ default: 'unit-test-service-key' })
};

globalThis.Deno = {
    env: {
        get(name) { return environment[name] || ''; }
    },
    serve(fn) { handler = fn; }
};

globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers || {});
    calls.push({ url, init, headers });

    if (databaseFailure === 'write' && url.pathname.endsWith('/rpc/hws_sync_apply')) {
        databaseFailure = '';
        return new Response('write failed', { status: 500 });
    }
    if (databaseFailure === 'read' && !url.pathname.endsWith('/rpc/hws_sync_apply')) {
        databaseFailure = '';
        return new Response('read failed', { status: 500 });
    }
    if (url.pathname.endsWith('/rpc/hws_sync_apply')) return new Response(null, { status: 204 });

    const table = url.pathname.split('/').pop();
    const offset = url.searchParams.has('or') ? 2 : Number(url.searchParams.get('offset'));
    const fixtures = {
        episode_progress: [
            { id: '1', sync_id: 'house', profile_id: '0', hash: 'legacy-ep', road: { percent: 54, time: 540, duration: 1000 }, client_updated_at: '2026-01-01T00:00:00Z', deleted_at: '2026-01-01T00:00:00Z', device_id: 'dev-a', updated_at: '2026-01-01T00:00:01Z', sync_updated_at: '2026-01-01T00:00:00Z' },
            { id: '2', sync_id: 'house', profile_id: '0', hash: 'new-ep', road: { percent: 100, time: 1000, duration: 1000 }, client_updated_at: '2026-01-02T00:00:00Z', deleted_at: null, device_id: 'dev-a', updated_at: '2026-01-02T00:00:01Z', sync_updated_at: '2026-01-02T00:00:00Z' },
            { id: '3', sync_id: 'house', profile_id: '0', hash: 'later-ep', road: { percent: 70, time: 700, duration: 1000 }, client_updated_at: '2026-01-03T00:00:00Z', deleted_at: null, device_id: 'dev-a', updated_at: '2026-01-03T00:00:01Z', sync_updated_at: '2026-01-03T00:00:00Z' }
        ],
        movie_watched_marks: [
            { id: '4', sync_id: 'house', profile_id: '0', source: 'tmdb', movie_id: '42', title: 'Tombstone', marked_at: 1767225600000, deleted_at: '2026-01-01T00:00:00Z', device_id: 'dev-a', updated_at: '2026-01-01T00:00:01Z', sync_updated_at: '2026-01-01T00:00:00Z' },
            { id: '5', sync_id: 'house', profile_id: '0', source: 'tmdb', movie_id: '43', title: 'Movie', marked_at: 1767312000000, deleted_at: null, device_id: 'dev-a', updated_at: '2026-01-02T00:00:01Z', sync_updated_at: '2026-01-02T00:00:00Z' },
            { id: '6', sync_id: 'house', profile_id: '0', source: 'tmdb', movie_id: '44', title: 'Later movie', marked_at: 1767398400000, deleted_at: null, device_id: 'dev-a', updated_at: '2026-01-03T00:00:01Z', sync_updated_at: '2026-01-03T00:00:00Z' }
        ],
        series_torrent_resume: [
            { id: '7', sync_id: 'house', profile_id: '0', source: 'tmdb', series_id: '7', title: 'Show', magnet: 'magnet:?xt=one', torrent_hash: 'legacy-hash', season_number: 1, episode_number: 2, device_id: 'dev-a', updated_at: '2026-01-01T00:00:01Z', sync_updated_at: '2026-01-01T00:00:00Z' },
            { id: '8', sync_id: 'house', profile_id: '0', source: 'tmdb', series_id: '8', title: 'Show 2', magnet: 'magnet:?xt=two', torrent_hash: 'legacy-hash-2', season_number: 1, episode_number: 3, device_id: 'dev-a', updated_at: '2026-01-02T00:00:01Z', sync_updated_at: '2026-01-02T00:00:00Z' },
            { id: '9', sync_id: 'house', profile_id: '0', source: 'tmdb', series_id: '9', title: 'Show 3', magnet: 'magnet:?xt=three', torrent_hash: 'legacy-hash-3', season_number: 2, episode_number: 1, device_id: 'dev-a', updated_at: '2026-01-03T00:00:01Z', sync_updated_at: '2026-01-03T00:00:00Z' }
        ]
    };
    const syncId = (url.searchParams.get('sync_id') || '').replace(/^eq\./, '');
    const profileId = (url.searchParams.get('profile_id') || '').replace(/^eq\./, '');
    const scoped = fixtures[table].filter((row) => String(row.sync_id) === syncId && String(row.profile_id) === profileId);
    const page = scoped.slice(offset, offset + Number(url.searchParams.get('limit')));
    return new Response(JSON.stringify(page), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

await import('../supabase/functions/swift-task/index.ts');

function request(body, code = 'test-sync-code') {
    return new Request('https://function.example.test', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-sync-code': code },
        body: JSON.stringify(body)
    });
}

test('rejects wrong x-sync-code without contacting PostgREST', async () => {
    calls.length = 0;
    const response = await handler(request({ action: 'sync' }, 'wrong'));
    assert.equal(response.status, 401);
    assert.equal(calls.length, 0);
});

test('OPTIONS preflight returns a bodyless 204 with CORS headers', async () => {
    const response = await handler(new Request('https://function.example.test', { method: 'OPTIONS' }));
    assert.equal(response.status, 204);
    assert.equal(await response.text(), '');
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
    assert.match(response.headers.get('Access-Control-Allow-Headers'), /x-sync-code/);
});

test('HTTP validation failures and health response use body-capable statuses', async () => {
    const get = await handler(new Request('https://function.example.test', { method: 'GET' }));
    assert.equal(get.status, 405);
    assert.deepEqual(await get.json(), { success: false, error: 'method_not_allowed' });

    const malformed = await handler(new Request('https://function.example.test', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-sync-code': 'test-sync-code' }, body: '{'
    }));
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { success: false, error: 'invalid_json' });

    const health = await handler(request({ action: 'health' }));
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { success: true });
});

test('rejects unsupported actions and invalid scopes with JSON errors', async () => {
    const action = await handler(request({ action: 'delete' }));
    assert.equal(action.status, 400);
    assert.deepEqual(await action.json(), { success: false, error: 'unknown_action' });

    const scope = await handler(request({ action: 'sync', sync_id: '', profile_id: '0' }));
    assert.equal(scope.status, 400);
    assert.deepEqual(await scope.json(), { success: false, error: 'invalid_scope' });
});

test('reports missing server configuration without calling PostgREST', async () => {
    calls.length = 0;
    const previous = environment.SUPABASE_URL;
    environment.SUPABASE_URL = '';
    try {
        const response = await handler(request({ action: 'sync', sync_id: 'house', profile_id: '0' }));
        assert.equal(response.status, 500);
        assert.deepEqual(await response.json(), { success: false, error: 'supabase_secrets_missing' });
        assert.equal(calls.length, 0);
    } finally {
        environment.SUPABASE_URL = previous;
    }
});

test('maps PostgREST write and read failures to JSON 502 responses', async () => {
    databaseFailure = 'write';
    const write = await handler(request({
        action: 'push', sync_id: 'house', profile_id: '0',
        changes: { episode_progress: [{ timeline_hash: 'ep', percent: 50 }] }
    }));
    assert.equal(write.status, 502);
    assert.deepEqual(await write.json(), { success: false, error: 'database_write_failed', table: 'episode_progress' });

    databaseFailure = 'read';
    const read = await handler(request({ action: 'sync', sync_id: 'house', profile_id: '0' }));
    assert.equal(read.status, 502);
    assert.deepEqual(await read.json(), { success: false, error: 'database_read_failed', table: 'episode_progress' });
});

test('uses SUPABASE_SECRET_KEYS.default and returns old/new compatible rows with pagination', async () => {
    calls.length = 0;
    const first = await handler(request({ action: 'sync', sync_id: 'house', profile_id: '0', limit: 2, offset: 0 }));
    const firstBody = await first.json();
    assert.equal(firstBody.success, true);
    assert.deepEqual(firstBody.more, { episode_progress: true, movie_watched_marks: true, series_torrent_resume: true });
    assert.equal(firstBody.data.episode_progress[0].percent, 54);
    assert.equal(firstBody.data.episode_progress[0].timeline_hash, 'legacy-ep');
    assert.equal(firstBody.data.episode_progress[0].is_deleted, true);
    assert.equal(firstBody.data.movie_watched_marks[0].marked_at, 1767225600000);
    assert.equal(firstBody.data.movie_watched_marks[0].is_deleted, true);
    assert.equal(firstBody.data.series_torrent_resume[0].magnet, 'magnet:?xt=one');
    assert.equal('link' in firstBody.data.series_torrent_resume[0], false);
    assert.equal('torrent_hash' in firstBody.data.series_torrent_resume[0], false);
    assert.ok(firstBody.next.episode_progress.hash);
    assert.ok(calls.every((call) => call.headers.get('apikey') === 'unit-test-service-key'));
    const torrentRead = calls.find((call) => call.url.pathname.endsWith('/series_torrent_resume'));
    assert.equal(torrentRead.url.searchParams.get('select').includes('link'), false);
    assert.equal(torrentRead.url.searchParams.get('select').includes('torrent_hash'), false);

    const second = await handler(request({ action: 'sync', sync_id: 'house', profile_id: '0', limit: 2, cursor: firstBody.next }));
    const secondBody = await second.json();
    assert.equal(secondBody.success, true);
    assert.deepEqual(secondBody.more, { episode_progress: false, movie_watched_marks: false, series_torrent_resume: false });
});

test('filters rows by exact sync_id and profile_id; unknown local profile receives no rows', async () => {
    calls.length = 0;
    const mismatch = await handler(request({ action: 'sync', sync_id: 'house', profile_id: 'main' }));
    const mismatchBody = await mismatch.json();
    assert.equal(mismatchBody.success, true);
    assert.equal(mismatchBody.data.episode_progress.length, 0);
    assert.equal(mismatchBody.data.movie_watched_marks.length, 0);
    assert.ok(calls.every((call) => call.url.searchParams.get('sync_id') === 'eq.house' && call.url.searchParams.get('profile_id') === 'eq.main'));

    calls.length = 0;
    const match = await handler(request({ action: 'sync', sync_id: 'house', profile_id: '0' }));
    const matchBody = await match.json();
    assert.equal(matchBody.success, true);
    assert.equal(matchBody.data.episode_progress.length, 3);
    assert.equal(matchBody.data.movie_watched_marks.length, 3);
    assert.ok(calls.every((call) => call.url.searchParams.get('sync_id') === 'eq.house' && call.url.searchParams.get('profile_id') === 'eq.0'));
});

test('push sends all three table batches through the RPC', async () => {
    calls.length = 0;
    const response = await handler(request({
        action: 'push', sync_id: 'house', profile_id: '0',
        changes: {
            episode_progress: [{ timeline_hash: 'ep', percent: 100 }],
            movie_watched_marks: [{ source: 'tmdb', movie_id: '42', marked_at: 1767225600000, is_deleted: true }],
            series_torrent_resume: [{ source: 'tmdb', series_id: '7', magnet: 'magnet:?xt=one' }]
        }
    }));
    assert.deepEqual(await response.json(), { success: true });
    const writes = calls.filter((call) => call.url.pathname.endsWith('/rpc/hws_sync_apply'));
    assert.equal(writes.length, 3);
    const writePayload = JSON.parse(writes[0].init.body);
    assert.equal(writePayload.p_device_id, 'legacy-client');
    assert.ok(writes.every((call) => call.headers.get('apikey') === 'unit-test-service-key'));
});

test('migration preserves legacy required columns and aligns SQL/client wire types', async () => {
    const sql = await readFile(new URL('../supabase/migrations/20261126000000_hws_sync.sql', import.meta.url), 'utf8');
    assert.match(sql, /hash and road are required legacy columns/i);
    assert.match(sql, /marked_at' and data_type = 'bigint'/i);
    assert.match(sql, /column_name = 'client_updated_at'[\s\S]*?data_type = 'bigint'/i);
    assert.doesNotMatch(sql, /alter column marked_at type/i);
    assert.match(sql, /deleted_at = excluded\.deleted_at/i);
    assert.match(sql, /sync_updated_at > movie_watched_marks\.sync_updated_at/i);
    assert.match(sql, /profile_id, sync_id, hash, road/i);
    assert.match(sql, /client_updated_at = excluded\.client_updated_at/i);
    assert.match(sql, /client_updated_at::numeric = 0 then null/i);
    assert.match(sql, /episode_progress_sync_identity/i);
    assert.match(sql, /movie_watched_sync_identity/i);
    assert.match(sql, /series_torrent_sync_identity/i);
    assert.match(sql, /torrent_hash/i);
    assert.match(sql, /sync_id text not null default 'default'/i);
    assert.match(sql, /sync_updated_at timestamptz not null/i);
    assert.match(sql, /jsonb_strip_nulls\(jsonb_build_object/i);
    assert.match(sql, /client_updated_at/);
    assert.match(sql, /elsif id_type = 'bigint' then/i);
    assert.match(sql, /create sequence if not exists public\.%i as bigint/i);
    assert.match(sql, /alter column id set default nextval/i);
    assert.match(sql, /select max\(id\) from public\.%i/i);
    assert.match(sql, /setval\(%l::regclass, \$1, true\)/i);
    assert.match(sql, /alter table public\.%i drop constraint/i);
    assert.doesNotMatch(sql, /^\s*drop\s+table\s+public\./im);
    assert.doesNotMatch(sql, /delete from public\.(episode_progress|movie_watched_marks|series_torrent_resume)/i);
});
