/*
 * Имитация окружения Lampa для тестов плагина.
 * Повторяет форму реальных API Lampa 2.3.0 (src/utils/favorite.js,
 * src/interaction/timeline.js, src/utils/api/tmdb.js, src/utils/timetable.js)
 * и Lampa 3.x (src/core/content_rows.js).
 */
'use strict';

const path = require('path');
const plugin = require(path.join(__dirname, '..', 'hide_watched_series.js'));

const DAY = 24 * 60 * 60 * 1000;

// Lampa.Utils.hash из lampa-source 2.3.0 (src/utils/math.js) — эталон
function lampaHash(input) {
    let str = (input || '') + '';
    let hash = 0;

    if (str.length == 0) return hash;

    for (let i = 0; i < str.length; i++) {
        let char = str.charCodeAt(i);

        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }

    return Math.abs(hash) + '';
}

function ymd(time) {
    const d = new Date(time);
    const p = (n) => (n < 10 ? '0' : '') + n;

    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/*
 * Минимальная модель jQuery и DOM для страницы сериала: $(html), find('.a, .b'),
 * append, before, on/trigger (кнопки Lampa реагируют на 'hover:enter'), add/removeClass.
 */
function fakeNode(className) {
    return { classes: (className || '').split(/\s+/).filter(Boolean), children: [], parent: null, handlers: {}, html: '' };
}

function wrap(nodes) {
    const w = {
        nodes,
        length: nodes.length,
        find(selector) {
            const names = selector.split(',').map((s) => s.trim().replace(/^\./, ''));
            const found = [];
            const walk = (n) => n.children.forEach((c) => {
                if (names.some((name) => c.classes.indexOf(name) >= 0)) found.push(c);
                walk(c);
            });

            nodes.forEach(walk);

            return wrap(found);
        },
        append(other) {
            other.nodes.forEach((c) => { c.parent = nodes[0]; nodes[0].children.push(c); });

            return w;
        },
        before(other) {
            const target = nodes[0];
            const siblings = target.parent.children;

            other.nodes.forEach((c) => { c.parent = target.parent; siblings.splice(siblings.indexOf(target), 0, c); });

            return w;
        },
        on(event, fn) {
            nodes.forEach((n) => (n.handlers[event] = n.handlers[event] || []).push(fn));

            return w;
        },
        trigger(event) {
            nodes.forEach((n) => (n.handlers[event] || []).forEach((fn) => fn({ target: n })));

            return w;
        },
        addClass(c) { nodes.forEach((n) => { if (n.classes.indexOf(c) < 0) n.classes.push(c); }); return w; },
        removeClass(c) { nodes.forEach((n) => { n.classes = n.classes.filter((x) => x !== c); }); return w; },
        hasClass(c) { return nodes.some((n) => n.classes.indexOf(c) >= 0); },
        index() { return nodes[0].parent.children.indexOf(nodes[0]); },
        text() { return nodes.map((n) => n.html.replace(/<[^>]+>/g, '')).join(''); }
    };

    return w;
}

function jq(html) {
    const m = /class="([^"]+)"/.exec(html);
    const node = fakeNode(m ? m[1] : '');

    node.html = html;

    return wrap([node]);
}

function memoryStorage(initial) {
    const map = Object.assign({}, initial || {});

    return {
        map,
        getItem: (k) => (Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null),
        setItem: (k, v) => { map[k] = String(v); },
        removeItem: (k) => { delete map[k]; }
    };
}

function subscribe() {
    const handlers = {};

    return {
        handlers,
        follow(name, fn) {
            name.split(',').forEach((n) => {
                (handlers[n] = handlers[n] || []).push(fn);
            });
        },
        send(name, data) {
            (handlers[name] || []).forEach((fn) => fn(data));
        },
        count(name) {
            return (handlers[name] || []).length;
        }
    };
}

