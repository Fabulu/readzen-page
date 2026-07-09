// lib/bigram-search.js
// Runtime CJK inverted-index search for the SPA. Replaces the Pagefind
// dependency with a 4096-shard hashed index built by
// build/build-bigram-index.js (see SYNTHESIS.md sections 6, 7 and
// IMPLEMENTATION_PLAN.md tasks W3.1 / W2.2).
//
// Query pipeline:
//   1. Load manifest (cached 30 min).
//   2. Normalize the query, split it into MAXIMAL CJK RUNS (non-CJK chars
//      are separators; the latin remainder is reported via onStats as
//      `latinIgnored`, never silently zeroing the query).
//   3. Per run: length >= 2 -> adjacent bigrams; length == 1 -> the char as a
//      unigram term (requires manifest.unigramShards — the v3 capability gate).
//   4. Hash each term via FNV-1a32 mod 4096; bigram terms resolve through
//      manifest.shards under /data/search/bigram/shards/, unigram terms
//      through manifest.unigramShards under /data/search/bigram/unigram/.
//   5. Promise.all fetch each unique shard, lazy-decode the header. The
//      per-shard IIDX header version is AUTHORITATIVE: version 3 postings
//      decode to {docIds, tfs}; version 2 to docIds only.
//   6. Short-circuit empty if any term is missing.
//   7. Cascade-intersect shortest-first, carrying per-term tfs (v3).
//   8a. V3 fast path (every posting carried tfs): rank entirely from the
//       index — hitCount = sum over runs of min-over-that-run's-term-tfs
//       (desktop parity: the min-over-bigrams phrase estimator). ZERO
//       text-shard fetches, no candidate cap.
//   8b. V2 fallback (any posting lacked tfs): legacy pipeline — cap at
//       VERIFICATION_CAP candidates, fetch each candidate's text shard and
//       verify every CJK run appears (hitCount = sum of per-run substring
//       counts). Graceful with an already-deployed v2 index.
//   9. Sort by hitCount desc; return [{docId, hitCount}].
//
// Observability: opts.onStats(stats) fires once per query (after manifest
// load) with {indexVersion, builtAt, candidateCount, returnedCount,
// truncated, cap, latinIgnored}.
//
// Self-heal: a shard 404 / decode failure invalidates the cached manifest
// and refetches it once per session (shared promise); EVERY healable-failing
// shard awaits that refetch and retries its own url against the fresh
// mapping (covers the stale-manifest window after a redeploy, including
// several shards of one query failing concurrently).
//
// Caches:
//   - Manifest:        1 entry, 30 min TTL via lib/cache.js (sessionStorage).
//   - Index shards:    in-memory Map keyed by shard URL (bigram + unigram
//                      share the same LRU), LRU 32.
//   - Text shards:     in-memory Map<bucketIdStr,Map<docId,text>>, LRU 16.
//                      Only SUCCESSFUL loads are cached; a failed fetch
//                      resolves null without being memoized so it can be
//                      retried later in the session.
//   - docs.txt:        single Promise, lifetime of the module.
//   - Decoded postings: NOT cached (decode is fast).
//
// Browser ES module. No Node-only APIs. No new dependencies.

import { normalizeString, isCjk } from './cjk-normalize.js';
import { fnv1a32 } from './fnv.js';
import { readShardHeader, decodePostingList, decodePostingListV3 } from './bigram-codec.js';
import * as cache from './cache.js';

const MANIFEST_URL = '/data/search/bigram/manifest.json';
const SHARD_BASE = '/data/search/bigram/shards/';
const UNIGRAM_SHARD_BASE = '/data/search/bigram/unigram/';
const TEXT_SHARD_BASE = '/data/search/text/';
const DOCS_TXT_URL = '/data/search/bigram/docs.txt';

const MANIFEST_CACHE_KEY = 'bigram:manifest';
const MANIFEST_TTL_MS = 30 * 60 * 1000;

