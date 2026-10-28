/*
 * Проверка, что плагин разбирается как чистый ES5 (старые движки LG webOS),
 * и что в коде нет API, которых может не быть в старых браузерах.
 * Запуск: npm install && node tests/check_es5.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const file = path.join(__dirname, '..', 'hide_watched_series.js');
const src = fs.readFileSync(file, 'utf8');
let failed = 0;

try {
    acorn.parse(src, { ecmaVersion: 5, sourceType: 'script' });
    console.log('OK   синтаксис ES5 (acorn ecmaVersion 5)');
} catch (e) {
    failed++;
    console.log('FAIL синтаксис ES5: ' + e.message);
}

// Комментарии не проверяем
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const banned = {
    // jQuery .find('селектор') допустим, Array.prototype.find принимает функцию
    'Array.prototype.find/findIndex': /\.find(Index)?\((?!\s*['"])/,
    'includes()': /\.includes\(/,
    'Promise': /\bPromise\b/,
    'Object.assign': /Object\.assign/,
    'startsWith/endsWith': /\.(startsWith|endsWith)\(/,
    'глобальный fetch()': /(^|[^.\w])fetch\(/m,
    'Symbol/Map/Set': /\b(Symbol|Map|Set|WeakMap)\b/
};

Object.keys(banned).forEach((name) => {
    const m = banned[name].exec(code);

    if (m) {
        failed++;
        console.log('FAIL найдено: ' + name + ' → ' + m[0]);
    } else {
        console.log('OK   нет ' + name);
    }
});

process.exit(failed ? 1 : 0);