/**
 * Фейковый TMDB: сериалы описываются датами выхода серий (смещение в днях
 * от «сейчас» на момент создания). details/last_episode_to_air/next_episode_to_air
 * вычисляются в момент запроса, как это делает TMDB.
 */
function createTmdb(env) {
    const shows = {};
    const log = [];

    function seasonAirDate(season) {
        const dated = season.episodes.filter((e) => e.air_date);

        return dated.length ? dated[0].air_date : null;
    }

    function details(show) {
        const now = env.now();
        const aired = [];
        const future = [];

        show.seasons.forEach((s) => {
            if (s.season_number < 1) return;

            s.episodes.forEach((e) => {
                if (!e.air_date) return;

                const t = plugin.Core.parseAirDate(e.air_date);

                (t <= now ? aired : future).push({ season_number: s.season_number, episode_number: e.episode_number, air_date: e.air_date, t });
            });
        });

        aired.sort((a, b) => a.t - b.t || a.season_number - b.season_number || a.episode_number - b.episode_number);
        future.sort((a, b) => a.t - b.t);

        const strip = (e) => e && { season_number: e.season_number, episode_number: e.episode_number, air_date: e.air_date };

        const out = {
            id: show.id,
            name: show.name,
            original_name: show.original_name,
            number_of_seasons: show.seasons.filter((s) => s.season_number >= 1).length,
            seasons: show.seasons.map((s) => ({
                season_number: s.season_number,
                episode_count: s.episodes.length,
                air_date: seasonAirDate(s)
            })),
            last_episode_to_air: strip(aired[aired.length - 1]) || null,
            next_episode_to_air: strip(future[0]) || null
        };

        if (show.patchDetails) show.patchDetails(out);

        return out;
    }

    return {
        shows,
        log,
        fail: false,
        failPaths: [],
        add(show) {
            shows[show.id] = show;
        },
        fetch(p, ok, fail) {
            log.push(p);

            if (this.fail || this.failPaths.some((f) => p.indexOf(f) === 0)) return fail('network');

            let m = /^tv\/(\d+)$/.exec(p);

            if (m) {
                const show = shows[m[1]];

                return show ? ok(details(show)) : fail('404');
            }

            m = /^tv\/(\d+)\/season\/(\d+)$/.exec(p);

            if (m) {
                const show = shows[m[1]];
                const season = show && show.seasons.find((s) => s.season_number == m[2]);

                if (!season || show.noSeasonData) return fail('404');

                return ok({ season_number: season.season_number, episodes: season.episodes.map((e) => Object.assign({ season_number: season.season_number }, e)) });
            }

            fail('404');
        }
    };
}

/**
 * Окружение Lampa. version: '2.3.0' — строка строится в Api.sources.*.category
 * через Favorite.continues(params.url); '3.x' — через ContentRows.
 */
