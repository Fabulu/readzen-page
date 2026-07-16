// test/sw-behavior.test.js
//
// Behavioural tests for sw.js. These EXECUTE the worker (see
// test/_sw-harness.js) and assert what it does, not what it looks like.
//
// ── Why this file exists ──────────────────────────────────────────────────
// readzen.pages.dev served a real user a months-stale app for months. 519
// tests passed the whole time. Recon 4's post-mortem (RECON_CONSOLIDATED.md
// §4): every service-worker test was a single-point-in-time content check
// against one commit, none modelled a cross-build invariant, and — the root
// of it — NONE OF THEM EVER RAN sw.js. Three fixes landed in phase 1
// (PLAN_v1.md §3, step 1.1) and nothing tested any of them; they were free to
// rot back out. `cacheFirst`'s missing `event.waitUntil` in particular had
// already survived TWO passes over this file (recon 1: "networkFirst and
// staleWhileRevalidate were fixed; this one was not"), which is exactly the
// evidence that reading the code is not a control.
//
// ── The three pinned fixes (PLAN §6.4) ────────────────────────────────────
//   1. cacheFirst holds its cache.put open with event.waitUntil() — the same
//      bug class that caused the incident.
//   2. The ?v= versioned-shell branch is reached BEFORE the generic shell /
//      navigate branch. If it is not, versioned assets silently fall back to
//      network-first: no error, no symptom, phase 2's entire speed win gone.
//   3. networkFirst never resolves respondWith with bare `undefined`.
// Plus the routing invariants whose regression is equally silent: activate
// evicting foreign caches (what unsticks frozen clients), install's
// skipWaiting, and the raw.githubusercontent.com SWR branch (offline reading)
// living outside the same-origin block.
//
// ── Negative controls ─────────────────────────────────────────────────────
// A test that cannot fail is decoration. Each of the two subtlest assertions
// is paired with a control that mutates sw.js IN MEMORY (never on disk) and
// asserts this harness catches the mutant. If a control ever goes green
// without its mutation applying, mutateWithin() throws rather than passing.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    loadServiceWorker,
    readSwSource,
    mutateWithin,
    swRequest,
    abs,
} from './_sw-harness.js';

/** Dispatch install and return the one cache name the worker uses (i.e.
 *  `zl-${BUILD}`), read from behaviour rather than hardcoded — build/make-dist.js
 *  stamps BUILD, so no test may assume the literal 'dev'. */
async function installAndGetCacheName(env) {
    const ev = env.dispatchInstall();
    await ev.settleExtended();
    const names = env.cacheNames();
    assert.equal(names.length, 1, `expected exactly one cache after install, got ${names.join(', ')}`);
    return names[0];
}

// ── sanity: the harness really is running the real worker ─────────────────

test('sanity: sw.js executes and registers install, activate and fetch listeners', () => {
    const env = loadServiceWorker();
    assert.deepEqual(env.listenerTypes(), ['activate', 'fetch', 'install']);
});

// ── FIX 1 — cacheFirst holds its cache.put open with event.waitUntil() ────

test('cacheFirst: the cache write survives worker termination (it is held by event.waitUntil)', async () => {
    // THE incident bug class. Without waitUntil the browser is free to kill
    // the worker the moment respondWith settles, aborting cache.put and
    // pinning the entry forever. Modelled honestly: the harness ends the
    // worker's life at exactly the moment the spec allows — after the
    // waitUntil promises settle — and drops any write arriving later.
    const env = loadServiceWorker();
    const ev = env.dispatchFetch(swRequest('/app.js?v=abc12345'));

    const resp = await ev.responsePromise;
    assert.equal(resp.body, `body:${abs('/app.js?v=abc12345')}`);

    // The direct evidence: the worker asked to be kept alive for the write.
    assert.equal(ev.extendedCount, 1, 'cacheFirst must pass its cache.put to event.waitUntil()');

    await ev.settleExtended(); // the ONLY lifetime the browser guarantees
    env.terminate();
    await env.flush(); // give any unheld work every chance to land anyway

    assert.ok(env.anyCacheHas('/app.js?v=abc12345'), 'cacheFirst lost its cache write on termination');
    assert.deepEqual(env.droppedWrites, [], 'a cache write arrived after the worker was killed');
});

