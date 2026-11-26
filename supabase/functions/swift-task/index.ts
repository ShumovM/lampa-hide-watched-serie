// Swift-task endpoint for HideWatchedSeries Supabase sync.
// Tables keep their original columns; the migration adds sync_id/sync_updated_at only.
// Required secrets: SUPABASE_URL, SUPABASE_SECRET_KEYS, LAMPA_SYNC_CODE.

const TABLES = ["episode_progress", "movie_watched_marks", "series_torrent_resume"] as const;
type SyncTable = (typeof TABLES)[number];

const SELECT_COLUMNS: Record<SyncTable, string> = {
    episode_progress: "id,sync_id,profile_id,hash,road,client_updated_at,deleted_at,device_id,updated_at,sync_updated_at",
    movie_watched_marks: "id,sync_id,profile_id,source,movie_id,title,marked_at,deleted_at,device_id,updated_at,sync_updated_at",
    // torrent_hash stays in the database for legacy compatibility but is not needed by the client.
    series_torrent_resume: "id,sync_id,profile_id,source,series_id,title,magnet,season_number,episode_number,device_id,updated_at,sync_updated_at",
};

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-sync-code",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Cursor = Record<string, string>;
type DbRow = Record<string, unknown>;

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
    });
}

function constantTimeEqual(a: string, b: string): boolean {
    const encoder = new TextEncoder();
    const left = encoder.encode(a);
    const right = encoder.encode(b);
    let diff = left.length ^ right.length;
    const size = Math.max(left.length, right.length);
    for (let i = 0; i < size; i++) diff |= (left[i] || 0) ^ (right[i] || 0);
    return diff === 0;
}

function serviceKey(): string {
    const raw = Deno.env.get("SUPABASE_SECRET_KEYS") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!raw) return "";
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            const preferred = parsed.find((item) => item && /service.?role|secret/i.test(String(item.name || item.type || "")));
            const value = preferred && (preferred.value || preferred.key || preferred.secret);
            if (typeof value === "string") return value;
            const first = parsed.find((item) => item && typeof (item.value || item.key || item.secret) === "string");
            if (first) return first.value || first.key || first.secret;
        }
        if (parsed && typeof parsed === "object") {
            for (const name of ["default", "service_role", "serviceRole", "secret", "SUPABASE_SERVICE_ROLE_KEY"]) {
                if (typeof parsed[name] === "string") return parsed[name];
                if (parsed[name] && typeof parsed[name] === "object") {
                    const nested = parsed[name].value || parsed[name].key || parsed[name].secret;
                    if (typeof nested === "string") return nested;
                }
            }
        }
    } catch (_) {
        // A plain secret key is also supported.
    }
    return raw.split(/[\r\n,; ]/)[0];
}

function validScope(value: unknown, maxLength: number): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= maxLength && !/[\r\n]/.test(value);
}

function quoteFilter(value: string): string {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

function identityColumns(table: SyncTable): string[] {
    if (table === "episode_progress") return ["hash"];
    if (table === "movie_watched_marks") return ["source", "movie_id"];
    return ["source", "series_id"];
}

function cursorFilter(table: SyncTable, cursor: Cursor): string {
    const updated = quoteFilter(cursor.updated_at);
    const columns = identityColumns(table);
    const tail = columns.map((column, index) => {
        const equal = columns.slice(0, index).map((prior) => `${prior}.eq.${quoteFilter(cursor[prior])}`);
        return `and(${equal.length ? `${equal.join(",")},` : ""}${column}.gt.${quoteFilter(cursor[column])})`;
    });
    const tie = columns.length === 1 ? `${columns[0]}.gt.${quoteFilter(cursor[columns[0]])}` : `or(${tail.join(",")})`;
    return `(sync_updated_at.gt.${updated},and(sync_updated_at.eq.${updated},${tie}))`;
}

function tableUrl(base: string, table: SyncTable, scope: string, profile: string, cursor: Cursor | undefined, offset: number, limit: number): string {
    const identity = identityColumns(table);
    const query = new URLSearchParams({
        select: SELECT_COLUMNS[table],
        sync_id: `eq.${scope}`,
        profile_id: `eq.${profile}`,
        order: `sync_updated_at.asc,${identity.map((column) => `${column}.asc`).join(",")}`,
        limit: String(limit),
        offset: String(offset),
    });
    if (cursor && cursor.updated_at && identity.every((column) => cursor[column])) query.set("or", cursorFilter(table, cursor));
    return `${base}/rest/v1/${table}?${query.toString()}`;
}

function toClientRow(table: SyncTable, row: DbRow): DbRow {
    const common = {
        sync_id: String(row.sync_id || "default"),
        profile_id: String(row.profile_id),
        updated_at: row.sync_updated_at || row.updated_at,
    };

    if (table === "episode_progress") {
        let road: DbRow = {};
        if (row.road && typeof row.road === "object") road = row.road as DbRow;
        else if (typeof row.road === "string") {
            try { road = JSON.parse(row.road) as DbRow; } catch (_) { road = {}; }
        }
        return {
            ...common,
            timeline_hash: String(row.hash || ""),
            percent: Number(road.percent) || 0,
            time: Number(road.time) || 0,
            duration: Number(road.duration) || 0,
            profile: Number(road.profile) || 0,
            card: road.card || null,
            season: road.season === null || typeof road.season === "undefined" ? null : Number(road.season),
            episode: road.episode === null || typeof road.episode === "undefined" ? null : Number(road.episode),
            is_deleted: row.deleted_at !== null && typeof row.deleted_at !== "undefined",
        };
    }

    if (table === "movie_watched_marks") {
        return {
            ...common,
            source: row.source,
            movie_id: String(row.movie_id),
            title: row.title || "",
            marked_at: row.marked_at,
            is_deleted: row.deleted_at !== null && typeof row.deleted_at !== "undefined",
        };
    }

    return {
        ...common,
        source: row.source,
        series_id: String(row.series_id),
        title: row.title || "",
        magnet: row.magnet || "",
        season_number: Number(row.season_number) || 1,
        episode_number: Number(row.episode_number) || 1,
    };
}

function rowCursor(table: SyncTable, row: DbRow): Cursor | null {
    if (!row.sync_updated_at) return null;
    const cursor: Cursor = { updated_at: String(row.sync_updated_at) };
    for (const column of identityColumns(table)) {
        if (row[column] === null || typeof row[column] === "undefined") return null;
        cursor[column] = String(row[column]);
    }
    return cursor;
}

async function restFetch(url: string, key: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers || {});
    headers.set("apikey", key);
    headers.set("Authorization", `Bearer ${key}`);
    headers.set("Accept", "application/json");
    return await fetch(url, { ...init, headers });
}

