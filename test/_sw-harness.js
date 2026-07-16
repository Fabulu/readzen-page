// test/_sw-harness.js
//
// A minimal ServiceWorkerGlobalScope harness, so test/sw-behavior.test.js can
// EXECUTE sw.js rather than grep it. Helper module (leading `_`, precedent:
// test/_dom-shim.js, test/_search-fixtures.js) — it defines no tests.
//
// ── Why this exists (RECON_CONSOLIDATED.md §4) ────────────────────────────
// readzen.pages.dev served a real user a months-stale build for months while
// 519 tests passed. Recon 4's diagnosis: every service-worker test is a
// single-point-in-time content check, and *none of them execute sw.js at
// all*. A regex asserting `waitUntil` appears near `cacheFirst` passes on
// code that calls it on the wrong promise, in the wrong branch, or too late.
// The only test that could not have been fooled is one that runs the routing.
//
// ── How sw.js can be executed at all ──────────────────────────────────────
// Recon 4 recorded "importing it in Node throws" — true, and the reason is
// worth stating precisely, because it is also the way through: sw.js is a
// CLASSIC script (zero import/export statements) whose only free identifiers
// are `self`, `caches`, `fetch`, `Response` and `URL`. `import()` fails
// because those globals are absent, not because the file is un-runnable. So
// we compile the source as a function body whose PARAMETERS are those five
// names and pass in fakes. No node:vm (no cross-realm Promise/instanceof
// hazards), no dependencies, no edit to sw.js. If a future sw.js reaches for
// a global we do not inject, it throws a ReferenceError naming it — a loud,
// correct failure that says "extend the harness".
//
// ── The load-bearing design decision: cache I/O is a MACROTASK ────────────
// The bug this harness must be able to see is a RACE: an unheld `cache.put`
// is lost when the browser kills the worker after respondWith settles. Model
// cache writes as microtasks and the race is unlosable — a promise chain
// with no `waitUntil` still completes before any plausible "terminate", so
// broken code passes. So every cache/network operation here resolves through
// setTimeout (a macrotask), which is the honest shape of real I/O:
//
//   * work registered via event.waitUntil()  -> awaited by settleExtended(),
//     completes BEFORE the test terminates the worker -> the write lands.
//   * work NOT registered via waitUntil()    -> nothing holds it; terminate()
//     runs first (Promise.all([]) is a microtask) and the put, when its timer
//     finally fires, is DROPPED and recorded in env.droppedWrites.
//
// That is the browser's actual contract: waitUntil is the ONLY thing that
// extends a worker's life past respondWith. test/sw-behavior.test.js proves
// this discrimination has teeth with negative controls that mutate sw.js in
// memory and assert the harness catches the mutant.
//
// Fidelity limits are documented at the bottom of this file.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ORIGIN = 'https://readzen.pages.dev';

/** Resolve a possibly-relative URL against the worker's origin. */
export const abs = (u) => new URL(u, ORIGIN).href;

/** Cache keys are FULL urls, query string included — the real Cache API
 *  matches on the complete URL unless ignoreSearch is passed, and it is not.
 *  That exact property is what makes `?v=` cache-first correct: a changed
 *  shell is a changed URL, so it can never hit a stale entry. */
const keyOf = (r) => (typeof r === 'string' ? abs(r) : r.url);

/** One macrotask. See the header note — this is not incidental. */
const tick = () => new Promise((r) => setTimeout(r, 0));

const SW_URL = new URL('../sw.js', import.meta.url);

/** The checked-in sw.js source. Read lazily (never at module load) so that
 *  merely importing this helper has no side effects. */
export function readSwSource() {
    return readFileSync(fileURLToPath(SW_URL), 'utf8');
}

/** Minimal Response. sw.js touches: .ok, .clone(), Response.error(). */
export class SwResponse {
    constructor(body, init = {}) {
        this.body = body;
        this.status = 'status' in init ? init.status : 200;
        this.ok = this.status >= 200 && this.status < 300;
        this.type = init.type || 'basic';
        this.url = init.url || '';
    }
    clone() {
        return new SwResponse(this.body, { status: this.status, type: this.type, url: this.url });
    }
    /** A network-error Response: what respondWith must get instead of
     *  `undefined` on an unrecoverable miss. */
    static error() {
        return new SwResponse(null, { status: 0, type: 'error' });
    }
}

/** Minimal Request. sw.js touches: .url, .method, .mode. */
export function swRequest(url, { method = 'GET', mode = 'cors' } = {}) {
    return { url: abs(url), method, mode };
}

