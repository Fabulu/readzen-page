// lib/search.js
// Federated search orchestrator — queries masters, titles, and full-text
// in a single call. Sync sources return immediately; full-text is a Promise
// so callers can render fast results while the index loads.
//
// CJK queries route to the bigram inverted index (lib/bigram-search.js).
// Latin queries scan the prebuilt english.jsonl corpus blob.

import { DATA_REPO_BASE, sourceXmlUrl, authoritativeTranslationUrl, communityTranslationUrl, fetchText } from './github.js';
import { parseTei } from './tei.js';
import { findPassages } from './kwic.js';
import * as cache from './cache.js';
import { searchFulltext, fileIdForDocId, metaForDocId } from './bigram-search.js';
import { containsCjk } from './cjk-normalize.js';
import { getWorkId } from './titles.js';

const CORPUS_SHARD_BASE = DATA_REPO_BASE + 'corpus/masters/';
const SHARD_TTL_MS = 10 * 60 * 1000;

const ENGLISH_JSONL_URL = '/data/search/english.jsonl';
const ENGLISH_JSONL_CACHE_KEY = 'search:english-jsonl';
const ENGLISH_JSONL_TTL_MS = 30 * 60 * 1000;

// In-flight promise dedupe so concurrent first queries hit the network once.
let _englishCorpusPromise = null;

/**
 * Search three sources and return structured results.
 * @param {string} query
 * @param {object} options
 * @returns {{ masters: object[], titles: object[], fulltext: Promise<object[]> }}
 */
export async function federatedSearch(query, options = {}) {
    const q = (query || '').trim();
    const {
        masters: masterData = [],
        titles: titleData = [],
        filters = {},
        masterFilter,
        translatedIds = null,
        zenIds = null,
    } = options;

    // Load master corpus shard for filtering (if requested)
    let allowedFileIds = null;
    if (masterFilter) {
        allowedFileIds = await loadShardFileIds(masterFilter);
    }

    const masterResults = searchMasters(q, masterData);
    const titleResults = searchTitles(q, titleData, filters, allowedFileIds, translatedIds, zenIds);

    // If masters matched, also find texts with their Chinese names in the title
    if (masterResults.length > 0) {
        const titlePaths = new Set(titleResults.map(t => t.path || ''));
        for (const m of masterResults) {
            const names = (m.names || []).filter(n => n && n.length >= 2);
            for (const name of names) {
                for (const t of titleData) {
                    if (!t || titlePaths.has(t.path)) continue;
                    if (!passesFilters(t, filters, translatedIds, zenIds)) continue;
                    if (allowedFileIds) {
                        const fid = t.fileId || t.fileID || t.workId || '';
                        if (!allowedFileIds.has(fid)) continue;
                    }
                    const blob = ((t.zh || '') + ' ' + (t.en || '') + ' ' + (t.path || '')).toLowerCase();
                    if (blob.includes(name.toLowerCase())) {
                        titleResults.push(t);
                        titlePaths.add(t.path);
                        if (titleResults.length >= 50) break;
                    }
                }
                if (titleResults.length >= 50) break;
            }
        }
    }

    const fulltext = searchFullText(q, filters, allowedFileIds, titleData, translatedIds, zenIds, {
        signal: options.signal,
        onProgress: options.onFulltextProgress,
        onFulltextStats: options.onFulltextStats,
    });

    return { masters: masterResults, titles: titleResults, fulltext };
}

/** Match query against master name aliases (synchronous). Max 5. */
function searchMasters(q, masters) {
    if (!q || !Array.isArray(masters)) return [];
    const lower = q.toLowerCase();
    const results = [];
    for (const m of masters) {
        if (!m || !m.names) continue;
        for (const n of m.names) {
            if (n && n.toLowerCase().includes(lower)) {
                results.push(m);
                break;
            }
        }
        if (results.length >= 5) break;
    }
    return results;
}

