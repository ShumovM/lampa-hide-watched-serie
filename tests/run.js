/*
 * Автотесты плагина hide_watched_series.
 * Запуск: node tests/run.js
 * Для каждой проверки выводится ожидаемый и фактический результат,
 * итог сохраняется в tests/results.md.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { createEnv, memoryStorage, lampaHash, plugin, DAY } = require('./harness');

const Core = plugin.Core;
const results = [];

function check(id, title, expected, actualFn) {
    let actual;

    try {
        actual = actualFn();
    } catch (e) {
        actual = 'EXCEPTION: ' + e.message;
    }

    const exp = JSON.stringify(expected);
    const act = JSON.stringify(actual);

    results.push({ id, title, expected: exp, actual: act, pass: exp === act });
}

function fresh(opts) {
    const env = createEnv(opts);

    env.install();
    env.flush();

    return env;
}

// Показ строки → фоновая проверка → повторный показ
function settle(env, screen, params) {
    env.continueTitles(screen, params);
    env.flush();

    return env.continueTitles(screen, params);
}

/* ---------------- 1. Полностью просмотренный сериал скрывается ---------------- */
check('1', 'Все вышедшие серии просмотрены на 100% — сериал скрыт', ['Other Show'], () => {
    const env = fresh();
    const a = env.addShow(101, 'Done Show', [{ n: 1, eps: [-80, -73, -66, -59, -52, -45, -38, -31] }]);
    const b = env.addShow(102, 'Other Show', [{ n: 1, eps: [-20, -13] }]);

    env.watchAll(a.card, a.show, 100);
    env.watch(b.card, 1, 1, 100);

    return settle(env);
});

/* ---------------- 2. Одна вышедшая непросмотренная серия ---------------- */
check('2', 'Одна вышедшая серия не просмотрена — сериал в списке', ['One Left'], () => {
    const env = fresh();
    const a = env.addShow(201, 'One Left', [{ n: 1, eps: [-30, -23, -16, -9, -2] }]);

    env.watchAll(a.card, a.show, 100, (s, e) => e !== 5);

    return settle(env);
});

/* ---------------- 3. Частично просмотренная последняя серия ---------------- */
check('3', 'Последняя серия просмотрена на 50% — сериал в списке', ['Partial'], () => {
    const env = fresh();
    const a = env.addShow(301, 'Partial', [{ n: 1, eps: [-30, -23, -16] }]);

    env.watchAll(a.card, a.show, 100);
    env.watch(a.card, 1, 3, 50);

    return settle(env);
});

check('3a', 'Порог 90%: серия на 89% — в списке, на 92% — скрыт', [['Edge'], []], () => {
    const env = fresh();
    const a = env.addShow(311, 'Edge', [{ n: 1, eps: [-30, -23] }]);

    env.watch(a.card, 1, 1, 100);
    env.watch(a.card, 1, 2, 89);

    const first = settle(env);

    env.watch(a.card, 1, 2, 92);

    return [first, settle(env)];
});

/* ---------------- 4. Будущая серия не мешает скрытию ---------------- */
check('4', 'Вышедшие просмотрены, 9-я серия выйдет через 7 дней — сериал скрыт', [], () => {
    const env = fresh();
    const a = env.addShow(401, 'Weekly', [{ n: 1, eps: [-49, -42, -35, -28, -21, -14, -7, 0, 7] }]);

    env.watchAll(a.card, a.show, 100);

    return settle(env);
});

/* ---------------- 5–6. Возврат после выхода новой серии и повторное скрытие ---------------- */
(function () {
    const env = fresh();
    const a = env.addShow(501, 'Weekly Return', [{ n: 1, eps: [-49, -42, -35, -28, -21, -14, -7, -1, 6] }]);

    env.watchAll(a.card, a.show, 100);

    const hidden = settle(env);

    check('5', 'Скрыт, пока 9-я серия не вышла', [], () => hidden);

    env.advance(7);
    // TMDB недоступен: возврат должен сработать по сохранённой дате выхода
    env.tmdb.fail = true;

    check('5a', 'Наступила дата 9-й серии — сериал вернулся (даже без сети)', ['Weekly Return'], () => env.continueTitles());

    env.tmdb.fail = false;

    check('5b', 'После перепроверки в TMDB 9-я серия числится непросмотренной — сериал в списке', ['Weekly Return'], () => settle(env));

    check('5c', 'Статус в кеше после выхода 9-й серии', 'incomplete', () => env.win.HideWatchedSeries.cache()[501].status);

    env.watch(a.card, 1, 9, 100);
    env.flush();

    check('6', 'Посмотрел 9-ю серию — сериал снова скрыт', [], () => settle(env));
})();

/* ---------------- 7. Нет данных о сезонах ---------------- */
check('7', 'TMDB без сезонов — сериал не скрывается', [['No Seasons'], 'unknown'], () => {
    const env = fresh();
    const a = env.addShow(701, 'No Seasons', [{ n: 1, eps: [-30, -20] }]);

    a.show.patchDetails = (d) => { d.seasons = []; };
    env.watchAll(a.card, a.show, 100);

    return [settle(env), env.win.HideWatchedSeries.cache()[701].status];
});

check('7a', 'Сезон не загружается (404) — сериал не скрывается', ['No Season Data'], () => {
    const env = fresh();
    const a = env.addShow(702, 'No Season Data', [{ n: 1, eps: [-30, -20] }, { n: 2, eps: [-10, -3] }]);

    a.show.noSeasonData = true;
    env.watchAll(a.card, a.show, 100);

    return settle(env);
});

/* ---------------- 8. Нет прогресса хотя бы одной серии ---------------- */
check('8', 'Для 2-й серии нет записи в истории — сериал не скрывается', ['Gap'], () => {
    const env = fresh();
    const a = env.addShow(801, 'Gap', [{ n: 1, eps: [-30, -23, -16] }]);

    env.watch(a.card, 1, 1, 100);
    env.watch(a.card, 1, 3, 100);

    return settle(env);
});

/* ---------------- 9. Ошибка получения расписания ---------------- */
check('9', 'Все запросы TMDB падают — сериалы остаются, ошибок нет', [['Net A', 'Net B'], 'unknown'], () => {
    const env = fresh();
    const a = env.addShow(901, 'Net A', [{ n: 1, eps: [-30] }]);
    const b = env.addShow(902, 'Net B', [{ n: 1, eps: [-30] }]);

    env.watchAll(a.card, a.show, 100);
    env.watchAll(b.card, b.show, 100);
    env.tmdb.fail = true;

    return [settle(env), env.win.HideWatchedSeries.cache()[901].status];
});

check('9a', 'Ошибка при загрузке сезона — сериал остаётся', ['Season Err'], () => {
    const env = fresh();
    const a = env.addShow(903, 'Season Err', [{ n: 1, eps: [-30, -20] }]);

    env.watchAll(a.card, a.show, 100);
    env.tmdb.failPaths = ['tv/903/season'];

    return settle(env);
});

check('9b', 'Сеть пропала после подтверждения — сериал остаётся скрытым до даты новой серии/7 дней', [[], ['Offline']], () => {
    const env = fresh();
    const a = env.addShow(904, 'Offline', [{ n: 1, eps: [-30, -20] }]);

    env.watchAll(a.card, a.show, 100);

    const hidden = settle(env);

    env.tmdb.fail = true;
    env.advance(1);

    const afterDay = settle(env);

    env.advance(7);

    return [afterDay.length === 0 ? hidden : afterDay, settle(env)];
});

check('9c', 'Ответ TMDB не приходит (таймаут) — проверка завершается, сериал остаётся', ['Timeout'], () => {
    const env = createEnv();
    let lost = 0;

    env.install({ fetch: () => { lost++; } });
    env.flush();

    const a = env.addShow(905, 'Timeout', [{ n: 1, eps: [-30] }]);

    env.watchAll(a.card, a.show, 100);

    const r = settle(env);

    return lost > 0 && env.win.HideWatchedSeries.cache()[905].reason === 'details_timeout' ? r : 'no timeout';
});

/* ---------------- 10. Фильмы ---------------- */
check('10', 'Строка фильмов «Вы смотрели» не меняется, фильм не скрывается', [['Movie A'], false], () => {
    const env = fresh();

    env.history.push({ id: 1001, source: 'tmdb', title: 'Movie A', original_title: 'Movie A', original_name: 'Movie A', release_date: '2020-01-01' });

    const rows = env.buildScreen('category', { url: 'movie' });

    env.flush();

    return [rows[0].results.map((c) => c.original_title), env.win.HideWatchedSeries.hideCard(env.history[0])];
});

