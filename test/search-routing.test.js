import { resolveKwicUrl } from '../lib/search.js';
// test/search-routing.test.js
//
// Verifies the post-Wave-3 federatedSearch routing rewire in lib/search.js:
//   - CJK queries route to lib/bigram-search.js#searchFulltext
//   - Latin queries scan /data/search/english.jsonl
//   - Empty/whitespace queries return empty fulltext
//   - filters (translated/zen/corpus) and allowedFileIds are applied
//
// Approach: mock globalThis.fetch to serve a small in-memory english.jsonl
// for Latin queries, and intercept the dynamic-import-cached bigram-search
// module by stubbing its fetch endpoints (manifest, shards, docs.txt, text
// shards) so a CJK query actually walks through the real lib/search.js +
// lib/bigram-search.js code paths.
//
// We use a mocked fetch (not module-level mocking) so the real lib/search.js
// is exercised end-to-end, including the CJK→bigram routing decision via
// containsCjk.

import { test } from 'node:test';
import assert from 'node:assert/strict';

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
    installFetchMock,
} from './_search-fixtures.js';

// ----- Fetch fixture infrastructure lives in test/_search-fixtures.js -----

/** Reset shared module-level state in lib/search.js + lib/bigram-search.js.
 *
 * Because lib/search.js's `import` of './bigram-search.js' resolves to the
 * same singleton instance regardless of how many times lib/search.js itself
 * is re-imported with a stamp, we reset bigram-search's module state via its
 * `_resetForTests` export (docs list, LRU caches, manifest refetch flag) and
 * clear the manifest cache via lib/cache.js. */
async function freshSearchModule() {
    cache.clear();
    bigramModule._resetForTests();
    // Re-import lib/search.js with a stamp to reset its module-level
    // _englishCorpusPromise (so a stale cached english.jsonl doesn't bleed
    // into the next test).
    const stamp = Date.now() + ':' + Math.random().toString(36).slice(2);
    return await import(`../lib/search.js?ts=${stamp}`);
}

// ===================================================================
// Routing tests
// ===================================================================

test('federatedSearch: CJK query routes to bigram backend, NOT english.jsonl', async () => {
    const { federatedSearch } = await freshSearchModule();

    // Build a tiny CJK fixture: 2 docs, query 無門關 matches both.
    const docCount = 2;
    const layout = shardLayoutFor(
        [
            { term: '無門', docIds: [0, 1] },
            { term: '門關', docIds: [0, 1] },
        ],
        docCount
    );
    const manifest = buildManifest(layout, docCount);
    const docsTxt = '/T48n2005\n/oz.wm32.case01';
    const textShards = new Map();
    const docs = [
        { docId: 0, text: '無門關' },
        { docId: 1, text: '無門關' },
    ];
    for (const d of docs) {
        const b = textBucketFor(d.docId);
        if (!textShards.has(b)) textShards.set(b, []);
        textShards.get(b).push(d);
    }
    const ndjsonShards = new Map();
    for (const [b, list] of textShards.entries()) ndjsonShards.set(b, buildTextShardNdjson(list));

    // Title data so the routing path can resolve titles.
    // Real titles.jsonl records do NOT carry `translated`/`zen` flags;
    // those facts live in the translatedIds/zenIds Sets passed alongside.
    const titleData = [
        { fileId: 'T48n2005', zh: '無門關', en: 'Gateless Gate', path: 'T48n2005.xml', corpus: 'cbeta' },
        { fileId: 'oz.wm32.case01', zh: '無門關 case 1', en: 'Wumenguan Case 1', path: 'oz/wm32-case01.xml', corpus: 'openzen' },
    ];

    const englishJsonl = JSON.stringify({ fileId: 'unrelated', titleEn: 'Bodhidharma', text: 'bodhidharma was a teacher' });

    const fetchMock = installFetchMock({
        manifest, docsTxt,
        shardLayout: layout,
        textShards: ndjsonShards,
        englishJsonl,
    });
    try {
        const { fulltext } = await federatedSearch('無門關', { titles: titleData });
        const results = await fulltext;
        // Both docs verified.
        assert.equal(results.length, 2, `expected 2 CJK hits, got ${results.length}`);
        // Verify routing: english.jsonl must NOT have been fetched for a CJK query.
        const englishCalls = fetchMock.calls.filter(u => u.includes('/english.jsonl'));
        assert.equal(englishCalls.length, 0, 'CJK query must not fetch english.jsonl');
        // Verify shape.
        for (const r of results) {
            assert.ok(r.url.startsWith('/'));
            assert.ok(r.meta.file_id);
            assert.ok(typeof r.hitCount === 'number' && r.hitCount > 0);
        }
    } finally {
        fetchMock.restore();
    }
});

