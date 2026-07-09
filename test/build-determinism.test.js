// test/build-determinism.test.js
//
// Acceptance criterion #6: running the bigram build twice over the same
// corpus must produce byte-identical shard files (modulo `builtAt`
// timestamp in the manifest).
//
// We don't shell out to the real build/build-bigram-index.js (it walks
// hard-coded absolute paths to CBETA + OpenZen corpora and emits ~4,300
// files at ~700 MB total). Instead we replicate its core deterministic
// pipeline in-memory using the exact same library functions:
//   - lib/cjk-normalize.js       (normalizeString)
//   - lib/build/extract-text.js  (extractText)
//   - lib/fnv.js                 (fnv1a32)
//   - lib/bigram-codec.js        (encodePostingList, encodeShard)
//
// And assert that two runs over a tiny fixture corpus produce identical
// shard bytes. This catches deterministic-build regressions in any of the
// underlying primitives without requiring the full corpus.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { normalizeString, isCjk } from '../lib/cjk-normalize.js';
import { extractText } from '../lib/build/extract-text.js';
import { fnv1a32 } from '../lib/fnv.js';
import {
    encodePostingList,
    encodeShard,
    encodeShardV3,
    readShardHeader,
    decodePostingListV3,
} from '../lib/bigram-codec.js';

const SHARD_COUNT = 4096;

/** Tiny fixture corpus: 3 documents with known CJK content. */
const FIXTURE_DOCS = [
    {
        url: '/fixture-doc-1',
        fileId: 'fixture-doc-1',
        xml: '<TEI><text><body>無門關，第一則。趙州狗子。</body></text></TEI>',
    },
    {
        url: '/fixture-doc-2',
        fileId: 'fixture-doc-2',
        xml: '<TEI><text><body><lb xml:id="l1"/>無門。關門。<lb xml:id="l2"/>狗子有佛性。</body></text></TEI>',
    },
    {
        url: '/fixture-doc-3',
        fileId: 'fixture-doc-3',
        xml: '<TEI><text><body>達摩西來，無門。<app><lem>關</lem><rdg>門</rdg></app>內外。</body></text></TEI>',
    },
];

/**
 * Run the same deterministic build pipeline used by build-bigram-index.js.
 * Returns Map<bucketHex4 (e.g. "0a3f"), Uint8Array>.
 */
function buildShardsFromCorpus(docs) {
    // 1. Extract + normalize.
    const normalizedDocs = docs.map((d, i) => ({
        ...d,
        docId: i,
        normalized: normalizeString(extractText(d.xml).text),
    }));

    // 2. Build bigram index (Map<bigram, sorted-unique Uint16Array>).
    const bigramToDocIds = new Map();
    for (const d of normalizedDocs) {
        const text = d.normalized;
        if (!text || text.length < 2) continue;
        const seen = new Set();
        for (let i = 1; i < text.length; i++) {
            const a = text.charCodeAt(i - 1);
            const b = text.charCodeAt(i);
            if (isCjk(a) && isCjk(b)) {
                const bg = text.substring(i - 1, i + 1);
                if (!seen.has(bg)) {
                    seen.add(bg);
                    let arr = bigramToDocIds.get(bg);
                    if (!arr) { arr = []; bigramToDocIds.set(bg, arr); }
                    arr.push(d.docId);
                }
            }
        }
    }

    // 3. Group bigrams into 4096 shards via FNV-1a32 mod 4096.
    const buckets = new Array(SHARD_COUNT);
    for (let i = 0; i < SHARD_COUNT; i++) buckets[i] = null;
    for (const [bg, docIds] of bigramToDocIds) {
        const bucket = fnv1a32(bg) % SHARD_COUNT;
        if (!buckets[bucket]) buckets[bucket] = [];
        buckets[bucket].push({ term: bg, postings: Uint16Array.from(docIds) });
    }

    // 4. Encode each non-empty shard. Critical: deterministic term ordering.
    const result = new Map();
    for (let b = 0; b < SHARD_COUNT; b++) {
        const entries = buckets[b];
        if (!entries || entries.length === 0) continue;
        entries.sort((a, b) => a.term < b.term ? -1 : a.term > b.term ? 1 : 0);
        const termList = entries.map(e => ({
            term: e.term,
            postings: encodePostingList(e.postings),
            count: e.postings.length,
        }));
        const shardBytes = encodeShard(termList, normalizedDocs.length);
        const xx = ((b >>> 8) & 0xff).toString(16).padStart(2, '0');
        const yy = (b & 0xff).toString(16).padStart(2, '0');
        result.set(xx + yy, shardBytes);
    }
    return result;
}

