// sw.js — Read Zen service worker.
// Caching policy mirrors _headers (see that file's rationale):
//   - content-hashed index/dict shards are immutable -> cache-first forever
//   - text shards, search manifest, docs.txt are REWRITTEN UNDER UNCHANGED
//     NAMES between deploys (docId renumbering) -> network-first, short-lived
//     fallback only, so a redeploy can never serve stale docId->text mappings
//   - app shell (js/css/html) -> stale-while-revalidate (one reload behind)
//   - corpus XML from raw.githubusercontent.com -> stale-while-revalidate,
//     which is what makes previously-read texts available offline
// Not registered on localhost (see app.js) so local development stays live.

const CACHE = 'zl-v1';
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

function cacheFirst(request) {
    return caches.match(request).then((hit) => {
        if (hit) return hit;
        return fetch(request).then((resp) => {
            if (resp.ok) {
                const copy = resp.clone();
                caches.open(CACHE).then((c) => c.put(request, copy));
            }
            return resp;
        });
    });
}

function networkFirst(request) {
    return fetch(request).then((resp) => {
        if (resp.ok) {
            const copy = resp.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return resp;
    }).catch(() => caches.match(request));
}

function staleWhileRevalidate(request) {
    return caches.match(request).then((hit) => {
        const refresh = fetch(request).then((resp) => {
            if (resp.ok) {
                const copy = resp.clone();
                caches.open(CACHE).then((c) => c.put(request, copy));
            }
            return resp;
        }).catch(() => hit);
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
            event.respondWith(cacheFirst(req));
            return;
        }
        // Mutable-under-same-name search data: never serve stale across deploys.
        if (p.startsWith('/data/search/')) {
            event.respondWith(networkFirst(req));
            return;
        }
        // App shell.
        if (p.endsWith('.js') || p.endsWith('.css') || p.endsWith('.html') ||
            p.endsWith('.svg') || p === '/' || p === '/manifest.json') {
            event.respondWith(staleWhileRevalidate(req));
            return;
        }
        return; // other same-origin: browser default
    }

    // Corpus XML / titles / masters from GitHub raw: offline reading of visited texts.
    if (url.hostname === 'raw.githubusercontent.com') {
        event.respondWith(staleWhileRevalidate(req));
    }
});
