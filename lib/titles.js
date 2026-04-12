// lib/titles.js
// Load and lookup work titles from the translations repos' titles.jsonl.
// titles.jsonl format (one JSON object per line):
//   {"path":"T/T48/T48n2005.xml","zh":"Wu Men Guan","en":"The Gateless Barrier","enShort":"Gateless Barrier","zhHash":"..."}
//
// Used to show translated titles in the passage view header instead of bare workIds.

import { DATA_REPO_BASE, OPEN_DATA_REPO_BASE, fetchText } from './github.js';
import { Corpus, inferCorpus, inferCorpusForRelPath } from './corpus.js';
import * as cache from './cache.js';

const TITLES_URLS = {
    [Corpus.Cbeta]: DATA_REPO_BASE + 'titles.jsonl',
    [Corpus.OpenZen]: OPEN_DATA_REPO_BASE + 'titles.jsonl'
};
const CACHE_KEYS = {
    [Corpus.Cbeta]: 'titles:index:cbeta',
    [Corpus.OpenZen]: 'titles:index:openzen'
};
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

const _loadPromises = {
    [Corpus.Cbeta]: null,
    [Corpus.OpenZen]: null
};

/**
 * Load and parse titles.jsonl into a Map keyed by fileId AND by full path.
 * Returns the Map (in-memory; cached lookup is JSON-serialized via cache.js).
 */
export async function loadTitlesIndexForCorpus(corpus) {
    if (corpus !== Corpus.Cbeta && corpus !== Corpus.OpenZen) {
        return new Map();
    }
    if (_loadPromises[corpus]) return _loadPromises[corpus];

    _loadPromises[corpus] = (async () => {
        const cacheKey = CACHE_KEYS[corpus];
        const cached = cache.get(cacheKey);
        if (cached && typeof cached === 'object') {
            return new Map(Object.entries(cached));
        }

        try {
            const text = await fetchText(TITLES_URLS[corpus]);
            const map = new Map();
            const lines = text.split(/\r?\n/);
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                let entry;
                try {
                    entry = JSON.parse(trimmed);
                } catch {
                    continue;
                }
                if (!entry || !entry.path) continue;
                map.set(entry.path, entry);
                if (entry.fileId) map.set(entry.fileId, entry);
                const fileId = fileIdFromPath(entry.path);
                if (fileId) map.set(fileId, entry);
            }

            const obj = Object.fromEntries(map);
            cache.set(cacheKey, obj, CACHE_TTL_MS);
            return map;
        } catch {
            return new Map();
        }
    })();

    return _loadPromises[corpus];
}

/**
 * Look up the title entry for a fileId or path. Returns null if not found.
 */
export async function lookupTitle(fileIdOrPath, corpus) {
    if (!fileIdOrPath) return null;
    let resolved = corpus;
    if (!resolved) {
        resolved = fileIdOrPath.includes('/')
            ? inferCorpusForRelPath(fileIdOrPath)
            : inferCorpus(fileIdOrPath);
    }

    if (resolved === Corpus.Cbeta || resolved === Corpus.OpenZen) {
        const map = await loadTitlesIndexForCorpus(resolved);
        return map.get(fileIdOrPath) || null;
    }

    const [cbetaMap, openMap] = await Promise.all([
        loadTitlesIndexForCorpus(Corpus.Cbeta),
        loadTitlesIndexForCorpus(Corpus.OpenZen)
    ]);
    return cbetaMap.get(fileIdOrPath) || openMap.get(fileIdOrPath) || null;
}

/**
 * Load both corpora and return a flattened array of entries with corpus tags.
 */
export async function loadAllTitlesAsArray() {
    const [cbetaMap, openMap] = await Promise.all([
        loadTitlesIndexForCorpus(Corpus.Cbeta),
        loadTitlesIndexForCorpus(Corpus.OpenZen)
    ]);
    return [
        ...entriesWithCorpus(cbetaMap, Corpus.Cbeta),
        ...entriesWithCorpus(openMap, Corpus.OpenZen)
    ];
}

/**
 * Backwards-compat alias retained for any external import (currently none).
 * Defaults to CBETA so behaviour matches the old single-corpus loader.
 */
export async function loadTitlesIndex() {
    return loadTitlesIndexForCorpus(Corpus.Cbeta);
}

/** Extract fileId from a path like "T/T48/T48n2005.xml" or "ws/gateless-barrier/gateless-barrier.xml". */
function fileIdFromPath(path) {
    if (!path) return null;
    const normalized = path.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    if (parts.length === 0) return null;
    if (inferCorpusForRelPath(normalized) === Corpus.OpenZen && parts.length >= 2) {
        return `${parts[0]}.${parts[1]}`;
    }
    const filename = parts[parts.length - 1];
    const dot = filename.lastIndexOf('.');
    return dot > 0 ? filename.substring(0, dot) : filename;
}

/**
 * Flatten a titles index into one tagged entry per source line.
 *
 * The map is intentionally over-keyed (full path AND fileId AND derived
 * fileIdFromPath all point at the same JSON line). On the first page-load
 * inside a tab those keys all reference the SAME object literal, so an
 * identity-based `Set(map.values())` dedupes correctly. On the second
 * page-load the map is rehydrated from sessionStorage via JSON.parse,
 * which produces a fresh object per key — `Set` then sees them as
 * distinct and search results show every entry 2–3 times. Dedupe by
 * the canonical `path` field (or `fileId` as a fallback) instead.
 */
function entriesWithCorpus(map, corpus) {
    const seen = new Set();
    const out = [];
    for (const entry of map.values()) {
        if (!entry) continue;
        const key = entry.path || entry.fileId;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push({ ...entry, corpus });
    }
    return out;
}
