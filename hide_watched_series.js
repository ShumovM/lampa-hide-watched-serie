/*!
 * Lampa plugin «Убирать просмотренные сериалы» (hide_watched_series)
 * Версия 1.2.0
 *
 * Убирает из строки «Продолжить просмотр» сериалы, у которых все вышедшие серии
 * досмотрены, и возвращает их, как только выходит новая непросмотренная серия.
 * На странице сериала добавляет кнопку «Отметить все вышедшие серии просмотренными».
 * На странице фильма — кнопку «Отметить просмотренным» и зелёную плашку на постере.
 *
 * Целевая платформа: Lampa 2.3.0 (LG webOS). Дополнительно поддерживается
 * ветка 3.x, где строка строится через Lampa.ContentRows.
 * Код написан на ES5 (без стрелочных функций, let/const, Promise,
 * Array.prototype.find/includes) для старых движков webOS.
 */
(function (root) {
    'use strict';

    var VERSION = '1.2.0';
    var LOG_TAG = 'HideWatched';

    var CACHE_KEY = 'hws_cache';
    var CACHE_VERSION = 1;
    var CACHE_LIMIT = 300;

    var HOUR = 60 * 60 * 1000;
    var DAY = 24 * HOUR;

    // Сколько доверять результату «всё досмотрено» без перепроверки в TMDB
    var SOFT_TTL = 6 * HOUR;
    // Дальше этого срока результат вообще не используется для скрытия
    var HARD_TTL = 7 * DAY;
    // Повторная проверка сериала, у которого есть непросмотренные серии
    var INCOMPLETE_TTL = 6 * HOUR;
    // Повторная попытка после ошибки или недостатка данных
    var RETRY_TTL = 15 * 60 * 1000;
    var REQUEST_TIMEOUT = 20000;

    var SETTINGS = {
        enabled: 'hws_enabled',
        anime: 'hws_anime',
        threshold: 'hws_threshold',
        debug: 'hws_debug'
    };

    var DEFAULT_THRESHOLD = 90;

    // Та же проверка, что Utils.containsJapanese в Lampa 3.x
    var JAPANESE_RE = /[぀-ヿㇰ-ㇿｦ-ﾟ一-鿿]/;

    /* ======================================================================
     * Core — чистая логика без обращения к Lampa (тестируется отдельно)
     * ==================================================================== */

    function isArray(value) {
        return Object.prototype.toString.call(value) === '[object Array]';
    }

    function toInt(value) {
        var n = parseInt(value, 10);

        return isNaN(n) ? NaN : n;
    }

    /**
     * Копия Lampa.Utils.hash (src/utils/math.js в 2.3.0, src/utils/utils.js в 3.x)
     */
    function hashString(input) {
        var str = (input || '') + '';
        var hash = 0;

        if (str.length === 0) return hash + '';

        for (var i = 0; i < str.length; i++) {
            hash = ((hash << 5) - hash) + str.charCodeAt(i);
            hash = hash & hash;
        }

        return Math.abs(hash) + '';
    }

    /**
     * Строка, из которой Lampa строит хеш серии:
     * [season, season > 10 ? ':' : '', episode, original_title].join('')
     */
    function episodeKey(season, episode, title) {
        return [season, season > 10 ? ':' : '', episode, title].join('');
    }

    /**
     * Дата выхода в формате TMDB (YYYY-MM-DD) → полночь по местному времени,
     * как Lampa.Utils.parseToDate. Некорректная дата → NaN.
     */
    function parseAirDate(str) {
        if (typeof str !== 'string') return NaN;

        var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(str);

        if (!m) return NaN;

        var time = new Date(toInt(m[1]), toInt(m[2]) - 1, toInt(m[3])).getTime();

        return isNaN(time) ? NaN : time;
    }

    function isTvCard(card) {
        return Boolean(card && (card.number_of_seasons || card.first_air_date));
    }

    function isAnimeCard(card) {
        if (!card) return false;

        return card.original_language === 'ja' || JAPANESE_RE.test(card.original_name || card.name || '');
    }

    /**
     * Названия, под которыми Lampa и плагины онлайн-просмотра сохраняют
     * прогресс серий: original_title (для сериалов карточка Lampa копирует туда
     * original_name) и original_name.
     */
    function titleCandidates(card) {
        var list = [];
        var fields = ['original_title', 'original_name'];

        for (var i = 0; i < fields.length; i++) {
            var value = card ? card[fields[i]] : '';

            if (typeof value === 'string' && value.length && list.indexOf(value) === -1) list.push(value);
        }

        return list;
    }

    function validEpisodeRef(ep) {
        return Boolean(ep && toInt(ep.season_number) >= 0 && toInt(ep.episode_number) >= 1);
    }

    function reqHas(req, season, episode) {
        var list = req[season];

        return Boolean(list && list.indexOf(episode) !== -1);
    }

    function sortedNumbers(list) {
        return list.slice().sort(function (a, b) {
            return a - b;
        });
    }

    /**
     * Какие сезоны нужно загрузить для проверки.
     * @returns {{status:string, reason?:string, seasons?:number[], last?:{season:number,episode:number}, nextAir:number}}
     */
    function planSeasons(details, now) {
        var result = {
            status: 'ok',
            seasons: [],
            last: null,
            nextAir: 0
        };

        function noteFuture(time) {
            if (time > now && (!result.nextAir || time < result.nextAir)) result.nextAir = time;
        }

        if (!details || !isArray(details.seasons) || !details.seasons.length) {
            return { status: 'unknown', reason: 'no_seasons', nextAir: 0 };
        }

        var regular = [];
        var maxAired = 0;

        for (var i = 0; i < details.seasons.length; i++) {
            var season = details.seasons[i] || {};
            var number = toInt(season.season_number);

            // Нулевой сезон — спецвыпуски: не учитываются ни для скрытия, ни для показа
            if (!(number >= 1)) continue;

            if (regular.indexOf(number) === -1) regular.push(number);

            var date = parseAirDate(season.air_date);

            if (!isNaN(date)) {
                if (date <= now) maxAired = Math.max(maxAired, number);
                else noteFuture(date);
            }
        }

        if (!regular.length) return { status: 'unknown', reason: 'no_regular_seasons', nextAir: result.nextAir };

        var last = details.last_episode_to_air;

        if (validEpisodeRef(last) && toInt(last.season_number) >= 1) {
            result.last = { season: toInt(last.season_number), episode: toInt(last.episode_number) };
            maxAired = Math.max(maxAired, result.last.season);
        }

        var next = details.next_episode_to_air;

        if (next) noteFuture(parseAirDate(next.air_date));

        if (!maxAired) return { status: 'unknown', reason: 'nothing_aired', nextAir: result.nextAir };

        regular = sortedNumbers(regular);

        for (var j = 0; j < regular.length; j++) {
            if (regular[j] <= maxAired) result.seasons.push(regular[j]);
        }

        // Сначала последние сезоны: непросмотренная серия там вероятнее, проверка короче
        result.seasons.reverse();

        return result;
    }

    /**
     * Есть ли в загруженном сезоне вышедшая непросмотренная серия
     */
    function seasonHasUnwatched(seasonData, seasonNumber, now, isWatched) {
        if (!seasonData || !isArray(seasonData.episodes)) return null;

        for (var i = 0; i < seasonData.episodes.length; i++) {
            var ep = seasonData.episodes[i] || {};
            var number = toInt(ep.episode_number);
            var date = parseAirDate(ep.air_date);

            if (number >= 1 && !isNaN(date) && date <= now && !isWatched(seasonNumber, number)) {
                return { season: seasonNumber, episode: number };
            }
        }

        return null;
    }

    /**
     * Полная проверка сериала.
     * @param {object} details - ответ TMDB tv/{id}
     * @param {object} seasonsData - {номер_сезона: ответ TMDB tv/{id}/season/{n}}
     * @param {number} now - текущее время, мс
     * @param {function(number,number):boolean} isWatched - досмотрена ли серия
     * @returns {{status:'complete'|'incomplete'|'unknown', reason:string, req?:object, count?:number, nextAir:number}}
     */
    function evaluate(details, seasonsData, now, isWatched) {
        var plan = planSeasons(details, now);

        if (plan.status !== 'ok') return { status: 'unknown', reason: plan.reason, nextAir: plan.nextAir };

        var nextAir = plan.nextAir;
        var req = {};
        var count = 0;
        var undatedPending = false;
        var unwatched = null;
        var seasons = sortedNumbers(plan.seasons);

        function noteFuture(time) {
            if (time > now && (!nextAir || time < nextAir)) nextAir = time;
        }

        function unknown(reason) {
            return { status: 'unknown', reason: reason, nextAir: nextAir };
        }

        for (var i = 0; i < seasons.length; i++) {
            var seasonNumber = seasons[i];
            var data = seasonsData ? seasonsData[seasonNumber] : null;

            if (!data || !isArray(data.episodes) || !data.episodes.length) return unknown('season_missing_' + seasonNumber);

            var episodes = data.episodes.slice().sort(function (a, b) {
                return toInt(a && a.episode_number) - toInt(b && b.episode_number);
            });

            for (var j = 0; j < episodes.length; j++) {
                var ep = episodes[j] || {};
                var number = toInt(ep.episode_number);

                if (!(number >= 1)) return unknown('bad_episode_number_s' + seasonNumber);

                var date = parseAirDate(ep.air_date);

                // Серия без даты: считаем ещё не вышедшей, но только если после неё
                // нет вышедших серий — иначе данные противоречивы
                if (isNaN(date)) {
                    undatedPending = true;
                    continue;
                }

                if (date > now) {
                    noteFuture(date);
                    continue;
                }

                if (undatedPending) return unknown('undated_before_aired_s' + seasonNumber + 'e' + number);

                if (!req[seasonNumber]) req[seasonNumber] = [];

                if (req[seasonNumber].indexOf(number) === -1) {
                    req[seasonNumber].push(number);
                    count++;
                }

                if (!unwatched && !isWatched(seasonNumber, number)) unwatched = { season: seasonNumber, episode: number };
            }
        }

        if (!count) return unknown('no_aired_episodes');

        // Сверка с полем TMDB «последняя вышедшая серия»
        if (!plan.last) return unknown('no_last_episode');

        if (!reqHas(req, plan.last.season, plan.last.episode)) return unknown('last_episode_mismatch');

        var next = details.next_episode_to_air;

        if (validEpisodeRef(next) && toInt(next.season_number) >= 1) {
            var nextDate = parseAirDate(next.air_date);

            if (!isNaN(nextDate) && nextDate <= now && !reqHas(req, toInt(next.season_number), toInt(next.episode_number))) {
                return unknown('next_episode_mismatch');
            }
        }

        if (unwatched) {
            return {
                status: 'incomplete',
                reason: 'unwatched_s' + unwatched.season + 'e' + unwatched.episode,
                nextAir: nextAir
            };
        }

        return {
            status: 'complete',
            reason: 'all_watched',
            req: req,
            count: count,
            nextAir: nextAir
        };
    }

    /**
     * Синхронное решение для отрисовки строки по сохранённому результату.
     * Прогресс серий перепроверяется каждый раз по локальной истории,
     * даты выхода — по сохранённому расписанию и локальному расписанию Lampa.
     */
    function shouldHide(entry, now, isWatched, localEpisodes) {
        if (!entry || entry.status !== 'complete' || !entry.req) return false;

        var age = now - entry.checked;

        if (!(age >= -DAY && age <= HARD_TTL)) return false;

        if (entry.nextAir && now >= entry.nextAir) return false;

        var total = 0;

        for (var season in entry.req) {
            if (!Object.prototype.hasOwnProperty.call(entry.req, season)) continue;

            var list = entry.req[season];

            if (!isArray(list)) return false;

            for (var i = 0; i < list.length; i++) {
                total++;

                if (!isWatched(toInt(season), list[i])) return false;
            }
        }

        if (!total) return false;

        if (isArray(localEpisodes)) {
            for (var j = 0; j < localEpisodes.length; j++) {
                var ep = localEpisodes[j] || {};
                var s = toInt(ep.season_number);
                var e = toInt(ep.episode_number);
                var date = parseAirDate(ep.air_date);

                if (s >= 1 && e >= 1 && !isNaN(date) && date <= now && !reqHas(entry.req, s, e) && !isWatched(s, e)) return false;
            }
        }

        return true;
    }

    /**
     * Нужна ли (пере)проверка сериала в TMDB
     */
    function needsCheck(entry, now) {
        if (!entry) return true;

        var age = now - entry.checked;

        if (!(age >= 0)) return true;

        if (entry.status === 'complete') {
            if (entry.nextAir && now >= entry.nextAir) return true;

            return age > SOFT_TTL;
        }

        if (entry.status === 'incomplete') return Boolean(entry.dirty) || age > INCOMPLETE_TTL;

        return age > RETRY_TTL;
    }

    var Core = {
        hashString: hashString,
        episodeKey: episodeKey,
        parseAirDate: parseAirDate,
        isTvCard: isTvCard,
        isAnimeCard: isAnimeCard,
        titleCandidates: titleCandidates,
        planSeasons: planSeasons,
        seasonHasUnwatched: seasonHasUnwatched,
        evaluate: evaluate,
        shouldHide: shouldHide,
        needsCheck: needsCheck,
        SOFT_TTL: SOFT_TTL,
        HARD_TTL: HARD_TTL,
        RETRY_TTL: RETRY_TTL,
        INCOMPLETE_TTL: INCOMPLETE_TTL
    };

    /* ======================================================================
     * Runtime — подключение к Lampa
     * ==================================================================== */

    function install(win, options) {
        options = options || {};

        if (!win || win.__hws_installed) return win ? win.HideWatchedSeries : null;

        win.__hws_installed = true;

        var clock = options.now || function () {
            return Date.now();
        };
        var timers = options.timers || {
            set: function (fn, ms) {
                return setTimeout(fn, ms);
            },
            interval: function (fn, ms) {
                return setInterval(fn, ms);
            }
        };

        var cache = null;
        var queue = [];
        var queued = {};
        var busy = false;
        var network = null;
        var mode = 'none';
        var started = false;
        var categoryDepth = 0;
        var originalContinues = null;
        var warmupTimer = null;
        var stats = { hidden: 0, checks: 0, errors: 0 };
        var marking = null;

        function L() {
            return win.Lampa;
        }

        /* ---------- настройки и журнал ---------- */

        function setting(name, def) {
            try {
                // Без значения по умолчанию: Storage.get в 3.x делает `value || empty`
                // и подменяет сохранённое булево false на значение по умолчанию.
                // Пустой ответ уточняем по localStorage, куда Storage.set пишет строку
                var value = L().Storage.get(name);

                if (value === null || typeof value === 'undefined' || value === '') {
                    var ls = storage();

                    value = ls ? ls.getItem(name) : null;

                    if (value === null || value === '') return def;
                }
                if (value === true || value === 'true') return true;
                if (value === false || value === 'false') return false;

                return value;
            } catch (e) {
                return def;
            }
        }

        function enabled() {
            return setting(SETTINGS.enabled, true) !== false;
        }

        function includeAnime() {
            return setting(SETTINGS.anime, false) === true;
        }

        function threshold() {
            var value = toInt(setting(SETTINGS.threshold, DEFAULT_THRESHOLD));

            return value >= 50 && value <= 100 ? value : DEFAULT_THRESHOLD;
        }

        function debugOn() {
            return setting(SETTINGS.debug, false) === true;
        }

        function log() {
            if (!debugOn()) return;

            try {
                var args = Array.prototype.slice.call(arguments);

                args.unshift(LOG_TAG);
                console.log.apply(console, args);
            } catch (e) {}
        }

        /* ---------- кеш ---------- */

        function storage() {
            try {
                return win.localStorage || null;
            } catch (e) {
                return null;
            }
        }

        function loadCache() {
            if (cache) return cache;

            cache = {};

            try {
                var ls = storage();
                var raw = ls ? ls.getItem(CACHE_KEY) : null;
                var parsed = raw ? JSON.parse(raw) : null;

                if (parsed && parsed.v === CACHE_VERSION && parsed.items && typeof parsed.items === 'object') cache = parsed.items;
            } catch (e) {
                cache = {};
            }

            return cache;
        }

        function saveCache() {
            try {
                var items = loadCache();
                var ids = Object.keys(items);

                if (ids.length > CACHE_LIMIT) {
                    ids.sort(function (a, b) {
                        return (items[a].checked || 0) - (items[b].checked || 0);
                    });

                    for (var i = 0; i < ids.length - CACHE_LIMIT; i++) delete items[ids[i]];
                }

                var ls = storage();

                if (ls) ls.setItem(CACHE_KEY, JSON.stringify({ v: CACHE_VERSION, items: items }));
            } catch (e) {
                log('cache save error', e && e.message);
            }
        }

        function clearCache() {
            cache = {};
            queue = [];
            queued = {};

            try {
                var ls = storage();

                if (ls) ls.removeItem(CACHE_KEY);
            } catch (e) {}

            log('cache cleared');
        }

        /* ---------- история просмотра ---------- */

        function hash(str) {
            try {
                if (L().Utils && typeof L().Utils.hash === 'function') return L().Utils.hash(str);
            } catch (e) {}

            return hashString(str);
        }

        function percentOf(hashValue) {
            try {
                var view = L().Timeline.view(hashValue);
                var percent = view ? parseFloat(view.percent) : 0;

                return isNaN(percent) ? 0 : percent;
            } catch (e) {
                return 0;
            }
        }

        function makeIsWatched(card) {
            var titles = titleCandidates(card);
            var limit = threshold();
            var memo = {};

            return function (season, episode) {
                var key = season + ':' + episode;

                if (Object.prototype.hasOwnProperty.call(memo, key)) return memo[key];

                var best = 0;

                for (var i = 0; i < titles.length && best < limit; i++) {
                    best = Math.max(best, percentOf(hash(episodeKey(season, episode, titles[i]))));
                }

                // Lampa 3.x: поиск прогресса по привязке, если название карточки менялось
                if (best < limit && L().Timeline && typeof L().Timeline.watchedEpisode === 'function') {
                    try {
                        var p = parseFloat(L().Timeline.watchedEpisode(card, season, episode));

                        if (!isNaN(p)) best = Math.max(best, p);
                    } catch (e) {}
                }

                memo[key] = best >= limit;

                return memo[key];
            };
        }

        function localEpisodes(card) {
            try {
                var tt = L().TimeTable;

                if (tt && typeof tt.get === 'function') {
                    var list = tt.get(card);

                    return isArray(list) ? list : [];
                }
            } catch (e) {}

            return [];
        }

        /* ---------- отбор карточек ---------- */

        function eligible(card) {
            if (!card || !isTvCard(card)) return false;
            if (typeof card.id !== 'number' && !/^\d+$/.test(card.id + '')) return false;
            if (card.source && card.source !== 'tmdb' && card.source !== 'cub') return false;
            if (!titleCandidates(card).length) return false;
            if (isAnimeCard(card) && !includeAnime()) return false;

            return true;
        }

        function cardId(card) {
            return toInt(card.id);
        }

        function hideCard(card) {
            if (!eligible(card)) return false;

            var entry = loadCache()[cardId(card)];

            return shouldHide(entry, clock(), makeIsWatched(card), localEpisodes(card));
        }

        /**
         * Фильтр списка строки «Продолжить просмотр». При любой ошибке
         * возвращается исходный список.
         */
        function filterList(list, origin) {
            if (!isArray(list) || !enabled()) return list;

            try {
                var out = [];
                var hidden = [];

                for (var i = 0; i < list.length; i++) {
                    var card = list[i];
                    var hide = false;

                    try {
                        hide = hideCard(card);
                    } catch (e) {
                        hide = false;
                    }

                    if (hide) hidden.push(card.original_name || card.name || card.id);
                    else out.push(card);
                }

                stats.hidden = hidden.length;

                log('row', origin, 'items:', list.length, 'hidden:', hidden.length, hidden.join(' | '));

                scheduleChecks(list);

                return out;
            } catch (e) {
                log('filter error', e && e.message);

                return list;
            }
        }

        /* ---------- запросы к TMDB ---------- */

        function tmdbGet(path, ok, fail) {
            var done = false;
            var timer = timers.set(function () {
                if (done) return;

                done = true;
                fail('timeout');
            }, REQUEST_TIMEOUT);

            function finish(fn, value) {
                if (done) return;

                done = true;

                try {
                    clearTimeout(timer);
                } catch (e) {}

                fn(value);
            }

            try {
                if (options.fetch) return options.fetch(path, function (json) {
                    finish(ok, json);
                }, function (err) {
                    finish(fail, err || 'network');
                });

                var lampa = L();

                if (!network) network = new lampa.Reguest();

                var lang = 'ru';

                try {
                    lang = lampa.Storage.field('tmdb_lang') || lang;
                } catch (e) {}

                var url = lampa.TMDB.api(path + (path.indexOf('?') >= 0 ? '&' : '?') + 'api_key=' + lampa.TMDB.key() + '&language=' + lang);

                if (typeof network.timeout === 'function') network.timeout(REQUEST_TIMEOUT - 2000);

                network.silent(url, function (json) {
                    finish(ok, json);
                }, function () {
                    finish(fail, 'network');
                });
            } catch (e) {
                finish(fail, 'exception: ' + (e && e.message));
            }
        }

        /* ---------- проверка сериала ---------- */

        function store(card, result) {
            var items = loadCache();
            var id = cardId(card);
            var prev = items[id];
            var now = clock();

            if (result.status === 'error') {
                stats.errors++;

                // Ошибка сети не отменяет ранее подтверждённый результат: он остаётся
                // в силе до наступления nextAir или истечения HARD_TTL
                if (prev && prev.status === 'complete') {
                    prev.error = result.reason;
                    prev.errorAt = now;
                } else {
                    items[id] = { status: 'unknown', reason: result.reason, checked: now, title: card.original_name || card.name };
                }
            } else {
                items[id] = {
                    status: result.status,
                    reason: result.reason,
                    checked: now,
                    nextAir: result.nextAir || 0,
                    req: result.status === 'complete' ? result.req : undefined,
                    title: card.original_name || card.name
                };
            }

            log('checked', id, card.original_name || card.name, '→', items[id].status, items[id].reason || '', items[id].nextAir ? 'next: ' + new Date(items[id].nextAir).toDateString() : '');

            saveCache();
        }

        function verify(card, done) {
            var isWatched = makeIsWatched(card);
            var id = cardId(card);

            stats.checks++;

            tmdbGet('tv/' + id, function (details) {
                try {
                    if (!details || toInt(details.id) !== id) {
                        store(card, { status: 'unknown', reason: 'bad_details' });

                        return done();
                    }

                    // Карточка без источника: сверяем оригинальное название
                    if (!card.source && details.original_name && titleCandidates(card).indexOf(details.original_name) === -1) {
                        store(card, { status: 'unknown', reason: 'title_mismatch' });

                        return done();
                    }

                    var now = clock();
                    var plan = planSeasons(details, now);

                    if (plan.status !== 'ok') {
                        store(card, { status: 'unknown', reason: plan.reason, nextAir: plan.nextAir });

                        return done();
                    }

                    // Быстрый путь: последняя вышедшая серия не досмотрена
                    if (plan.last && !isWatched(plan.last.season, plan.last.episode)) {
                        store(card, { status: 'incomplete', reason: 'unwatched_last_s' + plan.last.season + 'e' + plan.last.episode, nextAir: plan.nextAir });

                        return done();
                    }

                    var seasonsData = {};
                    var index = 0;

                    var next = function () {
                        if (index >= plan.seasons.length) {
                            store(card, evaluate(details, seasonsData, clock(), isWatched));

                            return done();
                        }

                        var number = plan.seasons[index++];

                        tmdbGet('tv/' + id + '/season/' + number, function (json) {
                            try {
                                if (!json || !isArray(json.episodes)) {
                                    store(card, { status: 'unknown', reason: 'season_missing_' + number });

                                    return done();
                                }

                                seasonsData[number] = json;

                                var missed = seasonHasUnwatched(json, number, clock(), isWatched);

                                if (missed) {
                                    store(card, { status: 'incomplete', reason: 'unwatched_s' + missed.season + 'e' + missed.episode, nextAir: plan.nextAir });

                                    return done();
                                }

                                next();
                            } catch (e) {
                                store(card, { status: 'error', reason: 'exception: ' + (e && e.message) });
                                done();
                            }
                        }, function (err) {
                            store(card, { status: 'error', reason: 'season_' + number + '_' + err });
                            done();
                        });
                    };

                    next();
                } catch (e) {
                    store(card, { status: 'error', reason: 'exception: ' + (e && e.message) });
                    done();
                }
            }, function (err) {
                store(card, { status: 'error', reason: 'details_' + err });
                done();
            });
        }

        function pump() {
            if (busy || !queue.length) return;

            busy = true;

            var card = queue.shift();
            var finished = false;

            verify(card, function () {
                if (finished) return;

                finished = true;
                delete queued[cardId(card)];
                busy = false;

                timers.set(pump, 300);
            });
        }

        function enqueue(card) {
            if (!eligible(card)) return;

            var id = cardId(card);

            if (queued[id]) return;
            if (!needsCheck(loadCache()[id], clock())) return;

            queued[id] = true;

            // Копия только нужных полей: оригинальная карточка не меняется
            queue.push({
                id: id,
                source: card.source,
                name: card.name,
                original_name: card.original_name,
                original_title: card.original_title,
                original_language: card.original_language,
                number_of_seasons: card.number_of_seasons,
                first_air_date: card.first_air_date
            });

            pump();
        }

        function scheduleChecks(list) {
            if (!isArray(list)) return;

            for (var i = 0; i < list.length; i++) {
                try {
                    enqueue(list[i]);
                } catch (e) {}
            }
        }

        /* ---------- массовая отметка вышедших серий ---------- */

        var MARK_LABEL = 'Отметить все вышедшие серии просмотренными';
        // Сколько серий записывать за один проход, чтобы не подвешивать интерфейс ТВ
        var MARK_CHUNK = 20;

        function markable(card) {
            if (!card || !isTvCard(card)) return false;
            if (typeof card.id !== 'number' && !/^\d+$/.test(card.id + '')) return false;
            if (card.source && card.source !== 'tmdb' && card.source !== 'cub') return false;

            return titleCandidates(card).length > 0;
        }

        /**
         * Названия для хеша серии, как их использует Lampa: original_title
         * (торренты 2.3.0/3.x, онлайн-плагины; у сериала Lampa копирует туда
         * original_name), затем original_name (карточки серий 3.x), если отличается
         */
        function markTitles(card) {
            var list = [];
            var primary = card.original_title || card.original_name;

            if (primary) list.push(primary);
            if (card.original_name && list.indexOf(card.original_name) === -1) list.push(card.original_name);

            return list;
        }

        /**
         * Привязка прогресса к карточке (Lampa 3.x). В 2.3.0 Timeline.link нет — null
         */
        function episodeLink(card, season, episode) {
            try {
                var timeline = L().Timeline;

                if (timeline && typeof timeline.link === 'function') return timeline.link(card, season, episode) || null;
            } catch (e) {}

            return null;
        }

        /**
         * Отметить серию досмотренной в истории Lampa: Timeline.view + Timeline.update,
         * как это делают торренты и отметка серии в самой Lampa.
         * @returns {string} 'marked' или 'already'
         */
        function markEpisode(card, season, episode, limit) {
            var timeline = L().Timeline;
            var link = episodeLink(card, season, episode);
            var titles = markTitles(card);
            var views = [];
            var best = 0;

            for (var i = 0; i < titles.length; i++) {
                var hashValue = hash(episodeKey(season, episode, titles[i]));
                var view = timeline.view(hashValue, link) || {};
                var percent = parseFloat(view.percent);

                if (!isNaN(percent)) best = Math.max(best, percent);

                views.push({ hash: hashValue, view: view });
            }

            // Досмотренную серию не трогаем: её время, длительность и дата остаются прежними
            if (best >= limit) return 'already';

            for (var j = 0; j < views.length; j++) {
                var current = views[j].view;
                var duration = parseFloat(current.duration) > 0 ? parseFloat(current.duration) : 0;
                var params = {
                    hash: views[j].hash,
                    percent: 100,
                    time: duration,
                    duration: duration
                };

                if (typeof current.profile !== 'undefined') params.profile = current.profile;

                if (link && link.card) {
                    params.card = link.card;

                    if (typeof link.season !== 'undefined') params.season = link.season;
                    if (typeof link.episode !== 'undefined') params.episode = link.episode;
                }

                timeline.update(params);
            }

            return 'marked';
        }

        /**
         * Вышедшие серии сезона: номер ≥ 1, дата известна и уже наступила.
         * Будущие и серии без даты только подсчитываются
         */
        function airedEpisodes(seasonData, now, result) {
            var list = [];

            for (var i = 0; i < seasonData.episodes.length; i++) {
                var ep = seasonData.episodes[i] || {};
                var number = toInt(ep.episode_number);
                var date = parseAirDate(ep.air_date);

                if (!(number >= 1)) continue;

                if (isNaN(date)) {
                    result.undated++;
                } else if (date > now) {
                    result.future++;
                } else if (list.indexOf(number) === -1) {
                    list.push(number);
                }
            }

            return list.sort(function (a, b) {
                return a - b;
            });
        }

        /**
         * Страницы со строкой «Продолжить просмотр» пересоздаются при возврате
         * на них штатным activity.refresh() (2.3.0: needRefresh, 3.x: waite_refresh)
         */
        function refreshRows() {
            try {
                var activity = L().Activity;

                if (!activity || typeof activity.all !== 'function') return;

                var active = typeof activity.active === 'function' ? activity.active() : null;
                var list = activity.all() || [];
                var count = 0;

                for (var i = 0; i < list.length; i++) {
                    var item = list[i];

                    if (!item || item === active || !item.activity || typeof item.activity.refresh !== 'function') continue;
                    if (item.component !== 'main' && item.component !== 'category') continue;

                    item.activity.refresh();
                    count++;
                }

                log('rows refresh requested:', count);
            } catch (e) {
                log('rows refresh error', e && e.message);
            }
        }

        /**
         * Отметить все вышедшие серии сериала просмотренными.
         * @param {object} card - карточка сериала (data.movie страницы сериала)
         * @param {function} callback - получает {status:'ok'|'partial'|'error'|'busy', marked, already, future, undated, failed, ...}
         */
        function markAllAired(card, callback) {
            callback = typeof callback === 'function' ? callback : function () {};

            if (marking) return callback({ status: 'busy' });
            if (!markable(card)) return callback({ status: 'error', error: 'not_series' });

            var id = cardId(card);
            var copy = {
                id: id,
                source: card.source,
                name: card.name,
                original_name: card.original_name,
                original_title: card.original_title,
                original_language: card.original_language,
                number_of_seasons: card.number_of_seasons,
                first_air_date: card.first_air_date
            };
            var result = { status: 'ok', id: id, marked: 0, already: 0, future: 0, undated: 0, errors: 0, total: 0, seasons: [], failed: [] };

            marking = { id: id };

            function finish(status, error) {
                result.status = status;

                if (error) result.error = error;

                marking = null;

                log('mark', id, copy.original_name || copy.name, '→', status, error || '', 'marked:', result.marked, 'already:', result.already, 'future:', result.future, 'undated:', result.undated, 'failed seasons:', result.failed.join(',') || '-');

                callback(result);
            }

            tmdbGet('tv/' + id, function (details) {
                try {
                    if (!details || toInt(details.id) !== id) return finish('error', 'bad_details');

                    var now = clock();
                    var plan = planSeasons(details, now);

                    if (plan.status !== 'ok') return finish(plan.reason === 'nothing_aired' ? 'ok' : 'error', plan.reason);

                    var seasons = sortedNumbers(plan.seasons);
                    var seasonsData = {};
                    var pending = [];
                    var index = 0;
                    var limit = threshold();

                    var complete = function () {
                        // Состояние пересчитывается по свежим отметкам и тем же данным TMDB:
                        // будущие серии дают nextAir, после которого сериал вернётся
                        if (!result.failed.length && !result.errors) store(copy, evaluate(details, seasonsData, clock(), makeIsWatched(copy)));
                        else store(copy, { status: 'unknown', reason: 'mark_partial' });

                        refreshRows();

                        if (!result.failed.length && !result.errors) return finish('ok');

                        finish(result.marked || result.already ? 'partial' : 'error', result.failed.length ? 'season_failed' : 'write_failed');
                    };

                    var write = function () {
                        var chunk = pending.splice(0, MARK_CHUNK);

                        for (var i = 0; i < chunk.length; i++) {
                            try {
                                if (markEpisode(copy, chunk[i][0], chunk[i][1], limit) === 'already') result.already++;
                                else result.marked++;
                            } catch (e) {
                                result.errors++;
                                log('mark error', 's' + chunk[i][0] + 'e' + chunk[i][1], e && e.message);
                            }
                        }

                        if (pending.length) timers.set(write, 0);
                        else complete();
                    };

                    var loadNext = function () {
                        if (index >= seasons.length) {
                            result.total = pending.length;

                            return pending.length ? write() : complete();
                        }

                        var number = seasons[index++];

                        tmdbGet('tv/' + id + '/season/' + number, function (json) {
                            if (!json || !isArray(json.episodes)) {
                                result.failed.push(number);

                                return loadNext();
                            }

                            seasonsData[number] = json;
                            result.seasons.push(number);

                            var aired = airedEpisodes(json, now, result);

                            for (var i = 0; i < aired.length; i++) pending.push([number, aired[i]]);

                            loadNext();
                        }, function (err) {
                            log('mark season error', number, err);
                            result.failed.push(number);
                            loadNext();
                        });
                    };

                    loadNext();
                } catch (e) {
                    finish('error', 'exception: ' + (e && e.message));
                }
            }, function (err) {
                finish('error', 'details_' + err);
            });
        }

        function notify(text) {
            try {
                L().Noty.show(text);
            } catch (e) {}
        }

        function markErrorText(error) {
            var map = {
                details_network: 'нет связи с TMDB',
                details_timeout: 'TMDB не ответил',
                bad_details: 'TMDB вернул некорректные данные',
                no_seasons: 'нет данных о сезонах',
                no_regular_seasons: 'нет обычных сезонов',
                season_failed: 'не загрузились сезоны',
                write_failed: 'не удалось записать историю',
                not_series: 'это не сериал'
            };

            return map[error] || error || 'неизвестная ошибка';
        }

        function markMessage(r) {
            if (r.status === 'busy') return 'Отметка серий уже выполняется, подождите';

            if (r.status === 'error' && !r.marked) {
                return 'Не удалось отметить серии: ' + markErrorText(r.error) + (r.failed && r.failed.length ? ' (сезоны ' + r.failed.join(', ') + ')' : '');
            }

            if (r.status === 'ok' && !r.marked && !r.already) return r.error === 'nothing_aired' ? 'У сериала ещё нет вышедших серий' : 'Вышедших серий с известной датой нет';

            var parts = [];

            if (r.marked) parts.push('Отмечено просмотренными: ' + r.marked + ' ' + plural(r.marked));
            else parts.push('Все вышедшие серии уже были отмечены');

            if (r.marked && r.already) parts.push('уже были отмечены: ' + r.already);
            if (r.future) parts.push('будущие не отмечены: ' + r.future);
            if (r.undated) parts.push('без даты выхода пропущено: ' + r.undated);

            var text = parts.join(', ');

            if (r.status === 'partial') {
                text += '. Не загрузились сезоны: ' + (r.failed.length ? r.failed.join(', ') : '-') + (r.errors ? ', ошибок записи: ' + r.errors : '') + '. Повторите позже';
            }

            return text;
        }

        function plural(n) {
            var mod10 = n % 10;
            var mod100 = n % 100;

            if (mod10 === 1 && mod100 !== 11) return 'серия';
            if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'серии';

            return 'серий';
        }

        function onMarkPress(movie, button) {
            if (marking) return notify(markMessage({ status: 'busy' }));

            button.addClass('hws-mark--busy');
            notify('Отмечаю вышедшие серии…');

            markAllAired(movie, function (r) {
                button.removeClass('hws-mark--busy');
                notify(markMessage(r));
            });
        }

        /**
         * Кнопка на странице сериала. Событие full/complite приходит до
         * activity.toggle(), поэтому кнопка попадает в навигацию пульта
         */
        function onFull(e) {
            if (!e || e.type !== 'complite') return;

            try {
                var movie = e.data && e.data.movie;
                var series = markable(movie);

                if (!series && !isMovieCard(movie)) return;

                var render = null;

                if (e.object && e.object.activity && typeof e.object.activity.render === 'function') render = e.object.activity.render();
                if ((!render || typeof render.find !== 'function') && e.body) render = e.body;
                if (!render || typeof render.find !== 'function') return;

                var container = render.find('.full-start-new__buttons');

                if (!container.length) container = render.find('.full-start__buttons');
                if (!container.length) return log('mark button: no buttons container');

                if (!series) return addMovieButton(movie, render, container);

                if (container.find('.button--hws-mark').length) return;

                var jq = win.$ || win.jQuery;
                var button = jq('<div class="full-start__button selector button--hws-mark">' +
                    '<svg width="36" height="36" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 12.5l4 4 8-9" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M11 15.5l1 1 9-10" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
                    '<span>' + MARK_LABEL + '</span></div>');

                button.on('hover:enter', function () {
                    onMarkPress(movie, button);
                });

                var options = container.find('.button--options');

                if (options.length) options.before(button);
                else container.append(button);

                log('mark button added', movie.id);
            } catch (err) {
                log('mark button error', err && err.message);
            }
        }

        /* ---------- отметка «Просмотрено» для фильмов ---------- */

        // Своё хранилище: штатная метка viewed в 3.x доступна в меню только с CUB Premium,
        // взаимоисключающая со «Смотрю» и убирает фильм из строки «Вы смотрели»
        var MOVIES_KEY = 'hws_movies_watched';
        var MOVIES_VERSION = 1;
        var BADGE_CLASS = 'hws-watched-badge';
        var BADGE_TEXT = 'Просмотрено';
        var MOVIE_MARK_LABEL = 'Отметить просмотренным';
        var MOVIE_UNMARK_LABEL = 'Снять отметку «Просмотрено»';
        var CHECK_ICON = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4.5 12.5l5 5 10-11" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        var movieMarks = null;
        var badgeObserver = null;
        var badgeRoots = [];
        var badgeTimer = null;

        function hasClass(el, name) {
            return Boolean(el && typeof el.className === 'string' && (' ' + el.className + ' ').indexOf(' ' + name + ' ') !== -1);
        }

        /**
         * Фильм: не сериал, есть название фильма, не персона.
         * У сериалов из TMDB есть original_name/first_air_date, у персон — gender
         */
        function isMovieCard(card) {
            if (!card || typeof card !== 'object' || isTvCard(card)) return false;
            if (card.original_name || typeof card.gender !== 'undefined' || card.known_for_department) return false;
            if (!(card.title || card.original_title)) return false;

            return movieKey(card) !== null;
        }

        /**
         * Стабильный ключ фильма: источник + id. cub отдаёт id TMDB, поэтому
         * cub и tmdb дают один ключ; у остальных источников свой префикс
         */
        function movieKey(card) {
            if (!card || card.id === null || typeof card.id === 'undefined') return null;

            var id = (card.id + '').replace(/[^\w.-]/g, '');

            if (!id) return null;

            var source = ((card.source || 'tmdb') + '').toLowerCase().replace(/[^\w-]/g, '');

            if (!source || source === 'cub') source = 'tmdb';

            return source + '_' + id;
        }

        function loadMovieMarks() {
            if (movieMarks) return movieMarks;

            movieMarks = {};

            try {
                var ls = storage();
                var raw = ls ? ls.getItem(MOVIES_KEY) : null;
                var parsed = raw ? JSON.parse(raw) : null;

                if (parsed && parsed.v === MOVIES_VERSION && parsed.items && typeof parsed.items === 'object' && !isArray(parsed.items)) {
                    for (var key in parsed.items) {
                        if (Object.prototype.hasOwnProperty.call(parsed.items, key) && parsed.items[key] && typeof parsed.items[key] === 'object') movieMarks[key] = parsed.items[key];
                    }
                } else if (raw) {
                    log('movie marks: unreadable data ignored');
                }
            } catch (e) {
                log('movie marks: broken data ignored', e && e.message);
                movieMarks = {};
            }

            return movieMarks;
        }

        function saveMovieMarks() {
            try {
                var ls = storage();

                if (ls) ls.setItem(MOVIES_KEY, JSON.stringify({ v: MOVIES_VERSION, items: loadMovieMarks() }));

                return true;
            } catch (e) {
                log('movie marks save error', e && e.message);

                return false;
            }
        }

        function isMovieWatched(card) {
            if (!isMovieCard(card)) return false;

            return Object.prototype.hasOwnProperty.call(loadMovieMarks(), movieKey(card));
        }

        /**
         * Поставить или снять отметку. Возвращает новое состояние
         * или null, если это не фильм либо запись не удалась
         */
        function setMovieWatched(card, watched) {
            if (!isMovieCard(card)) return null;

            var marks = loadMovieMarks();
            var key = movieKey(card);
            var before = marks[key];

            if (watched) marks[key] = { t: clock(), title: card.title || card.original_title };
            else delete marks[key];

            if (!saveMovieMarks()) {
                if (before) marks[key] = before;
                else delete marks[key];

                return null;
            }

            log('movie', key, card.title || card.original_title, '→', watched ? 'watched' : 'unmarked');

            updateBadges();

            return Boolean(watched);
        }

        function toggleMovieWatched(card) {
            return setMovieWatched(card, !isMovieWatched(card));
        }

        function doc() {
            return win.document || null;
        }

        function createBadge() {
            var badge = doc().createElement('div');

            badge.className = BADGE_CLASS;
            badge.innerHTML = CHECK_ICON + '<span>' + BADGE_TEXT + '</span>';

            return badge;
        }

        /**
         * Плашка в контейнере постера: добавить или убрать. Идемпотентно,
         * поэтому повторная отрисовка карточки не создаёт дублей
         */
        function syncBadge(view, show) {
            if (!view) return;

            var existing = [];

            for (var i = 0; i < view.childNodes.length; i++) {
                if (hasClass(view.childNodes[i], BADGE_CLASS)) existing.push(view.childNodes[i]);
            }

            if (show && !existing.length) view.appendChild(createBadge());

            for (var j = show ? 1 : 0; j < existing.length; j++) view.removeChild(existing[j]);
        }

        function applyCardBadge(el) {
            if (!el || !hasClass(el, 'card')) return;

            var card = el.card_data;
            var view = el.querySelector ? el.querySelector('.card__view') : null;

            if (!view) return;

            syncBadge(view, isMovieCard(card) && isMovieWatched(card));
        }

        function scanBadges(root) {
            try {
                root = root || (doc() && doc().body);

                if (!root || root.nodeType !== 1) return;

                applyCardBadge(root);

                var cards = root.querySelectorAll ? root.querySelectorAll('.card') : [];

                for (var i = 0; i < cards.length; i++) applyCardBadge(cards[i]);
            } catch (e) {
                log('badge scan error', e && e.message);
            }
        }

        function updateBadges() {
            scanBadges();
            updateFullPoster();
        }

        function flushBadgeRoots() {
            badgeTimer = null;

            var roots = badgeRoots;

            badgeRoots = [];

            for (var i = 0; i < roots.length; i++) {
                // Узел мог оказаться внутри уже обработанного корня
                var inside = false;

                for (var j = 0; j < roots.length && !inside; j++) {
                    if (j !== i && roots[j] !== roots[i] && roots[j].contains && roots[j].contains(roots[i])) inside = true;
                }

                if (!inside && roots.indexOf(roots[i]) === i) scanBadges(roots[i]);
            }
        }

        function onMutations(mutations) {
            for (var i = 0; i < mutations.length; i++) {
                var added = mutations[i].addedNodes || [];

                for (var j = 0; j < added.length; j++) {
                    var node = added[j];

                    // Свои плашки не обрабатываем: так нет повторных проходов
                    if (node.nodeType !== 1 || hasClass(node, BADGE_CLASS)) continue;

                    badgeRoots.push(node);
                }
            }

            if (badgeRoots.length && !badgeTimer) badgeTimer = timers.set(flushBadgeRoots, 60);
        }

        function injectBadgeStyle() {
            var d = doc();

            if (!d || d.getElementById('hws-style')) return;

            var style = d.createElement('style');

            style.id = 'hws-style';
            style.textContent = [
                // Над рейтингом .card__vote (низ постера справа), не над названием и иконками закладок
                '.' + BADGE_CLASS + '{position:absolute;right:.4em;bottom:3.3em;z-index:2;display:-webkit-box;display:-webkit-flex;display:flex;-webkit-box-align:center;-webkit-align-items:center;align-items:center;',
                'padding:.3em .6em .3em .45em;-webkit-border-radius:1em;border-radius:1em;background:#1f9d5c;background:-webkit-linear-gradient(top,#2ec27a,#178a4e);background:linear-gradient(to bottom,#2ec27a,#178a4e);',
                'color:#fff;font-size:.8em;font-weight:600;line-height:1.2;white-space:nowrap;-webkit-box-shadow:0 .15em .6em rgba(0,0,0,.4);box-shadow:0 .15em .6em rgba(0,0,0,.4);pointer-events:none}',
                '.' + BADGE_CLASS + ' svg{width:1.05em;height:1.05em;margin-right:.35em;-webkit-flex-shrink:0;flex-shrink:0}',
                '.card--wide .' + BADGE_CLASS + '{top:.6em;bottom:auto}',
                '.full-start-new__poster .' + BADGE_CLASS + ',.full-start__poster .' + BADGE_CLASS + '{top:.8em;right:.8em;bottom:auto;font-size:1em}',
                '.button--hws-movie.hws-movie--on svg{color:#2ec27a}'
            ].join('');

            (d.head || d.body).appendChild(style);
        }

        function startBadges() {
            try {
                var d = doc();

                if (!d || !d.body) return;

                injectBadgeStyle();
                scanBadges(d.body);

                var Observer = win.MutationObserver || win.WebKitMutationObserver;

                if (Observer) {
                    badgeObserver = new Observer(onMutations);
                    badgeObserver.observe(d.body, { childList: true, subtree: true });
                } else {
                    // Старые движки без MutationObserver: редкий проход по видимым карточкам
                    timers.interval(function () {
                        scanBadges();
                    }, 2000);
                }

                log('movie badges started', Observer ? 'observer' : 'interval', 'marked:', Object.keys(loadMovieMarks()).length);
            } catch (e) {
                log('movie badges error', e && e.message);
            }
        }

        /* Страница фильма: кнопка и плашка на постере */

        var fullPoster = null;

        function updateFullPoster() {
            if (!fullPoster) return;

            try {
                var view = fullPoster.view;

                if (!view || !doc().body.contains(view)) {
                    fullPoster = null;

                    return;
                }

                var on = isMovieWatched(fullPoster.movie);

                syncBadge(view, on);

                fullPoster.button.toggleClass('hws-movie--on', on);
                fullPoster.button.find('span').text(on ? MOVIE_UNMARK_LABEL : MOVIE_MARK_LABEL);
            } catch (e) {
                log('full poster error', e && e.message);
            }
        }

        function addMovieButton(movie, render, container) {
            if (container.find('.button--hws-movie').length) return;

            var jq = win.$ || win.jQuery;
            var on = isMovieWatched(movie);
            var button = jq('<div class="full-start__button selector button--hws-movie' + (on ? ' hws-movie--on' : '') + '">' +
                '<svg width="36" height="36" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1.5 12S5.5 4.5 12 4.5 22.5 12 22.5 12 18.5 19.5 12 19.5 1.5 12 1.5 12z" stroke="currentColor" stroke-width="2"/><path d="M8.5 12l2.5 2.5 4.5-5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
                '<span>' + (on ? MOVIE_UNMARK_LABEL : MOVIE_MARK_LABEL) + '</span></div>');

            var poster = render.find('.full-start-new__poster');

            if (!poster.length) poster = render.find('.full-start__poster');

            var page = { movie: movie, button: button, view: poster.length ? poster[0] : null };

            fullPoster = page;

            button.on('hover:enter', function () {
                // После «Назад» на другую страницу и возврата активна снова эта
                fullPoster = page;

                var state = toggleMovieWatched(movie);

                if (state === null) return notify('Не удалось сохранить отметку');

                notify(state ? 'Фильм отмечен как просмотренный' : 'Отметка «Просмотрено» снята');
            });

            var options = container.find('.button--options');

            if (options.length) options.before(button);
            else container.append(button);

            if (page.view) syncBadge(page.view, on);

            log('movie button added', movieKey(movie), on ? 'watched' : '');
        }

        /* ---------- источник списка для фоновой проверки ---------- */

        function continueList() {
            var lampa = L();
            var list = [];

            try {
                var fn = mode === 'legacy' && originalContinues ? originalContinues : lampa.Favorite.continues;

                list = list.concat(fn.call(lampa.Favorite, 'tv') || []);

                if (mode === 'rows' && includeAnime()) list = list.concat(fn.call(lampa.Favorite, 'anime') || []);
            } catch (e) {
                log('continues error', e && e.message);
            }

            return list;
        }

        function warmup() {
            if (!enabled()) return;

            var list = continueList();

            log('warmup, series in list:', list.length);
            scheduleChecks(list);
        }

        function scheduleWarmup(delay) {
            if (warmupTimer) {
                try {
                    clearTimeout(warmupTimer);
                } catch (e) {}
            }

            warmupTimer = timers.set(function () {
                warmupTimer = null;
                warmup();
            }, delay);
        }

        /* ---------- перехват строки ---------- */

        /**
         * Lampa 2.3.0: строку строят tmdb.category / cub.category вызовом
         * Favorite.continues(params.url) — свойство экспортированного объекта,
         * то есть тот же объект, что Lampa.Favorite. Фильтруем только вызовы
         * изнутри category(), остальные (плеер, Tizen) не трогаем.
         */
        function patchLegacy() {
            var lampa = L();
            var favorite = lampa.Favorite;

            if (!favorite || typeof favorite.continues !== 'function') return false;

            if (favorite.continues.__hws) {
                originalContinues = favorite.continues.__hws;

                return true;
            }

            originalContinues = favorite.continues;

            var wrapped = function (type) {
                var result = originalContinues.apply(this, arguments);

                if (categoryDepth > 0 && type === 'tv') return filterList(result, 'category:tv');

                return result;
            };

            wrapped.__hws = originalContinues;
            favorite.continues = wrapped;

            var sources = lampa.Api && lampa.Api.sources ? lampa.Api.sources : {};
            var names = [];

            for (var name in sources) {
                var source;

                try {
                    source = sources[name];
                } catch (e) {
                    continue;
                }

                if (!source || typeof source.category !== 'function' || source.category.__hws) continue;

                (function (src) {
                    var original = src.category;
                    var wrappedCategory = function () {
                        categoryDepth++;

                        try {
                            return original.apply(this, arguments);
                        } finally {
                            categoryDepth--;
                        }
                    };

                    wrappedCategory.__hws = original;
                    src.category = wrappedCategory;
                })(source);

                names.push(name);
            }

            log('legacy mode, sources:', names.join(','));

            return names.length > 0;
        }

        /**
         * Lampa 3.x: строка регистрируется через ContentRows.add, список строит
         * внутренняя функция favorite.js. Подменяем ответ только у строки,
         * чей заголовок — «Продолжить просмотр».
         */
        function patchRows() {
            var rows = L().ContentRows;

            if (!rows || typeof rows.call !== 'function') return false;
            if (rows.call.__hws) return true;

            var original = rows.call;

            var wrapped = function (screen, params, calls) {
                var before = isArray(calls) ? calls.slice() : null;
                var result = original.apply(this, arguments);

                if (before && (screen === 'main' || screen === 'category')) {
                    for (var i = 0; i < calls.length; i++) {
                        var fn = calls[i];

                        if (typeof fn === 'function' && !fn.__hws_row && before.indexOf(fn) === -1) calls[i] = wrapRow(fn, screen);
                    }
                }

                return result;
            };

            wrapped.__hws = original;
            rows.call = wrapped;

            log('rows mode');

            return true;
        }

        function continueTitle() {
            try {
                return L().Lang.translate('title_continue');
            } catch (e) {
                return null;
            }
        }

        function wrapRow(fn, screen) {
            var wrapped = function (call) {
                var args = Array.prototype.slice.call(arguments);

                if (typeof call === 'function') {
                    args[0] = function (json) {
                        try {
                            var title = continueTitle();

                            if (json && title && json.title === title && isArray(json.results)) json.results = filterList(json.results, screen);
                        } catch (e) {}

                        return call.apply(this, arguments);
                    };
                }

                return fn.apply(this, args);
            };

            wrapped.__hws_row = true;

            return wrapped;
        }

        /* ---------- настройки в интерфейсе ---------- */

        function addSettings() {
            var api = L().SettingsApi;

            if (!api || typeof api.addComponent !== 'function') return;

            var component = 'hide_watched_series';

            try {
                api.addComponent({
                    component: component,
                    name: 'Просмотренные сериалы',
                    icon: '<svg width="36" height="36" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 5h18v11H3z" stroke="white" stroke-width="2"/><path d="M8 20h8" stroke="white" stroke-width="2"/><path d="M8.5 10.5l2.5 2.5 4.5-5" stroke="white" stroke-width="2"/></svg>'
                });

                api.addParam({
                    component: component,
                    param: { name: SETTINGS.enabled, type: 'trigger', 'default': true },
                    field: { name: 'Убирать досмотренные сериалы', description: 'Из строки «Продолжить просмотр», пока не выйдет новая серия' }
                });

                api.addParam({
                    component: component,
                    param: { name: SETTINGS.anime, type: 'trigger', 'default': false },
                    field: { name: 'Обрабатывать аниме', description: 'Выключено: аниме никогда не скрывается' }
                });

                api.addParam({
                    component: component,
                    param: {
                        name: SETTINGS.threshold,
                        type: 'select',
                        values: { '80': '80%', '85': '85%', '90': '90%', '95': '95%', '100': '100%' },
                        'default': DEFAULT_THRESHOLD + ''
                    },
                    field: { name: 'Серия досмотрена при прогрессе от', description: 'Плеер Lampa не предлагает продолжить серию после 90%' }
                });

                api.addParam({
                    component: component,
                    param: { name: SETTINGS.debug, type: 'trigger', 'default': false },
                    field: { name: 'Режим отладки', description: 'Сообщения с меткой HideWatched в консоли Lampa' }
                });

                api.addParam({
                    component: component,
                    param: { name: 'hws_clear_cache', type: 'button' },
                    field: { name: 'Очистить данные плагина', description: 'Удалить сохранённые результаты проверок' },
                    onChange: function () {
                        clearCache();

                        try {
                            L().Noty.show('Данные плагина очищены');
                        } catch (e) {}

                        scheduleWarmup(1000);
                    }
                });
            } catch (e) {
                log('settings error', e && e.message);
            }
        }

        /* ---------- запуск ---------- */

        function onTimelineUpdate() {
            var items = loadCache();

            for (var id in items) {
                if (Object.prototype.hasOwnProperty.call(items, id) && items[id].status === 'incomplete') items[id].dirty = true;
            }

            scheduleWarmup(5000);
        }

        function start() {
            if (started) return;

            started = true;

            try {
                var lampa = L();

                if (lampa.ContentRows && typeof lampa.ContentRows.call === 'function') mode = patchRows() ? 'rows' : 'none';
                else mode = patchLegacy() ? 'legacy' : 'none';

                addSettings();

                try {
                    if (lampa.Timeline && lampa.Timeline.listener && typeof lampa.Timeline.listener.follow === 'function') {
                        lampa.Timeline.listener.follow('update', onTimelineUpdate);
                    }
                } catch (e) {}

                try {
                    if (lampa.Listener && typeof lampa.Listener.follow === 'function') lampa.Listener.follow('full', onFull);
                } catch (e) {}

                startBadges();

                try {
                    if (lampa.Manifest) {
                        lampa.Manifest.plugins = {
                            type: 'other',
                            version: VERSION,
                            name: 'Убирать просмотренные сериалы',
                            description: 'Скрывает досмотренные сериалы из «Продолжить просмотр»',
                            component: 'hide_watched_series'
                        };
                    }
                } catch (e) {}

                log('started, version', VERSION, 'mode', mode, 'lampa', lampa.Manifest ? lampa.Manifest.app_version : '?');

                if (mode !== 'none') {
                    scheduleWarmup(options.warmupDelay || 4000);
                    timers.interval(warmup, 30 * 60 * 1000);
                }
            } catch (e) {
                try {
                    console.error(LOG_TAG, 'start error', e && e.message);
                } catch (x) {}
            }
        }

        function boot() {
            var lampa = L();

            if (win.appready) return start();

            if (lampa && lampa.Listener && typeof lampa.Listener.follow === 'function') {
                lampa.Listener.follow('app', function (e) {
                    if (e && e.type === 'ready') start();
                });
            } else {
                timers.set(boot, 500);
            }
        }

        var api = {
            version: VERSION,
            Core: Core,
            mode: function () {
                return mode;
            },
            start: start,
            warmup: warmup,
            clearCache: clearCache,
            // Удалить все данные плагина: кеш проверок и его настройки
            purge: function () {
                clearCache();

                var ls = storage();

                for (var key in SETTINGS) {
                    if (!Object.prototype.hasOwnProperty.call(SETTINGS, key)) continue;

                    try {
                        if (ls) ls.removeItem(SETTINGS[key]);
                    } catch (e) {}
                }
            },
            filterList: filterList,
            hideCard: hideCard,
            markAllAired: markAllAired,
            markMessage: markMessage,
            isMovieWatched: isMovieWatched,
            setMovieWatched: setMovieWatched,
            toggleMovieWatched: toggleMovieWatched,
            movieKey: movieKey,
            scanBadges: scanBadges,
            cache: function () {
                return loadCache();
            },
            stats: function () {
                return { hidden: stats.hidden, checks: stats.checks, errors: stats.errors, queue: queue.length, busy: busy };
            },
            status: function () {
                var items = loadCache();
                var rows = [];

                for (var id in items) {
                    if (!Object.prototype.hasOwnProperty.call(items, id)) continue;

                    var it = items[id];

                    rows.push(id + ' ' + (it.title || '') + ': ' + it.status + ' (' + (it.reason || '') + ')' + (it.nextAir ? ', next ' + new Date(it.nextAir).toDateString() : '') + ', checked ' + new Date(it.checked).toLocaleString());
                }

                try {
                    console.log(LOG_TAG, 'mode:', mode, 'version:', VERSION, '\n' + rows.join('\n'));
                } catch (e) {}

                return rows;
            }
        };

        win.HideWatchedSeries = api;

        if (options.autoStart !== false) boot();

        return api;
    }

    var exported = { Core: Core, install: install, VERSION: VERSION };

    if (typeof module === 'object' && module && module.exports) module.exports = exported;
    else if (root) install(root);
})(typeof window !== 'undefined' ? window : this);
