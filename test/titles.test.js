// test/titles.test.js
// Unit tests for lib/titles.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DATA_REPO_BASE, OPEN_DATA_REPO_BASE } from '../lib/github.js';
import { loadTitlesIndexForCorpus, lookupTitle } from '../lib/titles.js';
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