test('negative control: stripping cacheFirst\'s event.waitUntil makes the write vanish', async () => {
    // Proves the assertion above has teeth — that it is testing the worker's
    // lifetime handling and not merely that a promise eventually resolves.
    // This is the mutation a future refactor could plausibly make.
    const mutated = mutateWithin(
        readSwSource(),
        'cacheFirst',
        'event.waitUntil(caches.open(CACHE).then((c) => c.put(request, copy)));',
        'caches.open(CACHE).then((c) => c.put(request, copy));'
    );
    const env = loadServiceWorker({ source: mutated });
    const ev = env.dispatchFetch(swRequest('/app.js?v=abc12345'));

    await ev.responsePromise;
    assert.equal(ev.extendedCount, 0, 'mutation did not apply');

    await ev.settleExtended();
    env.terminate();
    await env.flush();

    assert.equal(env.anyCacheHas('/app.js?v=abc12345'), false, 'harness failed to model the lost write');
    assert.deepEqual(env.droppedWrites, [abs('/app.js?v=abc12345')]);
});

// ── FIX 2 — the ?v= branch is REACHED before the generic shell branch ─────

test('routing: a ?v=-stamped shell asset is served cache-first (one network fetch for two requests)', async () => {
    // Branch ORDER, asserted by consequence. If the generic shell/navigate
    // branch (which matches p.endsWith('.js') and would swallow /app.js?v=..)
    // ran first, this URL would be network-first: two requests, two fetches,
    // no error, no symptom — just phase 2's entire win silently gone.
    const env = loadServiceWorker();

    const ev1 = env.dispatchFetch(swRequest('/app.js?v=abc12345'));
    await ev1.responsePromise;
    await ev1.settleExtended();

    const ev2 = env.dispatchFetch(swRequest('/app.js?v=abc12345'));
    const r2 = await ev2.responsePromise;

    assert.equal(env.fetchLog.length, 1, `?v= assets must be cache-first; network was hit ${env.fetchLog.length}x`);
    assert.equal(r2.body, `body:${abs('/app.js?v=abc12345')}`, 'second request must be served from cache');
});

test('routing: every ?v= shell prefix (app.js, style.css, views/, lib/) is cache-first', async () => {
    for (const path of ['/app.js?v=abc12345', '/style.css?v=abc12345', '/views/passage.js?v=abc12345', '/lib/tei.js?v=abc12345']) {
        const env = loadServiceWorker();
        const ev1 = env.dispatchFetch(swRequest(path));
        await ev1.responsePromise;
        await ev1.settleExtended();
        const ev2 = env.dispatchFetch(swRequest(path));
        await ev2.responsePromise;
        assert.equal(env.fetchLog.length, 1, `${path} must be cache-first, hit network ${env.fetchLog.length}x`);
    }
});

test('routing: an UNVERSIONED shell asset stays network-first (the dual-mode contract)', async () => {
    // The other half of PLAN §3's dual-mode worker: raw-tree deploys ship the
    // shell unstamped and MUST revalidate every load. If this ever went
    // cache-first, a raw deploy would reproduce the original months-stale
    // freeze — the exact incident.
    const env = loadServiceWorker();

    const ev1 = env.dispatchFetch(swRequest('/app.js'));
    await ev1.responsePromise;
    await ev1.settleExtended();

    const ev2 = env.dispatchFetch(swRequest('/app.js'));
    await ev2.responsePromise;

    assert.equal(env.fetchLog.length, 2, 'unversioned /app.js must be network-first (no-cache mode)');
});

