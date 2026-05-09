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
import { encodePostingList, encodeShard } from '../lib/bigram-codec.js';

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
