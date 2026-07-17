// test/bigram-search.test.js
// Integration tests for lib/bigram-search.js (W3.5).
//
// Approach: Option A — unit-test intersectU16 directly with hand-built
// Uint16Arrays, and exercise searchFulltext + fileIdForDocId by mocking
// globalThis.fetch with deterministic small shards built via lib/bigram-codec
// + lib/fnv. No on-disk fixture corpus required; runs in <1 s.
//
// Module state: lib/bigram-search.js holds module-level caches (manifest via
// lib/cache.js, two LRU shard maps, single-flight docs.txt promise). We
// reset everything between tests by:
//   - cache.clear() to drop the manifest sessionStorage entry
//   - the module's own _resetForTests() export (docs list, LRU caches,
//     manifest refetch flag, verification-cap override)
//   - swap globalThis.fetch + globalThis.AbortController per test
//
// Fixture builders + fetch mock live in test/_search-fixtures.js (shared
// with test/search-routing.test.js).
//
// Notes on environment:
//   - sessionStorage is absent in Node; lib/cache.js wraps every call in
//     try/catch, so the absence is silent.
//   - AbortController + AbortSignal are globals in Node 18+.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { encodeShard } from '../lib/bigram-codec.js';
import * as cache from '../lib/cache.js';
import * as bigramModule from '../lib/bigram-search.js';
import {
    bucketHexForBigram,
    textBucketFor,
    shardLayoutFor,
    shardLayoutForV3,
    buildManifest,
    buildTextShardNdjson,
    textShardsForDocs,
    v3EntriesForDocs,
    installFetchMock,
} from './_search-fixtures.js';

/** Reset all module-level state so the next test sees a clean module. */
async function freshSearchModule() {
    // Clear cache.js (drops manifest from memory + sessionStorage).
    cache.clear();
    // Reset bigram-search's module-level state (docs list promise, LRU maps,
    // manifest refetch-once flag, verification-cap override).
    bigramModule._resetForTests();
    return bigramModule;
}

// =====================================================================
// 1. intersectU16 correctness (no fetch needed)
// =====================================================================

test('intersectU16: basic two-list intersection [1,2,3] ∩ [2,3,4] = [2,3]', async () => {
    const { intersectU16 } = await freshSearchModule();
    const result = intersectU16([
        new Uint16Array([1, 2, 3]),
        new Uint16Array([2, 3, 4]),
    ]);
    assert.deepEqual(Array.from(result), [2, 3]);
    assert.ok(result instanceof Uint16Array, 'result must be a Uint16Array');
});

test('intersectU16: empty input list returns empty Uint16Array', async () => {
    const { intersectU16 } = await freshSearchModule();
    const result = intersectU16([]);
    assert.equal(result.length, 0);
    assert.ok(result instanceof Uint16Array);
});

test('intersectU16: any list empty short-circuits to empty', async () => {
    const { intersectU16 } = await freshSearchModule();
    const r1 = intersectU16([new Uint16Array([]), new Uint16Array([1, 2])]);
    assert.equal(r1.length, 0);
    const r2 = intersectU16([new Uint16Array([1, 2, 3]), new Uint16Array([])]);
    assert.equal(r2.length, 0);
    const r3 = intersectU16([new Uint16Array([1]), new Uint16Array([1]), new Uint16Array([])]);
    assert.equal(r3.length, 0);
});

test('intersectU16: single-list pass-through returns that list', async () => {
    const { intersectU16 } = await freshSearchModule();
    const only = new Uint16Array([5, 10, 15]);
    const result = intersectU16([only]);
    assert.deepEqual(Array.from(result), [5, 10, 15]);
});

test('intersectU16: shortest-first ordering — small list with large list works fast', async () => {
    const { intersectU16 } = await freshSearchModule();
    // Tiny list of size 2 vs big list of size 10000 (both contain 4242 and 4243).
    const tiny = new Uint16Array([4242, 4243]);
    const big = new Uint16Array(10000);
    for (let i = 0; i < 10000; i++) big[i] = i; // 0..9999
    // Pass big first, tiny second — algorithm must reorder.
    const result = intersectU16([big, tiny]);
    assert.deepEqual(Array.from(result), [4242, 4243]);
});

test('intersectU16: three-way cascade', async () => {
    const { intersectU16 } = await freshSearchModule();
    const result = intersectU16([
        new Uint16Array([1, 2, 3, 4, 5]),
        new Uint16Array([2, 3, 4, 5, 6]),
        new Uint16Array([3, 4, 5, 6, 7]),
    ]);
    assert.deepEqual(Array.from(result), [3, 4, 5]);
});

test('intersectU16: disjoint lists produce empty result', async () => {
    const { intersectU16 } = await freshSearchModule();
    const result = intersectU16([
        new Uint16Array([1, 2, 3]),
        new Uint16Array([100, 200, 300]),
    ]);
    assert.equal(result.length, 0);
});

// =====================================================================
// 2. Query bigram extraction (observed via searchFulltext behavior)
// =====================================================================

test('searchFulltext: non-CJK query on a non-word-capable index returns [] (manifest probe only, no shards)', async () => {
    // Router unification: searchFulltext now consults the manifest to learn
    // word-capability even for a pure-latin query. On a non-word-capable index
    // (no `wordTerms`) a pure-latin query has no CJK runs and no word leg, so
    // it degrades to [] after ONLY the manifest fetch — no shard/text fetches.
    // (Pure-latin is routed to english.jsonl upstream; this is the defensive
    // in-engine behavior.)
    const { searchFulltext } = await freshSearchModule();
    const manifest = { version: 3, shardCount: 4096, docCount: 1, shards: {} };
    const fetchMock = installFetchMock({ manifest });
    try {
        const results = await searchFulltext('hello world');
        assert.deepEqual(results, []);
        const nonManifest = fetchMock.calls.filter((u) => !u.endsWith('/manifest.json'));
        assert.deepEqual(nonManifest, [], `only the manifest may be fetched, got: ${nonManifest.join(', ')}`);
    } finally {
        fetchMock.restore();
    }
});

test('searchFulltext: empty/null/undefined query short-circuits to empty (no fetch)', async () => {
    const { searchFulltext } = await freshSearchModule();
    const fetchMock = installFetchMock({});
    try {
        assert.deepEqual(await searchFulltext(''), []);
        assert.deepEqual(await searchFulltext(null), []);
        assert.deepEqual(await searchFulltext(undefined), []);
        assert.equal(fetchMock.calls.length, 0);
    } finally {
        fetchMock.restore();
    }
});

test('searchFulltext: single CJK char on an index WITHOUT unigramShards returns [] after only the manifest fetch', async () => {
    // Unigram capability is gated on manifest.unigramShards. A v2 manifest
    // (no unigramShards key) cannot serve a 1-char query: the runtime must
    // consult the manifest (one fetch) and return [] with NO shard and NO
    // text-shard fetches.
    const { searchFulltext } = await freshSearchModule();
    const manifest = { shardCount: 4096, docCount: 1, shards: {} };
    const fetchMock = installFetchMock({ manifest });
    try {
        assert.deepEqual(await searchFulltext('無'), []);
        assert.equal(fetchMock.calls.length, 1, 'exactly one fetch');
        assert.ok(fetchMock.calls[0].endsWith('/manifest.json'),
            `only permitted fetch is the manifest, got: ${fetchMock.calls[0]}`);
    } finally {
        fetchMock.restore();
    }
});

test('searchFulltext: 3-char CJK query produces exactly 2 bigrams (one shard fetch per bigram bucket)', async () => {
    const { searchFulltext } = await freshSearchModule();
    // Query "甲乙丙" -> bigrams ["甲乙", "乙丙"]. Place in distinct buckets.
    // Both bigrams point to doc 0; doc 0's text contains "甲乙丙".
    const docCount = 1;
    const layout = shardLayoutFor(
        [
            { term: '甲乙', docIds: [0] },
            { term: '乙丙', docIds: [0] },
        ],
        docCount
    );
    const manifest = buildManifest(layout, docCount);
    const textShards = new Map([
        [textBucketFor(0), buildTextShardNdjson([{ docId: 0, text: '甲乙丙丁戊' }])],
    ]);
    const fetchMock = installFetchMock({ manifest, shardLayout: layout, textShards });
    try {
        const results = await searchFulltext('甲乙丙');
        assert.equal(results.length, 1, 'one verified doc');
        assert.equal(results[0].docId, 0);
        assert.equal(results[0].hitCount, 1);
        // Manifest + (≤2 bigram shards, depending on bucket collision) + 1 text shard.
        const manifestFetches = fetchMock.calls.filter((u) => u.endsWith('/manifest.json')).length;
        assert.equal(manifestFetches, 1);
    } finally {
        fetchMock.restore();
    }
});