/** Minimal ExtendableEvent/FetchEvent.
 *  NOTE: a real respondWith(undefined) throws a TypeError at the browser.
 *  This one records instead of throwing, so a test can assert precisely what
 *  came back (`undefined` vs a Response) rather than reading a stack trace. */
class SwEvent {
    constructor(request) {
        this.request = request;
        this.responsePromise = undefined;
        this._responded = false;
        this._extended = [];
    }
    respondWith(p) {
        if (this._responded) throw new Error('respondWith() called twice for one event');
        this._responded = true;
        this.responsePromise = Promise.resolve(p);
        this.responsePromise.catch(() => {}); // tests await it explicitly
    }
    waitUntil(p) {
        this._extended.push(Promise.resolve(p));
    }
    /** Did the worker take over this request, or fall through to the browser? */
    get responded() {
        return this._responded;
    }
    /** How many promises were handed to waitUntil() — i.e. how much work the
     *  worker asked the browser to keep it alive for. */
    get extendedCount() {
        return this._extended.length;
    }
    /** Await exactly the lifetime the browser guarantees, and no more. */
    settleExtended() {
        return Promise.all(this._extended);
    }
}

/**
 * Compile and run sw.js against fake service-worker globals.
 *
 * @param {object}   [options]
 * @param {string}   [options.source]  sw.js source override (negative controls
 *                                     mutate the real source IN MEMORY; nothing
 *                                     is ever written to disk).
 * @param {Function} [options.network] (url) => ({status?, body?}) to resolve,
 *                                     or null/undefined to make fetch REJECT
 *                                     (a network error — a 404 is
 *                                     {status:404}, which RESOLVES not-ok,
 *                                     exactly as the real fetch does).
 */
export function loadServiceWorker(options = {}) {
    const listeners = new Map();
    const cacheStorage = new FakeCacheStorage();

    const env = {
        origin: ORIGIN,
        /** Every URL the worker asked the network for, in order. */
        fetchLog: [],
        /** Writes that arrived after the worker was terminated: the bug. */
        droppedWrites: [],
        skipWaitingCalls: 0,
        claimCalls: 0,
        terminated: false,
        network: options.network || ((url) => ({ status: 200, body: `body:${url}` })),
    };

    function FakeCache(name) {
        this.name = name;
        this.entries = new Map();
    }
    FakeCache.prototype.put = async function put(request, response) {
        await tick(); // a cache write is I/O; it does not land for free
        if (env.terminated) {
            env.droppedWrites.push(keyOf(request));
            return;
        }
        this.entries.set(keyOf(request), response);
    };
    FakeCache.prototype.match = async function match(request) {
        await tick();
        return this.entries.get(keyOf(request));
    };
    FakeCache.prototype.addAll = async function addAll(urls) {
        // Real addAll is all-or-nothing: any failed request rejects the whole
        // call (and so aborts install). PLAN §8.4 depends on this.
        const pairs = [];
        for (const u of urls) {
            const resp = await swFetch(u);
            if (!resp.ok) throw new TypeError(`addAll: request failed for ${u}`);
            pairs.push([abs(u), resp]);
        }
        await tick();
        if (env.terminated) {
            for (const [k] of pairs) env.droppedWrites.push(k);
            return;
        }
        for (const [k, v] of pairs) this.entries.set(k, v);
    };

    function FakeCacheStorage() {
        this.caches = new Map();
    }
    FakeCacheStorage.prototype.open = async function open(name) {
        await tick();
        if (!this.caches.has(name)) this.caches.set(name, new FakeCache(name));
        return this.caches.get(name);
    };
    FakeCacheStorage.prototype.keys = async function keys() {
        await tick();
        return [...this.caches.keys()];
    };
    FakeCacheStorage.prototype.delete = async function del(name) {
        await tick();
        return this.caches.delete(name);
    };
    /** CacheStorage.match searches every cache, oldest first. */
    FakeCacheStorage.prototype.match = async function match(request) {
        await tick();
        for (const c of this.caches.values()) {
            const hit = c.entries.get(keyOf(request));
            if (hit) return hit;
        }
        return undefined;
    };

    async function swFetch(input) {
        const url = keyOf(input);
        env.fetchLog.push(url);
        await tick(); // the network is not free either
        const spec = env.network(url);
        if (!spec) throw new TypeError(`Failed to fetch: ${url}`); // network error
        return new SwResponse(spec.body, { status: spec.status ?? 200, url });
    }

    const selfObj = {
        location: { origin: ORIGIN, href: `${ORIGIN}/sw.js` },
        addEventListener(type, fn) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(fn);
        },
        skipWaiting() {
            env.skipWaitingCalls++;
            return Promise.resolve();
        },
        clients: {
            claim() {
                env.claimCalls++;
                return Promise.resolve();
            },
        },
        registration: {},
    };

    // ── Run sw.js ─────────────────────────────────────────────────────────
    // The five free identifiers become parameters. A ReferenceError here
    // means sw.js grew a new global dependency: extend this list.
    const source = options.source ?? readSwSource();
    const factory = new Function('self', 'caches', 'fetch', 'Response', 'URL', source);
    factory(selfObj, cacheStorage, swFetch, SwResponse, URL);

    function fire(type, event) {
        const fns = listeners.get(type) || [];
        if (fns.length === 0) throw new Error(`sw.js registered no '${type}' listener`);
        for (const fn of fns) fn(event);
        return event;
    }

    env.listenerTypes = () => [...listeners.keys()].sort();
    env.dispatchInstall = () => fire('install', new SwEvent(undefined));
    env.dispatchActivate = () => fire('activate', new SwEvent(undefined));
    env.dispatchFetch = (request) => fire('fetch', new SwEvent(request));

    /** The browser kills the worker. Anything not held by waitUntil is lost:
     *  a put arriving after this point is dropped, exactly as in production. */
    env.terminate = () => {
        env.terminated = true;
    };

    /** Let pending timers run — i.e. give un-held work every chance to land,
     *  so that a test asserting a write was LOST cannot pass by being hasty. */
    env.flush = async (n = 4) => {
        for (let i = 0; i < n; i++) await tick();
    };

    env.cacheNames = () => [...cacheStorage.caches.keys()].sort();
    env.cacheEntry = (name, url) => cacheStorage.caches.get(name)?.entries.get(abs(url));
    env.anyCacheHas = (url) =>
        [...cacheStorage.caches.values()].some((c) => c.entries.has(abs(url)));

    /** Test setup only: plant entries directly (no ticks, no terminate check). */
    env.seedCache = (name, entries) => {
        if (!cacheStorage.caches.has(name)) cacheStorage.caches.set(name, new FakeCache(name));
        const c = cacheStorage.caches.get(name);
        for (const [u, body] of Object.entries(entries)) {
            c.entries.set(abs(u), new SwResponse(body, { url: abs(u) }));
        }
    };

    return env;
}