test('negative control: an unreachable ?v= branch is caught (this is the order assertion)', async () => {
    // Reordering the two branches makes the ?v= branch dead code — observably
    // identical to its condition never holding. Mutating the condition is the
    // robust way to build that mutant, and it fails the cache-first assertion
    // above, which is what proves that assertion detects a reorder.
    const src = readSwSource();
    const mutated = src.replace("url.searchParams.has('v')", 'false');
    assert.notEqual(mutated, src, "mutation target url.searchParams.has('v') not found");

    const env = loadServiceWorker({ source: mutated });
    const ev1 = env.dispatchFetch(swRequest('/app.js?v=abc12345'));
    await ev1.responsePromise;
    await ev1.settleExtended();
    const ev2 = env.dispatchFetch(swRequest('/app.js?v=abc12345'));
    await ev2.responsePromise;

    assert.equal(env.fetchLog.length, 2, 'harness failed to detect an unreachable ?v= branch');
});

test('source: the ?v= branch precedes the generic shell/navigate branch', () => {
    // Cheap complement to the behavioural pair above (house precedent:
    // pwa.test.js's hashed-shard order check). Behaviour is the real
    // assertion; this one names the failure exactly when someone reorders.
    const src = readSwSource();
    const iVersioned = src.indexOf("url.searchParams.has('v')");
    const iGeneric = src.indexOf("req.mode === 'navigate'");
    assert.ok(iVersioned >= 0, 'versioned-shell branch not found');
    assert.ok(iGeneric >= 0, 'generic shell/navigate branch not found');
    assert.ok(iVersioned < iGeneric, 'the ?v= versioned-shell branch must precede the generic shell/navigate branch');
});

// ── FIX 3 — networkFirst never resolves respondWith with `undefined` ──────

test('networkFirst: a non-navigate cache miss with a dead network yields Response.error(), never undefined', async () => {
    // respondWith(undefined) is a TypeError at the browser, i.e. a hard
    // failure of the request the worker intercepted. Recon 5 flagged this as
    // pre-existing with a widening blast radius.
    const env = loadServiceWorker({ network: () => null }); // fetch rejects: offline
    const ev = env.dispatchFetch(swRequest('/data/search/manifest.json'));

    const resp = await ev.responsePromise;
    assert.notEqual(resp, undefined, 'networkFirst resolved respondWith with undefined');
    assert.equal(resp.type, 'error');
    assert.equal(resp.ok, false);
});

test('networkFirst: an offline navigation falls back to the precached /index.html', async () => {
    // The deep-links-work-offline promise, and the HIT half of the navigate
    // fallback (its miss half is the test below). Also pins that the fallback
    // is the shell, not a network error.
    const env = loadServiceWorker();
    await installAndGetCacheName(env); // precache /index.html

    env.network = () => null; // now go offline
    const ev = env.dispatchFetch(swRequest('/lineage', { mode: 'navigate' }));

    const resp = await ev.responsePromise;
    assert.notEqual(resp, undefined);
    assert.equal(resp.body, `body:${abs('/index.html')}`, 'offline navigation must fall back to the precached shell');
});

test('networkFirst: an offline navigation with NO precached /index.html still yields Response.error(), never undefined', async () => {
    // The last respondWith(undefined) hole, and the one that was actually
    // broken: the navigate arm can MISS TOO. caches.match('/index.html')
    // resolves undefined when the shell has been evicted under quota
    // pressure, so the old formula
    //     hit || (navigate ? caches.match('/index.html') : Response.error())
    // guarded only the non-navigate path and handed respondWith `undefined`
    // on exactly the path it claimed to fix — a TypeError and a hard-failed
    // navigation, strictly worse than an honest network error.
    //
    // Worth recording why this survived: the formula was specified INTO the
    // plan (PLAN_v1.md:73), in a sentence whose own words are "never resolve
    // respondWith with undefined". Reading it was not enough — for anyone.
    // Executing it was. That is this file's entire thesis.
    const env = loadServiceWorker({ network: () => null }); // offline, and nothing was ever installed
    const ev = env.dispatchFetch(swRequest('/lineage', { mode: 'navigate' }));

    const resp = await ev.responsePromise;
    assert.notEqual(resp, undefined, 'networkFirst resolved respondWith with undefined on a navigate cache miss');
    assert.equal(resp.type, 'error');
    assert.equal(resp.ok, false);
});

