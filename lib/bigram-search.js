// lib/bigram-search.js
// Runtime CJK bigram inverted-index search for the SPA. Replaces the
// Pagefind dependency with a 4096-shard hashed index built by
// build/build-bigram-index.js (see SYNTHESIS.md sections 6, 7 and
// IMPLEMENTATION_PLAN.md task W3.1).
//
// Cold-start sequence on a query:
//   1. Load manifest (cached 30 min).
//   2. Normalize the query, build adjacent CJK bigrams.
//   3. Hash each bigram via FNV-1a32 mod 4096 -> bucket id.
//   4. Promise.all fetch each unique shard, lazy-decode the header.
//   5. Look each bigram up by exact term match -> {offset,length,count}.
//   6. Short-circuit empty if any bigram is missing.
//   7. Decode posting lists, sort shortest-first, cascade-intersect.
//   8. Cap at top 200 candidates; verify each by fetching its text shard
//      (256 buckets, ~2.5 MB each, LRU-capped to 16) and counting true
//      indexOf hits against the normalized query.
//   9. Drop zero-hit candidates; return [{docId, hitCount}].
//
// Caches:
//   - Manifest:        1 entry, 30 min TTL via lib/cache.js (sessionStorage).
//   - Bigram shards:   in-memory Map<bucketId,{header,bytes}>, LRU 32.
//   - Text shards:     in-memory Map<bucketIdStr,Map<docId,text>>, LRU 16.
//   - docs.txt:        single Promise, lifetime of the module.
//   - Decoded postings: NOT cached (decode is fast).
//
// Browser ES module. No Node-only APIs. No new dependencies.

import { normalizeString, isCjk } from './cjk-normalize.js';
import { fnv1a32 } from './fnv.js';
import { readShardHeader, decodePostingList } from './bigram-codec.js';
import * as cache from './cache.js';

const MANIFEST_URL = '/data/search/bigram/manifest.json';
const SHARD_BASE = '/data/search/bigram/shards/';
const TEXT_SHARD_BASE = '/data/search/text/';
const DOCS_TXT_URL = '/data/search/bigram/docs.txt';

const MANIFEST_CACHE_KEY = 'bigram:manifest';
const MANIFEST_TTL_MS = 30 * 60 * 1000;

// Verification cap. The cap exists to bound HTTP fan-out for very common
// queries; at 4096 text shards (~50-200 KB each) we can afford ~1500 fetches
// in parallel. A 2-char query whose bigram IS the exact phrase doesn't need
// verification at all (see `isExactBigramQuery` below).
const VERIFICATION_CAP = 1500;
const TEXT_SHARD_COUNT = 4096;

const BIGRAM_SHARD_LRU_MAX = 32;
const TEXT_SHARD_LRU_MAX = 16;

// Map preserves insertion order; we delete + re-set on access for LRU bump.
const _bigramShardCache = new Map(); // bucketId (number) -> { header, bytes }
const _textShardCache = new Map();   // bucketIdStr ('00'..'ff') -> Map<docId,text>

// Single-flight in-flight fetches to dedupe concurrent requests.
const _inflightBigramShards = new Map(); // bucketId -> Promise<{header,bytes}>
const _inflightTextShards = new Map();   // bucketIdStr -> Promise<Map<docId,text>>

let _docsListPromise = null;

/** Thrown when the manifest cannot be loaded (no index deployed). */
export class BigramIndexUnavailable extends Error {
    constructor(message) {
        super(message);
        this.name = 'BigramIndexUnavailable';
    }
}

/** Drop all in-memory caches (manifest stays in sessionStorage). */
export function clearShardCache() {
    _bigramShardCache.clear();
    _textShardCache.clear();
    _inflightBigramShards.clear();
    _inflightTextShards.clear();
}

/** Eagerly fetch the manifest so the first query is faster. */
export async function preloadManifest() {
    await loadManifest();
}

/**
 * Look up the fileId for a docId by reading docs.txt (line N = url for docId N).
 * Returns the last path segment of the URL on that line.
 * @param {number} docId
 * @returns {Promise<string>}
 */
export async function fileIdForDocId(docId) {
    const meta = await metaForDocId(docId);
    return meta ? meta.fileId : '';
}