/* ---------------- 11. Аниме ---------------- */
(function () {
    function animeEnv(include) {
        const env = fresh({ settings: include ? { hws_anime: 'true' } : {} });
        const a = env.addShow(1101, 'シャドーハウス', [{ n: 1, eps: [-30, -23] }], { lang: 'ja' });

        env.watchAll(a.card, a.show, 100);

        return { env, titles: settle(env) };
    }

    check('11', 'Аниме (настройка выкл., по умолчанию) — не скрывается и не проверяется', [['シャドーハウス'], 0], () => {
        const r = animeEnv(false);

        return [r.titles, r.env.tmdb.log.length];
    });

    check('11a', 'Аниме (настройка вкл.) — обрабатывается как сериал', [], () => animeEnv(true).titles);

    check('11b', 'Определение аниме по японскому названию без original_language', true, () => Core.isAnimeCard({ original_name: '進撃の巨人', original_language: '' }));
})();

/* ---------------- 12. Другие строки и каталог ---------------- */
check('12', 'Строки «Рекомендуем»/«Популярное» и главная не изменены', [2, 2, 2, 1], () => {
    const env = fresh();
    const a = env.addShow(1201, 'Hidden In Continue', [{ n: 1, eps: [-30] }]);
    const b = env.addShow(1202, 'Visible', [{ n: 1, eps: [-30] }]);

    env.watchAll(a.card, a.show, 100);
    settle(env);

    const rows = env.buildScreen('category', { url: 'tv' });
    const main = env.buildScreen('main', {});

    return [rows[1].results.length, rows[2].results.length, main[0].results.length, rows[0].results.length];
});

check('12a', 'Favorite.continues вне строки (плеер, Tizen) возвращает полный список', 2, () => {
    const env = fresh();
    const a = env.addShow(1203, 'Hidden', [{ n: 1, eps: [-30] }]);

    env.addShow(1204, 'Visible', [{ n: 1, eps: [-30] }]);
    env.watchAll(a.card, a.show, 100);
    settle(env);

    return env.Lampa.Favorite.continues('tv').length;
});

check('12b', 'Исходные объекты карточек в истории не изменяются', true, () => {
    const env = fresh();
    const a = env.addShow(1205, 'Pure', [{ n: 1, eps: [-30] }]);
    const before = JSON.stringify(env.history);

    env.watchAll(a.card, a.show, 100);
    settle(env);

    return JSON.stringify(env.history) === before;
});

/* ---------------- 13. Повторная загрузка плагина ---------------- */
check('13', 'Повторная загрузка: одна обёртка, один обработчик Timeline, одни настройки', [true, true, 1, 5, true], () => {
    const env = createEnv();
    const api1 = env.install();
    const api2 = env.install();

    // и повторная загрузка файла в тот же window (новый экземпляр модуля)
    delete require.cache[require.resolve('../hide_watched_series.js')];
    require('../hide_watched_series.js').install(env.win);

    env.flush();

    const cont = env.Lampa.Favorite.continues;
    const cat = env.Lampa.Api.sources.tmdb.category;

    return [api1 === api2, typeof cont.__hws === 'function' && !cont.__hws.__hws && !cat.__hws.__hws, env.Lampa.Timeline.listener.count('update'), env.Lampa.SettingsApi.params.length, env.win.HideWatchedSeries === api1];
});

/* ---------------- 14. Разные названия ---------------- */
check('14', 'Прогресс записан под original_title ≠ original_name — распознаётся', [], () => {
    const env = fresh();
    const a = env.addShow(1401, 'Kaamelott', [{ n: 1, eps: [-30, -20] }], { card: { original_title: 'Kaamelott (FR)' } });

    env.watchAll(a.card, a.show, 100);

    return settle(env);
});

check('14a', 'Прогресс записан под original_name при другом original_title — распознаётся', [], () => {
    const env = fresh();
    const a = env.addShow(1402, 'Dark', [{ n: 1, eps: [-30, -20] }], { card: { original_title: 'Dark (2017)' } });

    a.show.seasons[0].episodes.forEach((e) => env.watch(a.card, 1, e.episode_number, 100, 'original_name'));

    return settle(env);
});

check('14b', 'Прогресс только под локализованным названием — не скрывается (нет достоверных данных)', ['Severance'], () => {
    const env = fresh();
    const a = env.addShow(1403, 'Severance', [{ n: 1, eps: [-30] }], { ruName: 'Разделение' });

    env.watch(a.card, 1, 1, 100, 'name');

    return settle(env);
});

check('14c', 'Карточка без source, название в TMDB другое — не скрывается', [['Mismatch'], 'title_mismatch'], () => {
    const env = fresh();
    const a = env.addShow(1404, 'Mismatch', [{ n: 1, eps: [-30] }], { card: { source: undefined } });

    a.show.original_name = 'Another Show';
    env.watchAll(a.card, a.show, 100);

    return [settle(env), env.win.HideWatchedSeries.cache()[1404].reason];
});

/* ---------------- 15. Сезоны и серии > 9 / 10 ---------------- */
(function () {
    const seasons = [];

    for (let s = 1; s <= 12; s++) {
        const eps = [];

        for (let e = 1; e <= 12; e++) eps.push(-(13 - s) * 100 - (13 - e));

        seasons.push({ n: s, eps });
    }

    check('15', '12 сезонов × 12 серий, всё просмотрено — скрыт', [], () => {
        const env = fresh();
        const a = env.addShow(1501, 'Long Show', seasons);

        env.watchAll(a.card, a.show, 100);

        return settle(env);
    });

    check('15a', 'Не просмотрена S11E10 (ключ «11:10») — в списке', ['Long Show'], () => {
        const env = fresh();
        const a = env.addShow(1502, 'Long Show', seasons);

        env.watchAll(a.card, a.show, 100, (s, e) => !(s === 11 && e === 10));

        return settle(env);
    });

    check('15b', 'Не просмотрена S1E11 при просмотренной S11E1 — в списке (нет коллизии ключей)', ['Long Show'], () => {
        const env = fresh();
        const a = env.addShow(1503, 'Long Show', seasons);

        env.watchAll(a.card, a.show, 100, (s, e) => !(s === 1 && e === 11));

        return settle(env);
    });

    check('15c', 'Ключи хеша: S10E1, S11E1, S1E11, S11E10', ['101T', '11:1T', '111T', '11:10T'], () => [
        Core.episodeKey(10, 1, 'T'), Core.episodeKey(11, 1, 'T'), Core.episodeKey(1, 11, 'T'), Core.episodeKey(11, 10, 'T')
    ]);

    check('15d', 'Хеш плагина совпадает с Lampa.Utils.hash 2.3.0', true, () => {
        const samples = ['', 'a', '11:10Breaking Bad', '1 1Игра престолов', 'シャドーハウス', '9999999The Office'];

        return samples.every((s) => Core.hashString(s) === String(lampaHash(s)));
    });
})();

/* ---------------- 16. Спецвыпуски и нулевой сезон ---------------- */
check('16', 'Непросмотренные спецвыпуски (сезон 0) не мешают скрытию', [], () => {
    const env = fresh();
    const a = env.addShow(1601, 'With Specials', [{ n: 0, eps: [-50, -5] }, { n: 1, eps: [-40, -30] }]);

    env.watchAll(a.card, a.show, 100, (s) => s >= 1);

    return settle(env);
});

check('16a', 'Просмотренные спецвыпуски не скрывают сериал с непросмотренной серией', ['Specials Watched'], () => {
    const env = fresh();
    const a = env.addShow(1602, 'Specials Watched', [{ n: 0, eps: [-50, -5] }, { n: 1, eps: [-40, -30] }]);

    env.watchAll(a.card, a.show, 100, (s, e) => s === 0 || e === 1);

    return settle(env);
});

check('16b', 'Вышли только спецвыпуски — сериал не скрывается', ['Only Specials'], () => {
    const env = fresh();
    const a = env.addShow(1603, 'Only Specials', [{ n: 0, eps: [-50] }, { n: 1, eps: [30] }]);

    env.watchAll(a.card, a.show, 100);

    return settle(env);
});

check('16c', 'Серия без даты перед вышедшей — данные противоречивы, не скрывается', [['Undated'], 'unknown'], () => {
    const env = fresh();
    const a = env.addShow(1604, 'Undated', [{ n: 1, eps: [-40, null, -10] }]);

    env.watchAll(a.card, a.show, 100);
    env.watch(a.card, 1, 2, 100);

    return [settle(env), env.win.HideWatchedSeries.cache()[1604].status];
});

check('16d', 'Серии без даты в конце сезона (анонс) не мешают скрытию', [], () => {
    const env = fresh();
    const a = env.addShow(1605, 'TBA Tail', [{ n: 1, eps: [-40, -30, null, null] }]);

    env.watchAll(a.card, a.show, 100);

    return settle(env);
});