function createEnv(opts) {
    opts = opts || {};

    let now = opts.now || new Date(2026, 9, 28, 12, 0, 0).getTime();
    const pending = [];
    const settings = Object.assign({}, opts.settings || {});
    const ls = opts.localStorage || memoryStorage();
    const timeline = {};
    const history = [];
    const viewed = [];
    const timetable = {};

    // Lampa хранит настройки и в памяти (readed), и в localStorage
    Object.keys(settings).forEach((k) => ls.setItem(k, String(settings[k])));

    const env = {
        now: () => now,
        advance(days) { now += days * DAY; },
        setNow(t) { now = t; },
        day: (offset) => ymd(now + offset * DAY),
        pending,
        ls,
        timeline,
        history,
        settings,
        timetable
    };

    env.tmdb = createTmdb(env);

    const updates = [];
    const linkIndex = {};

    env.updates = updates;

    // Timeline 2.3.0: view(hash) и update(params); в 3.x ещё link() и поиск по привязке
    const Timeline = {
        listener: subscribe(),
        view(hash, meta) {
            let v = timeline[hash];

            if (!v && opts.version === '3.x' && meta && meta.card) {
                const found = linkIndex[[meta.card, meta.season, meta.episode].join('|')];

                if (found) v = timeline[found];
            }

            return { hash, percent: v ? v.percent : 0, time: v ? v.time || 0 : 0, duration: v ? v.duration || 0 : 0, profile: 0 };
        },
        update(params) {
            if (params.hash == 0) return;

            updates.push(JSON.parse(JSON.stringify(params)));

            const road = timeline[params.hash] || {};

            road.percent = params.percent;

            ['time', 'duration', 'profile'].forEach((k) => { if (typeof params[k] !== 'undefined') road[k] = params[k]; });

            if (params.card) {
                road.card = params.card;
                road.season = params.season;
                road.episode = params.episode;
                linkIndex[[params.card, params.season, params.episode].join('|')] = params.hash;
            }

            timeline[params.hash] = road;
            Timeline.listener.send('update', { data: { hash: params.hash, road } });
        }
    };

    // копия Timeline.link из lampa-source 3.x (src/interaction/timeline.js)
    if (opts.version === '3.x') {
        Timeline.link = function (card, season, episode) {
            if (!card || !card.id) return null;

            const type = card.original_name ? 'tv' : 'movie';
            const source = (card.source || 'tmdb') + '';
            let key = type + '_' + card.id;

            if (source !== 'tmdb' && source !== 'cub') key = source + '_' + key;

            key = key.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 64);

            const result = { card: key };

            if (type == 'tv') {
                season = parseInt(season);
                episode = parseInt(episode);

                if (isNaN(season) || isNaN(episode)) return null;

                result.season = season;
                result.episode = episode;
            }

            return result;
        };

        Timeline.watchedEpisode = function (card, season, episode) {
            return Timeline.view(lampaHash([season, season > 10 ? ':' : '', episode, card.original_name || card.original_title].join('')), Timeline.link(card, season, episode)).percent;
        };
    }

    const Favorite = {
        listener: subscribe(),
        get(params) {
            if (params.type === 'history') return history.slice();
            if (params.type === 'viewed') return viewed.slice();

            return [];
        },
        // как continues() в lampa-source 2.3.0 (src/utils/favorite.js)
        continues(type) {
            return JSON.parse(JSON.stringify(history.filter((e) => (type == 'tv' ? (e.number_of_seasons || e.first_air_date) : !(e.number_of_seasons || e.first_air_date))).slice(0, 19))).map((e) => { e.check_new_episode = true; return e; });
        }
    };

    function rowsFromCategory(params, screen) {
        // упрощённая модель category() из src/utils/api/tmdb.js 2.3.0
        const books = ['movie', 'tv'].indexOf(params.url) > -1 ? Favorite.continues(params.url) : [];
        const rows = [
            { title: params.url == 'tv' ? 'Продолжить просмотр' : 'Вы смотрели', results: books },
            { title: 'Рекомендуем посмотреть', results: history.slice() },
            { title: 'Популярное', results: history.slice() }
        ];

        return rows;
    }

    const Lampa = {
        Listener: subscribe(),
        Storage: {
            // семантика Lampa.Storage.get: value = readed[name] ?? localStorage; value || empty || ''
            get(name, empty) {
                let v = Object.prototype.hasOwnProperty.call(settings, name) ? settings[name] : undefined;

                v = v || empty || '';

                if (v === 'true' || v === 'false') return v === 'true';
                if (/^\d+$/.test(v + '')) return parseInt(v, 10);

                return v;
            },
            set(name, value) {
                settings[name] = value;
                ls.setItem(name, typeof value === 'object' ? JSON.stringify(value) : String(value));
            },
            field(name) {
                return name === 'tmdb_lang' ? 'ru' : '';
            }
        },
        Utils: { hash: lampaHash },
        Timeline,
        Favorite,
        TimeTable: {
            get(card) {
                return timetable[card.id] || [];
            }
        },
        Lang: {
            translate(k) {
                return k === 'title_continue' ? 'Продолжить просмотр' : k;
            }
        },
        Manifest: { app_version: opts.version === '3.x' ? '3.4.4' : '2.3.0' },
        SettingsApi: {
            components: [],
            params: [],
            addComponent(c) { this.components.push(c); },
            addParam(p) { this.params.push(p); }
        },
        Noty: { show(text) { env.noty.push(text); } },
        // Activity.all(): элементы {component, activity}; refresh() как в 2.3.0/3.x
        Activity: {
            stack: [],
            all() { return this.stack; },
            active() { return this.stack[this.stack.length - 1]; }
        }
    };

    if (opts.version === '3.x') {
        const registered = [];

        Lampa.ContentRows = {
            add(row) { registered.push(row); },
            call(screen, params, calls) {
                registered.filter((r) => r.screen.indexOf(screen) >= 0).forEach((row) => {
                    const r = row.call(params, screen);

                    if (typeof r === 'function') calls.splice(row.index || 0, 0, r);
                });
            }
        };

        // как favorite.js 3.x: строка с внутренним списком
        Lampa.ContentRows.add({
            name: 'continue_watch',
            index: 1,
            screen: ['main', 'category'],
            call: (params, screen) => {
                const media = screen == 'main' ? 'tv' : params.url;
                const results = Favorite.continues(media === 'anime' ? 'tv' : media);

                if (!results.length) return;

                return (call) => call({ results, title: media == 'tv' || media == 'anime' ? 'Продолжить просмотр' : 'Вы смотрели' });
            }
        });

        Lampa.ContentRows.add({
            name: 'recomend',
            index: 2,
            screen: ['main', 'category'],
            call: () => (call) => call({ results: history.slice(), title: 'Рекомендуем посмотреть' })
        });

        env.buildScreen = function (screen, params) {
            const calls = [() => 'other'];
            const out = [];

            Lampa.ContentRows.call(screen, params || {}, calls);

            calls.forEach((fn) => {
                if (typeof fn === 'function') fn((json) => { if (json && json.results) out.push(json); });
            });

            return out;
        };
    } else {
        const tmdbSource = { category: (params) => rowsFromCategory(params, 'category'), main: () => [{ title: 'Сейчас смотрят', results: history.slice() }] };
        const cubSource = { category: (params) => rowsFromCategory(params, 'category'), main: () => [] };
        const sources = { tmdb: tmdbSource, cub: cubSource };

        Object.defineProperty(sources, 'tmdb', { get: () => tmdbSource });
        Object.defineProperty(sources, 'cub', { get: () => cubSource });

        Lampa.Api = {
            sources,
            category(params) {
                return (params.source && sources[params.source] ? sources[params.source] : sources.tmdb).category(params);
            },
            main(params) {
                return sources.tmdb.main(params);
            }
        };

        env.buildScreen = function (screen, params) {
            return screen === 'main' ? Lampa.Api.main(params || {}) : Lampa.Api.category(params || {});
        };
    }

    if (opts.mutate) opts.mutate(Lampa);

    const win = { Lampa, localStorage: ls, appready: opts.appready !== false, $: jq };

    env.win = win;
    env.Lampa = Lampa;
    env.noty = [];

    // Стек страниц: главная/«Сериалы» под открытой страницей сериала
    env.pushActivity = function (component) {
        const item = { component, refreshed: 0, activity: { refresh() { item.refreshed++; } } };

        Lampa.Activity.stack.push(item);

        return item;
    };

    /**
     * Открыть страницу сериала: разметка кнопок как в шаблонах full_start (old)
     * или full_start_new 2.3.0/3.x, затем Lampa.Listener 'full' → 'complite'
     */
    env.openFull = function (card, old) {
        const root = fakeNode('full-start');
        const container = fakeNode(old ? 'full-start__buttons' : 'full-start-new__buttons');

        root.children.push(container);
        container.parent = root;

        ['button--play', 'button--book', 'button--options'].forEach((c) => {
            const btn = fakeNode('full-start__button selector ' + c);

            btn.parent = container;
            container.children.push(btn);
        });

        const page = env.pushActivity('full');

        page.activity.render = () => wrap([root]);

        Lampa.Listener.send('full', { type: 'start', object: { activity: page.activity }, data: { movie: card } });
        Lampa.Listener.send('full', { type: 'complite', object: { activity: page.activity }, data: { movie: card } });

        const all = wrap([root]);

        return {
            root: all,
            button: all.find('.button--hws-mark'),
            press() { all.find('.button--hws-mark').trigger('hover:enter'); }
        };
    };

    env.install = function (extra) {
        return plugin.install(win, Object.assign({
            now: env.now,
            fetch: (p, ok, fail) => env.tmdb.fetch(p, ok, fail),
            timers: {
                // таймауты запросов (≥ 10 с) срабатывают позже ответов «сети»
                set: (fn, ms) => { (ms >= 10000 ? late : pending).push(fn); return pending.length + late.length; },
                interval: () => 0
            }
        }, extra || {}));
    };

    const late = [];

    // выполнить все отложенные задачи (очередь проверок, прогрев, ответы сети, затем таймауты)
    env.flush = function () {
        let guard = 0;

        while ((pending.length || late.length) && guard++ < 100000) (pending.length ? pending : late).shift()();

        if (guard >= 100000) throw new Error('flush: infinite loop');
    };

    env.watch = function (card, season, episode, percent, titleField) {
        const title = card[titleField || 'original_title'] || card.original_name;
        const key = [season, season > 10 ? ':' : '', episode, title].join('');
        const hash = lampaHash(key);

        timeline[hash] = { percent };
        Timeline.listener.send('update', { data: { hash, road: { percent } } });
    };

    env.continueTitles = function (screen, params) {
        const rows = env.buildScreen(screen || 'category', params || { url: 'tv' });
        const row = rows.find((r) => r.title === 'Продолжить просмотр');

        return row ? row.results.map((c) => c.original_name) : [];
    };

    /**
     * Сериал: seasons = [{n, eps:[смещения дат в днях | null]}]
     * Карточка в истории — как её сохраняет Lampa (Card() дописывает original_title).
     */
    env.addShow = function (id, name, seasons, extra) {
        extra = extra || {};

        const show = {
            id,
            name: extra.ruName || name,
            original_name: name,
            seasons: seasons.map((s) => ({
                season_number: s.n,
                episodes: s.eps.map((off, i) => ({ episode_number: (s.numbers ? s.numbers[i] : i + 1), air_date: off === null ? null : env.day(off), name: 'Ep ' + (i + 1) }))
            }))
        };

        env.tmdb.add(show);

        const card = Object.assign({
            id,
            source: 'tmdb',
            name: extra.ruName || name,
            original_name: name,
            original_title: name,
            original_language: extra.lang || 'en',
            first_air_date: '2020-01-01',
            number_of_seasons: show.seasons.filter((s) => s.season_number >= 1).length
        }, extra.card || {});

        if (!extra.notInHistory) history.push(card);

        return { show, card };
    };

    env.watchAll = function (card, show, percent, filter) {
        show.seasons.forEach((s) => {
            s.episodes.forEach((e) => {
                if (!e.air_date) return;
                if (plugin.Core.parseAirDate(e.air_date) > env.now()) return;
                if (filter && !filter(s.season_number, e.episode_number)) return;

                env.watch(card, s.season_number, e.episode_number, percent === undefined ? 100 : percent);
            });
        });
    };

    return env;
}

module.exports = { createEnv, memoryStorage, lampaHash, plugin, DAY, ymd };