/**
 * Resolve full doc metadata from a docId by reading docs.txt. Returns the
 * raw URL plus parsed `fileId`, `side` ('source'|'en'|'community'|''),
 * and `translator` (community only). Returns null on out-of-range.
 * @param {number} docId
 * @returns {Promise<{url:string, fileId:string, side:string, translator:string}|null>}
 */
export async function metaForDocId(docId) {
    const list = await loadDocsList();
    if (!Number.isInteger(docId) || docId < 0 || docId >= list.length) return null;
    const url = list[docId];
    if (!url) return null;
    // Split URL path from query.
    const q = url.indexOf('?');
    const path = q >= 0 ? url.substring(0, q) : url;
    const query = q >= 0 ? url.substring(q + 1) : '';
    const trimmed = path.replace(/\/+$/, '');
    const slash = trimmed.lastIndexOf('/');
    const fileId = slash >= 0 ? trimmed.substring(slash + 1) : trimmed;
    let side = '';
    let translator = '';
    if (query) {
        for (const kv of query.split('&')) {
            const eq = kv.indexOf('=');
            const k = eq >= 0 ? kv.substring(0, eq) : kv;
            const v = eq >= 0 ? decodeURIComponent(kv.substring(eq + 1)) : '';
            if (k === 'side') side = v;
            else if (k === 'translator') translator = v;
        }
    }
    return { url, fileId, side, translator };
}

/**
 * Run a CJK full-text search.
 * @param {string} query - User-typed query (may contain non-CJK chars).
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal] - Aborts in-flight fetches and yields [].
 * @param {(batch: Array<{docId:number, hitCount:number}>) => void} [opts.onProgress]
 *        Called with each shard's verified rows as soon as that shard's
 *        verification completes. Lets the UI render rows incrementally.
 *        The final sort by hitCount descending happens before the Promise
 *        resolves; consumers should re-sort on resolve.
 * @returns {Promise<Array<{docId:number, hitCount:number}>>}
 *
 * Returns [] on abort, query length < 2, or zero CJK bigrams. May throw
 * BigramIndexUnavailable on manifest failure.
 */