/* ---------------- 17. Изменение данных о сезонах ---------------- */
check('17', 'Добавлен новый сезон с вышедшей серией — после перепроверки сериал вернулся', [[], ['Renewed'], 'incomplete'], () => {
    const env = fresh();
    const a = env.addShow(1701, 'Renewed', [{ n: 1, eps: [-60, -50] }]);

    env.watchAll(a.card, a.show, 100);

    const hidden = settle(env);

    // за 7 часов TMDB добавил 2-й сезон, его 1-я серия уже вышла
    a.show.seasons.push({ season_number: 2, episodes: [{ episode_number: 1, air_date: env.day(0) }] });
    env.advance(7 / 24);

    const titles = settle(env);

    return [hidden, titles, env.win.HideWatchedSeries.cache()[1701].status];
});

check('17a', 'Анонсирован сезон с будущей датой — скрыт до даты, после — в списке', [[], [], ['Announced']], () => {
    const env = fresh();
    const a = env.addShow(1702, 'Announced', [{ n: 1, eps: [-60, -50] }]);

    env.watchAll(a.card, a.show, 100);

    const first = settle(env);

    a.show.seasons.push({ season_number: 2, episodes: [{ episode_number: 1, air_date: env.day(10) }] });
    env.advance(7 / 24);

    const second = settle(env);

    env.advance(11);
    env.tmdb.fail = true;

    return [first, second, env.continueTitles()];
});

check('17b', 'Локальное расписание Lampa (TimeTable) знает о вышедшей серии — сериал показывается сразу', [[], ['Local TT']], () => {
    const env = fresh();
    const a = env.addShow(1703, 'Local TT', [{ n: 1, eps: [-60, -50] }]);

    env.watchAll(a.card, a.show, 100);

    const first = settle(env);

    env.timetable[1703] = [{ season_number: 2, episode_number: 1, air_date: env.day(-1) }];
    env.tmdb.fail = true;

    return [first, env.continueTitles()];
});

check('17c', 'Пользователь снял отметку «просмотрено» — сериал сразу возвращается', [[], ['Unmark']], () => {
    const env = fresh();
    const a = env.addShow(1704, 'Unmark', [{ n: 1, eps: [-60, -50] }]);

    env.watchAll(a.card, a.show, 100);

    const first = settle(env);

    env.watch(a.card, 1, 2, 0);
    env.tmdb.fail = true;

    return [first, env.continueTitles()];
});

/* ---------------- 18. Отсутствие API и данных ---------------- */
check('18', 'Нет Timeline/TimeTable/SettingsApi/Api.sources — без исключений, список не меняется', [true, 1], () => {
    const env = createEnv({
        mutate: (L) => {
            delete L.Timeline;
            delete L.TimeTable;
            delete L.SettingsApi;
            L.Api.sources = undefined;
        }
    });

    env.install();
    env.flush();

    const a = env.addShow(1801, 'No API', [{ n: 1, eps: [-30] }]);

    env.flush();

    return [env.win.HideWatchedSeries.mode() === 'none' || env.win.HideWatchedSeries.mode() === 'legacy', env.Lampa.Favorite.continues('tv').length];
});

check('18a', 'Нет window.Lampa при загрузке — плагин ждёт и не падает', 'waiting', () => {
    const win = { localStorage: memoryStorage() };
    const pending = [];

    plugin.install(win, { timers: { set: (fn) => pending.push(fn), interval: () => 0 } });
    pending.shift()();

    return pending.length === 1 ? 'waiting' : 'not waiting';
});

check('18b', 'Повреждённый кеш в localStorage — игнорируется', [], () => {
    const ls = memoryStorage({ hws_cache: '{broken json' });
    const env = createEnv({ localStorage: ls });

    env.install();
    env.flush();

    const a = env.addShow(1802, 'Broken Cache', [{ n: 1, eps: [-30] }]);

    env.watchAll(a.card, a.show, 100);

    return settle(env);
});

check('18c', 'Исключение внутри Timeline.view — сериал остаётся', ['Throws'], () => {
    const env = fresh();
    const a = env.addShow(1803, 'Throws', [{ n: 1, eps: [-30] }]);

    env.watchAll(a.card, a.show, 100);
    env.Lampa.Timeline.view = () => { throw new Error('boom'); };

    return settle(env);
});

check('18d', 'Плагин выключен в настройках — список не фильтруется', ['Disabled'], () => {
    const env = fresh({ settings: { hws_enabled: 'false' } });
    const a = env.addShow(1804, 'Disabled', [{ n: 1, eps: [-30] }]);

    env.watchAll(a.card, a.show, 100);

    return settle(env);
});

check('18d2', 'Выключено булевым false (Storage.set(name, false)) — список не фильтруется', ['Disabled Bool'], () => {
    const env = fresh({ settings: { hws_enabled: false } });
    const a = env.addShow(1805, 'Disabled Bool', [{ n: 1, eps: [-30] }]);

    env.watchAll(a.card, a.show, 100);

    return settle(env);
});

check('18d3', 'Порог из настроек (число 95): серия на 92% — не досмотрена', ['Thr95'], () => {
    const env = fresh({ settings: { hws_threshold: '95' } });
    const a = env.addShow(1806, 'Thr95', [{ n: 1, eps: [-30] }]);

    env.watchAll(a.card, a.show, 92);

    return settle(env);
});

check('18e', 'Запуск по событию app:ready, если Lampa ещё не готова', ['none', 'legacy'], () => {
    const env = createEnv({ appready: false });

    env.install();

    const before = env.win.HideWatchedSeries.mode();

    env.Lampa.Listener.send('app', { type: 'ready' });

    return [before, env.win.HideWatchedSeries.mode()];
});

check('18f', 'purge() удаляет кеш и настройки плагина из localStorage', [true, []], () => {
    const env = fresh({ settings: { hws_debug: 'true', hws_threshold: '95' } });
    const a = env.addShow(1807, 'Purge', [{ n: 1, eps: [-30] }]);

    env.watchAll(a.card, a.show, 100);
    settle(env);

    const had = env.ls.getItem('hws_cache') !== null;

    env.win.HideWatchedSeries.purge();

    return [had, Object.keys(env.ls.map).filter((k) => k.indexOf('hws_') === 0)];
});

/* ---------------- Ветка Lampa 3.x (ContentRows) ---------------- */
check('R1', '3.x: главная — досмотренный сериал скрыт в «Продолжить просмотр»', [['Visible'], 2], () => {
    const env = createEnv({ version: '3.x' });

    env.install();
    env.flush();

    const a = env.addShow(2001, 'Done', [{ n: 1, eps: [-30] }]);

    env.addShow(2002, 'Visible', [{ n: 1, eps: [-30] }]);
    env.watchAll(a.card, a.show, 100);

    const titles = settle(env, 'main', {});
    const recomend = env.buildScreen('main', {}).find((r) => r.title === 'Рекомендуем посмотреть');

    return [titles, recomend.results.length];
});

check('R2', '3.x: повторная установка не оборачивает ContentRows.call дважды', true, () => {
    const env = createEnv({ version: '3.x' });

    env.install();
    delete require.cache[require.resolve('../hide_watched_series.js')];
    require('../hide_watched_series.js').install(env.win);

    const fn = env.Lampa.ContentRows.call;

    return typeof fn.__hws === 'function' && !fn.__hws.__hws;
});

/* ---------------- Массовая отметка вышедших серий ---------------- */

const epHash = (title, s, e) => lampaHash(Core.episodeKey(s, e, title));

// Отложенный TMDB: ответы приходят только при flush(), как настоящая сеть
function asyncEnv(opts) {
    const env = createEnv(opts);

    env.install({ fetch: (p, ok, fail) => env.pending.push(() => env.tmdb.fetch(p, ok, fail)) });
    env.flush();

    return env;
}

check('M1', 'Несколько сезонов: отмечены все вышедшие, будущая и без даты пропущены', [5, 1, 1, 'ok', [100, 100, 100, 100, 100, 0, 0]], () => {
    const env = fresh();
    const a = env.addShow(3001, 'Multi', [{ n: 1, eps: [-60, -53, -46] }, { n: 2, eps: [-14, -7, 7, null] }]);
    let res;

    env.win.HideWatchedSeries.markAllAired(a.card, (r) => { res = r; });
    env.flush();

    const pct = [[1, 1], [1, 2], [1, 3], [2, 1], [2, 2], [2, 3], [2, 4]].map(([s, e]) => (env.timeline[epHash('Multi', s, e)] || { percent: 0 }).percent);

    return [res.marked, res.future, res.undated, res.status, pct];
});

check('M2', 'Записи идут через Timeline.update: хеш Lampa, percent 100, по одной на серию', [true, 3, [100]], () => {
    const env = fresh();
    const a = env.addShow(3002, 'Hash Check', [{ n: 1, eps: [-30, -20, -10] }]);

    env.win.HideWatchedSeries.markAllAired(a.card);
    env.flush();

    const expected = [1, 2, 3].map((e) => epHash('Hash Check', 1, e));

    return [env.updates.map((u) => u.hash).join() === expected.join(), env.updates.length, Array.from(new Set(env.updates.map((u) => u.percent)))];
});

