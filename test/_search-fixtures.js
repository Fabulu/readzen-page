// test/_search-fixtures.js
// Shared in-memory fixture helpers for the bigram/unigram search test suite.
// Extracted from the copy-pasted helpers in test/bigram-search.test.js and
// test/search-routing.test.js so v3 (tf-carrying) fixtures live in one place.
//
// Format-version parameterization:
//   - v2 fixtures: buildShardBytes / shardLayoutFor  (encodePostingList + encodeShard)
//   - v3 fixtures: buildShardBytesV3 / shardLayoutForV3 (encodeShardV3, per-term {docIds, tfs})
//   - buildManifest(layout, docCount, {version, unigramLayout, builtAt})
//
// Test-only Node module (imported by test files, never by lib/).

import { encodePostingList, encodeShard, encodeShardV3 } from '../lib/bigram-codec.js';
import { fnv1a32 } from '../lib/fnv.js';
import { isCjk } from '../lib/cjk-normalize.js';

/** Bucket id (0..4095) for a term (bigram OR unigram), padded to 4 hex. */
export function bucketHexForTerm(term) {
    return (fnv1a32(term) % 4096).toString(16).padStart(4, '0');
}

/** Back-compat alias used by the pre-refactor bigram tests. */
export const bucketHexForBigram = bucketHexForTerm;

/** Bucket a docId into a text-shard bucket ('000'..'fff') like bigram-search.js. */
export function textBucketFor(docId) {
    return (docId % 4096).toString(16).padStart(3, '0');
}

