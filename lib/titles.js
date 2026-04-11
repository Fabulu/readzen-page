// lib/titles.js
// Load and lookup CBETA work titles from the translations repo's titles.jsonl.
// titles.jsonl format (one JSON object per line):
//   {"path":"T/T48/T48n2005.xml","zh":"無門關","en":"The Gateless Barrier","enShort":"Gateless Barrier","zhHash":"..."}
//
// Used to show translated titles in the passage view header instead of bare workIds.

import { DATA_REPO_BASE, fetchText } from './github.js';
import * as cache from './cache.js';

const TITLES_URL = DATA_REPO_BASE + 'titles.jsonl';
const CACHE_KEY = 'titles:index';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

let _loadPromise = null;

/**
 * Load and parse titles.jsonl into a Map keyed by workId (e.g., "T48n2005")
 * AND by full path (e.g., "T/T48/T48n2005.xml"). Cached in sessionStorage.
 * Returns the Map (in-memory; cached lookup is JSON-serialized via cache.js).
 */
export async function loadTitlesIndex() {
    if (_loadPromise) return _loadPromise;

    _loadPromise = (async () => {
        // Try in-memory + sessionStorage cache first
        const cached = cache.get(CACHE_KEY);
        if (cached && typeof cached === 'object') {
            return new Map(Object.entries(cached));
        }

        try {
            const text = await fetchText(TITLES_URL);
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
                // Index by full path
                map.set(entry.path, entry);
                // Also index by workId (last segment of path, minus .xml)
                const workId = workIdFromPath(entry.path);
                if (workId) map.set(workId, entry);
            }

            // Persist to cache as plain object (Map → object for JSON serialization)
            const obj = Object.fromEntries(map);
            cache.set(CACHE_KEY, obj, CACHE_TTL_MS);
            return map;
        } catch {
            // Network or parse failure — return empty map; callers fall back to workId.
            return new Map();
        }
    })();

    return _loadPromise;
}

/**
 * Look up the title entry for a workId or path. Returns null if not found
 * or if the index hasn't loaded yet.
 */
export async function lookupTitle(workIdOrPath) {
    const map = await loadTitlesIndex();
    return map.get(workIdOrPath) || null;
}

/** Extract workId from a path like "T/T48/T48n2005.xml" → "T48n2005". */
function workIdFromPath(path) {
    if (!path) return null;
    const lastSlash = path.lastIndexOf('/');
    const filename = lastSlash >= 0 ? path.substring(lastSlash + 1) : path;
    const dot = filename.lastIndexOf('.');
    return dot > 0 ? filename.substring(0, dot) : filename;
}