check('M3', 'Сезоны > 10: хеш с «:» (S11E10 → «11:10…»)', true, () => {
    const env = fresh();
    const seasons = [];

    for (let s = 1; s <= 11; s++) seasons.push({ n: s, eps: Array.from({ length: 10 }, (x, i) => -(12 - s) * 100 - (10 - i)) });

    const a = env.addShow(3003, 'Eleven', seasons);

    env.win.HideWatchedSeries.markAllAired(a.card);
    env.flush();

    return env.updates.length === 110 && env.updates.some((u) => u.hash === lampaHash('11:10Eleven')) && !env.updates.some((u) => u.hash === lampaHash('1110Eleven'));
});

check('M4', '2.3.0: Timeline.link нет — запись только по хешу, без полей привязки', [false, false], () => {
    const env = fresh();
    const a = env.addShow(3004, 'No Link', [{ n: 1, eps: [-30] }]);

    env.win.HideWatchedSeries.markAllAired(a.card);
    env.flush();

    return ['card' in env.updates[0], 'season' in env.updates[0]];
});

check('M5', '3.x: привязка Timeline.link(card, s, e) записывается вместе с отметкой', { card: 'tv_3005', season: 2, episode: 1 }, () => {
    const env = createEnv({ version: '3.x' });

    env.install();
    env.flush();

    const a = env.addShow(3005, 'Linked', [{ n: 1, eps: [-30] }, { n: 2, eps: [-10] }]);

    env.win.HideWatchedSeries.markAllAired(a.card);
    env.flush();

    const u = env.updates.find((x) => x.hash === epHash('Linked', 2, 1));

    return { card: u.card, season: u.season, episode: u.episode };
});

check('M5a', '3.x: прогресс под старым названием найден по привязке — не перезаписан, считается отмеченным', [1, 1, false], () => {
    const env = createEnv({ version: '3.x' });

    env.install();
    env.flush();

    const a = env.addShow(3006, 'New Title', [{ n: 1, eps: [-30, -20] }]);

    // серия 1 была досмотрена, когда сериал назывался иначе
    env.Lampa.Timeline.update({ hash: epHash('Old Title', 1, 1), percent: 100, time: 2400, duration: 2400, card: 'tv_3006', season: 1, episode: 1 });
    env.updates.length = 0;

    let res;

    env.win.HideWatchedSeries.markAllAired(a.card, (r) => { res = r; });
    env.flush();

    return [res.marked, res.already, env.updates.some((u) => u.hash === epHash('New Title', 1, 1))];
});

check('M6', 'Ошибка загрузки сезона: остальные отмечены, частичный результат, сериал не скрыт', ['mark_partial', 2, ['Season Fail'], true], () => {
    const env = fresh();
    const a = env.addShow(3007, 'Season Fail', [{ n: 1, eps: [-60, -50] }, { n: 2, eps: [-20, -10] }]);

    env.tmdb.failPaths = ['tv/3007/season/2'];

    const page = env.openFull(a.card);

    page.press();
    env.flush();

    return [env.win.HideWatchedSeries.cache()[3007].reason, env.updates.length, env.continueTitles(), /Не загрузились сезоны: 2/.test(env.noty[env.noty.length - 1])];
});

check('M6a', 'Ошибка получения сериала: ничего не записано, сообщение об ошибке', [0, 'Не удалось отметить серии: нет связи с TMDB'], () => {
    const env = fresh();
    const a = env.addShow(3008, 'Details Fail', [{ n: 1, eps: [-30] }]);

    env.tmdb.fail = true;

    const page = env.openFull(a.card);

    page.press();
    env.flush();

    return [env.updates.length, env.noty[env.noty.length - 1]];
});

check('M6b', 'Все сезоны не загрузились — ошибка, а не успех', ['error', 'Не удалось отметить серии: не загрузились сезоны (сезоны 1)'], () => {
    const env = fresh();
    const a = env.addShow(3021, 'All Seasons Fail', [{ n: 1, eps: [-30] }]);
    let res;

    env.tmdb.failPaths = ['tv/3021/season'];
    env.win.HideWatchedSeries.markAllAired(a.card, (r) => { res = r; });
    env.flush();

    return [res.status, env.win.HideWatchedSeries.markMessage(res)];
});

check('M7', 'Повторное нажатие во время операции: «уже выполняется», серии записаны один раз', [true, 'Отметка серий уже выполняется, подождите', 2, false], () => {
    const env = asyncEnv();
    const a = env.addShow(3009, 'Double', [{ n: 1, eps: [-30, -20] }]);
    const page = env.openFull(a.card);

    page.press();

    const busy = page.root.find('.button--hws-mark').hasClass('hws-mark--busy');

    page.press();

    const second = env.noty[env.noty.length - 1];

    env.flush();

    return [busy, second, env.updates.length, page.root.find('.button--hws-mark').hasClass('hws-mark--busy')];
});

check('M8', 'Кнопка: есть у сериала (новый и старый интерфейс), перед «…», нет у фильма, без дублей', [true, true, 2, 0, 1], () => {
    const env = fresh();
    const a = env.addShow(3010, 'Button', [{ n: 1, eps: [-30] }]);
    const pageNew = env.openFull(a.card);
    const pageOld = env.openFull(a.card, true);
    const movie = env.openFull({ id: 27205, source: 'tmdb', title: 'Inception', original_title: 'Inception', release_date: '2010-07-15' });

    // повторное событие complite на той же странице
    env.Lampa.Listener.send('full', { type: 'complite', object: { activity: { render: () => pageNew.root } }, data: { movie: a.card } });

    return [
        /Отметить все вышедшие серии просмотренными/.test(pageNew.button.nodes[0].html),
        pageOld.button.length === 1,
        pageNew.button.index(),
        movie.button.length,
        pageNew.root.find('.button--hws-mark').length
    ];
});

check('M9', 'Досмотренная серия не перезаписана, частично просмотренная доведена до 100%', [[100, 1234], [100], 1, 1], () => {
    const env = fresh();
    const a = env.addShow(3011, 'Keep', [{ n: 1, eps: [-30, -20] }]);

    env.timeline[epHash('Keep', 1, 1)] = { percent: 100, time: 1234, duration: 1300 };
    env.timeline[epHash('Keep', 1, 2)] = { percent: 40, time: 500, duration: 1300 };

    let res;

    env.win.HideWatchedSeries.markAllAired(a.card, (r) => { res = r; });
    env.flush();

    const e1 = env.timeline[epHash('Keep', 1, 1)];

    return [[e1.percent, e1.time], [env.timeline[epHash('Keep', 1, 2)].percent], res.marked, res.already];
});

check('M10', 'После отметки сериал сразу скрыт; главная и «Сериалы» получили refresh, страница сериала — нет', [['Mark Me', 'Neighbour'], ['Neighbour'], 1, 1, 0], () => {
    const env = fresh();
    const main = env.pushActivity('main');
    const tv = env.pushActivity('category');
    const a = env.addShow(3012, 'Mark Me', [{ n: 1, eps: [-30, -20] }, { n: 2, eps: [-10] }]);

    env.addShow(3013, 'Neighbour', [{ n: 1, eps: [-30] }]);

    const before = settle(env);
    const page = env.openFull(a.card);

    page.press();
    env.flush();

    const full = env.Lampa.Activity.stack[env.Lampa.Activity.stack.length - 1];

    return [before, env.continueTitles(), main.refreshed, tv.refreshed, full.refreshed];
});

check('M11', 'Новая серия после массовой отметки не отмечена — сериал возвращается, после просмотра снова скрыт', [[], ['Weekly Mark'], 0, []], () => {
    const env = fresh();
    const a = env.addShow(3014, 'Weekly Mark', [{ n: 1, eps: [-21, -14, -7, 0, 7] }]);

    env.win.HideWatchedSeries.markAllAired(a.card);
    env.flush();

    const hidden = env.continueTitles();

    env.advance(8);

    const back = env.continueTitles();
    const ep5 = (env.timeline[epHash('Weekly Mark', 1, 5)] || { percent: 0 }).percent;

    env.watch(a.card, 1, 5, 100);
    env.flush();

    return [hidden, back, ep5, settle(env)];
});

check('M11a', 'Повторная массовая отметка после выхода серии отмечает только новую', [1, 4], () => {
    const env = fresh();
    const a = env.addShow(3015, 'Again', [{ n: 1, eps: [-21, -14, -7, 0, 7] }]);

    env.win.HideWatchedSeries.markAllAired(a.card);
    env.flush();
    env.advance(8);

    let res;

    env.win.HideWatchedSeries.markAllAired(a.card, (r) => { res = r; });
    env.flush();

    return [res.marked, res.already];
});