// Verification cap (v2 fallback path only — the v3 tf-ranked path needs no
// text verification and is uncapped). The cap bounds HTTP fan-out for very
// common queries; at 4096 text shards (~50-200 KB each) we can afford ~1500
// fetches in parallel. A 2-char query whose bigram IS the exact phrase
// doesn't need match-verification at all (see `isExactSingleBigramRun`).
const VERIFICATION_CAP = 1500;
// Mutable so tests can pin truncation behavior without fabricating >1500
// docs (see _setVerificationCapForTests). Production always uses the const.
let _verificationCap = VERIFICATION_CAP;
const TEXT_SHARD_COUNT = 4096;

const BIGRAM_SHARD_LRU_MAX = 32;
const TEXT_SHARD_LRU_MAX = 16;

// Map preserves insertion order; we delete + re-set on access for LRU bump.
// Keyed by shard URL (or an `empty:` sentinel key for '0'-manifest buckets);
// bigram and unigram shards share this cache and its in-flight map.
const _indexShardCache = new Map(); // key (string) -> { header, bytes }
const _textShardCache = new Map();  // bucketIdStr ('000'..'fff') -> Map<docId,text>

// Single-flight in-flight fetches to dedupe concurrent requests.
const _inflightIndexShards = new Map(); // key -> Promise<{header,bytes}>
const _inflightTextShards = new Map();  // bucketIdStr -> Promise<Map<docId,text>>

let _docsListPromise = null;

// Manifest self-heal: refetch the manifest at most once per session when a
// shard 404s or fails to decode (stale-manifest window after a redeploy).
// The refetch itself is shared: the FIRST healable failure creates the
// promise; every other healable-failing shard (including shards of the same
// query failing concurrently) awaits the same promise and then retries its
// OWN url against the fresh mapping. Resolves null when the refetch failed.
let _manifestRefreshPromise = null; // Promise<manifest|null> | null

/** Thrown when the manifest cannot be loaded (no index deployed). */
export class BigramIndexUnavailable extends Error {
    constructor(message) {
        super(message);
        this.name = 'BigramIndexUnavailable';
    }
}

/** Drop all in-memory caches (manifest stays in sessionStorage). */
export function clearShardCache() {
    _indexShardCache.clear();
    _textShardCache.clear();
    _inflightIndexShards.clear();
    _inflightTextShards.clear();
}

/**
 * Test-only: reset ALL module-level state — manifest cache key, docs.txt
 * promise, both shard caches, single-flight maps, and the manifest
 * refetch-once flag — so tests can re-run against fresh fixtures without
 * re-importing the module.
 */
export function _resetForTests() {
    cache.remove(MANIFEST_CACHE_KEY);
    _docsListPromise = null;
    _manifestRefreshPromise = null;
    _verificationCap = VERIFICATION_CAP;
    clearShardCache();
}

/**
 * Test-only: override the v2-fallback verification cap so truncation behavior
 * can be pinned with tiny fixtures. Pass null/undefined (or any non-positive
 * integer) to restore the production default. Also reset by _resetForTests().
 */
export function _setVerificationCapForTests(cap) {
    _verificationCap = (Number.isInteger(cap) && cap > 0) ? cap : VERIFICATION_CAP;
}

/** Eagerly fetch the manifest so the first query is faster. */
export async function preloadManifest() {
    await loadManifest();
}

/**
 * Manifest summary for UI surfaces (staleness display, capability checks).
 * Uses the same cached manifest load path as searchFulltext.
 * @returns {Promise<{version:number|null, builtAt:string|null, docCount:number, hasUnigrams:boolean}>}
 * @throws {BigramIndexUnavailable} when the manifest cannot be loaded.
 */
