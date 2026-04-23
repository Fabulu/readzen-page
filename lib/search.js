// lib/search.js
// Federated search orchestrator — queries masters, titles, and full-text
// in a single call. Sync sources return immediately; full-text is a Promise
// so callers can render fast results while the index loads.

import { DATA_REPO_BASE } from './github.js';
import * as cache from './cache.js';

const CORPUS_SHARD_BASE = DATA_REPO_BASE + 'corpus/masters/';
const SHARD_TTL_MS = 10 * 60 * 1000;

let pagefindModule = null;

/**
 * Search three sources and return structured results.
 * @param {string} query
 * @param {object} options
 * @returns {{ masters: object[], titles: object[], fulltext: Promise<object[]> }}
 */
export async function federatedSearch(query, options = {}) {
    const q = (query || '').trim();
    const { masters: masterData = [], titles: titleData = [], filters = {}, masterFilter } = options;

    // Load master corpus shard for filtering (if requested)
    let allowedFileIds = null;
    if (masterFilter) {
        allowedFileIds = await loadShardFileIds(masterFilter);
    }

    const masterResults = searchMasters(q, masterData);
    const titleResults = searchTitles(q, titleData, filters, allowedFileIds);

    // If masters matched, also find texts with their Chinese names in the title
    if (masterResults.length > 0) {
        const titlePaths = new Set(titleResults.map(t => t.path || ''));
        for (const m of masterResults) {
            const names = (m.names || []).filter(n => n && n.length >= 2);
            for (const name of names) {
                for (const t of titleData) {
                    if (titlePaths.has(t.path)) continue;
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

    const fulltext = searchFullText(q, filters, allowedFileIds);

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
function searchTitles(q, titles, filters, allowedFileIds) {
    if (!Array.isArray(titles)) return [];
    const lower = (q || '').toLowerCase();
    const { translated, zen, corpus } = filters || {};
    const results = [];
    for (const t of titles) {
        if (!t) continue;
        // Corpus filter
        if (corpus && (t.corpus || '') !== corpus) continue;
        // Translation filter
        if (translated === 'true' && !t.translated) continue;
        if (translated === 'false' && t.translated) continue;
        // Zen filter
        if (zen && !t.zen) continue;
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

/** Full-text search via Pagefind (async). Never throws. */
async function searchFullText(q, filters, allowedFileIds) {
    if (!q) return [];
    try {
        if (!pagefindModule) {
            pagefindModule = await import('/pagefind/pagefind.js');
            await pagefindModule.options({ excerptLength: 20, basePath: '/pagefind/' });
        }
        const pf = pagefindModule;
        const pfFilters = {};
        if (filters.zen) pfFilters.zen = 'true';
        if (filters.translated === 'true') pfFilters.translated = 'true';
        if (filters.translated === 'false') pfFilters.translated = 'false';

        const search = await pf.search(q, { filters: pfFilters });
        const top = search.results.slice(0, 100);
        const loaded = await Promise.all(top.map(r => r.data()));

        const results = loaded.map(r => ({
            url: r.url || '',
            excerpt: r.excerpt || '',
            meta: r.meta || {},
            sub_results: r.sub_results || [],
        }));

        // Apply master corpus filter on file_id in meta
        if (!allowedFileIds) return results;
        return results.filter(r => {
            const fid = (r.meta && r.meta.file_id) || '';
            return allowedFileIds.has(fid);
        });
    } catch (err) {
        console.warn('Federated full-text search failed:', err);
        return [];
    }
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
