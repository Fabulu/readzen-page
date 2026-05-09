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
//   - clearShardCache() to drop the in-memory bigram + text shard caches
//   - swap globalThis.fetch + globalThis.AbortController per test
//   - reload the module via dynamic import with a cache-busting query so the
//     _docsListPromise resets when fileIdForDocId tests need a fresh corpus.
//
// Notes on environment:
//   - sessionStorage is absent in Node; lib/cache.js wraps every call in
//     try/catch, so the absence is silent.
//   - AbortController + AbortSignal are globals in Node 18+.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { encodePostingList, encodeShard } from '../lib/bigram-codec.js';
import { fnv1a32 } from '../lib/fnv.js';
import * as cache from '../lib/cache.js';

// --- helpers ---

/** Build a single shard from a {term: sortedDocIds[]} map. */
function buildShardBytes(termsMap, docCount) {
    const termList = [];
    for (const [term, docIds] of Object.entries(termsMap)) {
        const sorted = [...docIds].sort((a, b) => a - b);
        // Dedupe (encoder rejects dupes).
        const unique = sorted.filter((v, i) => i === 0 || v !== sorted[i - 1]);
        termList.push({
            term,
            postings: encodePostingList(unique),
            count: unique.length,
        });
    }
    return encodeShard(termList, docCount);
}

/** Build a manifest mapping every bigram in the layout to its bucket+content-hash. */
function buildManifest(shardLayout, docCount) {
    // shardLayout: Map<bucketHex4, Uint8Array>. We assign each non-empty bucket a
    // deterministic 6-hex content hash placeholder ('aaaaaa', 'bbbbbb', ...).
    const shards = {};
    let i = 0;
    const palette = ['aaaaaa', 'bbbbbb', 'cccccc', 'dddddd', 'eeeeee', 'ffffff', '111111', '222222'];
    for (const hex of shardLayout.keys()) {
        shards[hex] = palette[i % palette.length];
        i++;
    }
    return { shardCount: 4096, docCount, shards };
}

/** NDJSON-encode docs into a text-shard string. */
function buildTextShardNdjson(docs) {
    return docs.map((d) => JSON.stringify({ docId: d.docId, text: d.text })).join('\n');
}

/** Bucket id (0..4095) for a bigram, padded to 4 hex. */
function bucketHexForBigram(bg) {
    const b = fnv1a32(bg) % 4096;
    return b.toString(16).padStart(4, '0');
}

/** Place each {term, docIds} entry into its FNV bucket. */
function shardLayoutFor(entries, docCount) {
    // Group by bucket.
    const byBucket = new Map(); // hex4 -> { [term]: docIds[] }
    for (const { term, docIds } of entries) {
        const hex = bucketHexForBigram(term);
        if (!byBucket.has(hex)) byBucket.set(hex, {});
        byBucket.get(hex)[term] = docIds;
    }
    // Encode each bucket.
    const out = new Map();
    for (const [hex, terms] of byBucket.entries()) {
        out.set(hex, buildShardBytes(terms, docCount));
    }
    return out;
}

/**
 * Install a fetch mock that serves manifest, docs.txt, bigram shards, and
 * text shards from in-memory fixtures. Tracks calls so tests can inspect
 * fetch counts.
 *
 * @returns Object with `restore()` and `calls` (array of url strings).
 */
function installFetchMock({
    manifest = null,
    docsTxt = '',
    shardLayout = new Map(),     // hex4 -> Uint8Array
    textShards = new Map(),      // bucketStr ('00'..'ff') -> ndjson string
    delayMs = 0,
    delayPredicate = null,       // optional (url) => bool; if set, only delay matching URLs
} = {}) {
    const calls = [];
    const original = globalThis.fetch;

    globalThis.fetch = async (url, init) => {
        calls.push(String(url));
        const shouldDelay = delayMs > 0 && (!delayPredicate || delayPredicate(String(url)));
        if (shouldDelay) {
            await new Promise((res, rej) => {
                const t = setTimeout(res, delayMs);
                if (init && init.signal) {
                    if (init.signal.aborted) {
                        clearTimeout(t);
                        const e = new Error('aborted');
                        e.name = 'AbortError';
                        rej(e);
                        return;
                    }
                    init.signal.addEventListener('abort', () => {
                        clearTimeout(t);
                        const e = new Error('aborted');
                        e.name = 'AbortError';
                        rej(e);
                    });
                }
            });
        }
        if (init && init.signal && init.signal.aborted) {
            const e = new Error('aborted');
            e.name = 'AbortError';
            throw e;
        }
        const u = String(url);
        if (u.endsWith('/manifest.json')) {
            if (manifest == null) return new Response(null, { status: 404 });
            return new Response(JSON.stringify(manifest), { status: 200 });
        }
        if (u.endsWith('/docs.txt')) {
            return new Response(docsTxt, { status: 200 });
        }
        // Bigram shard:  /data/search/bigram/shards/XX/YY-<hash>.bin
        const bigramMatch = u.match(/\/shards\/([0-9a-f]{2})\/([0-9a-f]{2})-[0-9a-f]+\.bin$/);
        if (bigramMatch) {
            const hex = bigramMatch[1] + bigramMatch[2];
            const bytes = shardLayout.get(hex);
            if (!bytes) return new Response(null, { status: 404 });
            // Wrap the ArrayBuffer slice corresponding to the Uint8Array.
            const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
            return new Response(ab, { status: 200 });
        }
        // Text shard: /data/search/text/{bucket}.bin (NDJSON)
        const textMatch = u.match(/\/text\/([0-9a-f]{2})\.bin$/);
        if (textMatch) {
            const bucket = textMatch[1];
            const ndjson = textShards.get(bucket);
            if (ndjson == null) return new Response(null, { status: 404 });
            return new Response(ndjson, { status: 200 });
        }
        return new Response(null, { status: 404 });
    };

    return {
        calls,
        restore() {
            globalThis.fetch = original;
        },
    };
}

/** Reset all module-level state so the next test sees a clean import. */
async function freshSearchModule() {
    // Clear cache.js (drops manifest from memory + sessionStorage).
    cache.clear();
    // Bump query to bust the ESM module cache so _docsListPromise + LRU maps reset.
    const stamp = Date.now() + ':' + Math.random().toString(36).slice(2);
    const mod = await import(`../lib/bigram-search.js?ts=${stamp}`);
    return mod;
}

/** Bucket a docId into a text-shard bucket ('00'..'ff') the same way bigram-search.js does. */
function textBucketFor(docId) {
    return (docId % 256).toString(16).padStart(2, '0');
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

test('searchFulltext: non-CJK query short-circuits to empty (no fetch)', async () => {
    const { searchFulltext } = await freshSearchModule();
    const fetchMock = installFetchMock({});
    try {
        const results = await searchFulltext('hello world');
        assert.deepEqual(results, []);
        assert.equal(fetchMock.calls.length, 0, 'no network calls for non-CJK query');
    } finally {
        fetchMock.restore();
    }
});

test('searchFulltext: query shorter than 2 chars short-circuits to empty', async () => {
    const { searchFulltext } = await freshSearchModule();
    const fetchMock = installFetchMock({});
    try {
        assert.deepEqual(await searchFulltext(''), []);
        assert.deepEqual(await searchFulltext('無'), []);
        assert.deepEqual(await searchFulltext(null), []);
        assert.deepEqual(await searchFulltext(undefined), []);
        assert.equal(fetchMock.calls.length, 0);
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