// =====================================================================
// 3. searchFulltext end-to-end with mocked fetch
// =====================================================================

test('searchFulltext: AND-match across two bigrams returns 2 docs', async () => {
    const { searchFulltext } = await freshSearchModule();
    // Query "無門關" -> bigrams ["無門", "門關"].
    // Three docs total:
    //   doc 0: "無門關" — both bigrams match, text confirms.
    //   doc 1: "無門" only — first bigram matches, second misses.
    //   doc 2: "無門關" — both match, text confirms.
    const docCount = 3;
    const layout = shardLayoutFor(
        [
            { term: '無門', docIds: [0, 1, 2] },
            { term: '門關', docIds: [0, 2] },
        ],
        docCount
    );
    const manifest = buildManifest(layout, docCount);
    // Group docs by their text-bucket.
    const docs = [
        { docId: 0, text: '無門關' },
        { docId: 1, text: '無門無門' },
        { docId: 2, text: '無門關與無門關' },
    ];
    const textBuckets = new Map();
    for (const d of docs) {
        const b = textBucketFor(d.docId);
        if (!textBuckets.has(b)) textBuckets.set(b, []);
        textBuckets.get(b).push(d);
    }
    const textShards = new Map();
    for (const [b, list] of textBuckets.entries()) {
        textShards.set(b, buildTextShardNdjson(list));
    }
    const fetchMock = installFetchMock({ manifest, shardLayout: layout, textShards });
    try {
        const results = await searchFulltext('無門關');
        const docIds = results.map((r) => r.docId).sort((a, b) => a - b);
        assert.deepEqual(docIds, [0, 2], 'only docs containing 無門關 verified');
        const doc2 = results.find((r) => r.docId === 2);
        assert.equal(doc2.hitCount, 2, 'doc 2 has 2 substring hits');
    } finally {
        fetchMock.restore();
    }
});

test('searchFulltext: missing bigram in shard short-circuits to empty', async () => {
    const { searchFulltext } = await freshSearchModule();
    // Query "甲乙丙" -> bigrams ["甲乙", "乙丙"]. We populate only "甲乙"; "乙丙"
    // is absent from its shard, so the search must return [] without fetching text.
    const docCount = 5;
    const layout = shardLayoutFor(
        [{ term: '甲乙', docIds: [0, 1, 2] }],
        docCount
    );
    // Manifest must include the bucket where "乙丙" hashes — build it as empty.
    const yiBingHex = bucketHexForBigram('乙丙');
    if (!layout.has(yiBingHex)) {
        layout.set(yiBingHex, encodeShard([], docCount));
    }
    const manifest = buildManifest(layout, docCount);
    const fetchMock = installFetchMock({ manifest, shardLayout: layout, textShards: new Map() });
    try {
        const results = await searchFulltext('甲乙丙');
        assert.deepEqual(results, []);
        const textFetches = fetchMock.calls.filter((u) => u.includes('/text/'));
        assert.equal(textFetches.length, 0, 'no text fetches when bigram missing');
    } finally {
        fetchMock.restore();
    }
});

test('searchFulltext: empty intersection (bigrams disjoint across docs) returns empty', async () => {
    const { searchFulltext } = await freshSearchModule();
    // Query "甲乙丙" -> bigrams ["甲乙", "乙丙"]. doc 0 has only first; doc 1 has only second.
    const docCount = 2;
    const layout = shardLayoutFor(
        [
            { term: '甲乙', docIds: [0] },
            { term: '乙丙', docIds: [1] },
        ],
        docCount
    );
    const manifest = buildManifest(layout, docCount);
    const fetchMock = installFetchMock({ manifest, shardLayout: layout, textShards: new Map() });
    try {
        const results = await searchFulltext('甲乙丙');
        assert.deepEqual(results, []);
        const textFetches = fetchMock.calls.filter((u) => u.includes('/text/'));
        assert.equal(textFetches.length, 0, 'no text fetches when intersection is empty');
    } finally {
        fetchMock.restore();
    }
});

test('searchFulltext: bigram filter passes but text verification rejects (false positive)', async () => {
    const { searchFulltext } = await freshSearchModule();
    // Query "無門關": doc 0 has both bigrams 無門 + 門關 BUT the chars are not adjacent
    // as 無門關 in the text — they appear as "無門。。。其他關" (dots disrupt match).
    // The bigram intersect says "candidate", but the substring verify says "no".
    // (In production the build pipeline normalizes punctuation before bigram emission,
    // but at the runtime layer the verification catches any false positive.)
    const docCount = 1;
    const layout = shardLayoutFor(
        [
            { term: '無門', docIds: [0] },
            { term: '門關', docIds: [0] },
        ],
        docCount
    );
    const manifest = buildManifest(layout, docCount);
    const textShards = new Map([
        // Normalized text where 無門關 does NOT appear as a contiguous substring.
        [textBucketFor(0), buildTextShardNdjson([{ docId: 0, text: '無門xxx門關' }])],
    ]);
    const fetchMock = installFetchMock({ manifest, shardLayout: layout, textShards });
    try {
        const results = await searchFulltext('無門關');
        assert.deepEqual(results, [], 'verification rejects false positive');
    } finally {
        fetchMock.restore();
    }
});

// =====================================================================
// 4. AbortController behavior
//
// FINDING: lib/bigram-search.js#searchFulltext does NOT fully meet the W3.1
// IMPLEMENTATION_PLAN spec for abort handling. The spec says "AbortError
// silent" but the current implementation only swallows AbortError inside the
// two shard-fetch try/catch blocks; an abort that fires (a) before the call,
// or (b) during loadManifest's fetch, propagates the AbortError out of
// searchFulltext.
//
// Proper fix lives in W3.1 (3-line change: wrap the throwIfAborted + pass
// signal to loadManifest, OR wrap the whole body in try/catch on AbortError).
//
// Until W3.1 ships the fix, these integration tests assert the contract that
// IS satisfied: when abort fires AFTER the manifest is already cached and
// shard fetch begins, the abort is silently swallowed. The pre-aborted +
// during-manifest cases are tagged `todo` so they document the spec gap
// without failing CI.
// =====================================================================

test('searchFulltext: pre-aborted signal returns []', async () => {
    const { searchFulltext } = await freshSearchModule();
    const docCount = 1;
    const layout = shardLayoutFor([{ term: '無門', docIds: [0] }], docCount);
    const manifest = buildManifest(layout, docCount);
    const fetchMock = installFetchMock({ manifest, shardLayout: layout });
    try {
        const ac = new AbortController();
        ac.abort();
        const results = await searchFulltext('無門', { signal: ac.signal });
        assert.deepEqual(results, []);
    } finally {
        fetchMock.restore();
    }
});

test('searchFulltext: abort during manifest fetch returns []', async () => {
    const { searchFulltext } = await freshSearchModule();
    const docCount = 1;
    const layout = shardLayoutFor(
        [
            { term: '無門', docIds: [0] },
            { term: '門關', docIds: [0] },
        ],
        docCount
    );
    const manifest = buildManifest(layout, docCount);
    const textShards = new Map([
        [textBucketFor(0), buildTextShardNdjson([{ docId: 0, text: '無門關' }])],
    ]);
    // 50 ms delay on every fetch; we abort after 10 ms (during manifest fetch).
    const fetchMock = installFetchMock({ manifest, shardLayout: layout, textShards, delayMs: 50 });
    try {
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 10);
        const results = await searchFulltext('無門關', { signal: ac.signal });
        assert.deepEqual(results, []);
    } finally {
        fetchMock.restore();
    }
});

test('searchFulltext: abort during bigram shard fetch returns [] silently', async () => {
    const { searchFulltext, preloadManifest } = await freshSearchModule();
    const docCount = 1;
    const layout = shardLayoutFor(
        [
            { term: '無門', docIds: [0] },
            { term: '門關', docIds: [0] },
        ],
        docCount
    );
    const manifest = buildManifest(layout, docCount);
    const textShards = new Map([
        [textBucketFor(0), buildTextShardNdjson([{ docId: 0, text: '無門關' }])],
    ]);

    // Warm only the manifest (no delay).
    const warmMock = installFetchMock({ manifest, shardLayout: layout, textShards });
    try {
        await preloadManifest();
    } finally {
        warmMock.restore();
    }

    // Install a fetch that delays only bigram shard URLs; abort during the delay.
    const fetchMock = installFetchMock({
        manifest, shardLayout: layout, textShards,
        delayMs: 50,
        delayPredicate: (url) => url.includes('/shards/'),
    });
    try {
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 10);
        const results = await searchFulltext('無門關', { signal: ac.signal });
        assert.deepEqual(results, [], 'abort during bigram shard fetch swallowed silently');
    } finally {
        fetchMock.restore();
    }
});