test('negative control: the old networkFirst formula resolves undefined on a navigate miss', async () => {
    // Restores the pre-fix chain verbatim — the `null` sentinel goes back to
    // Response.error() (so only non-navigate is guarded) and the coalescing
    // .then() is neutered. If this control ever fails to reproduce
    // `undefined`, the assertion above has stopped discriminating and is
    // decoration.
    let mutated = mutateWithin(
        readSwSource(),
        'networkFirst',
        "hit || (request.mode === 'navigate' ? caches.match('/index.html') : null)",
        "hit || (request.mode === 'navigate' ? caches.match('/index.html') : Response.error())"
    );
    mutated = mutateWithin(mutated, 'networkFirst', '.then((r) => r || Response.error())', '.then((r) => r)');

    const env = loadServiceWorker({ source: mutated, network: () => null });
    const ev = env.dispatchFetch(swRequest('/lineage', { mode: 'navigate' }));

    const resp = await ev.responsePromise;
    assert.equal(resp, undefined, 'harness failed to model the pre-fix navigate-miss hole');

    // ...while the non-navigate path stayed guarded even in the old formula,
    // which is exactly why the hole hid: the obvious test passed.
    const env2 = loadServiceWorker({ source: mutated, network: () => null });
    const ev2 = env2.dispatchFetch(swRequest('/data/search/manifest.json'));
    const resp2 = await ev2.responsePromise;
    assert.equal(resp2.type, 'error');
});

// ── activate: evicting foreign caches is what unsticks frozen clients ─────

test('activate: every cache except the current build is deleted, then clients are claimed', async () => {
    // Recon 1's healing trace, made executable: new sw.js bytes -> install ->
    // skipWaiting -> activate deletes every cache !== CACHE -> claim. If this
    // filter regresses, the frozen users this whole run exists to rescue stay
    // frozen forever, and no test would notice.
    const env = loadServiceWorker();
    const current = await installAndGetCacheName(env);

    env.seedCache('zl-v1', { '/app.js': 'the stale build the real user was stuck on' });
    env.seedCache('zl-deadbeef', { '/app.js': 'some other old build' });
    assert.equal(env.cacheNames().length, 3);

    const ev = env.dispatchActivate();
    assert.equal(ev.extendedCount, 1, 'activate must hold its cleanup open with event.waitUntil()');
    await ev.settleExtended();

    assert.deepEqual(env.cacheNames(), [current], 'activate must delete every cache except the current build');
    assert.equal(env.claimCalls, 1, 'activate must call clients.claim()');
});

// ── install: precache + skipWaiting ───────────────────────────────────────

test('install: precaches the shell and calls skipWaiting, all held by event.waitUntil', async () => {
    const env = loadServiceWorker();
    const ev = env.dispatchInstall();
    assert.equal(ev.extendedCount, 1, 'install must hold its precache open with event.waitUntil()');

    await ev.settleExtended();
    env.terminate();
    await env.flush();

    assert.equal(env.skipWaitingCalls, 1, 'install must call skipWaiting() (else the new worker waits forever)');
    const [name] = env.cacheNames();
    for (const url of ['/', '/index.html', '/style.css', '/app.js', '/manifest.json', '/assets/icon.svg']) {
        assert.ok(env.cacheEntry(name, url), `install did not precache ${url}`);
    }
    assert.deepEqual(env.droppedWrites, [], 'precache writes arrived after the worker was killed');
});

test('install: a single failed precache fetch aborts the whole install (all-or-nothing addAll)', async () => {
    // PLAN §8.4 states this as a known, accepted degradation ("the old SW
    // keeps serving... degraded, not broken"). Pin the behaviour the caveat
    // is reasoning about, so it stays true.
    const env = loadServiceWorker({
        network: (url) => (url.endsWith('/manifest.json') ? { status: 404 } : { status: 200, body: 'ok' }),
    });
    const ev = env.dispatchInstall();
    await assert.rejects(ev.settleExtended(), 'install must reject when a precache entry 404s');
    assert.equal(env.skipWaitingCalls, 0, 'a failed install must not skipWaiting');
});