test('federatedSearch: Latin query routes to english.jsonl, NOT bigram backend', async () => {
    const { federatedSearch } = await freshSearchModule();

    // Build english.jsonl with one Bodhidharma record (lowercase already, per build contract).
    const englishJsonl = [
        JSON.stringify({ fileId: 'T48n2005', side: 'translation', titleEn: 'Gateless Gate', text: 'no gate. bodhidharma came from the west.' }),
        JSON.stringify({ fileId: 'oz.bo01', side: 'translation', titleEn: 'Bodhidharma intro', text: 'introduction to bodhidharma' }),
    ].join('\n');

    const titleData = [
        { fileId: 'T48n2005', zh: '無門關', en: 'Gateless Gate', path: 'T48n2005.xml' },
        { fileId: 'oz.bo01', zh: '達摩', en: 'Bodhidharma intro', path: 'oz/bo01.xml' },
    ];

    const fetchMock = installFetchMock({ englishJsonl });
    try {
        const { fulltext } = await federatedSearch('Bodhidharma', { titles: titleData });
        const results = await fulltext;
        assert.equal(results.length, 2, `expected 2 latin hits, got ${results.length}`);
        // Verify routing: bigram manifest must NOT have been fetched for a Latin query.
        const manifestCalls = fetchMock.calls.filter(u => u.includes('/manifest.json'));
        assert.equal(manifestCalls.length, 0, 'Latin query must not fetch bigram manifest');
        // Verify english.jsonl was fetched exactly once.
        const ejCalls = fetchMock.calls.filter(u => u.includes('/english.jsonl'));
        assert.equal(ejCalls.length, 1);
        // Verify hitCount.
        for (const r of results) {
            assert.ok(r.hitCount >= 1);
        }
    } finally {
        fetchMock.restore();
    }
});

test('federatedSearch: empty query returns empty fulltext (no fetches)', async () => {
    const { federatedSearch } = await freshSearchModule();
    const fetchMock = installFetchMock({});
    try {
        const { fulltext, masters, titles } = await federatedSearch('', {
            masters: [], titles: [],
        });
        const results = await fulltext;
        assert.deepEqual(results, []);
        assert.equal(fetchMock.calls.length, 0, 'empty query should not trigger any fetch');
        assert.deepEqual(masters, []);
        assert.deepEqual(titles, []);
    } finally {
        fetchMock.restore();
    }
});

test('federatedSearch: whitespace-only query is treated as empty', async () => {
    const { federatedSearch } = await freshSearchModule();
    const fetchMock = installFetchMock({});
    try {
        const { fulltext } = await federatedSearch('   \t  \n ', {
            masters: [], titles: [],
        });
        const results = await fulltext;
        assert.deepEqual(results, []);
        assert.equal(fetchMock.calls.length, 0);
    } finally {
        fetchMock.restore();
    }
});