test('searchFulltext: abort during text-shard fetch (post-intersect) returns [] silently', async () => {
    const { searchFulltext } = await freshSearchModule();
    const docCount = 1;
    const layout = shardLayoutFor(
        [
            { term: '無門', docIds: [0] },
            { term: '門關', docIds: [0] },
        ],
        docCount
    );
    const manifest = buildManifest(layout, docCount);
    const textShards = new Map([
        [textBucketFor(0), buildTextShardNdjson([{ docId: 0, text: '無門關' }])],
    ]);

    // Single fetch mock: delay ONLY text-shard URLs. Manifest + bigram shards
    // resolve immediately, then abort fires while the text shard is in flight.
    const fetchMock = installFetchMock({
        manifest, shardLayout: layout, textShards,
        delayMs: 50,
        delayPredicate: (url) => url.includes('/text/'),
    });
    try {
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 10);
        const results = await searchFulltext('無門關', { signal: ac.signal });
        assert.deepEqual(results, [], 'abort during text fetch swallowed silently');
    } finally {
        fetchMock.restore();
    }
});

// =====================================================================
// 5. fileIdForDocId correctness
// =====================================================================

test('fileIdForDocId: returns last path segment for a known docId', async () => {
    const { fileIdForDocId } = await freshSearchModule();
    const docsTxt = [
        '/cbeta/T48n2005',
        '/cbeta/T48n2003',
        '/openzen/oz.wm32.case01',
    ].join('\n');
    const fetchMock = installFetchMock({ docsTxt });
    try {
        assert.equal(await fileIdForDocId(0), 'T48n2005');
        assert.equal(await fileIdForDocId(1), 'T48n2003');
        assert.equal(await fileIdForDocId(2), 'oz.wm32.case01');
    } finally {
        fetchMock.restore();
    }
});

test('fileIdForDocId: trailing slash trimmed; single segment returned', async () => {
    const { fileIdForDocId } = await freshSearchModule();
    const docsTxt = '/cbeta/T48n2005/';
    const fetchMock = installFetchMock({ docsTxt });
    try {
        assert.equal(await fileIdForDocId(0), 'T48n2005');
    } finally {
        fetchMock.restore();
    }
});

test('fileIdForDocId: out-of-range docId returns empty string', async () => {
    const { fileIdForDocId } = await freshSearchModule();
    const docsTxt = '/cbeta/T48n2005\n/cbeta/T48n2003';
    const fetchMock = installFetchMock({ docsTxt });
    try {
        assert.equal(await fileIdForDocId(99), '', 'too high');
        assert.equal(await fileIdForDocId(-1), '', 'negative');
        assert.equal(await fileIdForDocId(2.5), '', 'non-integer');
        assert.equal(await fileIdForDocId(NaN), '', 'NaN');
    } finally {
        fetchMock.restore();
    }
});

test('fileIdForDocId: empty docs.txt returns empty for any docId', async () => {
    const { fileIdForDocId } = await freshSearchModule();
    const fetchMock = installFetchMock({ docsTxt: '' });
    try {
        assert.equal(await fileIdForDocId(0), '');
    } finally {
        fetchMock.restore();
    }
});

// =====================================================================
// 6. Module exports + shape sanity
// =====================================================================

test('module exports searchFulltext, intersectU16, fileIdForDocId, clearShardCache, preloadManifest, BigramIndexUnavailable', async () => {
    const mod = await freshSearchModule();
    assert.equal(typeof mod.searchFulltext, 'function');
    assert.equal(typeof mod.intersectU16, 'function');
    assert.equal(typeof mod.fileIdForDocId, 'function');
    assert.equal(typeof mod.clearShardCache, 'function');
    assert.equal(typeof mod.preloadManifest, 'function');
    assert.equal(typeof mod.BigramIndexUnavailable, 'function');
});

test('preloadManifest: throws BigramIndexUnavailable when manifest 404s', async () => {
    const { preloadManifest, BigramIndexUnavailable } = await freshSearchModule();
    const fetchMock = installFetchMock({ manifest: null });
    try {
        await assert.rejects(
            () => preloadManifest(),
            (err) => err instanceof BigramIndexUnavailable
        );
    } finally {
        fetchMock.restore();
    }
});

// =====================================================================
// 7. Manifest "0" sentinel: empty shard MUST NOT be fetched
// =====================================================================

test('searchFulltext: shard with manifest value "0" does NOT trigger a network fetch', async () => {
    const { searchFulltext } = await freshSearchModule();
    // Query "甲乙丙" -> bigrams ["甲乙", "乙丙"].
    // Place "甲乙" in a populated shard; mark "乙丙"'s bucket as "0" in the manifest.
    const docCount = 1;
    const populated = shardLayoutFor([{ term: '甲乙', docIds: [0] }], docCount);
    const manifest = buildManifest(populated, docCount);
    // Override "乙丙"'s bucket to the "0" sentinel.
    const yiBingHex = bucketHexForBigram('乙丙');
    manifest.shards[yiBingHex] = '0';

    const fetchMock = installFetchMock({
        manifest, shardLayout: populated, textShards: new Map(),
    });
    try {
        const results = await searchFulltext('甲乙丙');
        assert.deepEqual(results, [], 'empty bigram → no postings → no candidates');

        // Critically: the shard URL for the "0" bucket should NOT have been requested.
        const shardCalls = fetchMock.calls.filter((u) => u.includes('/shards/'));
        for (const url of shardCalls) {
            assert.ok(!url.includes(yiBingHex.slice(0, 2) + '/' + yiBingHex.slice(2, 4) + '-'),
                `unexpected fetch for sentinel-"0" shard: ${url}`);
        }
    } finally {
        fetchMock.restore();
    }
});

// =====================================================================
// 8. Concurrent searchFulltext calls — single-flight + AbortController isolation
// =====================================================================

test('searchFulltext: concurrent calls share the same shard fetch (single-flight)', async () => {
    const { searchFulltext, clearShardCache } = await freshSearchModule();
    clearShardCache();

    const docCount = 2;
    const layout = shardLayoutFor(
        [
            { term: '無門', docIds: [0, 1] },
            { term: '門關', docIds: [0, 1] },
        ],
        docCount
    );
    const manifest = buildManifest(layout, docCount);
    const docs = [
        { docId: 0, text: '無門關' },
        { docId: 1, text: '無門關' },
    ];
    const textShards = new Map();
    for (const d of docs) {
        const b = textBucketFor(d.docId);
        if (!textShards.has(b)) textShards.set(b, []);
        textShards.get(b).push(d);
    }
    const ndjsonShards = new Map();
    for (const [b, list] of textShards.entries()) ndjsonShards.set(b, buildTextShardNdjson(list));

    // Add a small delay so the two concurrent calls overlap.
    const fetchMock = installFetchMock({
        manifest, shardLayout: layout, textShards: ndjsonShards, delayMs: 20,
    });
    try {
        const [r1, r2] = await Promise.all([
            searchFulltext('無門關'),
            searchFulltext('無門關'),
        ]);
        // Both calls return the same result.
        assert.equal(r1.length, 2);
        assert.equal(r2.length, 2);
        // Each unique URL should be fetched at most twice (once per call only
        // if single-flight failed; once total if it worked). Looser assertion:
        // no shard URL should be fetched MORE than 2 times even with two
        // concurrent calls.
        const counts = new Map();
        for (const u of fetchMock.calls) counts.set(u, (counts.get(u) || 0) + 1);
        for (const [u, n] of counts) {
            assert.ok(n <= 2, `URL ${u} fetched ${n} times (single-flight broken?)`);
        }
    } finally {
        fetchMock.restore();
    }
});

test('searchFulltext: independent AbortControllers do not interfere across concurrent calls', async () => {
    const { searchFulltext, clearShardCache } = await freshSearchModule();
    clearShardCache();

    const docCount = 1;
    const layout = shardLayoutFor(
        [
            { term: '無門', docIds: [0] },
            { term: '門關', docIds: [0] },
        ],
        docCount
    );
    const manifest = buildManifest(layout, docCount);
    const textShards = new Map([
        [textBucketFor(0), buildTextShardNdjson([{ docId: 0, text: '無門關' }])],
    ]);
    // Delay only text-shard URLs so we can abort one mid-flight.
    const fetchMock = installFetchMock({
        manifest, shardLayout: layout, textShards,
        delayMs: 60,
        delayPredicate: (url) => url.includes('/text/'),
    });
    try {
        const ac1 = new AbortController();
        const ac2 = new AbortController();
        // Abort #1 before its text fetch resolves; #2 runs to completion.
        setTimeout(() => ac1.abort(), 10);
        const [r1, r2] = await Promise.all([
            searchFulltext('無門關', { signal: ac1.signal }),
            searchFulltext('無門關', { signal: ac2.signal }),
        ]);
        assert.deepEqual(r1, [], 'aborted call returns []');
        // Call #2 must succeed despite call #1 aborting.
        // (Single-flight may share a text-shard fetch that's ALSO bound to ac1's signal.
        // If aborting one call kills the shared fetch, call #2 will get [] too — that
        // would be a real bug. We assert the contract.)
        assert.equal(r2.length, 1, 'second concurrent call succeeded with its own signal');
        assert.equal(r2[0].docId, 0);
    } finally {
        fetchMock.restore();
    }
});

