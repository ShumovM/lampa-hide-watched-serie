import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const calls = [];
let handler;

globalThis.Deno = {
    env: {
        get(name) {
            return {
                LAMPA_SYNC_CODE: 'test-sync-code',
                SUPABASE_URL: 'https://db.example.test',
                SUPABASE_SECRET_KEYS: JSON.stringify({ default: 'sb_secret_from_default' })
            }[name] || '';
        }
    },
    serve(fn) { handler = fn; }
};

globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers || {});
    calls.push({ url, init, headers });

    if (url.pathname.endsWith('/rpc/hws_sync_apply')) return new Response(null, { status: 204 });

    const table = url.pathname.split('/').pop();
    const offset = url.searchParams.has('or') ? 2 : Number(url.searchParams.get('offset'));
    const fixtures = {
        episode_progress: [
            { hash: 'legacy-ep', road: { percent: 54 }, timeline_hash: 'legacy-ep', percent: 54, time: 540, duration: 1000, updated_at: '2026-01-01T00:00:00Z' },
            { hash: 'new-ep', road: { percent: 100 }, timeline_hash: 'new-ep', percent: 100, time: 1000, duration: 1000, updated_at: '2026-01-02T00:00:00Z' },
            { hash: 'later-ep', road: { percent: 70 }, timeline_hash: 'later-ep', percent: 70, time: 700, duration: 1000, updated_at: '2026-01-03T00:00:00Z' }
        ],
        movie_watched_marks: [
            { source: 'tmdb', movie_id: '42', marked_at: 1767225600000, updated_at: '2026-01-01T00:00:00Z', is_deleted: true },
            { source: 'tmdb', movie_id: '43', marked_at: 1767312000000, updated_at: '2026-01-02T00:00:00Z', is_deleted: false },
            { source: 'tmdb', movie_id: '44', marked_at: 1767398400000, updated_at: '2026-01-03T00:00:00Z', is_deleted: false }
        ],
        series_torrent_resume: [
            { source: 'tmdb', series_id: '7', magnet: 'magnet:?xt=one', season_number: 1, episode_number: 2, updated_at: '2026-01-01T00:00:00Z' },
            { source: 'tmdb', series_id: '8', magnet: 'magnet:?xt=two', season_number: 1, episode_number: 3, updated_at: '2026-01-02T00:00:00Z' },
            { source: 'tmdb', series_id: '9', magnet: 'magnet:?xt=three', season_number: 2, episode_number: 1, updated_at: '2026-01-03T00:00:00Z' }
        ]
    };
    const page = fixtures[table].slice(offset, offset + Number(url.searchParams.get('limit')));
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

test('uses SUPABASE_SECRET_KEYS.default and returns old/new compatible rows with pagination', async () => {
    calls.length = 0;
    const first = await handler(request({ action: 'sync', sync_id: 'house', profile_id: '0', limit: 2, offset: 0 }));
    const firstBody = await first.json();
    assert.equal(firstBody.success, true);
    assert.deepEqual(firstBody.more, { episode_progress: true, movie_watched_marks: true, series_torrent_resume: true });
    assert.equal(firstBody.data.episode_progress[0].road.percent, 54);
    assert.equal(firstBody.data.movie_watched_marks[0].marked_at, 1767225600000);
    assert.equal(firstBody.data.movie_watched_marks[0].is_deleted, true);
    assert.equal(firstBody.data.series_torrent_resume[0].magnet, 'magnet:?xt=one');
    assert.equal('link' in firstBody.data.series_torrent_resume[0], false);
    assert.ok(firstBody.next.episode_progress.timeline_hash);
    assert.ok(calls.every((call) => call.headers.get('apikey') === 'sb_secret_from_default'));
    const torrentRead = calls.find((call) => call.url.pathname.endsWith('/series_torrent_resume'));
    assert.equal(torrentRead.url.searchParams.get('select').includes('link'), false);
    assert.equal(torrentRead.url.searchParams.get('select').includes('hash'), false);

    const second = await handler(request({ action: 'sync', sync_id: 'house', profile_id: '0', limit: 2, cursor: firstBody.next }));
    const secondBody = await second.json();
    assert.equal(secondBody.success, true);
    assert.deepEqual(secondBody.more, { episode_progress: false, movie_watched_marks: false, series_torrent_resume: false });
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
    assert.ok(writes.every((call) => call.headers.get('apikey') === 'sb_secret_from_default'));
});

test('migration preserves legacy required columns and aligns SQL/client wire types', async () => {
    const sql = await readFile(new URL('../supabase/migrations/20261126000000_hws_sync.sql', import.meta.url), 'utf8');
    assert.match(sql, /hash text not null/i);
    assert.match(sql, /road jsonb not null/i);
    assert.match(sql, /insert into public\.episode_progress\s*\(\s*hash, road,/i);
    assert.match(sql, /marked_at bigint/i);
    assert.doesNotMatch(sql, /marked_at timestamptz/i);
    assert.match(sql, /is_deleted boolean/i);
    assert.match(sql, /where excluded\.updated_at > (episode_progress|movie_watched_marks|series_torrent_resume)\.updated_at/i);
    assert.match(sql, /episode_progress_sync_identity/i);
    assert.match(sql, /movie_watched_sync_identity/i);
    assert.match(sql, /series_torrent_sync_identity/i);
});