test('federatedSearch: latin query applies translated="false" filter via translatedIds Set', async () => {
    const { federatedSearch } = await freshSearchModule();
    const englishJsonl = [
        JSON.stringify({ fileId: 'A', titleEn: 'A', text: 'foo' }),
        JSON.stringify({ fileId: 'B', titleEn: 'B', text: 'foo' }),
    ].join('\n');
    // Real-shape fixtures: NO synthetic translated/zen fields.
    const titleData = [
        { fileId: 'A', en: 'A' },
        { fileId: 'B', en: 'B' },
    ];
    const translatedIds = new Set(['A']); // only A is translated
    const fetchMock = installFetchMock({ englishJsonl });
    try {
        const { fulltext } = await federatedSearch('foo', {
            titles: titleData,
            filters: { translated: 'false' },
            translatedIds,
        });
        const results = await fulltext;
        assert.equal(results.length, 1, 'only B should pass translated=false filter');
        assert.equal(results[0].meta.file_id, 'B');
    } finally {
        fetchMock.restore();
    }
});

test('federatedSearch: stripped-shape titles + active filter requires translatedIds Set', async () => {
    // Regression: real titles.jsonl has no `translated` field. Without the
    // Set, `translated:true` filter must return 0. With the Set, it returns 1.
    const { federatedSearch } = await freshSearchModule();
    const englishJsonl = JSON.stringify({ fileId: 'X', titleEn: 'X', text: 'foo' });
    const titleData = [{ fileId: 'X', en: 'X' }]; // stripped: no `translated`

    let mock = installFetchMock({ englishJsonl });
    try {
        const { fulltext } = await federatedSearch('foo', {
            titles: titleData,
            filters: { translated: 'true' },
            // No translatedIds Set: nothing is translated → 0 results.
        });
        const results = await fulltext;
        assert.equal(results.length, 0,
            'stripped-shape titles + translated=true filter without Set must return 0');
    } finally {
        mock.restore();
    }

    mock = installFetchMock({ englishJsonl });
    try {
        const { fulltext } = await federatedSearch('foo', {
            titles: titleData,
            filters: { translated: 'true' },
            translatedIds: new Set(['X']),
        });
        const results = await fulltext;
        assert.equal(results.length, 1,
            'with translatedIds Set, X passes translated=true filter');
        assert.equal(results[0].meta.file_id, 'X');
    } finally {
        mock.restore();
    }
});

test('federatedSearch: B10 — same fileId + different translator → distinct rows', async () => {
    // Two english.jsonl records sharing fileId but with different translator
    // values must surface as TWO results with distinct meta, not be merged.
    const { federatedSearch } = await freshSearchModule();
    const englishJsonl = [
        JSON.stringify({ fileId: 'T48n2005', titleEn: 'Gateless Gate', text: 'koan' }),
        JSON.stringify({ fileId: 'T48n2005', translator: 'Alice', titleEn: 'Gateless Gate (Alice)', text: 'koan' }),
        JSON.stringify({ fileId: 'T48n2005', translator: 'Bob', titleEn: 'Gateless Gate (Bob)', text: 'koan' }),
    ].join('\n');
    const titleData = [{ fileId: 'T48n2005', en: 'Gateless Gate' }];
    const fetchMock = installFetchMock({ englishJsonl });
    try {
        const { fulltext } = await federatedSearch('koan', { titles: titleData });
        const results = await fulltext;
        assert.equal(results.length, 3, 'expected 3 distinct rows (canonical + Alice + Bob)');
        const sides = results.map(r => r.meta.side).sort();
        assert.deepEqual(sides, ['community', 'community', 'en']);
        const translators = results.map(r => r.meta.translator).filter(Boolean).sort();
        assert.deepEqual(translators, ['Alice', 'Bob']);
        // URLs must carry the side/translator query params so navigation
        // lands on the right variant.
        const aliceRow = results.find(r => r.meta.translator === 'Alice');
        assert.ok(aliceRow.url.includes('side=community'));
        assert.ok(aliceRow.url.includes('translator=Alice'));
    } finally {
        fetchMock.restore();
    }
});

