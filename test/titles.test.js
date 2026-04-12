// test/titles.test.js
// Unit tests for lib/titles.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DATA_REPO_BASE, OPEN_DATA_REPO_BASE } from '../lib/github.js';
import {
    loadTitlesIndexForCorpus,
    lookupTitle,
    loadAllTitlesAsArray
} from '../lib/titles.js';
import { Corpus } from '../lib/corpus.js';
import * as cache from '../lib/cache.js';

test('titles loader uses per-corpus URL and cache key', async (t) => {
    const cbetaJsonl = '{"path":"T/T48/T48n2005.xml","en":"The Gateless Barrier"}\n';
    const openJsonl = '{"path":"ws/gateless-barrier/gateless-barrier.xml","fileId":"ws.gateless-barrier","en":"Gateless Barrier"}\n';
    const fetchCalls = [];
    const originalFetch = global.fetch;
    const originalSessionStorage = global.sessionStorage;
    const storage = new Map();
    global.sessionStorage = {
        getItem: (key) => (storage.has(key) ? storage.get(key) : null),
        setItem: (key, value) => { storage.set(key, String(value)); },
        removeItem: (key) => { storage.delete(key); },
        key: (i) => Array.from(storage.keys())[i] || null,
        get length() { return storage.size; }
    };

    global.fetch = async (url) => {
        fetchCalls.push(url);
        const body = url.startsWith(OPEN_DATA_REPO_BASE) ? openJsonl : cbetaJsonl;
        return {
            ok: true,
            status: 200,
            text: async () => body
        };
    };

    t.after(() => {
        global.fetch = originalFetch;
        global.sessionStorage = originalSessionStorage;
    });

    cache.clear();

    const unknown = await lookupTitle('unknown-key');
    assert.equal(unknown, null);
    assert.ok(fetchCalls.includes(DATA_REPO_BASE + 'titles.jsonl'));
    assert.ok(fetchCalls.includes(OPEN_DATA_REPO_BASE + 'titles.jsonl'));
    assert.ok(sessionStorage.getItem('rzc:titles:index:cbeta'));
    assert.ok(sessionStorage.getItem('rzc:titles:index:openzen'));

    const cbetaMap = await loadTitlesIndexForCorpus(Corpus.Cbeta);
    const openMap = await loadTitlesIndexForCorpus(Corpus.OpenZen);
    assert.equal(cbetaMap.get('T48n2005').en, 'The Gateless Barrier');
    assert.equal(openMap.get('ws.gateless-barrier').en, 'Gateless Barrier');

    const cbetaTitle = await lookupTitle('T48n2005');
    assert.equal(cbetaTitle.en, 'The Gateless Barrier');
    const openTitle = await lookupTitle('ws.gateless-barrier');
    assert.equal(openTitle.en, 'Gateless Barrier');
});

test('loadAllTitlesAsArray dedupes correctly across sessionStorage rehydration', async (t) => {
    // Regression: the original implementation deduped via Set<object> identity.
    // After a sessionStorage roundtrip the map is rebuilt from JSON.parse, so
    // each over-key in the index points at a fresh object literal — Set sees
    // them as distinct and search results show every entry 2-3 times. The fix
    // is to dedupe by entry.path (or fileId fallback). This test fakes the
    // rehydration path explicitly.
    const cbetaJsonl = '{"path":"T/T48/T48n2005.xml","en":"The Gateless Barrier","enShort":"GB"}\n';
    const openJsonl = '{"path":"ws/gateless-barrier/gateless-barrier.xml","fileId":"ws.gateless-barrier","en":"Gateless Barrier"}\n';

    const originalFetch = global.fetch;
    const originalSessionStorage = global.sessionStorage;
    const storage = new Map();
    global.sessionStorage = {
        getItem: (key) => (storage.has(key) ? storage.get(key) : null),
        setItem: (key, value) => { storage.set(key, String(value)); },
        removeItem: (key) => { storage.delete(key); },
        key: (i) => Array.from(storage.keys())[i] || null,
        get length() { return storage.size; }
    };
    global.fetch = async (url) => ({
        ok: true,
        status: 200,
        text: async () => (url.startsWith(OPEN_DATA_REPO_BASE) ? openJsonl : cbetaJsonl)
    });

    t.after(() => {
        global.fetch = originalFetch;
        global.sessionStorage = originalSessionStorage;
    });

    cache.clear();

    // First load: populates sessionStorage AND the in-memory single-flight
    // promises. The in-memory map values still share object identity here,
    // so the bug wouldn't surface — that's exactly why the original test
    // missed it.
    const firstLoad = await loadAllTitlesAsArray();
    const firstCbetaCount = firstLoad.filter((e) => e.corpus === Corpus.Cbeta).length;
    const firstOpenCount = firstLoad.filter((e) => e.corpus === Corpus.OpenZen).length;
    assert.equal(firstCbetaCount, 1, 'first load: exactly 1 CBETA entry');
    assert.equal(firstOpenCount, 1, 'first load: exactly 1 OpenZen entry');

    // Simulate a fresh tab navigation: clear the in-memory cache + the
    // single-flight promises so the next load goes through the rehydration
    // path that reads from sessionStorage and reconstructs the map via
    // JSON.parse. Each over-key now points at a fresh object reference.
    cache.clearMemory();
    // The single-flight promise table is module-level state — re-importing
    // the module is the cleanest way to reset it.
    const titlesModule = await import('../lib/titles.js?rehydrate=' + Date.now());
    const secondLoad = await titlesModule.loadAllTitlesAsArray();
    const secondCbetaCount = secondLoad.filter((e) => e.corpus === Corpus.Cbeta).length;
    const secondOpenCount = secondLoad.filter((e) => e.corpus === Corpus.OpenZen).length;
    assert.equal(secondCbetaCount, 1, 'after rehydrate: exactly 1 CBETA entry (no duplicates)');
    assert.equal(secondOpenCount, 1, 'after rehydrate: exactly 1 OpenZen entry (no duplicates)');
});
