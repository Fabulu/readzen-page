// sw.js — Read Zen service worker.
// Caching policy mirrors _headers (see that file's rationale):
//   - content-hashed index/dict shards are immutable -> cache-first forever
//   - text shards, search manifest, docs.txt are REWRITTEN UNDER UNCHANGED
//     NAMES between deploys (docId renumbering) -> network-first, short-lived
//     fallback only, so a redeploy can never serve stale docId->text mappings
//   - dual-mode app shell (app.js/style.css/views/lib):
//       * unversioned requests (raw-tree deploys) -> network-first, under the
//         server's no-cache headers; a deploy is live at once, at the cost of
//         a cheap 304 per shell file per full page load
//       * ?v=-stamped requests (when stamped — dist deploys) -> cache-first
//         forever; the URL names the build, so a changed shell is a changed
//         URL and the cache can never go stale
//   - index.html and navigations -> ALWAYS network-first; this is the one
//     entry point that must always be fresh, because when stamped it is what
//     names the current ?v=
//   - corpus XML from raw.githubusercontent.com -> stale-while-revalidate,
//     which is what makes previously-read texts available offline
// Not registered on localhost (see app.js) so local development stays live.
//
// ── The bug this design exists to prevent ─────────────────────────────────
// A service worker only reinstalls when ITS OWN BYTES change. This file sat
// unchanged for 27 deploys, so `install` never re-ran (precache never
// refreshed), `activate` never re-ran (old cache never cleaned), and returning
// visitors were served a months-old shell until they hard-reloaded. Since
// app.js imports views/*.js and lib/*.js, the whole application froze together.
// Stale-while-revalidate could not save it either: its background refresh was
// never wrapped in event.waitUntil(), so the browser was free to kill the
// worker before the cache.put landed.
//
// ── Two deploy modes, one file ────────────────────────────────────────────
// Raw-tree deploys ship the shell unversioned: PRECACHE below lists plain
// paths, and every shell fetch is network-first under the server's no-cache
// headers (see _headers) — correct, just not instant. When the shell is
// stamped by build/make-dist.js (dist deploys), every reference gains
// ?v=<BUILD_ID> — a hash of the shell's own contents — and this file's own
// BUILD constant is stamped too, so its bytes change whenever the shell does.
// That is what makes a new worker install, skipWaiting, and have activate
// drop every cache that is not the current build — which is also what
// unsticks clients frozen on an older cache: new bytes -> install ->
// skipWaiting -> activate -> old caches deleted. No hard reload needed, in
// either mode, because /sw.js itself is always no-cache.
const BUILD = 'dev';
const CACHE = `zl-${BUILD}`;
const PRECACHE = [
    '/',
    '/index.html',
    '/style.css',
    '/app.js',
    '/manifest.json',
    '/assets/icon.svg',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

function cacheFirst(event) {
    const request = event.request;
    return caches.match(request).then((hit) => {
        if (hit) return hit;
        return fetch(request).then((resp) => {
            if (resp.ok) {
                const copy = resp.clone();
                event.waitUntil(caches.open(CACHE).then((c) => c.put(request, copy)));
            }
            return resp;
        });
    });
}

// Network wins; the cache is only a fallback for offline/failed requests.
// A navigation that misses falls back to the precached shell so deep links
// still open offline.
function networkFirst(event) {
    const request = event.request;
    return fetch(request).then((resp) => {
        if (resp.ok) {
            const copy = resp.clone();
            event.waitUntil(caches.open(CACHE).then((c) => c.put(request, copy)));
        }
        return resp;
    }).catch(() =>
        caches.match(request)
            .then((hit) => hit || (request.mode === 'navigate' ? caches.match('/index.html') : null))
            // The navigate branch can miss too: caches.match resolves undefined when
            // /index.html has been evicted under quota pressure. Coalesce EVERY path
            // here — respondWith(undefined) is a TypeError and a hard-failed
            // navigation, which is worse than an honest network error.
            .then((r) => r || Response.error())
    );
}

// Serve the cached copy at once, refresh in the background. The refresh MUST be
// held open with event.waitUntil() — without it the browser may terminate the
// worker as soon as respondWith settles, aborting the put and pinning the entry
// forever. That is precisely how the shell went stale for months.
function staleWhileRevalidate(event) {
    const request = event.request;
    return caches.match(request).then((hit) => {
        const refresh = fetch(request).then((resp) => {
            if (resp.ok) {
                const copy = resp.clone();
                return caches.open(CACHE).then((c) => c.put(request, copy)).then(() => resp);
            }
            return resp;
        }).catch(() => hit);
        event.waitUntil(refresh);
        return hit || refresh;
    });
}

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);

    if (url.origin === self.location.origin) {
        const p = url.pathname;
        // Content-hashed shards: immutable by construction (filename = content hash).
        if (p.startsWith('/data/search/bigram/shards/') ||
            p.startsWith('/data/search/bigram/unigram/') ||
            p.startsWith('/dict/')) {
            event.respondWith(cacheFirst(event));
            return;
        }
        // Mutable-under-same-name search data: never serve stale across deploys.
        if (p.startsWith('/data/search/')) {
            event.respondWith(networkFirst(event));
            return;
        }
        // Versioned shell requests (dist deploys stamp ?v=<BUILD_ID> onto these
        // URLs, when stamped): the URL names the content, so cache-first is both
        // safe and correct — a changed shell is a changed URL, never this one.
        if (url.searchParams.has('v') &&
            (p === '/app.js' || p === '/style.css' ||
             p.startsWith('/views/') || p.startsWith('/lib/'))) {
            event.respondWith(cacheFirst(event));
            return;
        }
        // App shell + navigations. Network-first: the shell must never be stale
        // while online (see the header note). Cache is the offline fallback.
        if (req.mode === 'navigate' ||
            p.endsWith('.js') || p.endsWith('.css') || p.endsWith('.html') ||
            p.endsWith('.svg') || p === '/' || p === '/manifest.json') {
            event.respondWith(networkFirst(event));
            return;
        }
        return; // other same-origin: browser default
    }

    // Corpus XML / titles / masters from GitHub raw: offline reading of visited
    // texts. Stale-while-revalidate is right here — the canonical texts are
    // effectively immutable, and instant re-reads are the point.
    if (url.hostname === 'raw.githubusercontent.com') {
        event.respondWith(staleWhileRevalidate(event));
    }
});