/**
 * Replace `from` with `to`, but only inside `function <fnName>(...) {...}`.
 * Used by the negative controls to build a deliberately-broken sw.js in
 * memory. Scoped to one function because sw.js contains byte-identical
 * `event.waitUntil(caches.open(CACHE)...)` lines in more than one place, and
 * a bare String.replace silently hitting "whichever came first" is precisely
 * the kind of accident these tests exist to prevent.
 * Throws (loudly, by design) if the target has moved — a refactor should
 * break the control rather than silently neuter it.
 */
export function mutateWithin(source, fnName, from, to) {
    const start = source.indexOf(`function ${fnName}(`);
    if (start < 0) throw new Error(`mutateWithin: function ${fnName}() not found in sw.js`);
    const end = source.indexOf('\n}', start); // closing brace at column 0
    if (end < 0) throw new Error(`mutateWithin: end of ${fnName}() not found`);
    const body = source.slice(start, end);
    if (!body.includes(from)) {
        throw new Error(
            `mutateWithin: target not found inside ${fnName}():\n  ${from}\n` +
                'sw.js was refactored — update this negative control so it keeps discriminating.'
        );
    }
    return source.slice(0, start) + body.replace(from, to) + source.slice(end);
}

// ── What this harness CANNOT catch ────────────────────────────────────────
// It is a model of the SW spec, not the spec. Specifically:
//   * Real termination is wall-clock and browser-discretionary; here it is a
//     flag the test sets at the one moment the contract permits. A `put` that
//     is unheld but happens to be fast still lands in production sometimes —
//     the bug is a race, and this harness pins the losing side of it.
//   * No real HTTP: `_headers` (Cache-Control, the comma-join trap), the CF
//     edge, and tiered caching are entirely outside it. Browser HTTP cache vs
//     Cache API interaction is not modeled.
//   * Cache.match option handling (ignoreSearch/ignoreVary), Vary, Range,
//     opaque responses, quota eviction, and clients/postMessage are absent.
//   * Registration, update-check timing, and the install->waiting->activate
//     state machine are not modeled: tests dispatch lifecycle events directly.
//     "Does a new sw.js actually reach the user" is a deploy property, not a
//     property of this file (PLAN §7 covers it with live curl checks).
//   * It executes the sw.js ON DISK. It says nothing about the stamped copy
//     build/make-dist.js emits into dist/ (that is test/make-dist.test.js).
