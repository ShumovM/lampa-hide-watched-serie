/*!
 * Lampa plugin «Убирать просмотренные сериалы» (hide_watched_series)
 * Версия 1.5.0
 *
 * Убирает из строки «Продолжить просмотр» сериалы, у которых все вышедшие серии
 * досмотрены, и возвращает их, как только выходит новая непросмотренная серия.
 * На странице сериала добавляет кнопку «Отметить все вышедшие серии просмотренными»
 * и «Продолжить» — открывает последнюю раздачу с курсором на следующей серии.
 * На странице фильма — кнопку «Отметить просмотренным» и зелёную галочку на постере.
 * Такая же плашка у завершённых сериалов, все серии которых досмотрены.
 *
 * Целевая платформа: Lampa 2.3.0 (LG webOS). Дополнительно поддерживается
 * ветка 3.x, где строка строится через Lampa.ContentRows.
 * Код написан на ES5 (без стрелочных функций, let/const, Promise,
 * Array.prototype.find/includes) для старых движков webOS.
 */
(function (root) {
    'use strict';

    var VERSION = '1.5.0';
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
        debug: 'hws_debug',
        syncUrl: 'hws_sync_url',
        syncCode: 'hws_sync_code',
        syncId: 'hws_sync_id'
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
     * Сериал больше не выйдет: статус TMDB (не переводится) «завершён» или «отменён»,
     * нет будущих серий, серий без даты и ещё не начавшихся сезонов
     */
    function seriesEnded(details, plan, nextAir, undatedPending) {
        if (details.status !== 'Ended' && details.status !== 'Canceled') return false;
        if (nextAir || undatedPending || details.next_episode_to_air) return false;

        var maxLoaded = Math.max.apply(null, plan.seasons);

        for (var i = 0; i < details.seasons.length; i++) {
            if (toInt(details.seasons[i] && details.seasons[i].season_number) > maxLoaded) return false;
        }

        return true;
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
            nextAir: nextAir,
            ended: seriesEnded(details, plan, nextAir, undatedPending)
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
     * Показывать ли плашку «Просмотрено» на сериале
     */
    function isFinished(entry, now, isWatched, localEpisodes) {
        return Boolean(entry && entry.ended) && shouldHide(entry, now, isWatched, localEpisodes);
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

            // Запись версии до 1.4.0: неизвестно, завершён ли сериал
            if (typeof entry.ended === 'undefined') return true;

            return age > SOFT_TTL;
        }

        if (entry.status === 'incomplete') return Boolean(entry.dirty) || age > INCOMPLETE_TTL;

        return age > RETRY_TTL;
    }

    function statsIdentity(source, type, id) {
        source = (source || 'tmdb').toString().toLowerCase().replace(/[^a-z0-9_-]/g, '');
        if (!source || source === 'cub') source = 'tmdb';
        id = (id === null || typeof id === 'undefined' ? '' : String(id)).toLowerCase().replace(/[^a-z0-9_-]/g, '');
        if (!id || (type !== 'movie' && type !== 'tv')) return null;

        return source + '|' + type + '|' + id;
    }

    function statsIdentityFromLink(value) {
        var match = /^(?:(.+)_)?(movie|tv)_([a-z0-9_-]+)$/i.exec(String(value || '').toLowerCase());

        if (!match) return null;

        return statsIdentity(match[1] || 'tmdb', match[2], match[3]);
    }

    function statsTimestamp(value) {
        if (typeof value === 'number' && isFinite(value)) return value;
        if (typeof value === 'string' && value) {
            var parsed = new Date(value).getTime();
            return isNaN(parsed) ? 0 : parsed;
        }

        return 0;
    }

    /**
     * Считает только просмотренные записи с устойчивой связью Lampa card/season/episode.
     * Длительность — сумма известной полной длительности завершённых единиц контента,
     * а не фактическое время, проведённое перед экраном.
     */
    function calculateStats(timeline, movieMarks, cards, limit) {
        var result = {
            movies: { count: 0, seconds: 0, missingDuration: 0 },
            series: { count: 0, episodes: 0, seconds: 0, missingDuration: 0 },
            anime: { count: 0, episodes: 0, seconds: 0, missingDuration: 0 },
            unclassified: 0,
            totalSeconds: 0
        };
        var animeMap = {};
        var movieItems = {};
        var episodeItems = {};
        var seriesItems = { series: {}, anime: {} };
        var unknownEpisodes = {};
        var threshold = parseFloat(limit);
        var key;
        var i;

        if (isNaN(threshold)) threshold = DEFAULT_THRESHOLD;
        timeline = timeline && typeof timeline === 'object' ? timeline : {};
        movieMarks = movieMarks && typeof movieMarks === 'object' ? movieMarks : {};
        cards = isArray(cards) ? cards : [];

        for (i = 0; i < cards.length; i++) {
            var card = cards[i] || {};
            if (!isTvCard(card)) continue;
            var identity = statsIdentity(card.source, 'tv', card.id);
            if (!identity) continue;
            var hasLanguage = typeof card.original_language === 'string' && Boolean(card.original_language);
            var category = isAnimeCard(card) ? 'anime' : (hasLanguage ? 'series' : 'unknown');
            var mapKey = '$' + identity;

            if (typeof animeMap[mapKey] === 'undefined') animeMap[mapKey] = category;
            else if (animeMap[mapKey] !== category) animeMap[mapKey] = 'unknown';
        }

        for (key in movieMarks) {
            if (!Object.prototype.hasOwnProperty.call(movieMarks, key)) continue;
            var markKey = String(key).toLowerCase();
            if (markKey.indexOf('cub_') === 0) markKey = 'tmdb_' + markKey.slice(4);
            if (!/^[a-z0-9_-]+_[a-z0-9_-]+$/.test(markKey)) {
                result.unclassified++;
                continue;
            }
            movieItems['$movie|' + markKey] = { marked: true, completed: true, duration: 0, durationAt: -1 };
        }

        for (key in timeline) {
            if (!Object.prototype.hasOwnProperty.call(timeline, key)) continue;
            var road = timeline[key];
            if (typeof road === 'number') road = { percent: road };
            if (!road || typeof road !== 'object') continue;
            var percent = parseFloat(road.percent) || 0;
            var linkedIdentity = statsIdentityFromLink(road.card);

            if (!linkedIdentity) {
                if (percent >= threshold) result.unclassified++;
                continue;
            }

            var parts = linkedIdentity.split('|');
            var kind = parts[1];
            var duration = parseFloat(road.duration) || 0;
            var updated = statsTimestamp(road.updated);

            if (kind === 'movie') {
                var movieBucketKey = '$movie|' + parts[0] + '_' + parts[2];
                var movie = movieItems[movieBucketKey];
                if (!movie && percent >= threshold) movie = movieItems[movieBucketKey] = { marked: false, completed: false, duration: 0, durationAt: -1 };
                if (!movie) continue;
                if (percent >= threshold) movie.completed = true;
                if (duration > 0 && (updated >= movie.durationAt) && (movie.marked || percent >= threshold)) {
                    movie.duration = duration;
                    movie.durationAt = updated;
                }
            } else {
                var season = parseInt(road.season, 10);
                var episode = parseInt(road.episode, 10);
                if (percent < threshold) continue;
                if (isNaN(season) || season < 1 || isNaN(episode) || episode < 1) {
                    result.unclassified++;
                    continue;
                }

                var episodeIdentity = linkedIdentity + '|' + season + '|' + episode;
                var episodeBucketKey = '$' + episodeIdentity;
                var item = episodeItems[episodeBucketKey];
                if (!item) item = episodeItems[episodeBucketKey] = { series: linkedIdentity, duration: 0, durationAt: -1 };
                if (duration > 0 && updated >= item.durationAt) {
                    item.duration = duration;
                    item.durationAt = updated;
                }
            }
        }

        for (key in movieItems) {
            if (!Object.prototype.hasOwnProperty.call(movieItems, key)) continue;
            var movieItem = movieItems[key];
            if (!movieItem.marked && !movieItem.completed) continue;
            result.movies.count++;
            if (movieItem.duration > 0) result.movies.seconds += movieItem.duration;
            else result.movies.missingDuration++;
        }

        for (key in episodeItems) {
            if (!Object.prototype.hasOwnProperty.call(episodeItems, key)) continue;
            var episodeItem = episodeItems[key];
            var type = animeMap['$' + episodeItem.series];
            if (type !== 'series' && type !== 'anime') {
                unknownEpisodes[key] = true;
                continue;
            }

            var group = type === 'anime' ? result.anime : result.series;
            var set = type === 'anime' ? seriesItems.anime : seriesItems.series;
            set['$' + episodeItem.series] = true;
            group.episodes++;
            if (episodeItem.duration > 0) group.seconds += episodeItem.duration;
            else group.missingDuration++;
        }

        result.unclassified += Object.keys(unknownEpisodes).length;
        result.series.count = Object.keys(seriesItems.series).length;
        result.anime.count = Object.keys(seriesItems.anime).length;
        result.totalSeconds = result.movies.seconds + result.series.seconds + result.anime.seconds;

        return result;
    }

    function formatStatsDuration(seconds) {
        seconds = Math.max(0, Math.floor(Number(seconds) || 0));
        var minutes = Math.floor(seconds / 60);
        var days = Math.floor(minutes / (24 * 60));
        var hours = Math.floor((minutes - days * 24 * 60) / 60);
        var rest = minutes % 60;
        var parts = [];

        if (days) parts.push(days + ' д');
        if (hours || days) parts.push(hours + ' ч');
        if (rest && !days) parts.push(rest + ' мин');

        return parts.length ? parts.join(' ') : '0 ч';
    }

    function formatStatsDurationOrUnknown(seconds, missingDuration) {
        if ((Number(seconds) || 0) <= 0 && (Number(missingDuration) || 0) > 0) return 'Нет данных';
        return formatStatsDuration(seconds);
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
        isFinished: isFinished,
        needsCheck: needsCheck,
        calculateStats: calculateStats,
        formatStatsDuration: formatStatsDuration,
        formatStatsDurationOrUnknown: formatStatsDurationOrUnknown,
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
        var favoriteFeedRegistered = false;
        var startedFavorites = {};
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

        /* ---------- фоновая синхронизация Supabase ---------- */

        var SYNC_QUEUE_KEY = 'hws_sync_queue';
        var SYNC_DEVICE_KEY = 'hws_sync_device_id';
        var SYNC_QUEUE_VERSION = 1;
        var SYNC_BATCH = 100;
        var SYNC_PAGE = 300;
        var SYNC_INTERVAL = 5 * 60 * 1000;
        var syncQueue = null;
        var syncBusy = false;
        var syncApplying = false;
        var syncStarted = false;
        var syncTimer = null;
        var syncRemoteSeen = null;
        var syncLastError = '';
        var syncLastSuccess = 0;
        var syncRequestId = 0;

        function syncString(value) {
            return typeof value === 'string' ? value.replace(/^\s+|\s+$/g, '') : '';
        }

        function syncEndpoint() {
            var value = syncString(setting(SETTINGS.syncUrl, ''));

            if (!value) return '';
            value = value.replace(/\/+$/, '');

            return /\/functions\/v1\/swift-task$/i.test(value) ? value : value + '/functions/v1/swift-task';
        }

        function syncCode() {
            return syncString(setting(SETTINGS.syncCode, ''));
        }

        function syncNamespace() {
            var value = syncString(setting(SETTINGS.syncId, 'default'));

            return value ? value.slice(0, 128) : 'default';
        }

        function syncDeviceId() {
            try {
                var ls = storage();
                var id = ls && ls.getItem(SYNC_DEVICE_KEY);
                if (id) return id;
                id = 'hws-' + clock().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
                if (ls) ls.setItem(SYNC_DEVICE_KEY, id);
                return id;
            } catch (e) {
                return 'hws-session-' + clock().toString(36);
            }
        }

        function syncProfile() {
            try {
                var account = L().Storage.get('account');

                if (typeof account === 'string') account = JSON.parse(account);
                if (account && account.profile && typeof account.profile.id !== 'undefined') return String(account.profile.id);

                var timeline = L().Timeline;
                var filename = timeline && typeof timeline.filename === 'function' ? timeline.filename() : '';
                var match = /file_view_(.+)$/.exec(filename || '');

                return match ? match[1] : 'main';
            } catch (e) {
                return 'main';
            }
        }

        function syncTime(value) {
            if (typeof value === 'number' && isFinite(value)) return value;
            if (value === null || typeof value === 'undefined' || value === '') return 0;

            var parsed = new Date(value).getTime();

            return isNaN(parsed) ? 0 : parsed;
        }

        function syncIso(value) {
            var time = value === null || typeof value === 'undefined' || value === '' ? clock() : syncTime(value);

            try {
                return new Date(time).toISOString();
            } catch (e) {
                return new Date(clock()).toISOString();
            }
        }

        function syncLoadQueue() {
            if (syncQueue) return syncQueue;

            syncQueue = [];

            try {
                var ls = storage();
                var raw = ls ? ls.getItem(SYNC_QUEUE_KEY) : null;
                var parsed = raw ? JSON.parse(raw) : null;

                if (parsed && parsed.v === SYNC_QUEUE_VERSION && isArray(parsed.items)) syncQueue = parsed.items;
            } catch (e) {
                syncQueue = [];
            }

            return syncQueue;
        }

        function syncSaveQueue() {
            try {
                var ls = storage();

                if (ls) ls.setItem(SYNC_QUEUE_KEY, JSON.stringify({ v: SYNC_QUEUE_VERSION, items: syncLoadQueue() }));
            } catch (e) {
                log('sync queue save error', e && e.message);
            }
        }

        function syncQueueKey(table, row) {
            var scope = row.sync_id + '|' + row.profile_id + '|';
            if (table === 'episode_progress') return table + '|' + scope + row.timeline_hash;
            if (table === 'movie_watched_marks') return table + '|' + scope + row.source + '|' + row.movie_id;

            return table + '|' + scope + row.source + '|' + row.series_id;
        }

        function syncEnqueue(table, row, updated) {
            if (syncApplying || !row) return;

            var items = syncLoadQueue();
            var key = syncQueueKey(table, row);
            var stamp = syncTime(updated || row.updated_at) || clock();
            var item = {
                id: String(clock()) + '-' + String(++syncRequestId),
                table: table,
                key: key,
                updated: stamp,
                row: row
            };
            var replaced = false;

            for (var i = 0; i < items.length; i++) {
                if (items[i].key === key) {
                    if ((items[i].updated || 0) > stamp) return;
                    items[i] = item;
                    replaced = true;
                    break;
                }
            }

            if (!replaced) items.push(item);
            syncSaveQueue();
            scheduleSync(1200);
        }

        function scheduleSync(delay) {
            if (syncTimer) return;

            syncTimer = timers.set(function () {
                syncTimer = null;
                syncNow();
            }, typeof delay === 'number' ? delay : 1000);
        }

        function syncRequest(url, code, body, callback) {
            if (typeof options.syncRequest === 'function') return options.syncRequest(url, code, body, callback);

            var XHR = win.XMLHttpRequest;

            if (!XHR) return callback('xhr_unavailable');

            try {
                var request = new XHR();

                request.open('POST', url, true);
                request.timeout = 20000;
                request.setRequestHeader('Content-Type', 'application/json');
                request.setRequestHeader('x-sync-code', code);
                request.onreadystatechange = function () {
                    if (request.readyState !== 4) return;
                    if (request.status < 200 || request.status >= 300) return callback('http_' + request.status);

                    var response;

                    try {
                        response = JSON.parse(request.responseText || '{}');
                    } catch (e) {
                        return callback('invalid_json');
                    }

                    callback(null, response);
                };
                request.onerror = function () { callback('network'); };
                request.ontimeout = function () { callback('timeout'); };
                request.send(JSON.stringify(body));
            } catch (e) {
                callback('request_error');
            }
        }

        function syncPrepareRow(table, row) {
            var copy = {};
            var key;

            for (key in row) if (Object.prototype.hasOwnProperty.call(row, key)) copy[key] = row[key];
            copy.sync_id = syncNamespace();
            copy.profile_id = syncProfile();

            return copy;
        }

        function syncQueueSnapshot(remote) {
            var local = {};
            var seen = syncRemoteSeen || {};
            var tables = ['episode_progress', 'movie_watched_marks', 'series_torrent_resume'];
            var table;
            var i;

            for (i = 0; i < tables.length; i++) seen[tables[i]] = seen[tables[i]] || {};

            try {
                var timeline = L().Timeline;
                var filename = timeline && typeof timeline.filename === 'function' ? timeline.filename() : 'file_view';
                var viewed = L().Storage.get(filename, {});

                if (typeof viewed === 'string') viewed = JSON.parse(viewed || '{}');
                if (viewed && typeof viewed === 'object') {
                    for (var hashValue in viewed) {
                        if (!Object.prototype.hasOwnProperty.call(viewed, hashValue)) continue;
                        var road = viewed[hashValue];
                        if (typeof road === 'number') road = { percent: road };
                        if (!road || typeof road !== 'object') continue;

                        var timelineRow = syncPrepareRow('episode_progress', {
                            timeline_hash: String(hashValue), percent: parseFloat(road.percent) || 0,
                            time: parseFloat(road.time) || 0, duration: parseFloat(road.duration) || 0,
                            profile: typeof road.profile === 'undefined' ? 0 : road.profile,
                            card: road.card || null, season: typeof road.season === 'undefined' ? null : road.season,
                            episode: typeof road.episode === 'undefined' ? null : road.episode,
                            updated_at: syncIso(road.updated || 0)
                        });
                        local.episode_progress = local.episode_progress || [];
                        local.episode_progress.push(timelineRow);
                    }
                }
            } catch (e) {
                log('sync timeline snapshot error', e && e.message);
            }

            var marks = loadMovieMarks();

            for (var movieKeyValue in marks) {
                if (!Object.prototype.hasOwnProperty.call(marks, movieKeyValue)) continue;
                var movieMatch = /^([\w-]+)_(.+)$/.exec(movieKeyValue);
                if (!movieMatch) continue;
                var movieRow = syncPrepareRow('movie_watched_marks', {
                    source: movieMatch[1], movie_id: movieMatch[2], title: marks[movieKeyValue].title || '',
                    marked_at: marks[movieKeyValue].t || 0, updated_at: syncIso(marks[movieKeyValue].t || 0), is_deleted: false
                });
                local.movie_watched_marks = local.movie_watched_marks || [];
                local.movie_watched_marks.push(movieRow);
            }

            var torrents = loadTorrents();

            for (var torrentKey in torrents) {
                if (!Object.prototype.hasOwnProperty.call(torrents, torrentKey)) continue;
                var torrentMatch = /^([\w-]+)_(.+)$/.exec(torrentKey);
                var torrent = torrents[torrentKey];
                if (!torrentMatch || !torrent.magnet) continue;
                var torrentRow = syncPrepareRow('series_torrent_resume', {
                    source: torrentMatch[1], series_id: torrentMatch[2], title: torrent.title || '',
                    magnet: torrent.magnet, season_number: toInt(torrent.season), episode_number: toInt(torrent.episode),
                    updated_at: syncIso(torrent.t || 0)
                });
                local.series_torrent_resume = local.series_torrent_resume || [];
                local.series_torrent_resume.push(torrentRow);
            }

            for (i = 0; i < tables.length; i++) {
                table = tables[i];
                var list = local[table] || [];

                for (var j = 0; j < list.length; j++) {
                    var row = list[j];
                    var key = syncQueueKey(table, row);
                    var localTime = syncTime(row.updated_at);
                    var serverTime = seen[table][key] || 0;

                    if (!serverTime || localTime > serverTime) syncEnqueue(table, row, localTime);
                }
            }
        }

        function syncApplyRows(table, rows) {
            if (!isArray(rows) || !rows.length) return;

            var seen = syncRemoteSeen[table];
            var i;
            var row;
            var key;
            var updated;

            if (table === 'episode_progress') {
                try {
                    var timeline = L().Timeline;
                    var filename = timeline && typeof timeline.filename === 'function' ? timeline.filename() : 'file_view';
                    var viewed = L().Storage.get(filename, {});
                    if (typeof viewed === 'string') viewed = JSON.parse(viewed || '{}');
                    if (!viewed || typeof viewed !== 'object') viewed = {};

                    var changed = false;
                    for (i = 0; i < rows.length; i++) {
                        row = rows[i] || {};
                        if (!row.timeline_hash) continue;
                        key = syncQueueKey(table, row);
                        updated = syncTime(row.updated_at);
                        seen[key] = Math.max(seen[key] || 0, updated);
                        var current = viewed[row.timeline_hash];
                        var currentTime = current && typeof current === 'object' ? syncTime(current.updated) : 0;

                        if (current && currentTime >= updated) continue;
                        if (row.is_deleted) {
                            if (current) {
                                delete viewed[row.timeline_hash];
                                changed = true;
                            }
                            continue;
                        }
                        viewed[row.timeline_hash] = {
                            percent: row.percent || 0, time: row.time || 0, duration: row.duration || 0,
                            profile: row.profile || 0, updated: updated,
                            card: row.card || undefined, season: row.season, episode: row.episode
                        };
                        changed = true;
                    }

                    if (changed) {
                        syncApplying = true;
                        L().Storage.set(filename, viewed);
                        timeline.read();
                        syncApplying = false;
                    }
                } catch (e) {
                    syncApplying = false;
                    log('sync timeline restore error', e && e.message);
                }
            } else if (table === 'movie_watched_marks') {
                var marks = loadMovieMarks();
                var movieChanged = false;

                for (i = 0; i < rows.length; i++) {
                    row = rows[i] || {};
                    if (!row.source || !row.movie_id) continue;
                    key = syncQueueKey(table, row);
                    updated = syncTime(row.updated_at);
                    seen[key] = Math.max(seen[key] || 0, updated);
                    var movieKeyValue = row.source + '_' + row.movie_id;
                    var currentMark = marks[movieKeyValue];
                    var currentMarkTime = currentMark ? syncTime(currentMark.t) : 0;
                    if (currentMarkTime >= updated) continue;

                    if (row.is_deleted) delete marks[movieKeyValue];
                    else marks[movieKeyValue] = { t: updated, title: row.title || '' };
                    movieChanged = true;
                }

                if (movieChanged) {
                    saveMovieMarks();
                    updateBadges();
                }
            } else if (table === 'series_torrent_resume') {
                var torrentItems = loadTorrents();
                var torrentsChanged = false;

                for (i = 0; i < rows.length; i++) {
                    row = rows[i] || {};
                    if (!row.source || !row.series_id || !row.magnet) continue;
                    key = syncQueueKey(table, row);
                    updated = syncTime(row.updated_at);
                    seen[key] = Math.max(seen[key] || 0, updated);
                    var torrentKeyValue = row.source + '_' + row.series_id;
                    var currentTorrent = torrentItems[torrentKeyValue];
                    if (currentTorrent && syncTime(currentTorrent.t) >= updated) continue;

                    torrentItems[torrentKeyValue] = {
                        title: row.title || '', magnet: row.magnet, link: '', hash: '',
                        season: toInt(row.season_number), episode: toInt(row.episode_number), t: updated
                    };
                    torrentsChanged = true;
                }

                if (torrentsChanged) saveTorrents();
            }

            refreshStatsScreen();
        }

        function syncAck(batch) {
            var items = syncLoadQueue();
            var sent = {};
            var kept = [];

            for (var i = 0; i < batch.length; i++) sent[batch[i].id] = true;
            for (i = 0; i < items.length; i++) if (!sent[items[i].id]) kept.push(items[i]);

            syncQueue = kept;
            syncSaveQueue();
        }

        function syncBatch() {
            var items = syncLoadQueue();
            var batch = [];
            var changes = { episode_progress: [], movie_watched_marks: [], series_torrent_resume: [] };

            var scope = syncNamespace();
            var profile = syncProfile();

            for (var i = 0; i < items.length && batch.length < SYNC_BATCH; i++) {
                var item = items[i];
                if (!item || !item.row || item.row.sync_id !== scope || String(item.row.profile_id) !== String(profile)) continue;
                if (!changes[item.table]) continue;
                batch.push(item);
                changes[item.table].push(item.row);
            }

            return { items: batch, changes: changes };
        }

        function syncPushPending(callback) {
            var batch = syncBatch();

            if (!batch.items.length) return callback();

            syncRequest(syncEndpoint(), syncCode(), {
                action: 'push', sync_id: syncNamespace(), profile_id: syncProfile(), device_id: syncDeviceId(), changes: batch.changes
            }, function (err, response) {
                if (err || !response || response.success !== true) {
                    syncLastError = err || 'sync_rejected';
                    return callback(syncLastError);
                }

                syncAck(batch.items);
                timers.set(function () { syncPushPending(callback); }, 0);
            });
        }

        function syncPullPage(cursor, callback, legacyOffset) {
            if (typeof legacyOffset !== 'number') legacyOffset = 0;
            var batch = !cursor || !cursor.__pushed ? syncBatch() : { items: [], changes: { episode_progress: [], movie_watched_marks: [], series_torrent_resume: [] } };
            var body = {
                action: 'sync', sync_id: syncNamespace(), profile_id: syncProfile(),
                device_id: syncDeviceId(), offset: legacyOffset || 0, cursor: cursor || {}, limit: SYNC_PAGE, changes: batch.changes
            };

            if (cursor && cursor.__pushed) delete cursor.__pushed;

            syncRequest(syncEndpoint(), syncCode(), body, function (err, response) {
                if (err || !response || response.success !== true) {
                    syncLastError = err || 'sync_rejected';
                    return callback(syncLastError);
                }

                if (batch.items.length) syncAck(batch.items);
                var data = response.data || {};
                syncApplyRows('episode_progress', data.episode_progress || []);
                syncApplyRows('movie_watched_marks', data.movie_watched_marks || []);
                syncApplyRows('series_torrent_resume', data.series_torrent_resume || []);

                var next = response.next;
                if (next && (next.episode_progress || next.movie_watched_marks || next.series_torrent_resume)) {
                    next.__pushed = true;
                    return timers.set(function () { syncPullPage(next, callback, legacyOffset); }, 0);
                }

                var more = response.more || {};
                if (!response.next && (more.episode_progress || more.movie_watched_marks || more.series_torrent_resume)) {
                    return timers.set(function () { syncPullPage({ __pushed: true }, callback, legacyOffset + SYNC_PAGE); }, 0);
                }

                syncQueueSnapshot();
                syncPushPending(callback);
            });
        }

        function syncNow() {
            if (syncBusy || !syncEndpoint() || !syncCode()) return false;

            syncBusy = true;
            syncRemoteSeen = { episode_progress: {}, movie_watched_marks: {}, series_torrent_resume: {} };
            syncPullPage({}, function (err) {
                syncBusy = false;
                syncLastError = err || '';

                if (!err) {
                    syncLastSuccess = clock();
                    log('sync complete', 'queued:', syncLoadQueue().length);
                } else {
                    log('sync error', err);
                    timers.set(function () { syncNow(); }, Math.min(SYNC_INTERVAL, 15000));
                }
            });

            return true;
        }

        function syncStart() {
            if (syncStarted) return;

            syncStarted = true;
            timers.set(syncNow, 6000);
            timers.interval(syncNow, SYNC_INTERVAL);

            try {
                if (win.addEventListener) win.addEventListener('online', syncNow, false);
            } catch (e) {}
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
                    ended: result.status === 'complete' ? Boolean(result.ended) : undefined,
                    title: card.original_name || card.name
                };
            }

            log('checked', id, card.original_name || card.name, '→', items[id].status, items[id].reason || '', items[id].nextAir ? 'next: ' + new Date(items[id].nextAir).toDateString() : '');

            saveCache();

            if ((prev && prev.ended) || items[id].ended) updateBadges();
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
                rememberStatsCard(movie);
                refreshStatsScreen();
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

                addContinueButton(movie, container);
                addSeriesPoster(movie, render);

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
        var statsScreenOpen = false;
        var statsScreenRegistered = false;
        var statsMetadata = [];

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

        function rememberStatsCard(card) {
            if (!isTvCard(card)) return;
            var identity = statsIdentity(card.source, 'tv', card.id);
            if (!identity) return;

            for (var i = 0; i < statsMetadata.length; i++) {
                if (statsIdentity(statsMetadata[i].source, 'tv', statsMetadata[i].id) === identity) {
                    statsMetadata[i] = card;
                    return;
                }
            }

            statsMetadata.push(card);
        }

        function viewingStats() {
            var timeline = {};
            var cards = [];

            try {
                var timelineApi = L().Timeline;
                var filename = timelineApi && typeof timelineApi.filename === 'function' ? timelineApi.filename() : 'file_view';
                timeline = L().Storage.get(filename, {});
                if (typeof timeline === 'string') timeline = JSON.parse(timeline || '{}');
            } catch (e) {
                timeline = {};
            }

            try {
                var favorite = L().Favorite;
                var history = favorite && typeof favorite.get === 'function' ? favorite.get({ type: 'history' }) : [];
                if (isArray(history)) cards = cards.concat(history);
            } catch (e) {}

            // Проверочный кеш хранит только название, поэтому из него берём лишь
            // однозначно японское название; латинское нельзя считать доказательством не-аниме.
            var cached = loadCache();
            for (var id in cached) {
                if (!Object.prototype.hasOwnProperty.call(cached, id)) continue;
                if (cached[id] && cached[id].title && JAPANESE_RE.test(cached[id].title)) {
                    cards.push({ id: id, source: 'tmdb', original_name: cached[id].title });
                }
            }

            cards = cards.concat(statsMetadata);

            return calculateStats(timeline, loadMovieMarks(), cards, threshold());
        }

        function statsSyncNote() {
            if (!syncEndpoint() || !syncCode()) return 'Показаны Timeline активного профиля и локальные отметки фильмов.';
            if (syncBusy) return 'Синхронизация загружает данные. Экран обновится по мере их получения.';
            if (syncLastError) return 'Последняя синхронизация завершилась с ошибкой; часть данных может отсутствовать.';
            if (!syncLastSuccess) return 'Серверная история ещё не загружена. После синхронизации статистика обновится.';
            return 'Показаны Timeline активного профиля и локальные отметки, объединённые с загруженными данными Supabase.';
        }

        function statsMarkup() {
            var data = viewingStats();
            var incomplete = data.unclassified || data.movies.missingDuration || data.series.missingDuration || data.anime.missingDuration;
            var warning = incomplete ? '<div class="hws-stats__warning">Часть истории не включена в точные подсчёты: записей без надёжной связи — ' + data.unclassified + '; просмотренных единиц без длительности — ' + (data.movies.missingDuration + data.series.missingDuration + data.anime.missingDuration) + '.</div>' : '<div class="hws-stats__note">Все найденные завершённые записи имеют подходящие данные для подсчёта.</div>';

            return '<div class="hws-stats">' +
                '<div class="hws-stats__cards">' +
                    '<div class="hws-stats__card"><div class="hws-stats__label">ФИЛЬМЫ</div><div class="hws-stats__value">' + data.movies.count + '</div></div>' +
                    '<div class="hws-stats__card"><div class="hws-stats__label">СЕРИАЛЫ</div><div class="hws-stats__value">' + data.series.count + '</div><div class="hws-stats__hint">без аниме</div></div>' +
                    '<div class="hws-stats__card"><div class="hws-stats__label">АНИМЕ</div><div class="hws-stats__value">' + data.anime.count + '</div></div>' +
                '</div>' +
                '<div class="hws-stats__episodes"><div class="hws-stats__label">ПРОСМОТРЕНО СЕРИЙ</div><div class="hws-stats__value">' + (data.series.episodes + data.anime.episodes) + '</div></div>' +
                '<div class="hws-stats__total"><div class="hws-stats__label">УЧТЁННАЯ ДЛИТЕЛЬНОСТЬ КОНТЕНТА</div><div class="hws-stats__total-value">' + formatStatsDurationOrUnknown(data.totalSeconds, data.movies.missingDuration + data.series.missingDuration + data.anime.missingDuration) + '</div></div>' +
                '<div class="hws-stats__breakdown">' +
                    '<div><span>Фильмы</span><strong>' + formatStatsDurationOrUnknown(data.movies.seconds, data.movies.missingDuration) + '</strong></div>' +
                    '<div><span>Сериалы</span><strong>' + formatStatsDurationOrUnknown(data.series.seconds, data.series.missingDuration) + '</strong></div>' +
                    '<div><span>Аниме</span><strong>' + formatStatsDurationOrUnknown(data.anime.seconds, data.anime.missingDuration) + '</strong></div>' +
                '</div>' + warning +
                '<div class="hws-stats__note">Фильм учитывается по отметке плагина или по Timeline от ' + threshold() + '%. Сериал и аниме — если есть хотя бы одна серия от этого порога. Время — сумма длительности уникальных завершённых записей, не фактическое время перед экраном.</div>' +
                '<div class="hws-stats__note">' + statsSyncNote() + '</div>' +
            '</div>';
        }

        function injectStatsStyle() {
            var d = doc();
            if (!d || d.getElementById('hws-stats-style')) return;
            var style = d.createElement('style');
            style.id = 'hws-stats-style';
            style.textContent = '.hws-stats{width:100%;max-width:58em;color:#f4f5f7;font-size:1em;line-height:1.35}.hws-stats__cards{display:flex;flex-wrap:wrap;gap:.75em}.hws-stats__card{box-sizing:border-box;flex:1 1 28%;min-width:9em;padding:1em;border-radius:.65em;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.08)}.hws-stats__label{font-size:.72em;letter-spacing:.11em;opacity:.68}.hws-stats__value{font-size:2.1em;font-weight:700;line-height:1.15;margin-top:.22em}.hws-stats__hint{font-size:.72em;opacity:.65}.hws-stats__episodes,.hws-stats__total{margin-top:.8em;padding:1em 1.15em;border-radius:.65em;background:rgba(255,255,255,.06)}.hws-stats__total{background:linear-gradient(110deg,rgba(0,200,83,.2),rgba(255,255,255,.06))}.hws-stats__total-value{font-size:1.8em;font-weight:700;margin-top:.2em}.hws-stats__breakdown{display:flex;flex-wrap:wrap;gap:.5em;margin-top:.6em}.hws-stats__breakdown div{box-sizing:border-box;flex:1 1 30%;min-width:9em;display:flex;justify-content:space-between;gap:.5em;padding:.85em 1em;border-radius:.55em;background:rgba(255,255,255,.045)}.hws-stats__warning,.hws-stats__note{margin-top:.75em;padding:.7em .9em;border-radius:.45em;background:rgba(255,255,255,.045);font-size:.78em;opacity:.8}.hws-stats__warning{border-left:.22em solid #f0ad4e;opacity:1}@media(max-width:800px){.hws-stats__card{flex-basis:44%}.hws-stats__breakdown div{flex-basis:100%}}';
            (d.head || d.body).appendChild(style);
        }

        function StatsScreen() {
            var html = win.$('<div class="hws-stats-screen">' + statsMarkup() + '</div>');

            this.create = function () {
                statsScreenOpen = true;
                injectStatsStyle();

                return this.render();
            };

            this.render = function () {
                return html;
            };

            this.start = function () {
                statsScreenOpen = true;
            };

            this.stop = function () {
                statsScreenOpen = false;
            };

            this.destroy = function () {
                statsScreenOpen = false;
            };
        }

        function registerStatsScreen() {
            var component = L().Component;

            if (!component || typeof component.add !== 'function') return false;
            if (statsScreenRegistered) return true;

            try {
                component.add('hide_watched_series_stats_screen', StatsScreen);
                statsScreenRegistered = true;

                return true;
            } catch (e) {
                log('statistics component registration error', e && e.message);

                return false;
            }
        }

        function showStats() {
            try {
                var activity = L().Activity;
                if (!registerStatsScreen() || !activity || typeof activity.push !== 'function') return notify('Раздел статистики не поддерживается этой версией Lampa');

                activity.push({ url: '', title: 'Статистика просмотра', component: 'hide_watched_series_stats_screen', page: 1 });
            } catch (e) {
                log('statistics open error', e && e.message);
                notify('Не удалось открыть статистику');
            }
        }

        function refreshStatsScreen() {
            if (!statsScreenOpen) return;
            try {
                var d = doc();
                var view = d && d.querySelector('.hws-stats');
                if (view) view.innerHTML = statsMarkup();
            } catch (e) {
                log('statistics refresh error', e && e.message);
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

            var match = /^([\w-]+)_(.+)$/.exec(key);
            if (match) {
                var stamp = clock();
                syncEnqueue('movie_watched_marks', syncPrepareRow('movie_watched_marks', {
                    source: match[1], movie_id: match[2], title: watched ? (card.title || card.original_title) : (before && before.title || ''),
                    marked_at: watched ? stamp : null, updated_at: syncIso(stamp), is_deleted: !watched
                }), stamp);
            }

            updateBadges();
            refreshStatsScreen();

            return Boolean(watched);
        }

        function toggleMovieWatched(card) {
            return setMovieWatched(card, !isMovieWatched(card));
        }

        function doc() {
            return win.document || null;
        }

        function isSeriesFinished(card) {
            if (!eligible(card)) return false;

            var entry = loadCache()[cardId(card)];

            if (!entry || !entry.ended) return false;

            return isFinished(entry, clock(), makeIsWatched(card), localEpisodes(card));
        }

        function isCardWatched(card) {
            return isMovieCard(card) ? isMovieWatched(card) : isSeriesFinished(card);
        }

        /**
         * Проверка сериала с карточки: запросы в TMDB только для тех, что уже начинали
         * смотреть. Без первой серии досмотренным сериал быть не может
         */
        function checkSeries(card) {
            if (!eligible(card)) return;

            var entry = loadCache()[cardId(card)];

            // Карточка отрисовывается часто: без сети не повторять запрос при каждой отрисовке
            if (entry && entry.errorAt && clock() - entry.errorAt < RETRY_TTL) return;

            if (entry || makeIsWatched(card)(1, 1)) enqueue(card);
        }

        function createBadge() {
            var badge = doc().createElement('div');

            badge.className = BADGE_CLASS;
            badge.setAttribute('aria-label', BADGE_TEXT);
            badge.title = BADGE_TEXT;
            badge.innerHTML = CHECK_ICON + '<span class="hws-watched-badge__label">' + BADGE_TEXT + '</span>';

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

            if (isTvCard(card)) checkSeries(card);

            var show = isCardWatched(card);

            syncBadge(view, show);

            if (!show) return;

            // Значки закладок Lampa (.card__icons) стоят вверху по центру: при них плашка опускается под них
            var badge = null;

            for (var i = 0; i < view.childNodes.length && !badge; i++) {
                if (hasClass(view.childNodes[i], BADGE_CLASS)) badge = view.childNodes[i];
            }

            var className = BADGE_CLASS;

            if (badge && badge.className !== className) badge.className = className;
        }

        function closestCard(node) {
            for (var n = node; n && n.nodeType === 1; n = n.parentNode) {
                if (hasClass(n, 'card')) return n;
            }

            return null;
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

                if (inside || roots.indexOf(roots[i]) !== i) continue;

                // Изменение внутри карточки (например, значки закладок) — обновить саму карточку
                var card = hasClass(roots[i], 'card') ? null : closestCard(roots[i].parentNode);

                if (card) applyCardBadge(card);
                else scanBadges(roots[i]);
            }
        }

        function onMutations(mutations) {
            for (var i = 0; i < mutations.length; i++) {
                var added = mutations[i].addedNodes || [];
                var target = mutations[i].target;

                // Значки закладок могли только убрать (innerHTML = ''): тогда новых узлов нет
                if (target && hasClass(target, 'card__icons-inner')) badgeRoots.push(target);

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
                // Зелёный треугольный уголок с белой галочкой, как на постерах Lampa
                '.' + BADGE_CLASS + '{position:absolute;top:0;right:0;z-index:3;width:3.5em;height:3.5em;pointer-events:none}',
                '.' + BADGE_CLASS + ':before{content:"";position:absolute;top:0;right:0;width:0;height:0;border-top:3.5em solid #00c853;border-left:3.5em solid transparent}',
                '.' + BADGE_CLASS + ' svg{position:absolute;top:.16em;right:.16em;width:1.35em;height:1.35em;display:block;color:#fff}',
                '.' + BADGE_CLASS + '__label{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}',
                '.full-start-new__poster .' + BADGE_CLASS + ',.full-start__poster .' + BADGE_CLASS + '{font-size:1.1em}',
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

        /* Страница фильма или сериала: плашка на постере, у фильма ещё и кнопка */

        var fullPoster = null;

        function updateFullPoster() {
            if (!fullPoster) return;

            try {
                var view = fullPoster.view;

                if (!view || !doc().body.contains(view)) {
                    fullPoster = null;

                    return;
                }

                var on = isCardWatched(fullPoster.movie);

                syncBadge(view, on);

                if (!fullPoster.button) return;

                fullPoster.button.toggleClass('hws-movie--on', on);
                fullPoster.button.find('span').text(on ? MOVIE_UNMARK_LABEL : MOVIE_MARK_LABEL);
            } catch (e) {
                log('full poster error', e && e.message);
            }
        }

        function posterView(render) {
            var poster = render.find('.full-start-new__poster');

            if (!poster.length) poster = render.find('.full-start__poster');

            return poster.length ? poster[0] : null;
        }

        function addSeriesPoster(movie, render) {
            fullPoster = { movie: movie, button: null, view: posterView(render) };

            checkSeries(movie);
            updateFullPoster();
        }

        function addMovieButton(movie, render, container) {
            if (container.find('.button--hws-movie').length) return;

            var jq = win.$ || win.jQuery;
            var on = isMovieWatched(movie);
            var button = jq('<div class="full-start__button selector button--hws-movie' + (on ? ' hws-movie--on' : '') + '">' +
                '<svg width="36" height="36" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1.5 12S5.5 4.5 12 4.5 22.5 12 22.5 12 18.5 19.5 12 19.5 1.5 12 1.5 12z" stroke="currentColor" stroke-width="2"/><path d="M8.5 12l2.5 2.5 4.5-5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
                '<span>' + (on ? MOVIE_UNMARK_LABEL : MOVIE_MARK_LABEL) + '</span></div>');

            var page = { movie: movie, button: button, view: posterView(render) };

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

        /* ---------- «Продолжить» с последнего торрента сериала ---------- */

        // Lampa не связывает раздачу с сериалом (torrents_view — только хеши), поэтому
        // плагин запоминает раздачу сам, когда с неё запускают серию
        var TORRENTS_KEY = 'hws_torrents';
        var TORRENTS_VERSION = 1;
        var TORRENTS_LIMIT = 200;
        // Запуск торрента считается тем же просмотром, если серия включена в течение этого времени
        var START_WINDOW = 6 * HOUR;
        // Сколько ждать список файлов после нажатия «Продолжить», чтобы поставить курсор
        var FOCUS_WINDOW = 2 * 60 * 1000;
        var torrentRecords = null;
        var lastStart = null;
        var pendingFocus = null;
        var listItems = [];
        var focusTimer = null;

        function seriesKey(card) {
            return markable(card) ? movieKey(card) : null;
        }

        function loadTorrents() {
            if (torrentRecords) return torrentRecords;

            torrentRecords = {};

            try {
                var ls = storage();
                var raw = ls ? ls.getItem(TORRENTS_KEY) : null;
                var parsed = raw ? JSON.parse(raw) : null;

                if (parsed && parsed.v === TORRENTS_VERSION && parsed.items && typeof parsed.items === 'object' && !isArray(parsed.items)) {
                    for (var key in parsed.items) {
                        var rec = parsed.items[key];

                        if (Object.prototype.hasOwnProperty.call(parsed.items, key) && rec && typeof rec === 'object' && (rec.link || rec.hash || rec.magnet)) torrentRecords[key] = rec;
                    }
                }
            } catch (e) {
                log('torrents: broken data ignored', e && e.message);
                torrentRecords = {};
            }

            return torrentRecords;
        }

        function saveTorrents() {
            try {
                var items = loadTorrents();
                var keys = Object.keys(items);

                if (keys.length > TORRENTS_LIMIT) {
                    keys.sort(function (a, b) {
                        return (items[a].t || 0) - (items[b].t || 0);
                    });

                    for (var i = 0; i < keys.length - TORRENTS_LIMIT; i++) delete items[keys[i]];
                }

                var ls = storage();

                if (ls) ls.setItem(TORRENTS_KEY, JSON.stringify({ v: TORRENTS_VERSION, items: items }));
            } catch (e) {
                log('torrents save error', e && e.message);
            }
        }

        function torrentRecord(card) {
            var key = seriesKey(card);

            return key ? loadTorrents()[key] || null : null;
        }

        function textValue(value) {
            return typeof value === 'string' && value.length ? value : '';
        }

        /**
         * Обёртка Lampa.Torrent.start(element, movie): запоминает выбранную раздачу.
         * Сохраняется она только при запуске серии (onenter), а не при простом открытии
         */
        function patchTorrentStart() {
            var torrent = L().Torrent;

            if (!torrent || typeof torrent.start !== 'function' || torrent.start.__hws) return;

            var original = torrent.start;
            var wrapped = function (element, movie) {
                try {
                    if (element && movie && seriesKey(movie)) {
                        lastStart = {
                            key: seriesKey(movie),
                            title: textValue(element.title) || textValue(element.Title),
                            magnet: textValue(element.MagnetUri),
                            link: textValue(element.Link),
                            t: clock()
                        };
                    }
                } catch (e) {}

                return original.apply(this, arguments);
            };

            wrapped.__hws = original;
            torrent.start = wrapped;
        }

        function onTorrentFile(e) {
            if (!e) return;

            try {
                if (e.type === 'list_open') {
                    listItems = [];
                } else if (e.type === 'render') {
                    if (pendingFocus && e.element && e.item) {
                        listItems.push({ element: e.element, item: e.item });

                        if (!focusTimer) focusTimer = timers.set(applyPendingFocus, 50);
                    }
                } else if (e.type === 'onenter') {
                    rememberTorrent(e.element);
                } else if (e.type === 'list_close') {
                    pendingFocus = null;
                    listItems = [];
                }
            } catch (err) {
                log('torrent event error', err && err.message);
            }
        }

        function rememberTorrent(element) {
            if (!element) return;

            var card = element.card;
            var key = seriesKey(card);
            var season = toInt(element.season);
            var episode = toInt(element.episode);

            if (!key || !(episode >= 1)) return;

            var items = loadTorrents();
            var prev = items[key] || {};
            var hashValue = textValue(element.torrent_hash);
            var record = {
                hash: hashValue || prev.hash || '',
                season: season >= 0 ? season : 1,
                episode: episode,
                t: clock()
            };

            // Ссылку на раздачу знает только Torrent.start; при открытии из «Моих торрентов» её нет
            if (lastStart && lastStart.key === key && clock() - lastStart.t <= START_WINDOW && (lastStart.magnet || lastStart.link)) {
                record.title = lastStart.title;
                record.magnet = lastStart.magnet;
                record.link = lastStart.link;
            } else if (prev.hash && prev.hash === record.hash) {
                record.title = prev.title;
                record.magnet = prev.magnet;
                record.link = prev.link;
            }

            items[key] = record;
            saveTorrents();

            var keyParts = /^([\w-]+)_(.+)$/.exec(key);
            if (keyParts && record.magnet) {
                syncEnqueue('series_torrent_resume', syncPrepareRow('series_torrent_resume', {
                    source: keyParts[1], series_id: keyParts[2], title: record.title || '', magnet: record.magnet,
                    season_number: record.season, episode_number: record.episode, updated_at: syncIso(record.t)
                }), record.t);
            }

            log('torrent remembered', key, 's' + record.season + 'e' + record.episode, record.magnet ? 'magnet' : record.link ? 'link' : 'hash only');
        }

        /**
         * Курсор на следующую серию: первая не досмотренная после последней досмотренной
         * (по прогрессу, который Lampa показывает в этом же списке)
         */
        function pickNextItem(entries, limit) {
            var list = [];

            for (var i = 0; i < entries.length; i++) {
                var el = entries[i].element || {};
                var episode = toInt(el.episode);

                if (!(episode >= 1)) continue;

                var percent = parseFloat(el.timeline && el.timeline.percent);

                list.push({
                    entry: entries[i],
                    season: toInt(el.season) >= 0 ? toInt(el.season) : 1,
                    episode: episode,
                    watched: !isNaN(percent) && percent >= limit,
                    order: i
                });
            }

            if (!list.length) return null;

            list.sort(function (a, b) {
                return a.season - b.season || a.episode - b.episode || a.order - b.order;
            });

            var lastWatched = -1;

            for (var j = 0; j < list.length; j++) {
                if (list[j].watched) lastWatched = j;
            }

            for (var k = lastWatched + 1; k < list.length; k++) {
                if (!list[k].watched) return list[k].entry;
            }

            // Всё досмотрено — курсор на последнюю серию раздачи
            return list[list.length - 1].entry;
        }

        function applyPendingFocus() {
            focusTimer = null;

            if (!pendingFocus || !listItems.length) return;

            if (clock() - pendingFocus.t > FOCUS_WINDOW) {
                pendingFocus = null;

                return;
            }

            try {
                var next = pickNextItem(listItems, threshold());
                var lampa = L();

                if (!next || !lampa.Controller || typeof lampa.Controller.collectionFocus !== 'function') return;

                var scroll = lampa.Modal && typeof lampa.Modal.scroll === 'function' ? lampa.Modal.scroll() : null;

                lampa.Controller.collectionFocus(next.item, scroll && scroll.render ? scroll.render() : undefined);

                log('torrent focus', 's' + next.element.season + 'e' + next.element.episode);
            } catch (e) {
                log('torrent focus error', e && e.message);
            }

            pendingFocus = null;
        }

        function pad2(n) {
            return (n < 10 ? '0' : '') + n;
        }

        function continueLabel(record) {
            return 'Продолжить: последняя серия ' + record.season + '×' + pad2(record.episode);
        }

        /**
         * Открыть ту же раздачу: по magnet/ссылке через Torrent.start (раздача заново
         * добавится в TorrServer), иначе по хешу через Torrent.open
         */
        function continueTorrent(card) {
            var record = torrentRecord(card);
            var torrent = L().Torrent;

            if (!record || !torrent) return false;

            pendingFocus = { key: seriesKey(card), t: clock() };
            listItems = [];

            if (record.magnet || record.link) {
                var element = { title: record.title || card.name || card.title || '', Title: record.title || '', poster: card.img || '' };

                if (record.magnet) element.MagnetUri = record.magnet;
                if (record.link) element.Link = record.link;

                torrent.start(element, card);
            } else if (record.hash && typeof torrent.open === 'function') {
                torrent.open(record.hash, card);
            } else {
                pendingFocus = null;

                return false;
            }

            log('torrent continue', seriesKey(card), record.magnet ? 'magnet' : record.link ? 'link' : 'hash');

            return true;
        }

        function addContinueButton(movie, container) {
            var record = torrentRecord(movie);

            if (!record || container.find('.button--hws-continue').length) return;

            var jq = win.$ || win.jQuery;
            var button = jq('<div class="full-start__button selector button--hws-continue">' +
                '<svg width="36" height="36" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 4.5v15l11-7.5z" fill="currentColor"/><path d="M19.5 4.5v15" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>' +
                '<span>' + continueLabel(record) + '</span></div>');

            button.on('hover:enter', function () {
                if (!continueTorrent(movie)) notify('Нет сохранённой раздачи для этого сериала');
            });

            // Сразу после «Смотреть»: до кнопки одно нажатие вправо
            var play = container.find('.button--play');

            if (play.length) play.after(button);
            else container.append(button);

            log('continue button added', seriesKey(movie), 's' + record.season + 'e' + record.episode);
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
                // Прогресс мог измениться: плашки сериалов пересчитываются по свежей истории
                updateBadges();
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
         * Lampa 3.x: ContentRows.call сначала формирует полный список callback-ов
         * по индексам зарегистрированных строк. После этого приоритетные строки
         * переставляются на первые позиции, не меняя порядок остальных.
         */
        function patchRows() {
            var rows = L().ContentRows;

            if (!rows || typeof rows.call !== 'function') return false;
            if (rows.call.__hws) return true;

            var original = rows.call;

            var wrapped = function (screen, params, calls) {
                var before = isArray(calls) ? calls.slice() : null;
                var favorite = L().Favorite;
                var originalContinues = favorite && favorite.continues;
                var originalSplice = before ? calls.splice : null;
                var hadOwnSplice = before && Object.prototype.hasOwnProperty.call(calls, 'splice');
                var continuePending = false;
                var main = screen === 'main';
                var result;

                if (main && before && typeof originalContinues === 'function') {
                    favorite.continues = function (type) {
                        var items = originalContinues.apply(this, arguments);

                        if (type === 'tv' && isArray(items) && items.length) continuePending = true;

                        return items;
                    };

                    calls.splice = function () {
                        var args = Array.prototype.slice.call(arguments);
                        var inserted = args.slice(2);

                        if (continuePending) {
                            for (var i = 0; i < inserted.length; i++) {
                                if (typeof inserted[i] === 'function') {
                                    inserted[i].__hws_native_continue_row = true;
                                    continuePending = false;
                                    break;
                                }
                            }
                        }

                        return originalSplice.apply(this, args);
                    };
                }

                try {
                    result = original.apply(this, arguments);
                } finally {
                    if (main && before) {
                        if (hadOwnSplice) calls.splice = originalSplice;
                        else delete calls.splice;
                        if (favorite && typeof originalContinues === 'function') favorite.continues = originalContinues;
                    }
                }

                if (before && (screen === 'main' || screen === 'category')) {
                    for (var i = 0; i < calls.length; i++) {
                        var fn = calls[i];

                        if (typeof fn === 'function' && !fn.__hws_row && before.indexOf(fn) === -1) calls[i] = wrapRow(fn, screen);
                    }
                }

                if (main && isArray(calls)) prioritizeMainRows(calls);

                return result;
            };

            wrapped.__hws = original;
            rows.call = wrapped;

            log('rows mode');

            return true;
        }

        function prioritizeMainRows(calls) {
            var favorite = [];
            var continued = [];
            var rest = [];

            for (var i = 0; i < calls.length; i++) {
                var call = calls[i];

                if (call && call.__hws_favorite_feed_row) favorite.push(call);
                else if (call && call.__hws_native_continue_row) continued.push(call);
                else rest.push(call);
            }

            var ordered = favorite.concat(continued, rest);

            if (ordered.length !== calls.length) return;

            calls.splice.apply(calls, [0, calls.length].concat(ordered));
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
            if (fn.__hws_favorite_feed_row) wrapped.__hws_favorite_feed_row = true;
            if (fn.__hws_native_continue_row) wrapped.__hws_native_continue_row = true;

            return wrapped;
        }

        function favoriteRows() {
            try {
                var favorite = L().Favorite;
                var list = favorite && typeof favorite.get === 'function' ? favorite.get({ type: 'book' }) : [];

                return isArray(list) ? list : [];
            } catch (e) {
                return [];
            }
        }

        function favoriteKey(card) {
            if (!card || !card.id) return null;
            if (isTvCard(card)) return 'tv|' + (seriesKey(card) || '');
            if (isMovieCard(card)) return 'movie|' + (movieKey(card) || '');

            return null;
        }

        function favoriteTimeline() {
            try {
                var timeline = L().Timeline;
                var filename = timeline && typeof timeline.filename === 'function' ? timeline.filename() : 'file_view';
                var data = L().Storage.get(filename, {});

                if (typeof data === 'string') data = JSON.parse(data || '{}');

                return data && typeof data === 'object' ? data : {};
            } catch (e) {
                return {};
            }
        }

        function favoriteLink(card) {
            try {
                var timeline = L().Timeline;

                if (timeline && typeof timeline.link === 'function') {
                    var tv = isTvCard(card);
                    var link = timeline.link(card, tv ? 1 : undefined, tv ? 1 : undefined);

                    // Timeline.link() infers media type from original_name. Do not
                    // trust a returned movie key for a TV favorite lacking that field.
                    if (link && link.card && ((tv && /(^|_)tv_[a-z0-9]+$/.test(link.card)) || (!tv && /(^|_)movie_[a-z0-9]+$/.test(link.card)))) return link;
                }
            } catch (e) {}

            return null;
        }

        function hasLinkedFavoriteProgress(card, timelineData) {
            var link = favoriteLink(card);

            if (!link || !link.card) return false;

            for (var hashValue in timelineData) {
                if (!Object.prototype.hasOwnProperty.call(timelineData, hashValue)) continue;
                var road = timelineData[hashValue];

                if (!road || typeof road !== 'object' || road.card !== link.card || (parseFloat(road.percent) || 0) <= 0) continue;

                if (isTvCard(card) && (toInt(road.season) < 1 || toInt(road.episode) < 1)) continue;

                return true;
            }

            return false;
        }

        function hasLegacyFavoriteProgress(card) {
            var timeline = L().Timeline;
            var titles = titleCandidates(card);
            var episodes = [];
            var seen = {};
            var i;

            if (!titles.length) return false;

            if (isTvCard(card)) {
                episodes.push({ season: 1, episode: 1 });

                try {
                    var local = localEpisodes(card);

                    for (i = 0; i < local.length; i++) {
                        var season = toInt(typeof local[i].season_number !== 'undefined' ? local[i].season_number : local[i].season);
                        var episode = toInt(typeof local[i].episode_number !== 'undefined' ? local[i].episode_number : local[i].episode);

                        if (season < 1 || episode < 1) continue;
                        episodes.push({ season: season, episode: episode });
                    }
                } catch (e) {}
            } else {
                episodes.push({ movie: true });
            }

            for (i = 0; i < episodes.length; i++) {
                var ref = episodes[i];
                var refKey = ref.movie ? 'movie' : ref.season + ':' + ref.episode;

                if (seen[refKey]) continue;
                seen[refKey] = true;

                for (var j = 0; j < titles.length; j++) {
                    var key = ref.movie ? titles[j] : episodeKey(ref.season, ref.episode, titles[j]);
                    var percent = percentOf(hash(key));

                    if (percent > 0) return true;
                }
            }

            if (timeline && typeof timeline.watchedEpisode === 'function' && isTvCard(card)) {
                try {
                    return (parseFloat(timeline.watchedEpisode(card, 1, 1)) || 0) > 0;
                } catch (e) {}
            }

            return false;
        }

        function favoriteHasStarted(card) {
            var key = favoriteKey(card);

            if (!key) return false;
            if (startedFavorites['$' + key]) return true;

            var timelineData = favoriteTimeline();
            var started = hasLinkedFavoriteProgress(card, timelineData) || hasLegacyFavoriteProgress(card);

            if (started) startedFavorites['$' + key] = true;

            return started;
        }

        function favoriteFeedItems() {
            var source = favoriteRows();
            var result = [];
            var seen = {};

            for (var i = 0; i < source.length; i++) {
                var card = source[i];
                var key = favoriteKey(card);

                if (!key || seen['$' + key] || favoriteHasStarted(card)) continue;

                seen['$' + key] = true;
                result.push(card);
            }

            return result;
        }

        function favoriteFeedRow() {
            var results = favoriteFeedItems();

            if (!results.length) return null;

            var row = { title: 'Избранное', results: results };
            row.__hws_favorite_feed = true;

            return row;
        }

        function addFavoriteRowToMain(rows) {
            if (!isArray(rows)) return rows;

            var result = rows.slice();
            var continueRow = null;
            var title = continueTitle();

            for (var i = result.length - 1; i >= 0; i--) {
                if (result[i] && result[i].__hws_favorite_feed) result.splice(i, 1);
                else if (!continueRow && title && result[i] && result[i].title === title) continueRow = result.splice(i, 1)[0];
            }

            var row = favoriteFeedRow();

            if (row) result.unshift(row);
            if (continueRow) result.splice(row ? 1 : 0, 0, continueRow);

            return result;
        }

        function patchLegacyMain() {
            var api = L().Api;
            var sources = api && api.sources;
            var source = sources && sources.tmdb;
            var target = source && typeof source.main === 'function' ? source : api;
            var method = source && typeof source.main === 'function' ? 'main' : 'main';

            if (!target || typeof target[method] !== 'function' || target[method].__hws_favorite_feed) return false;

            var original = target[method];
            var wrapped = function () {
                var result = original.apply(this, arguments);

                return addFavoriteRowToMain(result);
            };

            wrapped.__hws_favorite_feed = original;
            target[method] = wrapped;

            return true;
        }

        function registerFavoriteFeed() {
            if (favoriteFeedRegistered) return true;

            var rows = L().ContentRows;

            if (rows && typeof rows.add === 'function') {
                try {
                    rows.add({
                        name: 'hws_favorites',
                        title: 'Избранное',
                        index: 0,
                        screen: ['main'],
                        call: function () {
                            var row = favoriteFeedRow();

                            if (!row) return;

                            var feedCall = function (call) { call(row); };
                            feedCall.__hws_favorite_feed_row = true;

                            return feedCall;
                        }
                    });
                    favoriteFeedRegistered = true;

                    return true;
                } catch (e) {}
            }

            favoriteFeedRegistered = patchLegacyMain();

            return favoriteFeedRegistered;
        }

        function reconcileStartedFavorites() {
            var favorite = L().Favorite;
            var source = favoriteRows();
            var removed = false;

            if (!favorite || typeof favorite.remove !== 'function') return;

            for (var i = 0; i < source.length; i++) {
                var card = source[i];
                var key = favoriteKey(card);
                var started;

                if (!key || startedFavorites['$' + key]) continue;
                started = favoriteHasStarted(card);
                if (!started) continue;

                startedFavorites['$' + key] = true;

                try {
                    favorite.remove('book', card);
                } catch (e) {
                    log('favorite remove failed', key, e && e.message);
                }

                removed = true;
            }

            if (removed) refreshRows();
        }

        /* ---------- настройки в интерфейсе ---------- */

        function addSettings() {
            var api = L().SettingsApi;

            if (!api || typeof api.addComponent !== 'function') return;

            var component = 'hide_watched_series';
            var statsComponent = 'hide_watched_series_stats';

            try {
                api.addComponent({
                    component: component,
                    name: 'Просмотренные сериалы',
                    icon: '<svg width="36" height="36" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 5h18v11H3z" stroke="white" stroke-width="2"/><path d="M8 20h8" stroke="white" stroke-width="2"/><path d="M8.5 10.5l2.5 2.5 4.5-5" stroke="white" stroke-width="2"/></svg>'
                });

                api.addComponent({
                    component: statsComponent,
                    name: 'Статистика',
                    icon: '<svg width="36" height="36" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 19V9m5 10V5m5 14v-7m5 7V3" stroke="white" stroke-width="2" stroke-linecap="round"/></svg>'
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
                    param: { name: SETTINGS.syncUrl, type: 'input', values: {}, placeholder: 'https://<project>.supabase.co', 'default': '' },
                    field: { name: 'Supabase: адрес проекта или swift-task URL', description: 'URL функции формата https://<project>.supabase.co/functions/v1/swift-task' },
                    onChange: function () { scheduleSync(1000); }
                });

                api.addParam({
                    component: component,
                    param: { name: SETTINGS.syncCode, type: 'input', values: {}, placeholder: 'x-sync-code', 'default': '' },
                    field: { name: 'Supabase: код синхронизации', description: 'Значение заголовка x-sync-code; сохраняется только в хранилище Lampa на этом устройстве' },
                    onChange: function () { scheduleSync(1000); }
                });

                api.addParam({
                    component: component,
                    param: { name: SETTINGS.syncId, type: 'input', values: {}, placeholder: 'default', 'default': 'default' },
                    field: { name: 'Группа синхронизации', description: 'Одинаковое значение на устройствах, историю которых нужно объединить' },
                    onChange: function () { scheduleSync(1000); }
                });

                api.addParam({
                    component: component,
                    param: { name: 'hws_sync_now', type: 'button' },
                    field: { name: 'Синхронизировать сейчас', description: 'Отправить очередь и получить актуальную историю' },
                    onChange: function () {
                        if (!syncNow()) notify('Укажите адрес Supabase и код синхронизации');
                    }
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

                api.addParam({
                    component: statsComponent,
                    param: { name: 'hws_open_stats', type: 'button' },
                    field: { name: 'Открыть статистику', description: 'Уникальный контент и известная длительность Timeline' },
                    onChange: showStats
                });
            } catch (e) {
                log('settings error', e && e.message);
            }
        }

        /* ---------- запуск ---------- */

        function onTimelineUpdate(e) {
            if (!syncApplying) {
                try {
                    var data = e && e.data || {};
                    var road = data.road || {};

                    if (data.hash !== null && typeof data.hash !== 'undefined') {
                        var timelineRow = syncPrepareRow('episode_progress', {
                            timeline_hash: String(data.hash), percent: parseFloat(road.percent) || 0,
                            time: parseFloat(road.time) || 0, duration: parseFloat(road.duration) || 0,
                            profile: typeof road.profile === 'undefined' ? 0 : road.profile,
                            card: road.card || null, season: typeof road.season === 'undefined' ? null : road.season,
                            episode: typeof road.episode === 'undefined' ? null : road.episode,
                            updated_at: syncIso(road.updated || clock())
                        });
                        syncEnqueue('episode_progress', timelineRow, road.updated || clock());
                    }
                } catch (syncError) {
                    log('sync timeline queue error', syncError && syncError.message);
                }
            }

            var items = loadCache();

            for (var id in items) {
                if (Object.prototype.hasOwnProperty.call(items, id) && items[id].status === 'incomplete') items[id].dirty = true;
            }

            scheduleWarmup(5000);
            refreshStatsScreen();
            reconcileStartedFavorites();
        }

        function start() {
            if (started) return;

            started = true;

            try {
                var lampa = L();

                if (lampa.ContentRows && typeof lampa.ContentRows.call === 'function') mode = patchRows() ? 'rows' : 'none';
                else mode = patchLegacy() ? 'legacy' : 'none';

                registerFavoriteFeed();

                addSettings();

                try {
                    if (lampa.Timeline && lampa.Timeline.listener && typeof lampa.Timeline.listener.follow === 'function') {
                        lampa.Timeline.listener.follow('update', onTimelineUpdate);
                    }
                } catch (e) {}

                reconcileStartedFavorites();

                try {
                    if (lampa.Listener && typeof lampa.Listener.follow === 'function') lampa.Listener.follow('full', onFull);
                } catch (e) {}

                startBadges();
                syncStart();

                try {
                    patchTorrentStart();

                    if (lampa.Listener && typeof lampa.Listener.follow === 'function') lampa.Listener.follow('torrent_file', onTorrentFile);
                } catch (e) {}

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

                try {
                    if (ls) ls.removeItem(SYNC_QUEUE_KEY);
                } catch (e) {}
            },
            filterList: filterList,
            hideCard: hideCard,
            markAllAired: markAllAired,
            markMessage: markMessage,
            isMovieWatched: isMovieWatched,
            isSeriesFinished: isSeriesFinished,
            setMovieWatched: setMovieWatched,
            toggleMovieWatched: toggleMovieWatched,
            movieKey: movieKey,
            scanBadges: scanBadges,
            torrentRecord: torrentRecord,
            continueTorrent: continueTorrent,
            syncNow: syncNow,
            syncStatus: function () {
                return { enabled: Boolean(syncEndpoint() && syncCode()), queued: syncLoadQueue().length, busy: syncBusy, lastError: syncLastError, lastSuccess: syncLastSuccess };
            },
            syncQueue: function () { return syncLoadQueue(); },
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