export async function searchFulltext(query, opts = {}) {
    const signal = opts.signal;
    const normalizedQuery = normalizeString(query == null ? '' : String(query));
    if (normalizedQuery.length < 2) return [];

    // Build adjacent CJK bigrams from the normalized query.
    const bigrams = [];
    for (let i = 0; i < normalizedQuery.length - 1; i++) {
        const a = normalizedQuery.charCodeAt(i);
        const b = normalizedQuery.charCodeAt(i + 1);
        if (isCjk(a) && isCjk(b)) {
            bigrams.push(normalizedQuery.substr(i, 2));
        }
    }
    if (bigrams.length === 0) return [];

    // Dedupe terms; multiple identical bigrams in a query share the same posting list.
    const uniqueBigrams = Array.from(new Set(bigrams));

    // Group bigrams by bucket so each shard is fetched once even when several
    // terms hash to the same shard.
    let manifest;
    try {
        manifest = await loadManifest(signal);
        throwIfAborted(signal);
    } catch (err) {
        if (isAbortError(err)) return [];
        throw err;
    }

    const bucketToBigrams = new Map(); // bucketId -> string[]
    for (const bg of uniqueBigrams) {
        const bucket = fnv1a32(bg) % 4096;
        const list = bucketToBigrams.get(bucket);
        if (list) list.push(bg);
        else bucketToBigrams.set(bucket, [bg]);
    }

    const uniqueBuckets = Array.from(bucketToBigrams.keys());

    // Fetch all required shards in parallel.
    let shardsByBucket;
    try {
        const shardResults = await Promise.all(
            uniqueBuckets.map((b) => loadBigramShard(b, manifest, signal))
        );
        shardsByBucket = new Map();
        for (let i = 0; i < uniqueBuckets.length; i++) {
            shardsByBucket.set(uniqueBuckets[i], shardResults[i]);
        }
    } catch (err) {
        if (isAbortError(err)) return [];
        throw err;
    }

    // Resolve each bigram's posting list. Short-circuit if any bigram missing.
    const postingLists = [];
    for (const bg of uniqueBigrams) {
        const bucket = fnv1a32(bg) % 4096;
        const shard = shardsByBucket.get(bucket);
        if (!shard) return []; // shard missing entirely
        const meta = shard.header.terms.get(bg);
        if (!meta || meta.count === 0) return [];
        const postings = decodePostingList(shard.bytes, meta.count, meta.offset);
        postingLists.push(postings);
    }

    // Cascade-intersect shortest-first.
    const candidates = intersectU16(postingLists);
    if (candidates.length === 0) return [];

    // A 2-char CJK query's single bigram IS the exact phrase, so the
    // bigram filter is sufficient — no false positives possible. For 3+
    // char queries, multiple bigrams may co-occur non-contiguously; we
    // verify by fetching each candidate's normalized text and counting
    // literal indexOf hits.
    const isExactBigramQuery =
        normalizedQuery.length === 2 && uniqueBigrams.length === 1;

    // Cap to bound HTTP fan-out for hot bigrams. With 4096 text shards
    // (~50-200 KB each) the limit is fan-out, not bytes per shard.
    const verifyCount = Math.min(candidates.length, VERIFICATION_CAP);

    // Group candidates by their text-shard bucket so we fetch each bucket once.
    const candidatesByBucket = new Map(); // bucketIdStr -> Array<docId>
    for (let i = 0; i < verifyCount; i++) {
        const docId = candidates[i];
        const bucketStr = (docId % TEXT_SHARD_COUNT).toString(16).padStart(3, '0');
        const list = candidatesByBucket.get(bucketStr);
        if (list) list.push(docId);
        else candidatesByBucket.set(bucketStr, [docId]);
    }

    const bucketEntries = Array.from(candidatesByBucket.entries());
    const verified = [];

    // Stream verified rows as each text shard arrives. Caller's onProgress
    // callback gets each per-shard batch immediately so the UI can render
    // rows incrementally instead of waiting for the full verify to finish.
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;

    const perShardWork = bucketEntries.map(async ([bucketStr, docIds]) => {
        let docMap;
        try {
            docMap = await loadTextShard(bucketStr, signal);
        } catch (err) {
            if (isAbortError(err)) return [];
            console.warn(`[bigram] text shard ${bucketStr} fetch error: ${err.message}`);
            return [];
        }

        const batch = [];
        if (!docMap) return batch;

        for (const docId of docIds) {
            const text = docMap.get(docId);
            if (text == null) continue;
            if (isExactBigramQuery) {
                // Bigram already proves contiguous adjacency; just count
                // occurrences for ranking.
                const hits = countSubstringHits(text, normalizedQuery) || 1;
                batch.push({ docId, hitCount: hits });
            } else {
                const hits = countSubstringHits(text, normalizedQuery);
                if (hits > 0) batch.push({ docId, hitCount: hits });
            }
        }

        if (batch.length) {
            verified.push(...batch);
            if (onProgress) {
                try { onProgress(batch); } catch (_) { /* ignore consumer errors */ }
            }
        }
        return batch;
    });

    try {
        await Promise.all(perShardWork);
    } catch (err) {
        if (isAbortError(err)) return verified.slice().sort((a, b) => b.hitCount - a.hitCount);
        throw err;
    }

    // Final sort by descending hit count so docs with the most matches
    // surface first. Streaming consumers may have already shown an
    // unsorted subset; the caller is expected to re-sort on this final
    // resolution.
    verified.sort((a, b) => b.hitCount - a.hitCount);
    return verified;
}

// --- intersectU16 ---

/**
 * Intersect a list of sorted Uint16Array posting lists. Sorts shortest-first
 * and cascades a pairwise two-pointer merge. Returns a Uint16Array.
 * @warning Mutates the input array (sorts in place by length).
 */
export function intersectU16(lists) {
    if (!lists.length) return new Uint16Array(0);
    if (lists.some((l) => l.length === 0)) return new Uint16Array(0);
    lists.sort((a, b) => a.length - b.length);
    let acc = lists[0];
    for (let k = 1; k < lists.length && acc.length > 0; k++) {
        acc = pairwise(acc, lists[k]);
    }
    return acc;
}

