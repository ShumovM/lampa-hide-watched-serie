/*
 * Заглушка TorrServer для проверки интерфейса Lampa в браузере (список файлов раздачи).
 * Отвечает на запросы, которые шлёт interaction/torserver.js Lampa 3.x:
 *   POST /settings  {action:get}           → {CacheSize}
 *   POST /torrents  {action:add, link}     → {hash}
 *   POST /torrents  {action:get, hash}     → {hash, file_stats:[...]}
 *   POST /viewed    {action:list|set}      → []
 *   GET  /stream/…&preload|&stat           → буфер заполнен (Lampa запускает плеер и шлёт onenter)
 * Видео не отдаёт. Все запросы пишутся в консоль.
 * Запуск: node tests/integration/torrserver_mock.js [порт]
 */
'use strict';

const http = require('http');

const port = parseInt(process.argv[2] || process.env.PORT || '8792', 10);
const added = {};

// Раздача MobLand: S01E01–E10 и S02E01–E07
function files() {
    const list = [];
    let id = 1;

    for (let s = 1; s <= 2; s++) {
        const count = s === 1 ? 10 : 7;

        for (let e = 1; e <= count; e++) {
            const ep = (e < 10 ? '0' : '') + e;

            list.push({ id: id++, path: 'MobLand.S0' + s + '.1080p/MobLand.S0' + s + 'E' + ep + '.1080p.WEB-DL.mkv', length: 1500000000 });
        }
    }

    return list;
}

function send(res, code, body) {
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    });
    res.end(JSON.stringify(body));
}

http.createServer((req, res) => {
    let raw = '';

    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
        let body = {};

        try {
            body = raw ? JSON.parse(raw) : {};
        } catch (e) {
            body = {};
        }

        const path = req.url.split('?')[0];

        console.log(req.method, path, raw.slice(0, 200));

        if (req.method === 'OPTIONS') return send(res, 200, {});
        if (path === '/settings') return send(res, 200, { CacheSize: 104857600 });
        if (path === '/viewed') return send(res, 200, []);

        // Предзагрузка (&preload / &stat): буфер сразу заполнен, Lampa переходит к плееру
        if (path.indexOf('/stream/') === 0) return send(res, 200, { preloaded_bytes: 1000, preload_size: 1000, download_speed: 0, active_peers: 1, total_peers: 1 });

        if (path === '/torrents') {
            if (body.action === 'add') {
                const hash = 'mockhash' + Object.keys(added).length;

                added[hash] = body.link;

                return send(res, 200, { hash, title: body.title, stat: 3 });
            }

            if (body.action === 'get') return send(res, 200, { hash: body.hash, title: 'MobLand', stat: 3, file_stats: files() });

            if (body.action === 'list') return send(res, 200, []);
        }

        send(res, 404, { error: 'not found' });
    });
}).listen(port, () => console.log('TorrServer mock on http://localhost:' + port));