check('M12', 'Фоновая проверка в очереди одновременно с отметкой — итог «досмотрен», сериал скрыт', ['complete', []], () => {
    const env = asyncEnv();
    const a = env.addShow(3016, 'Race', [{ n: 1, eps: [-30, -20] }]);

    // строка построена → проверка поставлена в очередь и ждёт ответа TMDB
    env.continueTitles();
    env.win.HideWatchedSeries.markAllAired(a.card);
    env.flush();

    return [env.win.HideWatchedSeries.cache()[3016].status, env.continueTitles()];
});

check('M13', '3.x: отметка скрывает сериал на главной', [[], 'ok'], () => {
    const env = createEnv({ version: '3.x' });

    env.install();
    env.flush();

    const a = env.addShow(3017, 'Rows Mark', [{ n: 1, eps: [-30] }, { n: 2, eps: [-10, 5] }]);

    let res;

    env.win.HideWatchedSeries.markAllAired(a.card, (r) => { res = r; });
    env.flush();

    return [env.continueTitles('main', {}), res.status];
});

check('M14', 'Спецвыпуски (сезон 0) не отмечаются', [false, 2], () => {
    const env = fresh();
    const a = env.addShow(3018, 'Specials Mark', [{ n: 0, eps: [-90, -80] }, { n: 1, eps: [-30, -20] }]);

    env.win.HideWatchedSeries.markAllAired(a.card);
    env.flush();

    return [env.updates.some((u) => u.hash === epHash('Specials Mark', 0, 1)), env.updates.length];
});

check('M15', 'Сообщение об успехе содержит количество', 'Отмечено просмотренными: 5 серий, будущие не отмечены: 1, без даты выхода пропущено: 1', () => {
    const env = fresh();
    const a = env.addShow(3019, 'Message', [{ n: 1, eps: [-60, -53, -46] }, { n: 2, eps: [-14, -7, 7, null] }]);

    env.openFull(a.card).press();
    env.flush();

    return env.noty[env.noty.length - 1];
});

check('M16', 'original_title ≠ original_name: записаны оба хеша Lampa', [true, true], () => {
    const env = fresh();
    const a = env.addShow(3020, 'Kaamelott', [{ n: 1, eps: [-30] }], { card: { original_title: 'Kaamelott (FR)' } });

    env.win.HideWatchedSeries.markAllAired(a.card);
    env.flush();

    return [env.timeline[epHash('Kaamelott (FR)', 1, 1)].percent === 100, env.timeline[epHash('Kaamelott', 1, 1)].percent === 100];
});

/* ---------------- Чистая логика ---------------- */
check('C1', 'evaluate: нет last_episode_to_air — unknown', 'unknown', () => {
    const now = Date.now();
    const d = (o) => require('./harness').ymd(now + o * DAY);

    return Core.evaluate({ seasons: [{ season_number: 1, air_date: d(-10) }] }, { 1: { episodes: [{ episode_number: 1, air_date: d(-10) }] } }, now, () => true).status;
});

check('C2', 'shouldHide: результат старше 7 дней не используется', false, () => {
    const now = Date.now();

    return Core.shouldHide({ status: 'complete', checked: now - Core.HARD_TTL - 1, req: { 1: [1] }, nextAir: 0 }, now, () => true, []);
});

check('C3', 'parseAirDate: некорректные даты → NaN', [true, true, true], () => [isNaN(Core.parseAirDate('')), isNaN(Core.parseAirDate(null)), isNaN(Core.parseAirDate('soon'))]);

/* ---------------- Отметка «Просмотрено» для фильмов ---------------- */

const asyncChecks = [];

function checkAsync(id, title, expected, fn) {
    asyncChecks.push({ id, title, expected, fn });
}

const MOVIE = { id: 27205, source: 'tmdb', title: 'Начало', original_title: 'Inception', release_date: '2010-07-15', vote_average: 8.4 };
const movie = (extra) => Object.assign({}, MOVIE, extra || {});

async function domEnv(opts) {
    const env = createEnv(Object.assign({ dom: true }, opts || {}));

    env.install();
    env.flush();

    return env;
}

checkAsync('F1', 'Фильм без отметки — плашки нет', [0, false], async () => {
    const env = await domEnv();

    env.line().appendChild(env.makeCard(movie()));
    await env.tick();

    return [env.badges(), env.win.HideWatchedSeries.isMovieWatched(movie())];
});

checkAsync('F2', 'Кнопка на странице фильма ставит отметку: плашка на постере и в каталоге, подпись меняется', [true, 1, 1, 'Снять отметку «Просмотрено»', 'Фильм отмечен как просмотренный', 'Просмотрено'], async () => {
    const env = await domEnv();

    env.line().appendChild(env.makeCard(movie()));
    await env.tick();

    const page = env.openMovie(movie());

    page.press();
    await env.tick();

    const badge = env.document.querySelector('.card .hws-watched-badge');

    return [env.win.HideWatchedSeries.isMovieWatched(movie()), env.badges(env.document.querySelector('.items-line')), page.posterBadges(), page.label(), env.noty[env.noty.length - 1], badge && badge.textContent];
});

checkAsync('F3', 'Повторное нажатие снимает отметку: плашки убраны, запись удалена из хранилища', [false, 0, 0, 'Отметить просмотренным', 'Отметка «Просмотрено» снята', {}], async () => {
    const env = await domEnv();

    env.line().appendChild(env.makeCard(movie()));

    const page = env.openMovie(movie());

    page.press();
    await env.tick();
    page.press();
    await env.tick();

    return [env.win.HideWatchedSeries.isMovieWatched(movie()), env.badges(), page.posterBadges(), page.label(), env.noty[env.noty.length - 1], JSON.parse(env.ls.getItem('hws_movies_watched')).items];
});

checkAsync('F4', 'Отметка сохраняется после перезапуска (новая инициализация с тем же localStorage)', [true, 1, 'Снять отметку «Просмотрено»'], async () => {
    const first = await domEnv();

    first.win.HideWatchedSeries.setMovieWatched(movie(), true);

    const env = await domEnv({ localStorage: first.ls });

    env.line().appendChild(env.makeCard(movie()));
    await env.tick();

    return [env.win.HideWatchedSeries.isMovieWatched(movie()), env.badges(), env.openMovie(movie()).label()];
});

checkAsync('F5', 'Одинаковые названия, разные id и источники не смешиваются; cub и tmdb — один фильм', [['tmdb_27205'], false, true, false, 1], async () => {
    const env = await domEnv();
    const api = env.win.HideWatchedSeries;
    const twin = movie({ id: 99999 });
    const ivi = movie({ source: 'ivi' });
    const line = env.line();

    api.setMovieWatched(movie(), true);
    [movie(), twin, ivi].forEach((c) => line.appendChild(env.makeCard(c)));
    await env.tick();

    return [Object.keys(JSON.parse(env.ls.getItem('hws_movies_watched')).items), api.isMovieWatched(twin), api.isMovieWatched(movie({ source: 'cub' })), api.isMovieWatched(ivi), env.badges()];
});

checkAsync('F6', 'Сериалы и персоны не получают отметку фильма, на странице сериала нет кнопки фильма', [0, null, false, 0, null], async () => {
    const env = await domEnv();
    const api = env.win.HideWatchedSeries;
    const tv = { id: 27205, source: 'tmdb', name: 'Сериал', original_name: 'Show', title: 'Сериал', original_title: 'Show', first_air_date: '2020-01-01', number_of_seasons: 1 };
    const person = { id: 27205, source: 'tmdb', name: 'Актёр', title: 'Актёр', gender: 2, profile_path: '/a.jpg' };
    // сериал без original_name (другой источник): признак — number_of_seasons
    const tvBare = { id: 27205, source: 'tmdb', title: 'Начало', original_title: 'Inception', number_of_seasons: 2 };

    api.setMovieWatched(movie(), true);

    const line = env.line();

    line.appendChild(env.makeCard(tv));
    line.appendChild(env.makeCard(person));
    line.appendChild(env.makeCard(tvBare));
    await env.tick();

    const page = env.openMovie(tv);

    return [env.badges(), api.setMovieWatched(tvBare, true), api.isMovieWatched(tv), page.root.querySelectorAll('.button--hws-movie').length, api.setMovieWatched(person, true)];
});