test('federatedSearch: B6 fail-closed — active filter + missing title → exclude', async () => {
    // A docId whose fileId is not in titleData + an active filter must be
    // excluded (fail-closed). Without an active filter, it passes through.
    const { federatedSearch } = await freshSearchModule();
    const englishJsonl = [
        JSON.stringify({ fileId: 'mystery', titleEn: 'Mystery', text: 'foo' }),
    ].join('\n');
    const titleData = []; // mystery has no title record

    let mock = installFetchMock({ englishJsonl });
    try {
        // Active filter + no title => fail closed.
        const { fulltext } = await federatedSearch('foo', {
            titles: titleData,
            filters: { translated: 'true' },
            translatedIds: new Set(['mystery']),
        });
        const results = await fulltext;
        assert.equal(results.length, 0,
            'fail-closed: missing title + active filter must exclude row');
    } finally {
        mock.restore();
    }

    mock = installFetchMock({ englishJsonl });
    try {
        // No active filter => row passes through.
        const { fulltext } = await federatedSearch('foo', { titles: titleData });
        const results = await fulltext;
        assert.equal(results.length, 1, 'no filter → mystery row passes through');
    } finally {
        mock.restore();
    }
});

test('federatedSearch: latin query with allowedFileIds filter via masterFilter would restrict', async () => {
    // We can't invoke masterFilter (it fetches from a remote URL); instead
    // exercise the in-memory equivalent by passing titles where one is gated
    // out via the allowedFileIds Set computed inside federatedSearch.
    // (This test confirms title-level filters compose with the latin path.)
    const { federatedSearch } = await freshSearchModule();
    const englishJsonl = [
        JSON.stringify({ fileId: 'A', titleEn: 'A', text: 'koan' }),
        JSON.stringify({ fileId: 'B', titleEn: 'B', text: 'koan' }),
    ].join('\n');
    const titleData = [
        { fileId: 'A', en: 'A', corpus: 'cbeta' },
        { fileId: 'B', en: 'B', corpus: 'openzen' },
    ];
    const fetchMock = installFetchMock({ englishJsonl });
    try {
        const { fulltext } = await federatedSearch('koan', {
            titles: titleData,
            filters: { corpus: 'cbeta' },
        });
        const results = await fulltext;
        assert.equal(results.length, 1);
        assert.equal(results[0].meta.file_id, 'A');
    } finally {
        fetchMock.restore();
    }
});

test('federatedSearch: latin query — counts non-overlapping occurrences', async () => {
    const { federatedSearch } = await freshSearchModule();
    const englishJsonl = JSON.stringify({
        fileId: 'doc1',
        titleEn: 'Multi',
        text: 'aa aa aa', // 3 occurrences of 'aa' (whitespace-separated, but indexOf is non-overlapping)
    });
    const titleData = [{ fileId: 'doc1', en: 'Multi' }];
    const fetchMock = installFetchMock({ englishJsonl });
    try {
        const { fulltext } = await federatedSearch('aa', { titles: titleData });
        const results = await fulltext;
        assert.equal(results.length, 1);
        assert.equal(results[0].hitCount, 3, 'expected 3 non-overlapping hits');
    } finally {
        fetchMock.restore();
    }
});

test('federatedSearch: CJK query gracefully degrades when manifest 404s', async () => {
    // searchFullText catches BigramIndexUnavailable and returns []; verifies
    // the public contract "Federated full-text search failed" warn path
    // doesn't propagate to the caller.
    const { federatedSearch } = await freshSearchModule();
    const fetchMock = installFetchMock({ manifest: null });  // 404
    try {
        const { fulltext } = await federatedSearch('無門', { titles: [] });
        const results = await fulltext;
        assert.deepEqual(results, [], 'manifest 404 → empty results, not an exception');
    } finally {
        fetchMock.restore();
    }
});

test('federatedSearch: CJK query with no matching bigrams returns empty quietly', async () => {
    const { federatedSearch } = await freshSearchModule();
    // Manifest is valid but every bucket is "0" (empty).
    const manifest = { shardCount: 4096, docCount: 0, shards: {} };
    const wuMen = bucketHexForBigram('無門');
    manifest.shards[wuMen] = '0';
    const fetchMock = installFetchMock({ manifest, docsTxt: '' });
    try {
        const { fulltext } = await federatedSearch('無門', { titles: [] });
        const results = await fulltext;
        assert.deepEqual(results, []);
    } finally {
        fetchMock.restore();
    }
});