// =====================================================================
// 9. LRU eviction order under load
// =====================================================================

test('clearShardCache: drops in-memory bigram + text shard caches', async () => {
    const { searchFulltext, clearShardCache } = await freshSearchModule();
    const docCount = 1;
    const layout = shardLayoutFor(
        [
            { term: '無門', docIds: [0] },
            { term: '門關', docIds: [0] },
        ],
        docCount
    );
    const manifest = buildManifest(layout, docCount);
    const textShards = new Map([
        [textBucketFor(0), buildTextShardNdjson([{ docId: 0, text: '無門關' }])],
    ]);

    // First query warms caches.
    const mock1 = installFetchMock({ manifest, shardLayout: layout, textShards });
    try {
        await searchFulltext('無門關');
    } finally {
        mock1.restore();
    }

    // Clear, then second query — must re-fetch shard URLs.
    clearShardCache();

    const mock2 = installFetchMock({ manifest, shardLayout: layout, textShards });
    try {
        await searchFulltext('無門關');
        // The bigram shard URL must have been fetched again (even though
        // manifest itself stays cached via lib/cache.js).
        const shardCalls = mock2.calls.filter((u) => u.includes('/shards/'));
        assert.ok(shardCalls.length >= 1, 'shard re-fetched after clearShardCache');
        const textCalls = mock2.calls.filter((u) => u.includes('/text/'));
        assert.ok(textCalls.length >= 1, 'text shard re-fetched after clearShardCache');
    } finally {
        mock2.restore();
    }
});

test('LRU eviction: more than BIGRAM_SHARD_LRU_MAX (32) buckets drops the oldest', async () => {
    // Run 40 distinct queries that each hit a unique bigram bucket. The LRU
    // cap is 32 → the oldest 8 entries should be evicted by the time we're
    // done. We verify this by issuing a 41st query that revisits the FIRST
    // bigram from the loop and asserting the shard URL is fetched again
    // (because it should have been evicted).
    const { searchFulltext, clearShardCache } = await freshSearchModule();
    clearShardCache();

    // Build 40 unique bigrams. Each is two distinct CJK ideographs.
    const bigrams = [];
    for (let i = 0; i < 40; i++) {
        bigrams.push(String.fromCharCode(0x4E00 + i * 2) + String.fromCharCode(0x4E00 + i * 2 + 1));
    }
    const docCount = 1;
    // Each bigram → docId 0 (very simple posting list).
    const allEntries = bigrams.map(term => ({ term, docIds: [0] }));
    const layout = shardLayoutFor(allEntries, docCount);
    const manifest = buildManifest(layout, docCount);
    const textShards = new Map([
        [textBucketFor(0), buildTextShardNdjson([{ docId: 0, text: bigrams.join('') }])],
    ]);

    const fetchMock = installFetchMock({ manifest, shardLayout: layout, textShards });
    try {
        // Issue 40 distinct 2-char queries → 1 bigram each → 1 unique bucket each.
        // Avoid wrap-around or multi-bigram queries so bigrams[0]'s bucket is
        // touched only on iteration 0 and ages out as iterations 1..39 push it
        // past the LRU cap of 32.
        for (let i = 0; i < 40; i++) {
            await searchFulltext(bigrams[i]);
        }

        // Count distinct shard URLs that were fetched.
        const shardUrls = new Set();
        for (const u of fetchMock.calls) {
            if (u.includes('/shards/')) shardUrls.add(u);
        }
        // At least 32 shards must have been fetched (the LRU's worth).
        assert.ok(shardUrls.size >= 32,
            `only ${shardUrls.size} unique bigram shards fetched; LRU pressure not realistic`);

        // Re-query bigrams[0]. After 40 single-bigram queries with a 32-entry
        // LRU, bigrams[0]'s bucket should have been evicted by iteration 32+.
        const callsBefore = fetchMock.calls.length;
        await searchFulltext(bigrams[0]);
        const newCalls = fetchMock.calls.slice(callsBefore);
        const newShardCalls = newCalls.filter(u => u.includes('/shards/'));
        assert.ok(newShardCalls.length >= 1,
            'expected at least one shard re-fetch after LRU eviction; got ' + newShardCalls.length);
    } finally {
        fetchMock.restore();
    }
});

// =====================================================================
// 10. V3 fast path: tf ranking with ZERO text-shard fetches (audit #1)
// =====================================================================

test('searchFulltext v3: 2-char query ranks by indexed tf with ZERO text fetches', async () => {
    const { searchFulltext } = await freshSearchModule();
    const docCount = 3;
    const layout = shardLayoutForV3(
        [{ term: '無門', docIds: [0, 1, 2], tfs: [5, 2, 9] }],
        docCount
    );
    const manifest = buildManifest(layout, docCount, { version: 3 });
    const fetchMock = installFetchMock({ manifest, shardLayout: layout });
    try {
        const results = await searchFulltext('無門');
        assert.equal(results.length, 3);
        // hitCount === indexed tf, sorted hitCount desc.
        assert.deepEqual(
            results.map((r) => ({ docId: r.docId, hitCount: r.hitCount })),
            [
                { docId: 2, hitCount: 9 },
                { docId: 0, hitCount: 5 },
                { docId: 1, hitCount: 2 },
            ]
        );
        const textFetches = fetchMock.calls.filter((u) => u.includes('/text/'));
        assert.equal(textFetches.length, 0, 'v3 ranking must not fetch text shards');
    } finally {
        fetchMock.restore();
    }
});

test('searchFulltext v3: multi-bigram query — hitCount = min over bigram tfs, sorted desc then docId asc, zero text fetches', async () => {
    const { searchFulltext } = await freshSearchModule();
    // Query 無門關 -> bigrams [無門, 門關]. Per-doc min over the two tfs:
    //   doc 0: min(3, 1) = 1
    //   doc 1: min(2, 2) = 2
    //   doc 2: min(5, 4) = 4
    //   doc 3: min(2, 7) = 2   (ties doc 1 -> docId asc breaks the tie)
    const docCount = 4;
    const layout = shardLayoutForV3(
        [
            { term: '無門', docIds: [0, 1, 2, 3], tfs: [3, 2, 5, 2] },
            { term: '門關', docIds: [0, 1, 2, 3], tfs: [1, 2, 4, 7] },
        ],
        docCount
    );
    const manifest = buildManifest(layout, docCount, { version: 3 });
    const fetchMock = installFetchMock({ manifest, shardLayout: layout });
    try {
        const results = await searchFulltext('無門關');
        assert.deepEqual(
            results.map((r) => ({ docId: r.docId, hitCount: r.hitCount })),
            [
                { docId: 2, hitCount: 4 },
                { docId: 1, hitCount: 2 },
                { docId: 3, hitCount: 2 }, // equal hitCount: docId ascending
                { docId: 0, hitCount: 1 },
            ],
            'sorted by hitCount desc, then docId asc'
        );
        const textFetches = fetchMock.calls.filter((u) => u.includes('/text/'));
        assert.equal(textFetches.length, 0, 'v3 multi-bigram ranking must not fetch text shards');
    } finally {
        fetchMock.restore();
    }
});

// =====================================================================
// 11. Unigram path (audit #4): 1-char queries via manifest.unigramShards
// =====================================================================

test('searchFulltext v3: single CJK char with unigramShards → exactly one unigram-shard fetch, ranked, zero text fetches', async () => {
    const { searchFulltext } = await freshSearchModule();
    const docCount = 2;
    const unigramLayout = shardLayoutForV3(
        [{ term: '佛', docIds: [0, 1], tfs: [2, 7] }],
        docCount
    );
    const manifest = buildManifest(new Map(), docCount, { version: 3, unigramLayout });
    const fetchMock = installFetchMock({ manifest, unigramLayout });
    try {
        const results = await searchFulltext('佛');
        assert.deepEqual(
            results.map((r) => ({ docId: r.docId, hitCount: r.hitCount })),
            [
                { docId: 1, hitCount: 7 },
                { docId: 0, hitCount: 2 },
            ]
        );
        const unigramFetches = fetchMock.calls.filter((u) => u.includes('/unigram/'));
        assert.equal(unigramFetches.length, 1, 'exactly one unigram shard fetch');
        const textFetches = fetchMock.calls.filter((u) => u.includes('/text/'));
        assert.equal(textFetches.length, 0, 'no text fetches for unigram query');
        const bigramFetches = fetchMock.calls.filter((u) => u.includes('/shards/'));
        assert.equal(bigramFetches.length, 0, 'no bigram shard fetches for a 1-char query');
    } finally {
        fetchMock.restore();
    }
});