checkAsync('F7', 'Повторный рендер карточки и повторные проходы не дублируют плашки', [1, 1, 1, 2], async () => {
    const env = await domEnv();
    const api = env.win.HideWatchedSeries;
    const line = env.line();
    const el = env.makeCard(movie());

    api.setMovieWatched(movie(), true);
    line.appendChild(el);
    await env.tick();
    api.scanBadges();
    api.scanBadges();

    const once = el.querySelectorAll('.hws-watched-badge').length;

    // карточку убрали и вставили снова (перерисовка строки)
    line.removeChild(el);
    line.appendChild(el);
    await env.tick();

    const again = el.querySelectorAll('.hws-watched-badge').length;

    // лишняя плашка (например, от другого кода) схлопывается до одной
    el.querySelector('.card__view').appendChild(el.querySelector('.hws-watched-badge').cloneNode(true));
    api.scanBadges();

    const collapsed = el.querySelectorAll('.hws-watched-badge').length;

    // новая карточка того же фильма — своя плашка
    line.appendChild(env.makeCard(movie()));
    await env.tick();

    return [once, again, collapsed, env.badges()];
});

checkAsync('F8', 'Прокрутка (подгрузка карточек) и смена раздела: плашки появляются, обработчики не дублируются', [2, 1, 1, 1], async () => {
    const env = await domEnv();
    const api = env.win.HideWatchedSeries;
    const a = movie({ id: 1 });
    const b = movie({ id: 2 });

    api.setMovieWatched(a, true);
    api.setMovieWatched(b, true);

    // повторная загрузка плагина в то же окно
    delete require.cache[require.resolve('../hide_watched_series.js')];
    require('../hide_watched_series.js').install(env.win);

    const line = env.line();

    // прокрутка: карточки подгружаются порциями
    line.appendChild(env.makeCard(movie({ id: 3 })));
    await env.tick();
    line.appendChild(env.makeCard(a));
    line.appendChild(env.makeCard(b));
    await env.tick();

    const afterScroll = env.badges();

    // смена раздела: старая страница удалена, новая построена целиком
    env.document.querySelector('.activitys').innerHTML = '';

    const section = env.document.createElement('div');

    section.className = 'activity';
    section.innerHTML = '<div class="items-line"><div class="scroll__body"></div></div>';
    section.querySelector('.scroll__body').appendChild(env.makeCard(a));
    env.document.querySelector('.activitys').appendChild(section);
    await env.tick();

    return [afterScroll, env.badges(), env.document.querySelectorAll('#hws-style').length, env.Lampa.Listener.count('full')];
});

checkAsync('F9', 'Повреждённые данные хранилища игнорируются, отметка затем работает', [false, false, true, 1], async () => {
    const { memoryStorage } = require('./harness');
    const broken = await domEnv({ localStorage: memoryStorage({ hws_movies_watched: '{broken' }) });
    const wrongShape = await domEnv({ localStorage: memoryStorage({ hws_movies_watched: JSON.stringify({ v: 1, items: [{ id: 27205 }] }) }) });
    const a = broken.win.HideWatchedSeries.isMovieWatched(movie());
    const b = wrongShape.win.HideWatchedSeries.isMovieWatched(movie());

    broken.win.HideWatchedSeries.setMovieWatched(movie(), true);
    broken.line().appendChild(broken.makeCard(movie()));
    await broken.tick();

    return [a, b, JSON.parse(broken.ls.getItem('hws_movies_watched')).items.tmdb_27205 !== undefined, broken.badges()];
});

checkAsync('F10', 'Ошибка записи в localStorage: состояние не меняется, сообщение об ошибке', [false, 'Не удалось сохранить отметку', 0], async () => {
    const env = await domEnv();

    env.ls.setItem = () => { throw new Error('QuotaExceededError'); };

    const page = env.openMovie(movie());

    page.press();
    await env.tick();

    return [env.win.HideWatchedSeries.isMovieWatched(movie()), env.noty[env.noty.length - 1], page.posterBadges()];
});

checkAsync('F11', 'Отметка фильма не трогает сериалы: история, кеш и «Продолжить просмотр» без изменений', [['Series A'], 0, false], async () => {
    const env = await domEnv();
    const s = env.addShow(4001, 'Series A', [{ n: 1, eps: [-30, -20] }]);

    env.watch(s.card, 1, 1, 100);

    const before = settle(env);
    const cacheBefore = JSON.stringify(env.win.HideWatchedSeries.cache());

    env.updates.length = 0;
    env.win.HideWatchedSeries.setMovieWatched(movie(), true);
    await env.tick();

    return [env.continueTitles().filter((t) => before.indexOf(t) >= 0), env.updates.length, JSON.stringify(env.win.HideWatchedSeries.cache()) !== cacheBefore];
});

checkAsync('F12', 'Нет бесконечного цикла: вставка своих плашек не запускает новые проходы', [1, 0], async () => {
    const env = await domEnv();

    env.line().appendChild(env.makeCard(movie()));
    await env.tick();
    env.win.HideWatchedSeries.setMovieWatched(movie(), true);
    await env.tick();
    await env.tick();

    return [env.badges(), env.pending.length];
});