// ===================================================================
// Latin result ordering (audit #5)
// ===================================================================

test('federatedSearch: latin rows are sorted by hitCount descending (audit #5)', async () => {
    const { federatedSearch } = await freshSearchModule();
    // Three records with 1 / 5 / 3 hits of "koan", deliberately in
    // non-sorted corpus order.
    const englishJsonl = [
        JSON.stringify({ fileId: 'A', titleEn: 'A', text: 'koan' }),
        JSON.stringify({ fileId: 'B', titleEn: 'B', text: 'koan koan koan koan koan' }),
        JSON.stringify({ fileId: 'C', titleEn: 'C', text: 'koan koan koan' }),
    ].join('\n');
    const titleData = [
        { fileId: 'A', en: 'A' },
        { fileId: 'B', en: 'B' },
        { fileId: 'C', en: 'C' },
    ];
    const fetchMock = installFetchMock({ englishJsonl });
    try {
        const { fulltext } = await federatedSearch('koan', { titles: titleData });
        const results = await fulltext;
        assert.equal(results.length, 3);
        assert.deepEqual(
            results.map((r) => ({ fileId: r.meta.file_id, hitCount: r.hitCount })),
            [
                { fileId: 'B', hitCount: 5 },
                { fileId: 'C', hitCount: 3 },
                { fileId: 'A', hitCount: 1 },
            ],
            'rows strictly hitCount-descending, not corpus file order'
        );
        for (let i = 1; i < results.length; i++) {
            assert.ok(results[i - 1].hitCount >= results[i].hitCount,
                'monotone non-increasing hitCounts');
        }
    } finally {
        fetchMock.restore();
    }
});

// ===================================================================
// Fulltext row shape: top-level docId (verify-on-demand needs it)
// ===================================================================

test('federatedSearch: CJK fulltext rows carry a top-level numeric docId', async () => {
    const { federatedSearch } = await freshSearchModule();
    const docCount = 2;
    const layout = shardLayoutForV3(
        [{ term: '無門', docIds: [0, 1], tfs: [3, 1] }],
        docCount
    );
    const manifest = buildManifest(layout, docCount, { version: 3 });
    const docsTxt = '/T48n2005\n/oz.wm32.case01';
    const fetchMock = installFetchMock({ manifest, shardLayout: layout, docsTxt });
    try {
        const { fulltext } = await federatedSearch('無門', { titles: [] });
        const results = await fulltext;
        assert.equal(results.length, 2);
        const byFileId = new Map(results.map((r) => [r.meta.file_id, r]));
        assert.equal(byFileId.get('T48n2005').docId, 0);
        assert.equal(byFileId.get('oz.wm32.case01').docId, 1);
        for (const r of results) {
            assert.equal(typeof r.docId, 'number', 'top-level docId present on every row');
        }
    } finally {
        fetchMock.restore();
    }
});

// ===================================================================
// onFulltextStats forwarding (both paths)
// ===================================================================

test('federatedSearch: onFulltextStats fires on the CJK path with bigram-index stats', async () => {
    const { federatedSearch } = await freshSearchModule();
    const docCount = 1;
    const layout = shardLayoutForV3(
        [{ term: '無門', docIds: [0], tfs: [4] }],
        docCount
    );
    const manifest = buildManifest(layout, docCount, { version: 3, builtAt: '2026-07-08T00:00:00.000Z' });
    const fetchMock = installFetchMock({ manifest, shardLayout: layout, docsTxt: '/T48n2005' });
    try {
        const statsCalls = [];
        const { fulltext } = await federatedSearch('無門', {
            titles: [],
            onFulltextStats: (s) => statsCalls.push(s),
        });
        await fulltext;
        assert.equal(statsCalls.length, 1, 'stats forwarded exactly once');
        assert.equal(statsCalls[0].indexVersion, 3);
        assert.equal(statsCalls[0].builtAt, '2026-07-08T00:00:00.000Z');
        assert.equal(statsCalls[0].truncated, false);
    } finally {
        fetchMock.restore();
    }
});