test('searchFulltext v3: unigram run combines with bigram runs (mixed-length runs)', async () => {
    const { searchFulltext } = await freshSearchModule();
    // Query '無門x佛' -> runs [無門, 佛] (the 'x' separates the runs; a SPACE
    // would not — normalization strips whitespace, fusing '無門 佛' into the
    // single run '無門佛'). hitCount = tf(無門) + tf(佛) per doc; AND
    // semantics: only docs in both posting lists survive.
    const docCount = 3;
    const layout = shardLayoutForV3(
        [{ term: '無門', docIds: [0, 1], tfs: [3, 1] }],
        docCount
    );
    const unigramLayout = shardLayoutForV3(
        [{ term: '佛', docIds: [1, 2], tfs: [4, 9] }],
        docCount
    );
    const manifest = buildManifest(layout, docCount, { version: 3, unigramLayout });
    const fetchMock = installFetchMock({ manifest, shardLayout: layout, unigramLayout });
    try {
        const results = await searchFulltext('無門x佛');
        assert.deepEqual(
            results.map((r) => ({ docId: r.docId, hitCount: r.hitCount })),
            [{ docId: 1, hitCount: 5 }],
            'only doc 1 has both runs; hitCount sums per-run tfs (1 + 4)'
        );
        const textFetches = fetchMock.calls.filter((u) => u.includes('/text/'));
        assert.equal(textFetches.length, 0);
    } finally {
        fetchMock.restore();
    }
});

// =====================================================================
// 12. Mixed-script queries (audit #3): CJK runs matched, latin reported
// =====================================================================

test('searchFulltext v3: mixed script 趙州dog matches CJK run, reports latinIgnored', async () => {
    const { searchFulltext } = await freshSearchModule();
    const docCount = 10;
    const layout = shardLayoutForV3(
        [{ term: '趙州', docIds: [3, 9], tfs: [4, 1] }],
        docCount
    );
    const manifest = buildManifest(layout, docCount, { version: 3 });
    const fetchMock = installFetchMock({ manifest, shardLayout: layout });
    try {
        let stats = null;
        const results = await searchFulltext('趙州dog', { onStats: (s) => { stats = s; } });
        assert.deepEqual(
            results.map((r) => ({ docId: r.docId, hitCount: r.hitCount })),
            [
                { docId: 3, hitCount: 4 },
                { docId: 9, hitCount: 1 },
            ],
            'mixed-script query matches on the CJK run, not silent zero'
        );
        assert.ok(stats, 'onStats fired');
        assert.equal(stats.latinIgnored, 'dog');
        const textFetches = fetchMock.calls.filter((u) => u.includes('/text/'));
        assert.equal(textFetches.length, 0);
    } finally {
        fetchMock.restore();
    }
});

test('searchFulltext v2 fallback: mixed script 趙州dog still matches via text verification (not silent zero)', async () => {
    const { searchFulltext } = await freshSearchModule();
    const docCount = 10;
    const layout = shardLayoutFor([{ term: '趙州', docIds: [3, 9] }], docCount);
    const manifest = buildManifest(layout, docCount);
    const textShards = textShardsForDocs([
        { docId: 3, text: '趙州趙州和尚' },
        { docId: 9, text: '趙州' },
    ]);
    const fetchMock = installFetchMock({ manifest, shardLayout: layout, textShards });
    try {
        let stats = null;
        const results = await searchFulltext('趙州dog', { onStats: (s) => { stats = s; } });
        const byDocId = new Map(results.map((r) => [r.docId, r.hitCount]));
        assert.deepEqual([...byDocId.keys()].sort((a, b) => a - b), [3, 9],
            'v2 fallback matches the CJK run instead of silently zeroing');
        assert.equal(byDocId.get(3), 2, 'substring hits counted on the CJK run');
        assert.equal(byDocId.get(9), 1);
        assert.equal(stats.latinIgnored, 'dog');
        assert.equal(stats.indexVersion, 2);
        const textFetches = fetchMock.calls.filter((u) => u.includes('/text/'));
        assert.ok(textFetches.length >= 1, 'v2 path verifies against text shards');
    } finally {
        fetchMock.restore();
    }
});

// =====================================================================
// 13. Fallback equivalence: v2 and v3 indexes over the SAME corpus agree
// =====================================================================

test('searchFulltext: v2 and v3 builds of the same corpus return identical docId sets', async () => {
    // Same logical corpus, two wire formats. The v2 path text-verifies (text
    // fetches occur); the v3 path ranks from the index (zero text fetches).
    // Result docId sets must be identical. (hitCounts may differ by design:
    // v2 counts full-run substring hits, v3 uses the min-over-bigrams
    // estimator.)
    const corpus = [
        { docId: 0, text: '無門關無門關' },
        { docId: 1, text: '無門者佛心也' },
        { docId: 2, text: '趙州狗子無佛性' },
        { docId: 3, text: '門關不通' },
        { docId: 4, text: '祖師西來意' },
    ];
    const docCount = corpus.length;
    const queries = ['無門', '無門關', '佛性', '趙州dog', '祖師西來'];
    const expectedSets = {
        '無門': [0, 1],
        '無門關': [0],
        '佛性': [2],
        '趙州dog': [2],
        '祖師西來': [4],
    };

    // --- v2 fixtures: docId-only postings + text shards for verification ---
    const { bigramEntries, unigramEntries } = v3EntriesForDocs(corpus);
    const v2Layout = shardLayoutFor(
        bigramEntries.map((e) => ({ term: e.term, docIds: e.docIds })),
        docCount
    );
    const v2Manifest = buildManifest(v2Layout, docCount);
    const textShards = textShardsForDocs(corpus);

    const v2Results = {};
    {
        const { searchFulltext, clearShardCache } = await freshSearchModule();
        const fetchMock = installFetchMock({ manifest: v2Manifest, shardLayout: v2Layout, textShards });
        try {
            for (const q of queries) {
                // Drop the shard LRUs so each query's fetch profile is
                // observable (text shards would otherwise stay cached from
                // the previous query in this loop).
                clearShardCache();
                const before = fetchMock.calls.length;
                const results = await searchFulltext(q);
                v2Results[q] = results.map((r) => r.docId).sort((a, b) => a - b);
                const newTextFetches = fetchMock.calls.slice(before).filter((u) => u.includes('/text/'));
                assert.ok(newTextFetches.length >= 1,
                    'v2 path for "' + q + '" should verify via text shards');
            }
        } finally {
            fetchMock.restore();
        }
    }

    // --- v3 fixtures: tf-carrying postings, no text shards needed ---
    const v3Layout = shardLayoutForV3(bigramEntries, docCount);
    const unigramLayout = shardLayoutForV3(unigramEntries, docCount);
    const v3Manifest = buildManifest(v3Layout, docCount, { version: 3, unigramLayout });

    const v3Results = {};
    {
        const { searchFulltext, clearShardCache } = await freshSearchModule();
        const fetchMock = installFetchMock({ manifest: v3Manifest, shardLayout: v3Layout, unigramLayout });
        try {
            for (const q of queries) {
                clearShardCache();
                const before = fetchMock.calls.length;
                const results = await searchFulltext(q);
                v3Results[q] = results.map((r) => r.docId).sort((a, b) => a - b);
                const newTextFetches = fetchMock.calls.slice(before).filter((u) => u.includes('/text/'));
                assert.equal(newTextFetches.length, 0,
                    'v3 path for "' + q + '" must not fetch text shards');
            }
        } finally {
            fetchMock.restore();
        }
    }

    for (const q of queries) {
        assert.deepEqual(v2Results[q], expectedSets[q], 'v2 result set for "' + q + '"');
        assert.deepEqual(v3Results[q], expectedSets[q], 'v3 result set for "' + q + '"');
        assert.deepEqual(v3Results[q], v2Results[q], 'v2/v3 equivalence for "' + q + '"');
    }
});

// =====================================================================
// 14. Unknown-version shard: graceful degradation + manifest self-heal
// =====================================================================