function pairwise(a, b) {
    const out = new Uint16Array(Math.min(a.length, b.length));
    let i = 0, j = 0, n = 0;
    while (i < a.length && j < b.length) {
        const av = a[i];
        const bv = b[j];
        if (av === bv) { out[n++] = av; i++; j++; }
        else if (av < bv) i++;
        else j++;
    }
    return out.subarray(0, n);
}

// --- loaders ---

async function loadManifest(signal) {
    const cached = cache.get(MANIFEST_CACHE_KEY);
    if (cached) return cached;

    let response;
    try {
        response = await fetch(MANIFEST_URL, { cache: 'default', signal });
    } catch (err) {
        if (isAbortError(err)) throw err;
        throw new BigramIndexUnavailable(`network error fetching manifest: ${err.message}`);
    }
    if (!response.ok) {
        throw new BigramIndexUnavailable(`manifest HTTP ${response.status}`);
    }
    const manifest = await response.json();
    cache.set(MANIFEST_CACHE_KEY, manifest, MANIFEST_TTL_MS);
    return manifest;
}

async function loadBigramShard(bucketId, manifest, signal) {
    throwIfAborted(signal);
    // Cache hit: bump LRU and return.
    if (_bigramShardCache.has(bucketId)) {
        const entry = _bigramShardCache.get(bucketId);
        _bigramShardCache.delete(bucketId);
        _bigramShardCache.set(bucketId, entry);
        return entry;
    }
    // Single-flight: dedupe concurrent fetches. The shared promise runs the
    // fetch WITHOUT a signal, so one caller aborting can't reject another
    // caller's pending wait. Each caller post-checks its own signal.
    let shared = _inflightBigramShards.get(bucketId);
    if (!shared) {
        shared = (async () => {
            try {
                const hex = bucketId.toString(16).padStart(4, '0');
                const hash = manifest && manifest.shards ? manifest.shards[hex] : undefined;
                if (!hash || hash === '0') {
                    const empty = { header: { version: 2, docCount: manifest.docCount, postingsStart: 0, terms: new Map() }, bytes: new Uint8Array(0) };
                    insertBigramShard(bucketId, empty);
                    return empty;
                }
                const url = `${SHARD_BASE}${hex.slice(0, 2)}/${hex.slice(2, 4)}-${hash}.bin`;
                try {
                    const response = await fetch(url, { cache: 'default' });
                    if (!response.ok) {
                        console.warn(`[bigram] shard ${hex} HTTP ${response.status}; treating as empty`);
                        const empty = { header: { version: 2, docCount: manifest.docCount, postingsStart: 0, terms: new Map() }, bytes: new Uint8Array(0) };
                        insertBigramShard(bucketId, empty);
                        return empty;
                    }
                    const ab = await response.arrayBuffer();
                    const bytes = new Uint8Array(ab);
                    let header;
                    try {
                        header = readShardHeader(bytes);
                    } catch (err) {
                        console.warn(`[bigram] shard ${hex} decode error: ${err.message}; treating as empty`);
                        const empty = { header: { version: 2, docCount: manifest.docCount, postingsStart: 0, terms: new Map() }, bytes: new Uint8Array(0) };
                        insertBigramShard(bucketId, empty);
                        return empty;
                    }
                    const entry = { header, bytes };
                    insertBigramShard(bucketId, entry);
                    return entry;
                } catch (err) {
                    console.warn(`[bigram] shard ${hex} fetch error: ${err.message}; treating as empty`);
                    const empty = { header: { version: 2, docCount: manifest.docCount, postingsStart: 0, terms: new Map() }, bytes: new Uint8Array(0) };
                    insertBigramShard(bucketId, empty);
                    return empty;
                }
            } finally {
                _inflightBigramShards.delete(bucketId);
            }
        })();
        _inflightBigramShards.set(bucketId, shared);
    }
    const entry = await shared;
    throwIfAborted(signal);
    return entry;
}