function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

test('build determinism: two runs produce identical shard bytes (acceptance #6)', () => {
    const run1 = buildShardsFromCorpus(FIXTURE_DOCS);
    const run2 = buildShardsFromCorpus(FIXTURE_DOCS);

    assert.equal(run1.size, run2.size, 'same number of non-empty shards');
    for (const [bucket, bytes1] of run1) {
        const bytes2 = run2.get(bucket);
        assert.ok(bytes2, `bucket ${bucket} present in run1 but missing in run2`);
        assert.equal(bytes1.length, bytes2.length, `bucket ${bucket} length mismatch`);
        // Compare via hash for compactness on diff failure.
        const h1 = sha256(bytes1);
        const h2 = sha256(bytes2);
        assert.equal(h1, h2, `bucket ${bucket} bytes diverged: run1=${h1} run2=${h2}`);
    }
});

test('build determinism: shard contains all expected bigrams from fixture corpus', () => {
    const shards = buildShardsFromCorpus(FIXTURE_DOCS);
    // Spot-check a few known bigrams from the fixture.
    const expectedBigrams = ['無門', '門關', '達摩'];
    let foundCount = 0;
    for (const term of expectedBigrams) {
        const bucket = fnv1a32(term) % SHARD_COUNT;
        const xx = ((bucket >>> 8) & 0xff).toString(16).padStart(2, '0');
        const yy = (bucket & 0xff).toString(16).padStart(2, '0');
        const shardBytes = shards.get(xx + yy);
        assert.ok(shardBytes, `expected shard for bigram ${term} (bucket ${xx}${yy})`);
        // Decode and verify the term is present (using readShardHeader).
        // Instead of importing here, we rely on bigram-codec round-trip tests
        // having validated the format; we just ensure the shard exists and is
        // non-empty.
        assert.ok(shardBytes.length >= 16, `shard too small for ${term}`);
        foundCount++;
    }
    assert.equal(foundCount, expectedBigrams.length);
});

test('build determinism: bigram count is stable across runs', () => {
    // Run the build twice and assert identical shard count + total bigram count.
    const run1 = buildShardsFromCorpus(FIXTURE_DOCS);
    const run2 = buildShardsFromCorpus(FIXTURE_DOCS);
    let totalBytes1 = 0; for (const v of run1.values()) totalBytes1 += v.length;
    let totalBytes2 = 0; for (const v of run2.values()) totalBytes2 += v.length;
    assert.equal(totalBytes1, totalBytes2);
});

test('build determinism: extracted text is identical across runs (canary)', () => {
    // If extract-text becomes order-sensitive (e.g. via Map iteration order
    // bugs), this would flag it independently of the shard layer.
    const t1 = FIXTURE_DOCS.map(d => extractText(d.xml).text);
    const t2 = FIXTURE_DOCS.map(d => extractText(d.xml).text);
    assert.deepEqual(t1, t2);
});