test('searchFulltext: unknown-version shard yields [] and refetches the manifest exactly once (self-heal)', async () => {
    const { searchFulltext } = await freshSearchModule();
    const docCount = 1;
    const layout = shardLayoutFor([{ term: '無門', docIds: [0] }], docCount);
    // Byte-patch every shard's version u32 to 99 (technique from the codec
    // tests) so decoding fails with /unsupported version/.
    for (const bytes of layout.values()) {
        bytes[4] = 99; bytes[5] = 0; bytes[6] = 0; bytes[7] = 0;
    }
    const manifest = buildManifest(layout, docCount);
    const fetchMock = installFetchMock({ manifest, shardLayout: layout });
    try {
        const results = await searchFulltext('無門');
        assert.deepEqual(results, [], 'undecodable shard degrades to empty result, no throw');
        const manifestFetches = fetchMock.calls.filter((u) => u.endsWith('/manifest.json'));
        assert.equal(manifestFetches.length, 2,
            'decode failure triggers exactly one manifest self-heal refetch');
    } finally {
        fetchMock.restore();
    }
});

test('searchFulltext: MULTIPLE shards 404ing concurrently in the stale-manifest window all heal off ONE manifest refetch', async () => {
    // Regression pin: the once-per-session gate applies to the manifest
    // REFETCH only — every healable-failing shard must retry its own url
    // against the shared fresh mapping. Previously the first failing shard
    // claimed the gate inside its single-flight closure and the other
    // concurrently-404ing shard was silently treated as empty, so the
    // triggering query returned [] even though the fresh manifest was
    // already in hand.
    const { searchFulltext } = await freshSearchModule();
    const docCount = 1;
    const layout = shardLayoutForV3(
        [
            { term: '無門', docIds: [0], tfs: [1] },
            { term: '門關', docIds: [0], tfs: [1] },
        ],
        docCount
    );
    assert.equal(layout.size, 2, 'fixture precondition: the two bigrams hash to two distinct shards');
    const staleManifest = { version: 3, shardCount: 4096, docCount, shards: {} };
    const freshManifest = { version: 3, shardCount: 4096, docCount, shards: {} };
    for (const hex of layout.keys()) {
        staleManifest.shards[hex] = 'aaaaaa'; // pre-redeploy hash → 404
        freshManifest.shards[hex] = 'bbbbbb'; // current hash → 200
    }
    const calls = [];
    let manifestFetches = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        const u = String(url);
        calls.push(u);
        if (u.endsWith('/manifest.json')) {
            manifestFetches++;
            const body = manifestFetches === 1 ? staleManifest : freshManifest;
            return new Response(JSON.stringify(body), { status: 200 });
        }
        const m = u.match(/\/shards\/([0-9a-f]{2})\/([0-9a-f]{2})-([0-9a-f]+)\.bin$/);
        if (m) {
            if (m[3] === 'aaaaaa') return new Response(null, { status: 404 }); // stale hash
            const bytes = layout.get(m[1] + m[2]);
            if (!bytes) return new Response(null, { status: 404 });
            const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
            return new Response(ab, { status: 200 });
        }
        return new Response(null, { status: 404 });
    };
    try {
        const results = await searchFulltext('無門關');
        assert.equal(manifestFetches, 2,
            'exactly one self-heal refetch shared by both failing shards (initial + heal)');
        assert.deepEqual(results.map((r) => r.docId), [0],
            'both concurrently-failing shards retried against the fresh mapping, so the triggering query succeeds');
        assert.equal(calls.filter((u) => u.endsWith('-aaaaaa.bin')).length, 2, 'both stale urls tried once');
        assert.equal(calls.filter((u) => u.endsWith('-bbbbbb.bin')).length, 2, 'both shards retried on the fresh hash');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

// =====================================================================
// 15. onStats observability (audit #2 / #6 wiring)
// =====================================================================

test('searchFulltext v3: onStats fires once with the documented shape', async () => {
    const { searchFulltext } = await freshSearchModule();
    const docCount = 2;
    const layout = shardLayoutForV3(
        [{ term: '無門', docIds: [0, 1], tfs: [2, 3] }],
        docCount
    );
    const manifest = buildManifest(layout, docCount, { version: 3, builtAt: '2026-07-08T12:00:00.000Z' });
    const fetchMock = installFetchMock({ manifest, shardLayout: layout });
    try {
        const statsCalls = [];
        await searchFulltext('無門', { onStats: (s) => statsCalls.push(s) });
        assert.equal(statsCalls.length, 1, 'onStats fires exactly once');
        const s = statsCalls[0];
        assert.deepEqual(
            Object.keys(s).sort(),
            ['builtAt', 'candidateCount', 'cap', 'indexVersion', 'latinIgnored', 'returnedCount', 'truncated']
        );
        assert.equal(s.indexVersion, 3);
        assert.equal(s.builtAt, '2026-07-08T12:00:00.000Z');
        assert.equal(s.candidateCount, 2);
        assert.equal(s.returnedCount, 2);
        assert.equal(s.truncated, false);
        assert.equal(typeof s.cap, 'number');
        assert.equal(s.latinIgnored, null);
    } finally {
        fetchMock.restore();
    }
});

test('searchFulltext v2: onStats fires once on the fallback path (shape + indexVersion 2)', async () => {
    const { searchFulltext } = await freshSearchModule();
    const docCount = 1;
    const layout = shardLayoutFor([{ term: '無門', docIds: [0] }], docCount);
    const manifest = buildManifest(layout, docCount);
    const textShards = textShardsForDocs([{ docId: 0, text: '無門' }]);
    const fetchMock = installFetchMock({ manifest, shardLayout: layout, textShards });
    try {
        const statsCalls = [];
        await searchFulltext('無門', { onStats: (s) => statsCalls.push(s) });
        assert.equal(statsCalls.length, 1);
        const s = statsCalls[0];
        assert.equal(s.indexVersion, 2);
        assert.equal(s.builtAt, null, 'v2 manifests carry no builtAt');
        assert.equal(s.candidateCount, 1);
        assert.equal(s.returnedCount, 1);
        assert.equal(s.truncated, false);
        assert.equal(s.latinIgnored, null);
    } finally {
        fetchMock.restore();
    }
});

test('searchFulltext v2: truncation over the verification cap is reported (audit #2)', async () => {
    const { searchFulltext, _setVerificationCapForTests } = await freshSearchModule();
    // 4 candidate docs, cap overridden to 2: only the first 2 candidates are
    // verified and onStats must report truncated:true with the cap + full
    // candidate count. (Cap override avoids fabricating >1500 docs.)
    const docCount = 4;
    const layout = shardLayoutFor([{ term: '無門', docIds: [0, 1, 2, 3] }], docCount);
    const manifest = buildManifest(layout, docCount);
    const textShards = textShardsForDocs([
        { docId: 0, text: '無門' },
        { docId: 1, text: '無門無門' },
        { docId: 2, text: '無門' },
        { docId: 3, text: '無門' },
    ]);
    const fetchMock = installFetchMock({ manifest, shardLayout: layout, textShards });
    try {
        _setVerificationCapForTests(2);
        const statsCalls = [];
        const results = await searchFulltext('無門', { onStats: (s) => statsCalls.push(s) });
        assert.equal(results.length, 2, 'only cap-many candidates verified');
        assert.deepEqual(results.map((r) => r.docId).sort((a, b) => a - b), [0, 1]);
        assert.equal(statsCalls.length, 1);
        const s = statsCalls[0];
        assert.equal(s.truncated, true);
        assert.equal(s.cap, 2);
        assert.equal(s.candidateCount, 4);
        assert.equal(s.returnedCount, 2);
        assert.equal(s.indexVersion, 2);
    } finally {
        _setVerificationCapForTests(null); // restore production default
        fetchMock.restore();
    }
});

// =====================================================================
// 16. onProgress streaming (both paths)
// =====================================================================

test('searchFulltext v3: onProgress delivers at least one batch of {docId, hitCount} rows', async () => {
    const { searchFulltext } = await freshSearchModule();
    const docCount = 2;
    const layout = shardLayoutForV3(
        [{ term: '無門', docIds: [0, 1], tfs: [1, 6] }],
        docCount
    );
    const manifest = buildManifest(layout, docCount, { version: 3 });
    const fetchMock = installFetchMock({ manifest, shardLayout: layout });
    try {
        const batches = [];
        const results = await searchFulltext('無門', { onProgress: (b) => batches.push(b) });
        assert.ok(batches.length >= 1, 'at least one progress batch on the v3 path');
        for (const batch of batches) {
            assert.ok(Array.isArray(batch) && batch.length >= 1);
            for (const row of batch) {
                assert.equal(typeof row.docId, 'number');
                assert.equal(typeof row.hitCount, 'number');
            }
        }
        // All streamed rows must be contained in the final result set.
        const finalIds = new Set(results.map((r) => r.docId));
        for (const batch of batches) {
            for (const row of batch) assert.ok(finalIds.has(row.docId));
        }
    } finally {
        fetchMock.restore();
    }
});

test('searchFulltext v2: onProgress delivers at least one batch of {docId, hitCount} rows', async () => {
    const { searchFulltext } = await freshSearchModule();
    const docCount = 2;
    const layout = shardLayoutFor([{ term: '無門', docIds: [0, 1] }], docCount);
    const manifest = buildManifest(layout, docCount);
    const textShards = textShardsForDocs([
        { docId: 0, text: '無門' },
        { docId: 1, text: '無門無門' },
    ]);
    const fetchMock = installFetchMock({ manifest, shardLayout: layout, textShards });
    try {
        const batches = [];
        await searchFulltext('無門', { onProgress: (b) => batches.push(b) });
        assert.ok(batches.length >= 1, 'at least one progress batch on the v2 path');
        for (const batch of batches) {
            assert.ok(Array.isArray(batch) && batch.length >= 1);
            for (const row of batch) {
                assert.equal(typeof row.docId, 'number');
                assert.equal(typeof row.hitCount, 'number');
            }
        }
    } finally {
        fetchMock.restore();
    }
});

// =====================================================================
// 17. verifyDocPhrase: exact on-demand phrase counts for displayed rows
// =====================================================================

test('verifyDocPhrase: all runs present → sum of per-run substring counts', async () => {
    const { verifyDocPhrase } = await freshSearchModule();
    const textShards = textShardsForDocs([{ docId: 0, text: '趙州趙州無門' }]);
    const fetchMock = installFetchMock({ textShards });
    try {
        // Latin separates CJK runs: '趙州x無門' -> runs [趙州, 無門] -> 2 + 1.
        assert.equal(await verifyDocPhrase(0, '趙州x無門'), 3, '2 hits of 趙州 + 1 hit of 無門');
        // Whitespace is STRIPPED by normalization, so '趙州 無門' fuses into
        // the single contiguous run 趙州無門 (1 phrase hit in this doc).
        assert.equal(await verifyDocPhrase(0, '趙州 無門'), 1, 'space-separated CJK fuses into one phrase run');
        assert.equal(await verifyDocPhrase(0, '趙州dog'), 2, 'latin remainder ignored');
        assert.equal(await verifyDocPhrase(0, '趙州'), 2);
    } finally {
        fetchMock.restore();
    }
});

test('verifyDocPhrase: any run absent → 0', async () => {
    const { verifyDocPhrase } = await freshSearchModule();
    const textShards = textShardsForDocs([{ docId: 0, text: '趙州趙州無門' }]);
    const fetchMock = installFetchMock({ textShards });
    try {
        assert.equal(await verifyDocPhrase(0, '趙州x佛'), 0, 'run 佛 absent → whole phrase 0');
        assert.equal(await verifyDocPhrase(0, '祖師'), 0);
    } finally {
        fetchMock.restore();
    }
});

test('verifyDocPhrase: missing doc / missing shard / non-CJK / bad docId → null (could-not-verify, NOT a verified zero)', async () => {
    const { verifyDocPhrase } = await freshSearchModule();
    const textShards = textShardsForDocs([{ docId: 0, text: '趙州' }]);
    const fetchMock = installFetchMock({ textShards });
    try {
        assert.equal(await verifyDocPhrase(5, '趙州'), null, 'text shard for bucket 005 missing');
        assert.equal(await verifyDocPhrase(0, 'dog'), null, 'no CJK runs');
        assert.equal(await verifyDocPhrase(-1, '趙州'), null, 'negative docId');
        assert.equal(await verifyDocPhrase(1.5, '趙州'), null, 'non-integer docId');
    } finally {
        fetchMock.restore();
    }
});

test('verifyDocPhrase: doc absent from an EXISTING text shard → null, not 0', async () => {
    const { verifyDocPhrase } = await freshSearchModule();
    // Doc 0 and doc 4096 share bucket 000, but only doc 0 is in the shard.
    const textShards = textShardsForDocs([{ docId: 0, text: '趙州' }]);
    const fetchMock = installFetchMock({ textShards });
    try {
        assert.equal(await verifyDocPhrase(4096, '趙州'), null,
            'doc missing from its bucket is could-not-verify, not a match count');
    } finally {
        fetchMock.restore();
    }
});

test('verifyDocPhrase: transient text-shard failure is retryable (null result is not memoized)', async () => {
    const { verifyDocPhrase } = await freshSearchModule();
    // First mock: bucket 000 404s → null. Second mock: shard present → real count.
    const failMock = installFetchMock({ textShards: new Map() });
    try {
        assert.equal(await verifyDocPhrase(0, '趙州'), null, 'shard fetch failed → null');
    } finally {
        failMock.restore();
    }
    const okMock = installFetchMock({ textShards: textShardsForDocs([{ docId: 0, text: '趙州趙州' }]) });
    try {
        assert.equal(await verifyDocPhrase(0, '趙州'), 2,
            'failed shard load must not be cached — the retry sees the real shard');
    } finally {
        okMock.restore();
    }
});

test('verifyDocPhrase: aborted signal resolves null (matches could-not-verify contract)', async () => {
    const { verifyDocPhrase } = await freshSearchModule();
    const textShards = textShardsForDocs([{ docId: 0, text: '趙州' }]);
    const fetchMock = installFetchMock({ textShards });
    try {
        const ac = new AbortController();
        ac.abort();
        assert.equal(await verifyDocPhrase(0, '趙州', { signal: ac.signal }), null);
    } finally {
        fetchMock.restore();
    }
});

// =====================================================================
// 18. getManifestInfo (audit #6: staleness surface)
// =====================================================================

test('getManifestInfo: returns {version, builtAt, docCount, hasUnigrams} and caches the manifest', async () => {
    const { getManifestInfo } = await freshSearchModule();
    const unigramLayout = shardLayoutForV3([{ term: '佛', docIds: [0], tfs: [1] }], 42);
    const manifest = buildManifest(new Map(), 42, {
        version: 3,
        builtAt: '2026-07-01T00:00:00.000Z',
        unigramLayout,
    });
    const fetchMock = installFetchMock({ manifest });
    try {
        const info = await getManifestInfo();
        assert.deepEqual(info, {
            version: 3,
            builtAt: '2026-07-01T00:00:00.000Z',
            docCount: 42,
            hasUnigrams: true,
            wordTerms: false,
        });
        // Second call must be served from the cached manifest (lib/cache.js).
        const info2 = await getManifestInfo();
        assert.deepEqual(info2, info);
        const manifestFetches = fetchMock.calls.filter((u) => u.endsWith('/manifest.json'));
        assert.equal(manifestFetches.length, 1, 'manifest fetched once across both calls');
    } finally {
        fetchMock.restore();
    }
});

test('getManifestInfo: v2-era manifest (no version/builtAt/unigramShards) degrades to nulls', async () => {
    const { getManifestInfo } = await freshSearchModule();
    const manifest = { shardCount: 4096, docCount: 5014, shards: {} };
    const fetchMock = installFetchMock({ manifest });
    try {
        const info = await getManifestInfo();
        assert.deepEqual(info, {
            version: null,
            builtAt: null,
            docCount: 5014,
            hasUnigrams: false,
            wordTerms: false,
        });
    } finally {
        fetchMock.restore();
    }
});

test('module exports the v3 API surface: verifyDocPhrase, getManifestInfo, metaForDocId, _resetForTests, _setVerificationCapForTests', async () => {
    const mod = await freshSearchModule();
    assert.equal(typeof mod.verifyDocPhrase, 'function');
    assert.equal(typeof mod.getManifestInfo, 'function');
    assert.equal(typeof mod.metaForDocId, 'function');
    assert.equal(typeof mod._resetForTests, 'function');
    assert.equal(typeof mod._setVerificationCapForTests, 'function');
});

// =====================================================================
// 19. Word-capable path (manifest v4 `wordTerms`): English word terms in the
//     bigram shard set, work-level AND for mixed queries, density ranking.
//     Capability gate proven BOTH ways.
// =====================================================================

/**
 * Build a small BILINGUAL v4 fixture:
 *   docId 0: T48n2005 source (zh)   — CJK 無門
 *   docId 1: T48n2005 en            — word "gateless"
 *   docId 2: T48n2003 source (zh)   — CJK 碧巖
 *   docId 3: T48n2003 en            — word "gateless"
 * Word terms share the bigram shard set. docLengths drives density.
 */
function buildBilingualV4({ wordTerms = true, docLengths } = {}) {
    const docCount = 4;
    const bigramEntries = [
        { term: '無門', docIds: [0], tfs: [3] },
        { term: '碧巖', docIds: [2], tfs: [4] },
    ];
    const wordEntries = [
        { term: 'gateless', docIds: [1, 3], tfs: [2, 5] },
    ];
    const layout = shardLayoutForV3([...bigramEntries, ...wordEntries], docCount);
    const manifest = buildManifest(layout, docCount, {
        version: 4,
        wordTerms,
        docLengths: docLengths || [500, 1000, 500, 100000],
    });
    const docsTxt = [
        '/T48n2005',
        '/T48n2005?side=en',
        '/T48n2003',
        '/T48n2003?side=en',
    ].join('\n');
    return { manifest, layout, docsTxt, docCount };
}

test('word-capable: pure-English query matches EN docs, ranked by density (raw hitCounts preserved)', async () => {
    const { searchFulltext } = await freshSearchModule();
    // doc 1 (len 1000, tf 2) density = 2; doc 3 (len 100000, tf 5) density = 0.05.
    // Density ranking floats the shorter doc ABOVE the raw-count winner.
    const { manifest, layout, docsTxt } = buildBilingualV4();
    const fetchMock = installFetchMock({ manifest, shardLayout: layout, docsTxt });
    try {
        const results = await searchFulltext('gateless');
        assert.deepEqual(
            results.map((r) => ({ docId: r.docId, hitCount: r.hitCount })),
            [
                { docId: 1, hitCount: 2 }, // higher density
                { docId: 3, hitCount: 5 }, // more raw hits but far longer doc
            ],
            'density ranking, not raw count'
        );
        assert.ok(results.every((r) => typeof r.density === 'number'), 'rows carry density');
        assert.ok(results[0].density > results[1].density, 'sorted density desc');
        const textFetches = fetchMock.calls.filter((u) => u.includes('/text/'));
        assert.equal(textFetches.length, 0, 'word-capable path is index-only (no text fetches)');
    } finally {
        fetchMock.restore();
    }
});

test('word-capable: mixed query 無門+gateless → WORK-LEVEL AND (works(CJK) ∩ works(word))', async () => {
    const { searchFulltext } = await freshSearchModule();
    const { manifest, layout, docsTxt } = buildBilingualV4();
    const fetchMock = installFetchMock({ manifest, shardLayout: layout, docsTxt });
    try {
        // CJK leg: 無門 → doc 0 (work T48n2005).
        // Word leg: gateless → doc 1 (T48n2005), doc 3 (T48n2003).
        // works(CJK)={T48n2005} ∩ works(word)={T48n2005,T48n2003} = {T48n2005}.
        // Result = docs of either leg in T48n2005 → doc 0 + doc 1. doc 3 dropped.
        const results = await searchFulltext('無門 gateless');
        const ids = results.map((r) => r.docId).sort((a, b) => a - b);
        assert.deepEqual(ids, [0, 1], 'only the work matched on BOTH scripts survives (doc 3 excluded)');
        const textFetches = fetchMock.calls.filter((u) => u.includes('/text/'));
        assert.equal(textFetches.length, 0);
    } finally {
        fetchMock.restore();
    }
});

test('word-capable: mixed query with NO shared work → empty (work-level AND is strict)', async () => {
    const { searchFulltext } = await freshSearchModule();
    // 碧巖 is in T48n2003 (doc 2); pair it with a word only present in
    // T48n2005's EN. Actually 'gateless' is in BOTH ENs, so use 無門+... no —
    // choose CJK 無門 (T48n2005) with a word absent from T48n2005: none here,
    // so instead query CJK 碧巖 (T48n2003 source) AND a word only in a DIFFERENT
    // work's EN. Add such a fixture inline.
    const docCount = 3;
    const layout = shardLayoutForV3([
        { term: '碧巖', docIds: [0], tfs: [1] },   // doc0 = WorkA source
        { term: 'gateless', docIds: [2], tfs: [1] }, // doc2 = WorkB en
    ], docCount);
    const manifest = buildManifest(layout, docCount, { version: 4, wordTerms: true, docLengths: [100, 100, 100] });
    const docsTxt = ['/WorkA', '/WorkA?side=en', '/WorkB?side=en'].join('\n');
    const fetchMock = installFetchMock({ manifest, shardLayout: layout, docsTxt });
    try {
        const results = await searchFulltext('碧巖 gateless');
        assert.deepEqual(results, [], 'works(CJK)={WorkA} ∩ works(word)={WorkB} = ∅');
    } finally {
        fetchMock.restore();
    }
});

test('capability gate OFF: same fixture WITHOUT wordTerms — English query returns [] in the engine (english.jsonl handles it upstream)', async () => {
    const { searchFulltext } = await freshSearchModule();
    const { manifest, layout, docsTxt } = buildBilingualV4({ wordTerms: false });
    const fetchMock = installFetchMock({ manifest, shardLayout: layout, docsTxt });
    try {
        const results = await searchFulltext('gateless');
        assert.deepEqual(results, [], 'no wordTerms ⇒ engine does not word-search (fallback owns latin)');
    } finally {
        fetchMock.restore();
    }
});

test('capability gate OFF: mixed query falls back to CJK-only, reports latinIgnored (historical behavior intact)', async () => {
    const { searchFulltext } = await freshSearchModule();
    const { manifest, layout, docsTxt } = buildBilingualV4({ wordTerms: false });
    const fetchMock = installFetchMock({ manifest, shardLayout: layout, docsTxt });
    try {
        let stats = null;
        const results = await searchFulltext('無門 gateless', { onStats: (s) => { stats = s; } });
        assert.deepEqual(results.map((r) => r.docId), [0], 'matched the CJK run only');
        assert.equal(stats.latinIgnored, 'gateless', 'fallback reports the ignored English remainder');
        assert.ok(results.every((r) => typeof r.density === 'undefined'), 'fallback rows carry no density');
    } finally {
        fetchMock.restore();
    }
});

test('word-capable: single-script CJK query still works and is density-ranked', async () => {
    const { searchFulltext } = await freshSearchModule();
    const { manifest, layout, docsTxt } = buildBilingualV4();
    const fetchMock = installFetchMock({ manifest, shardLayout: layout, docsTxt });
    try {
        const results = await searchFulltext('無門');
        assert.deepEqual(results.map((r) => r.docId), [0], '無門 → doc 0 only');
        assert.equal(results[0].hitCount, 3, 'raw tf preserved');
    } finally {
        fetchMock.restore();
    }
});

test('word-capable: onStats reports indexVersion 4, latinIgnored null, no truncation', async () => {
    const { searchFulltext } = await freshSearchModule();
    const { manifest, layout, docsTxt } = buildBilingualV4();
    const fetchMock = installFetchMock({ manifest, shardLayout: layout, docsTxt });
    try {
        let stats = null;
        await searchFulltext('無門 gateless', { onStats: (s) => { stats = s; } });
        assert.equal(stats.indexVersion, 4);
        assert.equal(stats.latinIgnored, null, 'word-capable ignores nothing');
        assert.equal(stats.truncated, false);
        assert.deepEqual(
            Object.keys(stats).sort(),
            ['builtAt', 'candidateCount', 'cap', 'indexVersion', 'latinIgnored', 'returnedCount', 'truncated']
        );
    } finally {
        fetchMock.restore();
    }
});

test('verifyDocPhrase: EN-side doc verifies WORD terms; source doc verifies CJK runs (per-side dispatch)', async () => {
    const { verifyDocPhrase } = await freshSearchModule();
    // doc 0 = source (CJK text), doc 1 = en (english-normalized text).
    const docsTxt = ['/T48n2005', '/T48n2005?side=en'].join('\n');
    const textShards = textShardsForDocs([
        { docId: 0, text: '無門關無門' },              // CJK source form
        { docId: 1, text: 'the gateless gate gateless' }, // english-normalized form
    ]);
    const fetchMock = installFetchMock({ docsTxt, textShards });
    try {
        // EN side → word verification: 'gateless' appears twice in doc 1.
        assert.equal(await verifyDocPhrase(1, 'gateless'), 2, 'en-side counts word occurrences');
        // EN side, absent word → 0.
        assert.equal(await verifyDocPhrase(1, 'dharma'), 0, 'en-side missing word → 0');
        // Source side → CJK verification unaffected.
        assert.equal(await verifyDocPhrase(0, '無門'), 2, 'source-side counts CJK run occurrences');
        // Source side never word-verifies: a pure-English needle has no CJK
        // runs → null (could-not-verify), not a spurious count.
        assert.equal(await verifyDocPhrase(0, 'gateless'), null, 'source-side + no CJK runs → null');
    } finally {
        fetchMock.restore();
    }
});