/** Substring match on title fields with filter support (synchronous). Max 50. */
function searchTitles(q, titles, filters, allowedFileIds, translatedIds, zenIds) {
    if (!Array.isArray(titles)) return [];
    const lower = (q || '').toLowerCase();
    const results = [];
    for (const t of titles) {
        if (!t) continue;
        if (!passesFilters(t, filters, translatedIds, zenIds)) continue;
        // Master corpus filter
        if (allowedFileIds) {
            const fid = t.fileId || t.fileID || t.workId || '';
            if (!allowedFileIds.has(fid)) continue;
        }
        // Query match (empty query matches all, for browse mode)
        if (lower) {
            const blob = ((t.zh || '') + ' ' + (t.en || '') + ' ' +
                (t.enShort || '') + ' ' + (t.path || '')).toLowerCase();
            if (!blob.includes(lower)) continue;
        }
        results.push(t);
        if (results.length >= 50) break;
    }
    return results;
}

/**
 * Full-text search router. CJK queries go through the bigram index;
 * everything else scans the english.jsonl corpus blob. Never throws.
 *
 * The `opts.onProgress` callback (if provided) fires once per text-shard
 * verification batch with the partial result rows so the UI can render
 * incrementally while the full search is still in flight.
 */
async function searchFullText(q, filters, allowedFileIds, titleData, translatedIds, zenIds, opts = {}) {
    if (!q) return [];
    try {
        if (containsCjk(q)) {
            return await searchFullTextCjk(q, filters, allowedFileIds, titleData, translatedIds, zenIds, opts);
        }
        return await searchFullTextLatin(q, filters, allowedFileIds, titleData, translatedIds, zenIds, opts);
    } catch (err) {
        console.warn('Federated full-text search failed:', err);
        return [];
    }
}

/** Build a Map<fileId, titleRecord> for fast title lookup.
 * Real titles.jsonl records carry only `path`, not `fileId`. Use the
 * shared getWorkId() helper which derives the workId from the path.
 */
function buildTitleIndex(titleData) {
    const map = new Map();
    if (!Array.isArray(titleData)) return map;
    for (const t of titleData) {
        if (!t) continue;
        const fid = getWorkId(t);
        if (fid && !map.has(fid)) map.set(fid, t);
    }
    return map;
}

/**
 * Apply the same translated/zen/corpus filter set as searchTitles.
 *
 * Real titles.jsonl records do NOT carry `translated` or `zen` fields, so
 * the caller passes Set<fileId> for each. When the Sets are absent we fall
 * back to the legacy `t.translated` / `t.zen` boolean fields purely as a
 * test-fixture compatibility shim.
 */
function passesFilters(t, filters, translatedIds, zenIds) {
    if (!filters) return true;
    if (!t) return false;
    const { translated, zen, corpus } = filters;
    if (corpus && (t.corpus || '') !== corpus) return false;
    if (translated === 'true' || translated === 'false') {
        const isTranslated = translatedIds
            ? translatedIds.has(getWorkId(t))
            : !!t.translated;
        if (translated === 'true' && !isTranslated) return false;
        if (translated === 'false' && isTranslated) return false;
    }
    if (zen) {
        const isZen = zenIds ? zenIds.has(getWorkId(t)) : !!t.zen;
        if (!isZen) return false;
    }
    return true;
}

/** True when any user-facing filter is active (not just a default). */
function hasActiveFilter(filters) {
    if (!filters) return false;
    return Boolean(
        filters.corpus ||
        filters.translated === 'true' ||
        filters.translated === 'false' ||
        filters.zen
    );
}