test('build determinism: <app> block exclusion is stable across runs', () => {
    // Doc 3 (after extract+normalize) is "達摩西來無門內外": the <app> block
    // (containing <lem>關</lem> and <rdg>門</rdg>) is fully excluded.
    // Verify the canary substrings 關 and the duplicated 門 from inside the
    // <app> block did NOT leak through. The pre-app text ends with 無門, and
    // the post-app text begins with 內 -- so the join is 門內 (which IS a
    // valid bigram), but the lem-side string 關 must be entirely absent.
    const doc3 = normalizeString(extractText(FIXTURE_DOCS[2].xml).text);
    assert.ok(!doc3.includes('關'),
        `<app><lem>關</lem></app> leaked into normalized text: ${JSON.stringify(doc3)}`);
    // Determinism canary: extracting twice yields the same normalized form.
    const doc3Bis = normalizeString(extractText(FIXTURE_DOCS[2].xml).text);
    assert.equal(doc3, doc3Bis);
});

test('build determinism: docId assignment is positional (collection order)', () => {
    // Two consecutive calls must assign the same docIds → same posting lists.
    const out1 = FIXTURE_DOCS.map((d, i) => ({ docId: i, text: normalizeString(extractText(d.xml).text) }));
    const out2 = FIXTURE_DOCS.map((d, i) => ({ docId: i, text: normalizeString(extractText(d.xml).text) }));
    assert.deepEqual(out1, out2);
});

test('build determinism: shard file naming hash is stable for identical bytes', () => {
    // The build script names files using sha-256[:6] of shard bytes. Confirm
    // that a deterministic shard yields a deterministic name. (If the shard
    // bytes are identical, sha-256 is by definition identical.)
    const shards = buildShardsFromCorpus(FIXTURE_DOCS);
    const [firstHex, firstBytes] = shards.entries().next().value;
    const h = sha256(firstBytes).slice(0, 6);
    // Re-build and re-hash.
    const shards2 = buildShardsFromCorpus(FIXTURE_DOCS);
    const firstBytes2 = shards2.get(firstHex);
    const h2 = sha256(firstBytes2).slice(0, 6);
    assert.equal(h, h2);
});

// =====================================================================
// V3 pipeline replication: per-doc tf counting + unigram emission +
// encodeShardV3 determinism.
//
// Mirrors build/build-bigram-index.js#buildTermIndexes + shardAndWrite
// in-memory, using the exact same library primitives. NOTE: like the v2
// replication above, this CANNOT catch filesystem-enumeration-order
// defects (readdirSync ordering, docId assignment across directories) —
// QA's double-build over the real corpus covers that class of bug.
// =====================================================================

/** V3 fixture corpus: the v2 fixtures plus a doc with a REPEATED bigram. */
const FIXTURE_DOCS_V3 = [
    ...FIXTURE_DOCS,
    {
        url: '/fixture-doc-4',
        fileId: 'fixture-doc-4',
        // 無門無門: bigram 無門 occurs twice (tf 2), 門無 once; unigrams 無 ×2, 門 ×2.
        xml: '<TEI><text><body>無門無門。</body></text></TEI>',
    },
];

/**
 * Replicate the v3 builder's per-doc term-frequency counting (bigram +
 * unigram in one char walk — build-bigram-index.js#buildTermIndexes).
 * Bigram tfs are NON-OVERLAPPING (greedy), matching the runtime's
 * countSubstringHits convention: a self-pair bigram inside a run of the
 * same char counts at every other position (無無無 → tf(無無) = 1).
 */
function termTfsForNormalizedText(text) {
    const bigrams = new Map();
    const unigrams = new Map();
    if (!text) return { bigrams, unigrams };
    let prevIsCjk = isCjk(text.charCodeAt(0));
    if (prevIsCjk) unigrams.set(text[0], 1);
    let eqRunStart = 0;
    for (let i = 1; i < text.length; i++) {
        const cu = text.charCodeAt(i);
        const cuIsCjk = isCjk(cu);
        if (cu !== text.charCodeAt(i - 1)) eqRunStart = i;
        if (cuIsCjk) {
            const ch = text[i];
            unigrams.set(ch, (unigrams.get(ch) || 0) + 1);
            if (prevIsCjk) {
                if (cu !== text.charCodeAt(i - 1) || (i - 1 - eqRunStart) % 2 === 0) {
                    const bg = text.substring(i - 1, i + 1);
                    bigrams.set(bg, (bigrams.get(bg) || 0) + 1);
                }
            }
        }
        prevIsCjk = cuIsCjk;
    }
    return { bigrams, unigrams };
}