/** Build a single v2 shard from a {term: sortedDocIds[]} map. */
export function buildShardBytes(termsMap, docCount) {
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

/** Build a single v3 shard from a {term: {docIds, tfs}} map. */
export function buildShardBytesV3(termsMap, docCount) {
    const termList = [];
    for (const [term, entry] of Object.entries(termsMap)) {
        termList.push({ term, docIds: entry.docIds, tfs: entry.tfs });
    }
    return encodeShardV3(termList, docCount);
}

/**
 * Place each v2 {term, docIds} entry into its FNV bucket.
 * @returns {Map<hex4, Uint8Array>}
 */
export function shardLayoutFor(entries, docCount) {
    const byBucket = new Map(); // hex4 -> { [term]: docIds[] }
    for (const { term, docIds } of entries) {
        const hex = bucketHexForTerm(term);
        if (!byBucket.has(hex)) byBucket.set(hex, {});
        byBucket.get(hex)[term] = docIds;
    }
    const out = new Map();
    for (const [hex, terms] of byBucket.entries()) {
        out.set(hex, buildShardBytes(terms, docCount));
    }
    return out;
}

/**
 * Place each v3 {term, docIds, tfs} entry into its FNV bucket.
 * Works for bigram AND unigram term sets (terms are just strings).
 * @returns {Map<hex4, Uint8Array>}
 */
export function shardLayoutForV3(entries, docCount) {
    const byBucket = new Map(); // hex4 -> { [term]: {docIds, tfs} }
    for (const { term, docIds, tfs } of entries) {
        const hex = bucketHexForTerm(term);
        if (!byBucket.has(hex)) byBucket.set(hex, {});
        byBucket.get(hex)[term] = { docIds, tfs };
    }
    const out = new Map();
    for (const [hex, terms] of byBucket.entries()) {
        out.set(hex, buildShardBytesV3(terms, docCount));
    }
    return out;
}

const HASH_PALETTE = ['aaaaaa', 'bbbbbb', 'cccccc', 'dddddd', 'eeeeee', 'ffffff', '111111', '222222'];

/** Assign each non-empty bucket a deterministic placeholder content hash. */
function paletteAssign(shardLayout) {
    const shards = {};
    let i = 0;
    for (const hex of shardLayout.keys()) {
        shards[hex] = HASH_PALETTE[i % HASH_PALETTE.length];
        i++;
    }
    return shards;
}

/**
 * Build a manifest mapping every term bucket in the layout to a placeholder
 * content hash.
 * @param {Map<hex4, Uint8Array>} shardLayout - bigram shard layout.
 * @param {number} docCount
 * @param {{version?: number, unigramLayout?: Map<string, Uint8Array>, builtAt?: string, wordTerms?: boolean, docLengths?: number[]}} [opts]
 *        version: manifest version field (omitted when not given — matches
 *        the deployed v1/v2 manifests); unigramLayout: adds a parallel
 *        `unigramShards` map (the v3 unigram capability gate); builtAt:
 *        ISO timestamp surfaced by getManifestInfo; wordTerms: the v4 English-
 *        word-term capability gate; docLengths: per-docId searchText char
 *        counts (index-order) — sole input to density ranking.
 */
export function buildManifest(shardLayout, docCount, opts = {}) {
    const manifest = { shardCount: 4096, docCount, shards: paletteAssign(shardLayout) };
    if (opts.version != null) manifest.version = opts.version;
    if (opts.builtAt != null) manifest.builtAt = opts.builtAt;
    if (opts.unigramLayout) manifest.unigramShards = paletteAssign(opts.unigramLayout);
    if (opts.wordTerms != null) manifest.wordTerms = opts.wordTerms;
    if (opts.docLengths != null) manifest.docLengths = opts.docLengths;
    return manifest;
}

/**
 * Merge extra v3 term entries ({term, docIds, tfs}[]) — e.g. English word
 * terms — into an existing bigram shard layout in place, returning it. Word
 * terms share the bigram shard set (an ASCII token can't collide with a
 * 2-CJK-char bigram), so this just re-buckets the union.
 * @param {Map<hex4, Uint8Array>} bigramLayout - built from bigram entries.
 * @param {Array<{term:string, docIds:number[], tfs:number[]}>} bigramEntries
 * @param {Array<{term:string, docIds:number[], tfs:number[]}>} wordEntries
 * @param {number} docCount
 * @returns {Map<hex4, Uint8Array>} a fresh combined layout.
 */
export function shardLayoutForV3Combined(bigramEntries, wordEntries, docCount) {
    return shardLayoutForV3([...bigramEntries, ...wordEntries], docCount);
}

/** NDJSON-encode docs into a text-shard string. */
export function buildTextShardNdjson(docs) {
    return docs.map((d) => JSON.stringify({ docId: d.docId, text: d.text })).join('\n');
}

/**
 * Group {docId, text} docs into text shards keyed by their 3-hex bucket.
 * @returns {Map<bucketStr, ndjsonString>}
 */
export function textShardsForDocs(docs) {
    const byBucket = new Map();
    for (const d of docs) {
        const b = textBucketFor(d.docId);
        if (!byBucket.has(b)) byBucket.set(b, []);
        byBucket.get(b).push(d);
    }
    const out = new Map();
    for (const [b, list] of byBucket.entries()) out.set(b, buildTextShardNdjson(list));
    return out;
}

/**
 * Count per-doc bigram + unigram term frequencies the way the v3 builder
 * does (every adjacent CJK pair / every CJK code unit). Bigram occurrences
 * are counted NON-OVERLAPPING (greedy, like the runtime's countSubstringHits)
 * so a self-pair bigram in a run of identical chars (無無無 → tf(無無) = 1)
 * matches the count every text-verification/KWIC path computes.
 * Returns {bigrams: Map<term, tf>, unigrams: Map<term, tf>}.
 */
export function termTfsForText(text) {
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
 * Build v3 term-entry lists ({term, docIds, tfs}[]) for a whole corpus of
 * {docId, text} docs — the in-memory equivalent of the builder's
 * buildTermIndexes. Docs must be in ascending docId order.
 * @returns {{bigramEntries: Array, unigramEntries: Array}}
 */
export function v3EntriesForDocs(docs) {
    const bigramIndex = new Map(); // term -> {docIds: [], tfs: []}
    const unigramIndex = new Map();
    const flush = (index, tfs, docId) => {
        for (const [term, tf] of tfs) {
            let e = index.get(term);
            if (!e) { e = { docIds: [], tfs: [] }; index.set(term, e); }
            e.docIds.push(docId);
            e.tfs.push(tf);
        }
    };
    for (const d of docs) {
        const { bigrams, unigrams } = termTfsForText(d.text);
        flush(bigramIndex, bigrams, d.docId);
        flush(unigramIndex, unigrams, d.docId);
    }
    const toEntries = (index) => {
        const out = [];
        for (const [term, e] of index) out.push({ term, docIds: e.docIds, tfs: e.tfs });
        return out;
    };
    return { bigramEntries: toEntries(bigramIndex), unigramEntries: toEntries(unigramIndex) };
}

/**
 * Install a fetch mock that serves manifest, docs.txt, bigram shards,
 * unigram shards, text shards, and english.jsonl from in-memory fixtures.
 * Tracks calls so tests can inspect fetch counts.
 *
 * @returns Object with `restore()` and `calls` (array of url strings).
 */
export function installFetchMock({
    manifest = null,
    docsTxt = '',
    shardLayout = new Map(),     // hex4 -> Uint8Array (bigram shards)
    unigramLayout = new Map(),   // hex4 -> Uint8Array (unigram shards)
    textShards = new Map(),      // bucketStr ('000'..'fff') -> ndjson string
    englishJsonl = null,
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
        // Unigram shard: /data/search/bigram/unigram/XX/YY-<hash>.bin
        // (checked BEFORE the bigram pattern; only the base dir differs).
        const unigramMatch = u.match(/\/unigram\/([0-9a-f]{2})\/([0-9a-f]{2})-[0-9a-f]+\.bin$/);
        if (unigramMatch) {
            const hex = unigramMatch[1] + unigramMatch[2];
            const bytes = unigramLayout.get(hex);
            if (!bytes) return new Response(null, { status: 404 });
            const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
            return new Response(ab, { status: 200 });
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
        // Text shard: /data/search/text/{bucket}.bin (NDJSON, 3-hex bucket)
        const textMatch = u.match(/\/text\/([0-9a-f]{3})\.bin$/);
        if (textMatch) {
            const bucket = textMatch[1];
            const ndjson = textShards.get(bucket);
            if (ndjson == null) return new Response(null, { status: 404 });
            return new Response(ndjson, { status: 200 });
        }
        if (u.endsWith('/english.jsonl')) {
            if (englishJsonl == null) return new Response(null, { status: 404 });
            return new Response(englishJsonl, { status: 200 });
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