/** CJK full-text via the bigram inverted index (lib/bigram-search.js). */
async function searchFullTextCjk(q, filters, allowedFileIds, titleData, translatedIds, zenIds, opts = {}) {
    const titleIndex = buildTitleIndex(titleData);
    const filtersActive = hasActiveFilter(filters);
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;

    // Convert one bigram-backend batch ({docId, hitCount}[]) into result-row
    // shape, applying filters + B6 fail-closed + URL synthesis.
    const rowsForBatch = async (batch) => {
        const rows = [];
        for (const { docId, hitCount } of batch) {
            const meta = await metaForDocId(docId);
            if (!meta || !meta.fileId) continue;
            const { fileId, side, translator } = meta;
            if (allowedFileIds && !allowedFileIds.has(fileId)) continue;
            const t = titleIndex.get(fileId);
            if (filtersActive && !t) continue;
            if (t && !passesFilters(t, filters, translatedIds, zenIds)) continue;
            const title = (t && (t.zh || t.en)) || fileId;
            const titleEn = (t && (t.en || t.enShort)) || '';
            let url = '/' + fileId;
            if (side === 'community' && translator) {
                url += '?side=community&translator=' + encodeURIComponent(translator);
            } else if (side === 'en') {
                url += '?side=en';
            }
            rows.push({
                url,
                excerpt: '',
                meta: { file_id: fileId, title, title_en: titleEn, side, translator },
                sub_results: [],
                hitCount,
                docId,
            });
        }
        return rows;
    };

    // Stream: bigram-backend's onProgress fires as each text shard verifies.
    // Convert the partial batch and forward to the view layer immediately.
    const innerOnProgress = onProgress
        ? (batch) => {
            // Fire-and-forget; final await ensures full result is returned.
            rowsForBatch(batch).then((rows) => {
                if (rows.length) onProgress(rows);
            }).catch(() => { /* swallow per-batch errors */ });
        }
        : null;

    const hits = await searchFulltext(q, {
        signal: opts.signal,
        onProgress: innerOnProgress,
        onStats: opts.onFulltextStats,
    });
    if (!hits || hits.length === 0) {
        console.log(`[bigram] q="${q}" hits=0`);
        return [];
    }

    const out = await rowsForBatch(hits);
    console.log(`[bigram] q="${q}" hits=${hits.length} returned=${out.length}`);
    return out;
}