test('federatedSearch: onFulltextStats fires on the latin path with null index fields', async () => {
    const { federatedSearch } = await freshSearchModule();
    const englishJsonl = [
        JSON.stringify({ fileId: 'A', titleEn: 'A', text: 'koan' }),
        JSON.stringify({ fileId: 'B', titleEn: 'B', text: 'koan koan' }),
    ].join('\n');
    const titleData = [
        { fileId: 'A', en: 'A' },
        { fileId: 'B', en: 'B' },
    ];
    const fetchMock = installFetchMock({ englishJsonl });
    try {
        const statsCalls = [];
        const { fulltext } = await federatedSearch('koan', {
            titles: titleData,
            onFulltextStats: (s) => statsCalls.push(s),
        });
        const results = await fulltext;
        assert.equal(statsCalls.length, 1, 'latin scan emits stats exactly once');
        const s = statsCalls[0];
        assert.equal(s.indexVersion, null, 'no bigram index on the latin path');
        assert.equal(s.builtAt, null);
        assert.equal(s.candidateCount, results.length);
        assert.equal(s.returnedCount, results.length);
        assert.equal(s.truncated, false);
        assert.equal(s.latinIgnored, null);
    } finally {
        fetchMock.restore();
    }
});

// ===================================================================
// metaForDocId: docs.txt query-string parsing (side / translator)
// ===================================================================

test('metaForDocId: parses side and translator query params from docs.txt entries', async () => {
    await freshSearchModule(); // resets the cached docs list
    const docsTxt = [
        '/T48n2005',
        '/T48n2005?side=en',
        '/T48n2005?side=community&translator=Alice%20B',
        '/oz.wm32.case01?translator=Bob&side=community',
    ].join('\n');
    const fetchMock = installFetchMock({ docsTxt });
    try {
        assert.deepEqual(await bigramModule.metaForDocId(0), {
            url: '/T48n2005', fileId: 'T48n2005', side: '', translator: '',
        });
        assert.deepEqual(await bigramModule.metaForDocId(1), {
            url: '/T48n2005?side=en', fileId: 'T48n2005', side: 'en', translator: '',
        });
        assert.deepEqual(await bigramModule.metaForDocId(2), {
            url: '/T48n2005?side=community&translator=Alice%20B',
            fileId: 'T48n2005', side: 'community', translator: 'Alice B',
        }, 'translator is percent-decoded; fileId excludes the query string');
        assert.deepEqual(await bigramModule.metaForDocId(3), {
            url: '/oz.wm32.case01?translator=Bob&side=community',
            fileId: 'oz.wm32.case01', side: 'community', translator: 'Bob',
        }, 'param order does not matter');
        assert.equal(await bigramModule.metaForDocId(99), null, 'out-of-range docId → null');
        assert.equal(await bigramModule.metaForDocId(-1), null);
    } finally {
        fetchMock.restore();
    }
});

// -- resolveKwicUrl: expand-time KWIC must search the document the hits live in --

test('resolveKwicUrl: source side searches the Chinese source', () => {
    assert.match(resolveKwicUrl('T48n2005', '', ''), /CbetaZenTexts.*T48n2005\.xml$/);
});

test('resolveKwicUrl: en side searches the authoritative translation', () => {
    assert.match(resolveKwicUrl('T48n2005', 'en', ''), /CbetaZenTranslations.*T48n2005\.xml$/);
});

test('resolveKwicUrl: community side searches that translator file', () => {
    const url = resolveKwicUrl('T48n2005', 'community', 'Fabulu');
    assert.match(url, /community/);
    assert.match(url, /Fabulu/);
});

test('resolveKwicUrl: community without translator falls back to authoritative EN', () => {
    assert.match(resolveKwicUrl('T48n2005', 'community', ''), /CbetaZenTranslations.*T48n2005\.xml$/);
});
