// lib/search.js
// Federated search orchestrator — queries masters, titles, and full-text
// in a single call. Sync sources return immediately; full-text is a Promise
// so callers can render fast results while the index loads.
//
// CJK queries route to the bigram inverted index (lib/bigram-search.js).
// Latin queries scan the prebuilt english.jsonl corpus blob.

import { DATA_REPO_BASE, sourceXmlUrl, fetchText } from './github.js';
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

    const fulltext = searchFullText(q, filters, allowedFileIds, titleData, translatedIds, zenIds);

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
 */
async function searchFullText(q, filters, allowedFileIds, titleData, translatedIds, zenIds) {
    if (!q) return [];
    try {
        if (containsCjk(q)) {
            return await searchFullTextCjk(q, filters, allowedFileIds, titleData, translatedIds, zenIds);
        }
        return await searchFullTextLatin(q, filters, allowedFileIds, titleData, translatedIds, zenIds);
    } catch (err) {
        console.warn('Federated full-text search failed:', err);
        return [];
    }
}

/** Build a Map<fileId, titleRecord> for fast title lookup. */
function buildTitleIndex(titleData) {
    const map = new Map();
    if (!Array.isArray(titleData)) return map;
    for (const t of titleData) {
        if (!t) continue;
        const fid = t.fileId || t.fileID || t.workId || '';
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
async function searchFullTextCjk(q, filters, allowedFileIds, titleData, translatedIds, zenIds) {
    const hits = await searchFulltext(q);
    if (!hits || hits.length === 0) {
        console.log(`[bigram] q="${q}" hits=0`);
        return [];
    }

    const titleIndex = buildTitleIndex(titleData);
    const filtersActive = hasActiveFilter(filters);
    const out = [];
    for (const { docId, hitCount } of hits) {
        const meta = await metaForDocId(docId);
        if (!meta || !meta.fileId) continue;
        const { fileId, side, translator } = meta;
        if (allowedFileIds && !allowedFileIds.has(fileId)) continue;
        const t = titleIndex.get(fileId);
        // B6 fail-closed: when ANY filter is active and we cannot locate the
        // title record, exclude the row rather than silently letting it through.
        if (filtersActive && !t) continue;
        if (t && !passesFilters(t, filters, translatedIds, zenIds)) continue;
        const title = (t && (t.zh || t.en)) || fileId;
        const titleEn = (t && (t.en || t.enShort)) || '';
        // Synthesize the URL from path + side/translator query string so
        // translation-side / community matches link to the correct variant.
        let url = '/' + fileId;
        if (side === 'community' && translator) {
            url += '?side=community&translator=' + encodeURIComponent(translator);
        } else if (side === 'en') {
            url += '?side=en';
        }
        out.push({
            url,
            excerpt: '',
            meta: { file_id: fileId, title, title_en: titleEn, side, translator },
            sub_results: [],
            hitCount,
        });
    }
    console.log(`[bigram] q="${q}" hits=${hits.length} returned=${out.length}`);
    return out;
}

/** Latin full-text via cached english.jsonl substring scan. */
async function searchFullTextLatin(q, filters, allowedFileIds, titleData, translatedIds, zenIds) {
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
 * @param {string} fileId - e.g. "T48n2005" (CBETA) or "wm32.case01" (OpenZen)
 * @param {string} term   - the search term to locate within the document
 * @returns {Promise<{passages: Array, totalHits: number, titleZh: string, titleEn: string}>}
 */
export async function loadAndSearchXml(fileId, term) {
    const url = sourceXmlUrl(fileId);
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

    return {
        passages,
        totalHits: passages.length,
        titleZh: titleZh || '',
        titleEn: titleEn || '',
    };
}