checkAsync('F13', 'Стиль: плашка в правом верхнем углу постера (и у широких карточек), внутри .card__view', [1, true, true], async () => {
    const env = await domEnv();

    env.win.HideWatchedSeries.setMovieWatched(movie(), true);
    env.line().appendChild(env.makeCard(movie(), 'card--wide'));
    await env.tick();

    const css = env.document.getElementById('hws-style').textContent;
    const badge = env.document.querySelector('.hws-watched-badge');

    return [env.badges(), /\.hws-watched-badge\{position:absolute;top:\.5em;right:\.5em;/.test(css) && css.indexOf('bottom:') === -1, badge.parentNode.className === 'card__view'];
});

checkAsync('F14', 'Значки закладок вверху: плашка опускается под них, без значков — в самом углу; следит за изменениями', [false, true, false, 1], async () => {
    const env = await domEnv();
    const el = env.makeCard(movie());
    const badge = () => el.querySelector('.hws-watched-badge');
    const low = () => badge().className.indexOf('hws-watched-badge--low') !== -1;

    env.win.HideWatchedSeries.setMovieWatched(movie(), true);
    env.line().appendChild(el);
    await env.tick();

    const plain = low();

    // Lampa добавила значок «Избранное» (card/module/favorite.js → addicon)
    const icon = env.document.createElement('div');

    icon.className = 'card__icon icon--book';
    el.querySelector('.card__icons-inner').appendChild(icon);
    await env.tick();

    const withIcon = low();

    // значки очищены (innerHTML = '') — новых узлов нет, только удаление
    el.querySelector('.card__icons-inner').innerHTML = '';
    await env.tick();

    return [plain, withIcon, low(), el.querySelectorAll('.hws-watched-badge').length];
});

/* ---------------- Плашка «Просмотрено» у завершённых сериалов ---------------- */

function finishedShow(env, id, status, seasons, extra) {
    const added = env.addShow(id, 'Show' + id, seasons || [{ n: 1, eps: [-30, -20] }, { n: 2, eps: [-10] }], extra);

    added.show.patchDetails = (d) => { if (status) d.status = status; };

    return added;
}

checkAsync('W1', 'Завершённый сериал, все серии досмотрены: плашка в каталоге и на постере страницы', [1, 1, 'Просмотрено', true], async () => {
    const env = await domEnv();
    const a = finishedShow(env, 501, 'Ended');

    env.watchAll(a.card, a.show);
    env.line().appendChild(env.makeCard(a.card));
    await env.tick();

    const page = env.openMovie(a.card);

    await env.tick();

    return [env.badges(env.document.querySelector('.items-line')), page.posterBadges(), env.document.querySelector('.hws-watched-badge').textContent, env.win.HideWatchedSeries.isSeriesFinished(a.card)];
});

checkAsync('W2', 'Отменённый сериал считается завершённым, в том числе вне истории просмотра', [1], async () => {
    const env = await domEnv();
    const a = finishedShow(env, 502, 'Canceled', null, { notInHistory: true });

    env.watchAll(a.card, a.show);
    env.line().appendChild(env.makeCard(a.card));
    await env.tick();

    return [env.badges()];
});

checkAsync('W3', 'Идущий сериал, всё досмотрено: скрывается, но плашки нет', [0, 'complete', false], async () => {
    const env = await domEnv();
    const a = finishedShow(env, 503, 'Returning Series');

    env.watchAll(a.card, a.show);
    env.line().appendChild(env.makeCard(a.card));
    await env.tick();

    const api = env.win.HideWatchedSeries;

    return [env.badges(), api.cache()[503].status, api.cache()[503].ended];
});

checkAsync('W4', 'Завершённый сериал, не все серии досмотрены: плашки нет', [0, 'incomplete'], async () => {
    const env = await domEnv();
    const a = finishedShow(env, 504, 'Ended');

    env.watchAll(a.card, a.show, 100, (s, e) => !(s === 1 && e === 2));
    env.line().appendChild(env.makeCard(a.card));
    await env.tick();

    return [env.badges(), env.win.HideWatchedSeries.cache()[504].status];
});

checkAsync('W5', 'Сериал, который не начинали смотреть: запросов в TMDB нет', [0, 0], async () => {
    const env = await domEnv();
    const a = finishedShow(env, 505, 'Ended', null, { notInHistory: true });

    env.line().appendChild(env.makeCard(a.card));
    await env.tick();

    return [env.badges(), env.tmdb.log.length];
});

checkAsync('W6', 'Статус «завершён», но есть будущая серия или серия без даты: плашки нет', [0, 0], async () => {
    const env = await domEnv();
    const future = finishedShow(env, 506, 'Ended', [{ n: 1, eps: [-30, 10] }]);
    const undated = finishedShow(env, 507, 'Ended', [{ n: 1, eps: [-30, null] }]);

    env.watchAll(future.card, future.show);
    env.watchAll(undated.card, undated.show);

    const line = env.line();

    line.appendChild(env.makeCard(future.card));
    await env.tick();

    const first = env.badges();

    line.appendChild(env.makeCard(undated.card));
    await env.tick();

    return [first, env.badges()];
});

checkAsync('W7', 'Снятие отметки с серии убирает плашку без перезагрузки', [1, 0], async () => {
    const env = await domEnv();
    const a = finishedShow(env, 508, 'Ended');

    env.watchAll(a.card, a.show);
    env.line().appendChild(env.makeCard(a.card));
    await env.tick();

    const before = env.badges();

    env.watch(a.card, 1, 2, 10);
    await env.tick();

    return [before, env.badges()];
});

checkAsync('W8', 'Массовая отметка завершённого сериала сразу даёт плашку', [0, 1, 'ok'], async () => {
    const env = await domEnv();
    const a = finishedShow(env, 509, 'Ended');

    env.line().appendChild(env.makeCard(a.card));
    await env.tick();

    const before = env.badges();
    let status = null;

    env.win.HideWatchedSeries.markAllAired(a.card, (r) => { status = r.status; });
    await env.tick();

    return [before, env.badges(), status];
});

checkAsync('W9', 'Запись старой версии без статуса перепроверяется и получает плашку', [true, true, 1], async () => {
    const env = await domEnv();
    const a = finishedShow(env, 510, 'Ended');
    const api = env.win.HideWatchedSeries;

    env.watchAll(a.card, a.show);
    env.line().appendChild(env.makeCard(a.card));
    await env.tick();

    delete api.cache()[510].ended;

    const before = env.tmdb.log.length;

    api.scanBadges();
    await env.tick();

    return [env.tmdb.log.length > before, api.cache()[510].ended, env.badges()];
});

checkAsync('W10', 'Без сети старая запись не перезапрашивается при каждой отрисовке', [1], async () => {
    const env = await domEnv();
    const a = finishedShow(env, 511, 'Ended');
    const api = env.win.HideWatchedSeries;

    env.watchAll(a.card, a.show);
    env.line().appendChild(env.makeCard(a.card));
    await env.tick();

    delete api.cache()[511].ended;
    env.tmdb.fail = true;

    const before = env.tmdb.log.length;

    api.scanBadges();
    await env.tick();
    api.scanBadges();
    await env.tick();
    api.scanBadges();
    await env.tick();

    return [env.tmdb.log.length - before];
});

checkAsync('W11', 'Аниме без включённой настройки плашку не получает', [0, 0], async () => {
    const env = await domEnv();
    const a = finishedShow(env, 512, 'Ended', null, { lang: 'ja' });

    env.watchAll(a.card, a.show);
    env.line().appendChild(env.makeCard(a.card));
    await env.tick();

    return [env.badges(), env.tmdb.log.filter((p) => p.indexOf('tv/512') === 0).length];
});

/* ---------------- «Продолжить» с последнего торрента ---------------- */

const SERIES = { id: 247718, source: 'tmdb', name: 'MobLand', original_name: 'MobLand', original_title: 'MobLand', first_air_date: '2025-03-30', number_of_seasons: 2, img: 'poster.jpg' };
const series = (extra) => Object.assign({}, SERIES, extra || {});
const TORRENT = { title: 'MobLand S01-02 WEB-DL 1080p', Title: 'MobLand S01-02 WEB-DL 1080p', MagnetUri: 'magnet:?xt=urn:btih:ABC123', Link: 'http://jackett/dl/1' };

// Список файлов как в interaction/torrent.js list(): list_open → render ×N; serverHash — хеш TorrServer
function torrentList(env, files, serverHash) {
    env.Lampa.Listener.send('torrent_file', { type: 'list_open', items: files });

    return files.map((f) => {
        const element = { season: f[0], episode: f[1], timeline: { percent: f[2] || 0 }, torrent_hash: serverHash || 'srvhash', card: f[3] || series() };
        const item = { name: 's' + f[0] + 'e' + f[1] };

        env.Lampa.Listener.send('torrent_file', { type: 'render', element, item, items: files });

        return { element, item };
    });
}

// Пользователь выбрал раздачу (components/torrents.js → Torrent.start) и запустил серию
function playFromTorrent(env, card, s, e, torrent) {
    env.Lampa.Torrent.start(torrent || TORRENT, card);

    const rendered = torrentList(env, [[s, e, 0, card]]);

    env.Lampa.Listener.send('torrent_file', { type: 'onenter', element: rendered[0].element, item: rendered[0].item });
}

check('T1', 'Запуск серии из раздачи запоминает раздачу, сезон, серию и хеш', { title: TORRENT.title, magnet: TORRENT.MagnetUri, link: TORRENT.Link, hash: 'srvhash', season: 2, episode: 6 }, () => {
    const env = fresh();

    playFromTorrent(env, series(), 2, 6);

    const r = env.win.HideWatchedSeries.torrentRecord(series());

    return { title: r.title, magnet: r.magnet, link: r.link, hash: r.hash, season: r.season, episode: r.episode };
});

check('T1a', 'Только открыли список файлов без запуска серии — ничего не запоминается', null, () => {
    const env = fresh();

    env.Lampa.Torrent.start(TORRENT, series());
    torrentList(env, [[2, 6, 0]]);

    return env.win.HideWatchedSeries.torrentRecord(series());
});

check('T2', 'Кнопка «Продолжить» на странице сериала сразу после «Смотреть», с последней серией', [1, 1, 'Продолжить: последняя серия 2×06'], () => {
    const env = fresh();

    playFromTorrent(env, series(), 2, 6);

    const page = env.openFull(series());
    const btn = page.root.find('.button--hws-continue');

    return [btn.length, btn.index(), /<span>([^<]+)<\/span>/.exec(btn.nodes[0].html)[1]];
});

check('T2a', 'Без сохранённой раздачи кнопки нет; у фильма кнопки нет', [0, 0], () => {
    const env = fresh();

    playFromTorrent(env, series(), 2, 6);

    const other = env.openFull(series({ id: 1396, name: 'Breaking Bad', original_name: 'Breaking Bad', original_title: 'Breaking Bad' }));
    const film = env.openFull({ id: 247718, source: 'tmdb', title: 'MobLand', original_title: 'MobLand', release_date: '2020-01-01' });

    return [other.root.find('.button--hws-continue').length, film.root.find('.button--hws-continue').length];
});

check('T3', 'Нажатие открывает ту же раздачу через Torrent.start с magnet и сериалом', ['start', 'magnet:?xt=urn:btih:ABC123', 'http://jackett/dl/1', 'MobLand S01-02 WEB-DL 1080p', 247718], () => {
    const env = fresh();

    playFromTorrent(env, series(), 2, 6);
    env.Lampa.Torrent.calls.length = 0;

    env.openFull(series()).root.find('.button--hws-continue').trigger('hover:enter');

    const c = env.Lampa.Torrent.calls[0];

    return [c.fn, c.element.MagnetUri, c.element.Link, c.element.title, c.movie.id];
});

check('T4', 'Курсор на следующую серию: после последней досмотренной — первая недосмотренная', ['s2e7', 'modal-scroll'], () => {
    const env = fresh();

    playFromTorrent(env, series(), 2, 6);
    env.Lampa.Controller.focus.length = 0;
    env.win.HideWatchedSeries.continueTorrent(series());

    // файлы в произвольном порядке, два сезона
    torrentList(env, [[2, 8, 0], [1, 10, 100], [2, 7, 0], [2, 5, 100], [2, 6, 95], [1, 9, 100]]);
    env.flush();

    const f = env.Lampa.Controller.focus[0];

    return [f.target.name, f.scroll];
});

check('T4a', 'Последняя серия досмотрена частично — курсор на неё (продолжить с места)', 's2e6', () => {
    const env = fresh();

    playFromTorrent(env, series(), 2, 6);
    env.Lampa.Controller.focus.length = 0;
    env.win.HideWatchedSeries.continueTorrent(series());
    torrentList(env, [[2, 5, 100], [2, 6, 50], [2, 7, 0]]);
    env.flush();

    return env.Lampa.Controller.focus[0].target.name;
});

check('T4b', 'Пропущенная в середине серия не сбивает: курсор после последней досмотренной', 's1e5', () => {
    const env = fresh();

    playFromTorrent(env, series(), 1, 4);
    env.Lampa.Controller.focus.length = 0;
    env.win.HideWatchedSeries.continueTorrent(series());
    torrentList(env, [[1, 1, 100], [1, 2, 0], [1, 3, 100], [1, 4, 100], [1, 5, 0]]);
    env.flush();

    return env.Lampa.Controller.focus[0].target.name;
});

check('T4c', 'Всё в раздаче досмотрено — курсор на последнюю серию', 's1e3', () => {
    const env = fresh();

    playFromTorrent(env, series(), 1, 3);
    env.Lampa.Controller.focus.length = 0;
    env.win.HideWatchedSeries.continueTorrent(series());
    torrentList(env, [[1, 1, 100], [1, 2, 100], [1, 3, 100]]);
    env.flush();

    return env.Lampa.Controller.focus[0].target.name;
});

check('T5', 'Обычный путь «Смотреть» → раздача: курсор плагин не трогает', 0, () => {
    const env = fresh();

    playFromTorrent(env, series(), 2, 6);
    env.Lampa.Controller.focus.length = 0;
    env.Lampa.Torrent.start(TORRENT, series());
    torrentList(env, [[2, 6, 100], [2, 7, 0]]);
    env.flush();

    return env.Lampa.Controller.focus.length;
});

check('T5a', 'Курсор ставится один раз: после закрытия списка и повторного открытия — нет', [1, 1], () => {
    const env = fresh();

    playFromTorrent(env, series(), 2, 6);
    env.Lampa.Controller.focus.length = 0;
    env.win.HideWatchedSeries.continueTorrent(series());
    torrentList(env, [[2, 6, 100], [2, 7, 0]]);
    env.flush();

    const first = env.Lampa.Controller.focus.length;

    env.Lampa.Listener.send('torrent_file', { type: 'list_close' });
    torrentList(env, [[2, 6, 100], [2, 7, 0]]);
    env.flush();

    return [first, env.Lampa.Controller.focus.length];
});

check('T5b', 'Список файлов пришёл позже 2 минут после нажатия — курсор не ставится', 0, () => {
    const env = fresh();

    playFromTorrent(env, series(), 2, 6);
    env.Lampa.Controller.focus.length = 0;
    env.win.HideWatchedSeries.continueTorrent(series());
    env.advance(3 / 24 / 60);
    torrentList(env, [[2, 6, 100], [2, 7, 0]]);
    env.flush();

    return env.Lampa.Controller.focus.length;
});

check('T6', 'Раздача открыта из «Моих торрентов» (без Torrent.start): запоминается хеш, повтор через Torrent.open', ['open', 'myhash', 247718], () => {
    const env = fresh();
    const rendered = torrentList(env, [[2, 6, 0]], 'myhash');

    env.Lampa.Listener.send('torrent_file', { type: 'onenter', element: rendered[0].element, item: rendered[0].item });
    env.Lampa.Torrent.calls.length = 0;
    env.win.HideWatchedSeries.continueTorrent(series());

    const c = env.Lampa.Torrent.calls[0];

    return [c.fn, c.hash, c.movie.id];
});

check('T6a', 'Тот же хеш без Torrent.start: magnet из прошлой записи сохраняется', 'magnet:?xt=urn:btih:ABC123', () => {
    const env = fresh();

    playFromTorrent(env, series(), 2, 6);
    env.advance(1);

    const rendered = torrentList(env, [[2, 7, 0]], 'srvhash');

    env.Lampa.Listener.send('torrent_file', { type: 'onenter', element: rendered[0].element, item: rendered[0].item });

    return env.win.HideWatchedSeries.torrentRecord(series()).magnet;
});

check('T7', 'Раздача другого сериала или устаревший запуск (> 6 ч) не приписываются', ['', ''], () => {
    const env = fresh();
    const other = series({ id: 1396, name: 'Breaking Bad', original_name: 'Breaking Bad', original_title: 'Breaking Bad' });

    // выбрали раздачу у другого сериала, а запустили серию MobLand
    env.Lampa.Torrent.start(TORRENT, other);

    let r = torrentList(env, [[2, 6, 0]], 'h1');

    env.Lampa.Listener.send('torrent_file', { type: 'onenter', element: r[0].element });

    const a = env.win.HideWatchedSeries.torrentRecord(series()).magnet || '';

    // запуск давно
    const env2 = fresh();

    env2.Lampa.Torrent.start(TORRENT, series());
    env2.advance(0.3);
    r = torrentList(env2, [[2, 6, 0]], 'h2');
    env2.Lampa.Listener.send('torrent_file', { type: 'onenter', element: r[0].element });

    return [a, env2.win.HideWatchedSeries.torrentRecord(series()).magnet || ''];
});

check('T8', 'Фильм из торрента не запоминается; серия без номера — тоже', [null, null], () => {
    const env = fresh();
    const film = { id: 27205, source: 'tmdb', title: 'Inception', original_title: 'Inception', release_date: '2010-07-15' };

    env.Lampa.Torrent.start(TORRENT, film);

    let r = torrentList(env, [[0, 0, 0, film]]);

    env.Lampa.Listener.send('torrent_file', { type: 'onenter', element: r[0].element });

    r = torrentList(env, [[1, 0, 0]]);
    env.Lampa.Listener.send('torrent_file', { type: 'onenter', element: r[0].element });

    return [env.win.HideWatchedSeries.torrentRecord(film), env.win.HideWatchedSeries.torrentRecord(series())];
});

check('T9', 'Сохраняется после перезапуска; повреждённые данные игнорируются', [true, null], () => {
    const first = fresh();

    playFromTorrent(first, series(), 2, 6);

    const again = createEnv({ localStorage: first.ls });

    again.install();
    again.flush();

    const broken = createEnv({ localStorage: memoryStorage({ hws_torrents: '{oops' }) });

    broken.install();
    broken.flush();

    return [again.win.HideWatchedSeries.torrentRecord(series()).magnet === TORRENT.MagnetUri, broken.win.HideWatchedSeries.torrentRecord(series())];
});

check('T10', 'Повторная загрузка: Torrent.start обёрнут один раз, обработчик torrent_file один', [true, 1], () => {
    const env = createEnv();

    env.install();
    delete require.cache[require.resolve('../hide_watched_series.js')];
    require('../hide_watched_series.js').install(env.win);
    env.flush();

    const fn = env.Lampa.Torrent.start;

    return [typeof fn.__hws === 'function' && !fn.__hws.__hws, env.Lampa.Listener.count('torrent_file')];
});

check('T11', 'Запуск через обёртку передаёт аргументы в Lampa без изменений', [1, 'start', 247718], () => {
    const env = fresh();

    env.Lampa.Torrent.start(TORRENT, series());

    const c = env.Lampa.Torrent.calls;

    return [c.length, c[0].fn, c[0].movie.id];
});

/* ---------------- Отчёт ---------------- */
async function runAsyncChecks() {
    for (const c of asyncChecks) {
        let actual;

        try {
            actual = await c.fn();
        } catch (e) {
            actual = 'EXCEPTION: ' + e.message;
        }

        const exp = JSON.stringify(c.expected);
        const act = JSON.stringify(actual);

        results.push({ id: c.id, title: c.title, expected: exp, actual: act, pass: exp === act });
    }
}

runAsyncChecks().then(report);

function report() {
const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
const lines = [];

lines.push('# Результаты автотестов hide_watched_series');
lines.push('');
lines.push('Запуск: `node tests/run.js`, Node ' + process.version + ', ' + new Date().toISOString());
lines.push('');
lines.push('**Всего: ' + results.length + ', успешно: ' + passed + ', неуспешно: ' + failed + '**');
lines.push('');
lines.push('| № | Проверка | Ожидаемый результат | Фактический результат | Итог |');
lines.push('|---|---|---|---|---|');

results.forEach((r) => {
    const esc = (s) => s.replace(/\|/g, '\\|');

    lines.push('| ' + r.id + ' | ' + esc(r.title) + ' | `' + esc(r.expected) + '` | `' + esc(r.actual) + '` | ' + (r.pass ? 'OK' : '**FAIL**') + ' |');
});

fs.writeFileSync(path.join(__dirname, 'results.md'), lines.join('\n') + '\n');

results.forEach((r) => {
    console.log((r.pass ? 'OK  ' : 'FAIL') + ' [' + r.id + '] ' + r.title + '\n      ожидалось: ' + r.expected + '\n      получено:  ' + r.actual);
});

console.log('\nВсего: ' + results.length + ', успешно: ' + passed + ', неуспешно: ' + failed);

process.exit(failed ? 1 : 0);
}