/** Latin full-text via cached english.jsonl substring scan. */
async function searchFullTextLatin(q, filters, allowedFileIds, titleData, translatedIds, zenIds, opts = {}) {
    const corpus = await loadEnglishCorpus();
    if (!corpus || corpus.length === 0) return [];

    const qlc = q.toLowerCase().trim();
    if (!qlc) return [];

    const titleIndex = buildTitleIndex(titleData);
    const filtersActive = hasActiveFilter(filters);
    const out = [];
    for (const rec of corpus) {
        if (!rec || !rec.text) continue;
        const text = rec.text; // already lowercased at build time
        const count = countOccurrences(text, qlc);
        if (count === 0) continue;

        const fileId = rec.fileId || '';
        if (!fileId) continue;
        if (allowedFileIds && !allowedFileIds.has(fileId)) continue;
        const t = titleIndex.get(fileId);
        // B6 fail-closed: any active filter + missing title record = exclude.
        if (filtersActive && !t) continue;
        if (t && !passesFilters(t, filters, translatedIds, zenIds)) continue;

        const titleEn = rec.titleEn || (t && (t.en || t.enShort)) || fileId;
        const translator = rec.translator || '';
        const side = translator ? 'community' : 'en';
        const url = '/' + fileId + (translator
            ? '?side=community&translator=' + encodeURIComponent(translator)
            : '?side=en');
        out.push({
            url,
            excerpt: '',
            meta: {
                file_id: fileId,
                title: titleEn,
                title_en: titleEn,
                side,
                translator,
            },
            sub_results: [],
            hitCount: count,
        });
    }
    // Audit #5: sort by hitCount descending. Array.prototype.sort is stable,
    // so equal-hitCount rows keep the deterministic corpus file order.
    out.sort((a, b) => (b.hitCount || 0) - (a.hitCount || 0));
    if (typeof opts.onFulltextStats === 'function') {
        // Uniform stats channel with the CJK path (indexVersion/builtAt are
        // bigram-index concepts; null on the latin scan path).
        opts.onFulltextStats({
            indexVersion: null,
            builtAt: null,
            candidateCount: out.length,
            returnedCount: out.length,
            truncated: false,
            latinIgnored: null,
        });
    }
    console.log(`[search:latin] q="${q}" records=${corpus.length} returned=${out.length}`);
    return out;
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack, needle) {
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

/** Load + parse english.jsonl with cache + in-flight dedupe. */
async function loadEnglishCorpus() {
    const cached = cache.get(ENGLISH_JSONL_CACHE_KEY);
    if (cached) return cached;
    if (_englishCorpusPromise) return _englishCorpusPromise;

    _englishCorpusPromise = (async () => {
        try {
            const resp = await fetch(ENGLISH_JSONL_URL, { cache: 'default' });
            if (!resp.ok) {
                console.warn(`[search:latin] english.jsonl HTTP ${resp.status}`);
                return [];
            }
            const text = await resp.text();
            const records = parseNdjson(text);
            cache.set(ENGLISH_JSONL_CACHE_KEY, records, ENGLISH_JSONL_TTL_MS);
            return records;
        } catch (err) {
            console.warn('[search:latin] english.jsonl fetch error:', err);
            return [];
        } finally {
            _englishCorpusPromise = null;
        }
    })();
    return _englishCorpusPromise;
}

/** Parse NDJSON text into an array of records, skipping malformed lines. */
function parseNdjson(text) {
    const out = [];
    if (!text) return out;
    let start = 0;
    const len = text.length;
    for (let i = 0; i <= len; i++) {
        if (i === len || text.charCodeAt(i) === 0x0A /* LF */) {
            if (i > start) {
                const line = text.charCodeAt(i - 1) === 0x0D /* CR */
                    ? text.substring(start, i - 1)
                    : text.substring(start, i);
                if (line.length > 0) {
                    try {
                        out.push(JSON.parse(line));
                    } catch {
                        // Malformed line — skip.
                    }
                }
            }
            start = i + 1;
        }
    }
    return out;
}

/** Load a master's corpus shard and extract the set of file IDs. */
async function loadShardFileIds(slug) {
    const key = 'search:shard:' + slug;
    const cached = cache.get(key);
    if (cached) return cached;
    try {
        const resp = await fetch(CORPUS_SHARD_BASE + slug + '.json');
        if (!resp.ok) return null;
        const data = await resp.json();
        const ids = new Set();
        for (const entry of (data.primary || [])) ids.add(entry.fileId || entry.file_id || '');
        for (const entry of (data.secondary || [])) ids.add(entry.fileId || entry.file_id || '');
        ids.delete('');
        cache.set(key, ids, SHARD_TTL_MS);
        return ids;
    } catch {
        return null;
    }
}

const XML_CACHE_TTL_MS = 15 * 60 * 1000;

/**
 * Bridge from a file-level full-text hit (bigram for CJK, JSONL scan for Latin) to passage-level KWIC results.
 * Fetches the source XML for `fileId`, parses it with parseTei(), and runs
 * findPassages() to locate every occurrence of `term` with surrounding context.
 *
 * When `opts.includeTranslation` is true and an authoritative translation
 * exists, also fetches+parses the translation XML and returns a Map keyed
 * by `startLb` with the aligned English text spanning each source passage's
 * lb range. The translation XML is cached separately (15-min TTL).
 *
 * @param {string} fileId - e.g. "T48n2005" (CBETA) or "wm32.case01" (OpenZen)
 * @param {string} term   - the search term to locate within the document
 * @param {object} [opts]
 * @param {boolean} [opts.includeTranslation=false] - also fetch the EN side and align by lb.
 * @returns {Promise<{passages: Array, totalHits: number, titleZh: string, titleEn: string, translatedPassages?: Map<string,string>}>}
 */
/**
 * Which document should KWIC search for a result group? Source-side groups
 * search the Chinese source; 'en' groups the authoritative translation;
 * 'community' groups that translator's file. Latin queries only ever match
 * en/community groups, so searching the source for them returned zero
 * passages ("No passage-level matches found") - the group's own hits live in
 * the English document. Pure; unit-tested.
 */
export function resolveKwicUrl(fileId, side, translator) {
    if (side === 'community' && translator) return communityTranslationUrl(fileId, translator);
    if (side === 'en' || side === 'community') return authoritativeTranslationUrl(fileId);
    return sourceXmlUrl(fileId);
}

export async function loadAndSearchXml(fileId, term, opts = {}) {
    const url = resolveKwicUrl(fileId, opts.side || '', opts.translator || '');
    if (!url) {
        return { passages: [], totalHits: 0, titleZh: '', titleEn: '' };
    }

    // Fetch XML with cache
    const cacheKey = 'xml:' + url;
    let xmlText = cache.get(cacheKey);
    if (!xmlText) {
        try {
            xmlText = await fetchText(url);
            cache.set(cacheKey, xmlText, XML_CACHE_TTL_MS);
        } catch (err) {
            console.warn('loadAndSearchXml: failed to fetch', url, err);
            return { passages: [], totalHits: 0, titleZh: '', titleEn: '' };
        }
    }

    // Parse TEI and search
    let parsed;
    try {
        parsed = parseTei(xmlText);
    } catch (err) {
        console.warn('loadAndSearchXml: failed to parse TEI for', fileId, err);
        return { passages: [], totalHits: 0, titleZh: '', titleEn: '' };
    }

    const { titleZh, titleEn, linesById, lineOrder } = parsed;
    const passages = findPassages(linesById, lineOrder, term);

    const result = {
        passages,
        totalHits: passages.length,
        titleZh: titleZh || '',
        titleEn: titleEn || '',
    };

    if (opts && opts.includeTranslation && !opts.side && passages.length > 0) {
        // Pass the already-parsed source `lineOrder` so buildAlignedTranslation
        // doesn't have to re-parse the source XML it already saw to compute
        // the lb set for each passage range.
        result.translatedPassages = await buildAlignedTranslation(fileId, passages, lineOrder);
    }

    return result;
}

/**
 * Fetch the authoritative EN translation XML, parse it, and produce a Map
 * keyed by source-side `startLb` with the aligned English text spanning
 * each passage's lb range (startLb..endLb inclusive). Lazy: only called
 * when the caller asks for it. Returns an empty Map if the translation is
 * unavailable or no source-side lb IDs match — so the caller can fall back
 * to monolingual KWIC display.
 */
async function buildAlignedTranslation(fileId, passages, sourceLineOrder) {
    const out = new Map();
    const tUrl = authoritativeTranslationUrl(fileId);
    if (!tUrl) return out;

    const tCacheKey = 'xml:' + tUrl;
    let tXml = cache.get(tCacheKey);
    if (!tXml) {
        try {
            tXml = await fetchText(tUrl);
            cache.set(tCacheKey, tXml, XML_CACHE_TTL_MS);
        } catch {
            // Translation may not exist (community-only file, or genuine 404)
            // — that's fine; caller will treat as "no alignment available".
            return out;
        }
    }

    let tParsed;
    try {
        tParsed = parseTei(tXml);
    } catch {
        return out;
    }

    const { linesById: tLinesById } = tParsed;

    // Build lb → index map over the SOURCE's lineOrder so we can collect the
    // exact set of real-line lb IDs in each passage's range, then look them
    // up in the translation. Walking the translation's own lineOrder by
    // index range would splice in translator-only IDs (interpolated
    // headings, translator notes) that happen to fall between startLb and
    // endLb in the translated file — those would corrupt the aligned text.
    const sIdxOf = new Map();
    if (Array.isArray(sourceLineOrder)) {
        for (let i = 0; i < sourceLineOrder.length; i++) {
            sIdxOf.set(sourceLineOrder[i], i);
        }
    }

    for (const p of passages) {
        const startIdx = sIdxOf.get(p.startLb);
        const endIdx = sIdxOf.get(p.endLb);
        if (startIdx == null || endIdx == null) continue;
        const lo = Math.min(startIdx, endIdx);
        const hi = Math.max(startIdx, endIdx);
        const parts = [];
        for (let i = lo; i <= hi; i++) {
            const id = sourceLineOrder[i];
            if (!id || id.startsWith('__')) continue; // skip synthetic markers
            // Only include the EN line if the SAME lb id exists in the
            // translation. Translator-only IDs are not in this set; source
            // IDs missing from the translation are treated as unaligned.
            const entry = tLinesById.get(id);
            if (!entry) continue;
            const text = typeof entry === 'string' ? entry : (entry.text || '');
            if (text) parts.push(text);
        }
        const aligned = parts.join(' ').trim();
        if (aligned) out.set(p.startLb, aligned);
    }

    return out;
}