Deno.serve(async (request: Request) => {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
    if (request.method !== "POST") return json({ success: false, error: "method_not_allowed" }, 405);

    const expected = Deno.env.get("LAMPA_SYNC_CODE") || "";
    const supplied = request.headers.get("x-sync-code") || "";
    if (!expected || !supplied || !constantTimeEqual(expected, supplied)) {
        return json({ success: false, error: "unauthorized" }, 401);
    }

    let body: Record<string, unknown>;
    try {
        body = await request.json();
    } catch (_) {
        return json({ success: false, error: "invalid_json" }, 400);
    }

    const action = typeof body.action === "string" ? body.action : "health";
    if (action === "health") return json({ success: true });
    if (action !== "sync" && action !== "push") return json({ success: false, error: "unknown_action" }, 400);

    const syncId = body.sync_id;
    const profileId = body.profile_id;
    const deviceId = validScope(body.device_id, 128) ? body.device_id : "legacy-client";
    if (!validScope(syncId, 128) || !validScope(profileId, 128)) {
        return json({ success: false, error: "invalid_scope" }, 400);
    }

    const base = (Deno.env.get("SUPABASE_URL") || "").replace(/\/+$/, "");
    const key = serviceKey();
    if (!base || !key) return json({ success: false, error: "supabase_secrets_missing" }, 500);

    const changes = (body.changes && typeof body.changes === "object" ? body.changes : {}) as Record<string, unknown>;

    try {
        for (const table of TABLES) {
            const rows = changes[table];
            if (rows === undefined) continue;
            if (!Array.isArray(rows) || rows.length > 500) return json({ success: false, error: `invalid_${table}` }, 400);
            if (!rows.length) continue;

            const response = await restFetch(`${base}/rest/v1/rpc/hws_sync_apply`, key, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    p_table: table, p_sync_id: syncId, p_profile_id: profileId,
                    p_device_id: deviceId, p_rows: rows,
                }),
            });
            if (!response.ok) {
                const detail = await response.text();
                console.error("swift-task database write failed", table, response.status, detail.slice(0, 500));
                return json({ success: false, error: "database_write_failed", table }, 502);
            }
        }

        if (action === "push") return json({ success: true });

        const offset = Math.max(0, Math.floor(Number(body.offset) || 0));
        const limit = Math.min(500, Math.max(1, Math.floor(Number(body.limit) || 300)));
        const data: Record<string, unknown[]> = {};
        const more: Record<string, boolean> = {};
        const next: Record<string, Cursor | null> = {};
        const cursors = (body.cursor && typeof body.cursor === "object" ? body.cursor : {}) as Record<string, Cursor>;

        for (const table of TABLES) {
            const response = await restFetch(tableUrl(base, table, syncId, profileId, cursors[table], offset, limit + 1), key);
            if (!response.ok) {
                const detail = await response.text();
                console.error("swift-task database read failed", table, response.status, detail.slice(0, 500));
                return json({ success: false, error: "database_read_failed", table }, 502);
            }
            const fetched = await response.json();
            if (!Array.isArray(fetched)) return json({ success: false, error: "invalid_database_response", table }, 502);

            const hasMore = fetched.length > limit;
            const dbRows = hasMore ? fetched.slice(0, limit) : fetched;
            data[table] = dbRows.map((row) => toClientRow(table, row as DbRow));
            more[table] = hasMore;
            next[table] = hasMore && dbRows.length ? rowCursor(table, dbRows[dbRows.length - 1] as DbRow) : null;
        }

        return json({ success: true, data, more, next });
    } catch (error) {
        console.error("swift-task request failed", error);
        return json({ success: false, error: "internal_error" }, 500);
    }
});
