/*
 * Статический сервер для интеграционной проверки в браузере:
 *   /                      — собранная Lampa (каталог из LAMPA_DIR или 1-го аргумента)
 *   /plugin/<файл>.js      — файлы плагина из корня проекта
 * Запуск: node tests/integration/serve.js <путь к сборке lampa> [порт]
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const lampaDir = path.resolve(process.argv[2] || process.env.LAMPA_DIR || '.');
const port = parseInt(process.argv[3] || process.env.PORT || '8790', 10);
const projectDir = path.resolve(__dirname, '..', '..');

const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg'
};

http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    let file;

    if (url.indexOf('/plugin/') === 0) file = path.join(projectDir, path.basename(url));
    else file = path.join(lampaDir, url === '/' ? 'index.html' : url);

    if (file.indexOf(projectDir) !== 0 && file.indexOf(lampaDir) !== 0) {
        res.writeHead(403);

        return res.end();
    }

    fs.readFile(file, (err, data) => {
        if (err) {
            res.writeHead(404);

            return res.end('not found');
        }

        res.writeHead(200, {
            'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*'
        });
        res.end(data);
    });
}).listen(port, () => {
    console.log('Lampa: ' + lampaDir);
    console.log('Serving on http://localhost:' + port);
});