// ── the GitHub-raw SWR branch: offline reading of visited texts ───────────

test('raw.githubusercontent.com: stale-while-revalidate serves the cached copy and refreshes in the background', async () => {
    // The offline-reading feature. This branch must stay OUTSIDE the
    // same-origin block: moved inside, a cross-origin request never reaches
    // it and the worker silently stops intercepting corpus XML entirely.
    const RAW = 'https://raw.githubusercontent.com/Fabulu/readzen-data/main/texts/T0001.xml';
    const env = loadServiceWorker();
    const current = await installAndGetCacheName(env);
    env.seedCache(current, { [RAW]: 'the previously-read text' });

    env.network = () => ({ status: 200, body: 'the refreshed text' });
    const ev = env.dispatchFetch(swRequest(RAW));

    assert.ok(ev.responded, 'the raw.githubusercontent.com branch must intercept (is it inside the same-origin block?)');
    const resp = await ev.responsePromise;
    assert.equal(resp.body, 'the previously-read text', 'SWR must serve the cached copy at once');

    assert.equal(ev.extendedCount, 1, 'the background refresh must be held open with event.waitUntil()');
    await ev.settleExtended();
    env.terminate();
    await env.flush();

    assert.equal(env.cacheEntry(current, RAW).body, 'the refreshed text', 'SWR lost its background refresh');
    assert.deepEqual(env.droppedWrites, []);
});

test('raw.githubusercontent.com: a cold read still resolves from the network', async () => {
    const RAW = 'https://raw.githubusercontent.com/Fabulu/readzen-data/main/texts/T0002.xml';
    const env = loadServiceWorker();
    const ev = env.dispatchFetch(swRequest(RAW));
    const resp = await ev.responsePromise;
    assert.notEqual(resp, undefined);
    assert.equal(resp.body, `body:${RAW}`);
});

// ── the rest of the routing table ─────────────────────────────────────────

test('routing: content-hashed shards and /dict/ are cache-first; mutable search data is network-first', async () => {
    // pwa.test.js asserts this split by source ORDER; this asserts the split
    // actually happens. A stale text shard after a redeploy serves wrong
    // docId->text mappings, which is why the specific branch must win.
    const cacheFirstPaths = [
        '/data/search/bigram/shards/ab12.bin',
        '/data/search/bigram/unigram/cd34.bin',
        '/dict/shard-01.json',
    ];
    for (const p of cacheFirstPaths) {
        const env = loadServiceWorker();
        const ev1 = env.dispatchFetch(swRequest(p));
        await ev1.responsePromise;
        await ev1.settleExtended();
        const ev2 = env.dispatchFetch(swRequest(p));
        await ev2.responsePromise;
        assert.equal(env.fetchLog.length, 1, `${p} must be cache-first`);
    }

    for (const p of ['/data/search/manifest.json', '/data/search/docs.txt']) {
        const env = loadServiceWorker();
        const ev1 = env.dispatchFetch(swRequest(p));
        await ev1.responsePromise;
        await ev1.settleExtended();
        const ev2 = env.dispatchFetch(swRequest(p));
        await ev2.responsePromise;
        assert.equal(env.fetchLog.length, 2, `${p} must be network-first (never stale across deploys)`);
    }
});

test('routing: non-GET requests and unmatched same-origin/cross-origin URLs fall through to the browser', async () => {
    const env = loadServiceWorker();

    const post = env.dispatchFetch(swRequest('/app.js', { method: 'POST' }));
    assert.equal(post.responded, false, 'non-GET must not be intercepted');

    // Same-origin, no matching branch (lib/lineage-data.js fetches this one).
    const other = env.dispatchFetch(swRequest('/data/lineage-masters.json'));
    assert.equal(other.responded, false, 'unmatched same-origin must fall through to the browser default');

    // Cross-origin, not raw.githubusercontent.com.
    const foreign = env.dispatchFetch(swRequest('https://example.com/thing.js'));
    assert.equal(foreign.responded, false, 'unrelated cross-origin must not be intercepted');
});