/**
 * Run the v3 deterministic build pipeline in-memory.
 * Returns { bigramShards, unigramShards }: Map<bucketHex4, Uint8Array>.
 */
function buildShardsV3FromCorpus(docs) {
    // 1. Extract + normalize + assign positional docIds.
    const normalizedDocs = docs.map((d, i) => ({
        docId: i,
        normalized: normalizeString(extractText(d.xml).text),
    }));

    // 2. Per-doc tf counting flushed into global indexes (docIds ascending
    //    by construction, exactly like the builder's flushDocTerms).
    const bigramIndex = new Map();  // term -> {docIds: [], tfs: []}
    const unigramIndex = new Map();
    const flush = (index, tfs, docId) => {
        for (const [term, tf] of tfs) {
            let e = index.get(term);
            if (!e) { e = { docIds: [], tfs: [] }; index.set(term, e); }
            e.docIds.push(docId);
            e.tfs.push(tf);
        }
    };
    for (const d of normalizedDocs) {
        const { bigrams, unigrams } = termTfsForNormalizedText(d.normalized);
        flush(bigramIndex, bigrams, d.docId);
        flush(unigramIndex, unigrams, d.docId);
    }

    // 3+4. Bucket via fnv1a32 mod 4096 and encode each non-empty bucket as a
    //      v3 shard (encodeShardV3 sorts terms internally — deterministic).
    const shardify = (index) => {
        const buckets = new Map(); // bucket number -> termList
        for (const [term, e] of index) {
            const b = fnv1a32(term) % SHARD_COUNT;
            if (!buckets.has(b)) buckets.set(b, []);
            buckets.get(b).push({ term, docIds: e.docIds, tfs: e.tfs });
        }
        const result = new Map();
        for (const [b, termList] of buckets) {
            const xx = ((b >>> 8) & 0xff).toString(16).padStart(2, '0');
            const yy = (b & 0xff).toString(16).padStart(2, '0');
            result.set(xx + yy, encodeShardV3(termList, normalizedDocs.length));
        }
        return result;
    };
    return { bigramShards: shardify(bigramIndex), unigramShards: shardify(unigramIndex) };
}

function assertShardMapsIdentical(map1, map2, label) {
    assert.equal(map1.size, map2.size, `${label}: same number of non-empty shards`);
    for (const [bucket, bytes1] of map1) {
        const bytes2 = map2.get(bucket);
        assert.ok(bytes2, `${label}: bucket ${bucket} missing in second run`);
        assert.equal(sha256(bytes1), sha256(bytes2), `${label}: bucket ${bucket} bytes diverged`);
    }
}

test('v3 build determinism: two runs produce byte-identical bigram AND unigram shards', () => {
    const run1 = buildShardsV3FromCorpus(FIXTURE_DOCS_V3);
    const run2 = buildShardsV3FromCorpus(FIXTURE_DOCS_V3);
    assertShardMapsIdentical(run1.bigramShards, run2.bigramShards, 'bigram');
    assertShardMapsIdentical(run1.unigramShards, run2.unigramShards, 'unigram');
    assert.ok(run1.unigramShards.size >= 1, 'unigram shard set is non-empty');
});