function insertBigramShard(bucketId, entry) {
    if (_bigramShardCache.has(bucketId)) _bigramShardCache.delete(bucketId);
    _bigramShardCache.set(bucketId, entry);
    while (_bigramShardCache.size > BIGRAM_SHARD_LRU_MAX) {
        const oldestKey = _bigramShardCache.keys().next().value;
        if (oldestKey === undefined) break;
        _bigramShardCache.delete(oldestKey);
    }
}

async function loadTextShard(bucketStr, signal) {
    if (_textShardCache.has(bucketStr)) {
        const entry = _textShardCache.get(bucketStr);
        _textShardCache.delete(bucketStr);
        _textShardCache.set(bucketStr, entry);
        return entry;
    }
    let shared = _inflightTextShards.get(bucketStr);
    if (!shared) {
        shared = (async () => {
            const url = `${TEXT_SHARD_BASE}${bucketStr}.bin`;
            try {
                const response = await fetch(url, { cache: 'default' });
                if (!response.ok) {
                    console.warn(`[bigram] text shard ${bucketStr} HTTP ${response.status}; skipping verification`);
                    insertTextShard(bucketStr, null);
                    return null;
                }
                const text = await response.text();
                const map = parseTextShardNdjson(text);
                insertTextShard(bucketStr, map);
                return map;
            } catch (err) {
                console.warn(`[bigram] text shard ${bucketStr} fetch error: ${err.message}; skipping verification`);
                insertTextShard(bucketStr, null);
                return null;
            } finally {
                _inflightTextShards.delete(bucketStr);
            }
        })();
        _inflightTextShards.set(bucketStr, shared);
    }
    const entry = await shared;
    throwIfAborted(signal);
    return entry;
}

function insertTextShard(bucketStr, mapOrNull) {
    if (_textShardCache.has(bucketStr)) _textShardCache.delete(bucketStr);
    _textShardCache.set(bucketStr, mapOrNull);
    while (_textShardCache.size > TEXT_SHARD_LRU_MAX) {
        const oldestKey = _textShardCache.keys().next().value;
        if (oldestKey === undefined) break;
        _textShardCache.delete(oldestKey);
    }
}

/** Parse NDJSON of {docId,text} records into a Map<docId,text>. */
function parseTextShardNdjson(text) {
    const map = new Map();
    if (!text) return map;
    let start = 0;
    const len = text.length;
    for (let i = 0; i <= len; i++) {
        if (i === len || text.charCodeAt(i) === 0x0A /* \n */) {
            if (i > start) {
                const line = text.charCodeAt(i - 1) === 0x0D /* \r */
                    ? text.substring(start, i - 1)
                    : text.substring(start, i);
                if (line.length > 0) {
                    try {
                        const rec = JSON.parse(line);
                        if (rec && typeof rec.docId === 'number' && typeof rec.text === 'string') {
                            map.set(rec.docId, rec.text);
                        }
                    } catch {
                        // Malformed line — skip.
                    }
                }
            }
            start = i + 1;
        }
    }
    return map;
}

async function loadDocsList() {
    if (_docsListPromise) return _docsListPromise;
    _docsListPromise = (async () => {
        try {
            const response = await fetch(DOCS_TXT_URL, { cache: 'default' });
            if (!response.ok) {
                console.warn(`[bigram] docs.txt HTTP ${response.status}`);
                return [];
            }
            const text = await response.text();
            // Trim a trailing newline so the final empty segment isn't a "docId".
            const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
            return trimmed.length === 0 ? [] : trimmed.split('\n');
        } catch (err) {
            console.warn(`[bigram] docs.txt fetch error: ${err.message}`);
            _docsListPromise = null; // allow retry
            return [];
        }
    })();
    return _docsListPromise;
}

// --- helpers ---

function countSubstringHits(haystack, needle) {
    if (!haystack || !needle) return 0;
    let count = 0;
    let pos = 0;
    while (true) {
        const idx = haystack.indexOf(needle, pos);
        if (idx < 0) break;
        count++;
        pos = idx + needle.length;
    }
    return count;
}

function isAbortError(err) {
    return err && (err.name === 'AbortError' || err.code === 20);
}

function throwIfAborted(signal) {
    if (signal && signal.aborted) {
        const e = new Error('aborted');
        e.name = 'AbortError';
        throw e;
    }
}