export async function getManifestInfo() {
    const manifest = await loadManifest();
    return {
        version: typeof manifest.version === 'number' ? manifest.version : null,
        builtAt: manifest.builtAt != null ? manifest.builtAt : null,
        docCount: typeof manifest.docCount === 'number' ? manifest.docCount : 0,
        hasUnigrams: !!(manifest.unigramShards && typeof manifest.unigramShards === 'object'),
    };
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
 * Count exact occurrences of a query in one document's normalized text.
 * Used for on-demand verification of DISPLAYED rows (v3 tf ranking is a
 * min-over-bigrams upper bound for multi-term queries; this is the exact
 * count). Extracts CJK runs like searchFulltext: every run must appear at
 * least once, result = sum of per-run substring counts, else 0.
 *
 * Outcome contract (consumers act on it — see views/search.js
 * applyVerifiedCount): a NUMBER means the doc text was actually scanned
 * (0 = genuinely no match, caller may drop the row); NULL means the count
 * could not be determined (text shard fetch failed, doc absent from its
 * shard, bad docId, no CJK runs, or abort) and the caller must keep its
 * index-derived estimate rather than treat the row as dead.
 * @param {number} docId
 * @param {string} query
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {Promise<number|null>} exact count (>= 0), or null when
 *          verification was impossible.
 */
export async function verifyDocPhrase(docId, query, opts = {}) {
    const signal = opts.signal;
    if (!Number.isInteger(docId) || docId < 0) return null;
    const normalized = normalizeString(query == null ? '' : String(query));
    const { runs } = extractCjkRuns(normalized);
    if (runs.length === 0) return null;
    let docMap;
    try {
        const bucketStr = (docId % TEXT_SHARD_COUNT).toString(16).padStart(3, '0');
        docMap = await loadTextShard(bucketStr, signal);
    } catch (err) {
        if (isAbortError(err)) return null;
        throw err;
    }
    if (!docMap) return null;
    const text = docMap.get(docId);
    if (text == null) return null;
    let total = 0;
    for (const run of runs) {
        const hits = countSubstringHits(text, run);
        if (hits === 0) return 0;
        total += hits;
    }
    return total;
}

/**
 * Run a CJK full-text search.
 * @param {string} query - User-typed query (may contain non-CJK chars; the
 *        CJK runs are matched, the latin remainder is ignored and reported
 *        via onStats.latinIgnored).
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal] - Aborts in-flight fetches and yields [].
 * @param {(batch: Array<{docId:number, hitCount:number}>) => void} [opts.onProgress]
 *        Streaming rows. On the v2 fallback path: each text shard's verified
 *        rows as soon as that shard's verification completes. On the v3 fast
 *        path: one batch with the full sorted result. The final sort by
 *        hitCount descending happens before the Promise resolves; consumers
 *        should re-sort on resolve.
 * @param {(stats: {indexVersion:number, builtAt:string|null, candidateCount:number,
 *        returnedCount:number, truncated:boolean, cap:number, latinIgnored:string|null}) => void} [opts.onStats]
 *        Called once per query after the manifest is loaded (never for the
 *        trivial [] short-circuits before manifest load, nor on abort).
 * @returns {Promise<Array<{docId:number, hitCount:number}>>}
 *
 * Returns [] on abort or when the query contains no indexable CJK content.
 * May throw BigramIndexUnavailable on manifest failure.
 */
export async function searchFulltext(query, opts = {}) {
    const signal = opts.signal;
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    const onStats = typeof opts.onStats === 'function' ? opts.onStats : null;

    const normalizedQuery = normalizeString(query == null ? '' : String(query));
    if (normalizedQuery.length === 0) return [];

    // Split into maximal CJK runs; the latin remainder is reported, not matched.
    const { runs, latinIgnored } = extractCjkRuns(normalizedQuery);
    // Pure-latin queries are routed away upstream (lib/search.js); defensive.
    if (runs.length === 0) return [];

    let manifest;
    try {
        manifest = await loadManifest(signal);
        throwIfAborted(signal);
    } catch (err) {
        if (isAbortError(err)) return [];
        throw err;
    }

    const hasUnigrams = !!(manifest.unigramShards && typeof manifest.unigramShards === 'object');
    const manifestHintV3 = typeof manifest.version === 'number' && manifest.version >= 3;
    const emitStats = (indexVersion, candidateCount, returnedCount, truncated) => {
        if (!onStats) return;
        try {
            onStats({
                indexVersion,
                builtAt: manifest.builtAt != null ? manifest.builtAt : null,
                candidateCount,
                returnedCount,
                truncated,
                cap: _verificationCap,
                latinIgnored,
            });
        } catch (_) { /* ignore consumer errors */ }
    };

    // Build per-run term specs. Terms are keyed 'b:<bigram>' / 'u:<char>' so
    // bigram and unigram namespaces never collide.
    const runSpecs = [];        // Array<{run: string, termKeys: string[]}>
    const termInfo = new Map(); // key -> {term: string, kind: 'bigram'|'unigram'}
    let droppedUnigramRun = false;
    for (const run of runs) {
        if (run.length >= 2) {
            const termKeys = [];
            const seen = new Set();
            for (let i = 0; i < run.length - 1; i++) {
                const bg = run.substr(i, 2);
                if (seen.has(bg)) continue;
                seen.add(bg);
                const key = 'b:' + bg;
                termKeys.push(key);
                if (!termInfo.has(key)) termInfo.set(key, { term: bg, kind: 'bigram' });
            }
            runSpecs.push({ run, termKeys });
        } else if (hasUnigrams) {
            const key = 'u:' + run;
            if (!termInfo.has(key)) termInfo.set(key, { term: run, kind: 'unigram' });
            runSpecs.push({ run, termKeys: [key] });
        } else {
            // v2 index (no unigram shards): the 1-char run can't contribute
            // candidates, but stays a verification constraint — the fallback
            // path text-verifies every run.
            droppedUnigramRun = true;
            runSpecs.push({ run, termKeys: [] });
        }
    }

    if (termInfo.size === 0) {
        // Query is ONLY unserved single-char runs — this index can't answer.
        emitStats(2, 0, 0, false);
        return [];
    }

    // Group terms by (kind, bucket) so each shard is fetched once even when
    // several terms hash to the same shard.
    const shardGroups = new Map(); // `${kind}:${bucket}` -> {kind, bucketId, termKeys: string[]}
    for (const [key, info] of termInfo) {
        const bucketId = fnv1a32(info.term) % 4096;
        const gk = info.kind + ':' + bucketId;
        let group = shardGroups.get(gk);
        if (!group) {
            group = { kind: info.kind, bucketId, termKeys: [] };
            shardGroups.set(gk, group);
        }
        group.termKeys.push(key);
    }

    // Fetch all required shards in parallel.
    const shardByTermKey = new Map(); // term key -> {header, bytes}
    try {
        const groups = Array.from(shardGroups.values());
        const fetched = await Promise.all(
            groups.map((g) => loadIndexShard(g.kind, g.bucketId, manifest, signal))
        );
        for (let i = 0; i < groups.length; i++) {
            for (const key of groups[i].termKeys) shardByTermKey.set(key, fetched[i]);
        }
    } catch (err) {
        if (isAbortError(err)) return [];
        throw err;
    }

    // Resolve each term's posting list, dispatching decode on the per-shard
    // header version (authoritative). Short-circuit if any term is missing —
    // AND semantics, and it keeps the no-text-fetch guarantee.
    const termKeysInOrder = [];
    const postingLists = []; // aligned with termKeysInOrder: {docIds, tfs|null}
    let sawV2 = false;
    for (const [key, info] of termInfo) {
        const shard = shardByTermKey.get(key);
        if (!shard) {
            emitStats(sawV2 ? 2 : (manifestHintV3 ? 3 : 2), 0, 0, false);
            return [];
        }
        const meta = shard.header.terms.get(info.term);
        if (!meta || meta.count === 0) {
            emitStats(sawV2 ? 2 : (manifestHintV3 ? 3 : 2), 0, 0, false);
            return [];
        }
        if (shard.header.version === 3) {
            postingLists.push(decodePostingListV3(shard.bytes, meta.count, meta.offset));
        } else {
            postingLists.push({
                docIds: decodePostingList(shard.bytes, meta.count, meta.offset),
                tfs: null,
            });
            sawV2 = true;
        }
        termKeysInOrder.push(key);
    }

    // Cascade-intersect shortest-first, carrying per-term tfs for survivors.
    const { docIds: candidates, tfsByList } = intersectWithTf(postingLists);
    if (candidates.length === 0) {
        emitStats(sawV2 ? 2 : 3, 0, 0, false);
        return [];
    }

    // --- V3 fast path: rank entirely from the index, zero text fetches. ---
    // Requires every fetched term's postings to carry tfs AND no 1-char run
    // dropped for lack of a unigram index (those need text verification).
    if (!sawV2 && !droppedUnigramRun) {
        const listIndexByKey = new Map();
        for (let i = 0; i < termKeysInOrder.length; i++) listIndexByKey.set(termKeysInOrder[i], i);
        const results = new Array(candidates.length);
        for (let i = 0; i < candidates.length; i++) {
            // Desktop parity: per run, runTf = min over that run's terms' tfs
            // (single-term run: its tf, exact by construction); hitCount =
            // sum of runTf across runs.
            let total = 0;
            for (const spec of runSpecs) {
                let runTf = Infinity;
                for (const key of spec.termKeys) {
                    const tf = tfsByList[listIndexByKey.get(key)][i];
                    if (tf < runTf) runTf = tf;
                }
                total += runTf;
            }
            results[i] = { docId: candidates[i], hitCount: total };
        }
        results.sort((a, b) => (b.hitCount - a.hitCount) || (a.docId - b.docId));
        if (onProgress) {
            try { onProgress(results.slice()); } catch (_) { /* ignore consumer errors */ }
        }
        emitStats(3, candidates.length, results.length, false);
        return results;
    }

    // --- V2 fallback path: legacy cap + text-shard verification. ---
    // Verification needles are the CJK RUNS (not the raw normalized query),
    // so mixed-script queries match under v2 too. For a single pure-CJK run
    // this is byte-for-byte the historical behavior.

    // A single 2-char run's one bigram IS the exact phrase, so the bigram
    // filter is sufficient — no false positives possible. Otherwise multiple
    // bigrams/runs may co-occur non-contiguously; verify against the doc's
    // normalized text.
    const isExactSingleBigramRun = runs.length === 1 && runs[0].length === 2;

    // Cap to bound HTTP fan-out for hot bigrams. With 4096 text shards
    // (~50-200 KB each) the limit is fan-out, not bytes per shard.
    const verifyCount = Math.min(candidates.length, _verificationCap);

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

    // Stream verified rows as each text shard arrives.
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
            if (isExactSingleBigramRun) {
                // Bigram already proves contiguous adjacency; just count
                // occurrences for ranking.
                const hits = countSubstringHits(text, runs[0]) || 1;
                batch.push({ docId, hitCount: hits });
            } else {
                let total = 0;
                let allRunsPresent = true;
                for (const run of runs) {
                    const hits = countSubstringHits(text, run);
                    if (hits === 0) { allRunsPresent = false; break; }
                    total += hits;
                }
                if (allRunsPresent) batch.push({ docId, hitCount: total });
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
    emitStats(2, candidates.length, verified.length, candidates.length > _verificationCap);
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

/**
 * Intersect posting lists that may carry per-doc term frequencies, keeping
 * the tf of each surviving doc for every input list. Delegates the docId
 * intersection to intersectU16 (shortest-first cascade) on a fresh outer
 * array so the caller's list order is preserved.
 * @param {Array<{docIds: Uint16Array, tfs: Uint32Array|null}>} lists
 * @returns {{docIds: Uint16Array, tfsByList: Array<Uint32Array|null>}}
 *          `tfsByList[k][i]` = list k's tf for surviving doc `docIds[i]`
 *          (null when list k carried no tfs, i.e. decoded from a v2 shard).
 */
function intersectWithTf(lists) {
    const inter = intersectU16(lists.map((l) => l.docIds));
    const tfsByList = new Array(lists.length);
    for (let k = 0; k < lists.length; k++) {
        const { docIds, tfs } = lists[k];
        if (!tfs) { tfsByList[k] = null; continue; }
        const out = new Uint32Array(inter.length);
        let j = 0;
        for (let i = 0; i < inter.length; i++) {
            const target = inter[i];
            while (docIds[j] !== target) j++;
            out[i] = tfs[j];
        }
        tfsByList[k] = out;
    }
    return { docIds: inter, tfsByList };
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

/**
 * Session-shared manifest refetch for the shard self-heal path. The first
 * caller invalidates the cached manifest and starts the refetch; concurrent
 * and later callers await the SAME promise (once per session), then each
 * retries its own shard url against the returned mapping. Never rejects —
 * resolves null when the refetch itself failed.
 * @returns {Promise<object|null>}
 */
function refetchManifestOnce() {
    if (!_manifestRefreshPromise) {
        _manifestRefreshPromise = (async () => {
            try {
                cache.remove(MANIFEST_CACHE_KEY);
                return await loadManifest();
            } catch (_) {
                return null; // refetch failed — callers fall through to empty
            }
        })();
    }
    return _manifestRefreshPromise;
}

function shardUrl(base, hex, hash) {
    return `${base}${hex.slice(0, 2)}/${hex.slice(2, 4)}-${hash}.bin`;
}

/**
 * Fetch + header-decode one index shard. Returns {entry} on success, or
 * {healable, reason} on failure — `healable` marks the failures the manifest
 * self-heal should retry (HTTP error, e.g. 404 from a stale content hash, or
 * a corrupt/unsupported shard body).
 */
async function fetchAndDecodeShard(url) {
    let response;
    try {
        response = await fetch(url, { cache: 'default' });
    } catch (err) {
        return { healable: false, reason: `fetch error: ${err.message}` };
    }
    if (!response.ok) {
        return { healable: true, reason: `HTTP ${response.status}` };
    }
    let bytes;
    try {
        bytes = new Uint8Array(await response.arrayBuffer());
    } catch (err) {
        return { healable: false, reason: `fetch error: ${err.message}` };
    }
    try {
        return { entry: { header: readShardHeader(bytes), bytes } };
    } catch (err) {
        return { healable: true, reason: `decode error: ${err.message}` };
    }
}

/**
 * Load one index shard — bigram (`kind` 'bigram': manifest.shards under
 * SHARD_BASE) or unigram (`kind` 'unigram': manifest.unigramShards under
 * UNIGRAM_SHARD_BASE). '0'-sentinel / unmapped buckets resolve to an empty
 * shard without any fetch. Shares one URL-keyed LRU + single-flight map
 * across both kinds.
 */
async function loadIndexShard(kind, bucketId, manifest, signal) {
    throwIfAborted(signal);
    const hex = bucketId.toString(16).padStart(4, '0');
    const base = kind === 'unigram' ? UNIGRAM_SHARD_BASE : SHARD_BASE;
    const map = manifest
        ? (kind === 'unigram' ? manifest.unigramShards : manifest.shards)
        : undefined;
    const hash = map ? map[hex] : undefined;
    const isEmpty = !hash || hash === '0';
    const cacheKey = isEmpty ? `empty:${kind}:${hex}` : shardUrl(base, hex, hash);

    // Cache hit: bump LRU and return.
    if (_indexShardCache.has(cacheKey)) {
        const entry = _indexShardCache.get(cacheKey);
        _indexShardCache.delete(cacheKey);
        _indexShardCache.set(cacheKey, entry);
        return entry;
    }
    // Single-flight: dedupe concurrent fetches. The shared promise runs the
    // fetch WITHOUT a signal, so one caller aborting can't reject another
    // caller's pending wait. Each caller post-checks its own signal.
    let shared = _inflightIndexShards.get(cacheKey);
    if (!shared) {
        shared = (async () => {
            try {
                if (isEmpty) {
                    const empty = { header: { version: 2, docCount: manifest.docCount, postingsStart: 0, terms: new Map() }, bytes: new Uint8Array(0) };
                    insertIndexShard(cacheKey, empty);
                    return empty;
                }
                const first = await fetchAndDecodeShard(shardUrl(base, hex, hash));
                if (first.entry) {
                    insertIndexShard(cacheKey, first.entry);
                    return first.entry;
                }
                // Self-heal: a 404 (stale content hash) or decode failure may
                // mean our cached manifest predates a redeploy. The manifest
                // is refetched at most ONCE per session (shared promise), but
                // EVERY healable-failing shard — including other shards of
                // the same query failing concurrently in the stale-manifest
                // window — awaits that shared refetch and retries its own
                // url against the fresh mapping.
                if (first.healable) {
                    const fresh = await refetchManifestOnce();
                    if (fresh) {
                        const freshMap = kind === 'unigram' ? fresh.unigramShards : fresh.shards;
                        const freshHash = freshMap ? freshMap[hex] : undefined;
                        if (!freshHash || freshHash === '0') {
                            const empty = { header: { version: 2, docCount: fresh.docCount, postingsStart: 0, terms: new Map() }, bytes: new Uint8Array(0) };
                            insertIndexShard(cacheKey, empty);
                            return empty;
                        }
                        const freshUrl = shardUrl(base, hex, freshHash);
                        const retry = await fetchAndDecodeShard(freshUrl);
                        if (retry.entry) {
                            // Cache under the FRESH url so post-heal queries
                            // (which see the fresh manifest) hit directly.
                            insertIndexShard(freshUrl, retry.entry);
                            return retry.entry;
                        }
                    }
                }
                console.warn(`[bigram] shard ${hex} ${first.reason}; treating as empty`);
                const empty = { header: { version: 2, docCount: manifest.docCount, postingsStart: 0, terms: new Map() }, bytes: new Uint8Array(0) };
                insertIndexShard(cacheKey, empty);
                return empty;
            } finally {
                _inflightIndexShards.delete(cacheKey);
            }
        })();
        _inflightIndexShards.set(cacheKey, shared);
    }
    const entry = await shared;
    throwIfAborted(signal);
    return entry;
}

function insertIndexShard(cacheKey, entry) {
    if (_indexShardCache.has(cacheKey)) _indexShardCache.delete(cacheKey);
    _indexShardCache.set(cacheKey, entry);
    while (_indexShardCache.size > BIGRAM_SHARD_LRU_MAX) {
        const oldestKey = _indexShardCache.keys().next().value;
        if (oldestKey === undefined) break;
        _indexShardCache.delete(oldestKey);
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
            // Failures resolve null but are NOT cached (only the in-flight
            // promise dedupes concurrent callers): a transient HTTP/network
            // error must stay retryable within the session, otherwise a
            // single blip would permanently skip verification for every doc
            // in this bucket.
            try {
                const response = await fetch(url, { cache: 'default' });
                if (!response.ok) {
                    console.warn(`[bigram] text shard ${bucketStr} HTTP ${response.status}; skipping verification`);
                    return null;
                }
                const text = await response.text();
                const map = parseTextShardNdjson(text);
                insertTextShard(bucketStr, map);
                return map;
            } catch (err) {
                console.warn(`[bigram] text shard ${bucketStr} fetch error: ${err.message}; skipping verification`);
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

function insertTextShard(bucketStr, map) {
    if (_textShardCache.has(bucketStr)) _textShardCache.delete(bucketStr);
    _textShardCache.set(bucketStr, map);
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

/**
 * Split a normalized query into maximal CJK runs (same 3-range BMP predicate
 * as bigram extraction). The non-CJK remainder is concatenated, trimmed, and
 * returned as `latinIgnored` ('' -> null) for onStats reporting.
 * @param {string} normalized
 * @returns {{runs: string[], latinIgnored: string|null}}
 */
function extractCjkRuns(normalized) {
    const runs = [];
    let cur = '';
    let latin = '';
    for (let i = 0; i < normalized.length; i++) {
        if (isCjk(normalized.charCodeAt(i))) {
            cur += normalized[i];
        } else {
            if (cur) { runs.push(cur); cur = ''; }
            latin += normalized[i];
        }
    }
    if (cur) runs.push(cur);
    const trimmed = latin.trim();
    return { runs, latinIgnored: trimmed === '' ? null : trimmed };
}

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