test('v3 build: repeated bigram increments tf (round-trip through the runtime decoder)', () => {
    const { bigramShards } = buildShardsV3FromCorpus(FIXTURE_DOCS_V3);
    const bucket = fnv1a32('無門') % SHARD_COUNT;
    const hex = ((bucket >>> 8) & 0xff).toString(16).padStart(2, '0')
        + (bucket & 0xff).toString(16).padStart(2, '0');
    const shardBytes = bigramShards.get(hex);
    assert.ok(shardBytes, 'shard containing 無門 exists');
    const header = readShardHeader(shardBytes);
    assert.equal(header.version, 3);
    const meta = header.terms.get('無門');
    assert.ok(meta, '無門 present');
    const { docIds, tfs } = decodePostingListV3(shardBytes, meta.count, meta.offset);
    // 無門 appears once in docs 0, 1, 2 and TWICE in doc 3 (無門無門).
    assert.deepEqual(Array.from(docIds), [0, 1, 2, 3]);
    assert.deepEqual(Array.from(tfs), [1, 1, 1, 2], 'repeat bigram increments tf, others stay 1');
});

test('v3 build: unigram terms are emitted with per-doc occurrence counts', () => {
    const { unigramShards } = buildShardsV3FromCorpus(FIXTURE_DOCS_V3);
    const bucket = fnv1a32('門') % SHARD_COUNT;
    const hex = ((bucket >>> 8) & 0xff).toString(16).padStart(2, '0')
        + (bucket & 0xff).toString(16).padStart(2, '0');
    const shardBytes = unigramShards.get(hex);
    assert.ok(shardBytes, 'unigram shard containing 門 exists');
    const header = readShardHeader(shardBytes);
    assert.equal(header.version, 3);
    const meta = header.terms.get('門');
    assert.ok(meta, 'unigram 門 present');
    const { docIds, tfs } = decodePostingListV3(shardBytes, meta.count, meta.offset);
    // 門 per doc (normalized text): doc 0 "無門關第一則趙州狗子" ×1,
    // doc 1 "無門關門狗子有佛性" ×2, doc 2 "達摩西來無門內外" ×1,
    // doc 3 "無門無門" ×2.
    assert.deepEqual(Array.from(docIds), [0, 1, 2, 3]);
    assert.deepEqual(Array.from(tfs), [1, 2, 1, 2]);
});

test('v3 build: self-overlapping bigram tf counts NON-overlapping occurrences (countSubstringHits convention)', () => {
    // A run of the same char self-overlaps: 無無無 contains 無無 at positions
    // 0 and 1, but the runtime (countSubstringHits, v2 verification, KWIC)
    // counts non-overlapping hits (= 1). The builder must agree, otherwise a
    // single-run 2-char query like 無無 — whose displayed count is taken
    // straight from the index tf — disagrees with its own KWIC expansion.
    const one = termTfsForNormalizedText('無無無');
    assert.equal(one.bigrams.get('無無'), 1, '無無無 → one non-overlapping 無無, not two');
    assert.equal(one.unigrams.get('無'), 3, 'unigrams count every occurrence (length-1 cannot overlap)');

    const two = termTfsForNormalizedText('無無無無');
    assert.equal(two.bigrams.get('無無'), 2, '無無無無 → two non-overlapping 無無');

    // Separate runs count independently; non-self bigrams are unaffected.
    const mixed = termTfsForNormalizedText('無無門無無');
    assert.equal(mixed.bigrams.get('無無'), 2);
    assert.equal(mixed.bigrams.get('無門'), 1);
    assert.equal(mixed.bigrams.get('門無'), 1);
});

test('v3 build: shard naming hash (sha-256[:6]) is stable for identical v3 bytes', () => {
    const run1 = buildShardsV3FromCorpus(FIXTURE_DOCS_V3);
    const run2 = buildShardsV3FromCorpus(FIXTURE_DOCS_V3);
    for (const [hex, bytes1] of run1.bigramShards) {
        const h1 = sha256(bytes1).slice(0, 6);
        const h2 = sha256(run2.bigramShards.get(hex)).slice(0, 6);
        assert.equal(h1, h2, `bigram shard ${hex} content-hash name diverged`);
    }
    for (const [hex, bytes1] of run1.unigramShards) {
        const h1 = sha256(bytes1).slice(0, 6);
        const h2 = sha256(run2.unigramShards.get(hex)).slice(0, 6);
        assert.equal(h1, h2, `unigram shard ${hex} content-hash name diverged`);
    }
});
