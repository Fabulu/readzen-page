// lib/github.js
// Raw-GitHub fetch helpers. All URLs point at public repos served with CORS,
// so the browser can request them directly with no auth.

import { Corpus, inferCorpus } from './corpus.js';

export const TEXT_REPO_BASE =
    'https://raw.githubusercontent.com/Fabulu/CbetaZenTexts/main/xml-p5/';
export const TRANSLATION_REPO_BASE =
    'https://raw.githubusercontent.com/Fabulu/CbetaZenTranslations/main/xml-p5t/';
export const COMMUNITY_TRANSLATIONS_BASE =
    'https://raw.githubusercontent.com/Fabulu/CbetaZenTranslations/main/community/translations/';
export const DATA_REPO_BASE =
    'https://raw.githubusercontent.com/Fabulu/CbetaZenTranslations/main/';
export const OPEN_TEXT_REPO_BASE =
    'https://raw.githubusercontent.com/Fabulu/OpenZenTexts/main/xml-open/';
export const OPEN_TRANSLATION_REPO_BASE =
    'https://raw.githubusercontent.com/Fabulu/OpenZenTranslations/main/xml-open-t/';
export const OPEN_COMMUNITY_TRANSLATIONS_BASE =
    'https://raw.githubusercontent.com/Fabulu/OpenZenTranslations/main/community/translations/';
export const OPEN_DATA_REPO_BASE =
    'https://raw.githubusercontent.com/Fabulu/OpenZenTranslations/main/';

/**
 * Converts a compact file ID like `T48n2005` into the canonical relative
 * TEI path `T/T48/T48n2005.xml`. Mirrors FileIdToRelPath in ZenUriParser.cs.
 * Returns `null` if the file ID cannot be decomposed.
 */
export function xmlUrlForFileId(fileId, corpus) {
    if (!fileId) return null;
    const resolved = corpus || inferCorpus(fileId);
    if (resolved === Corpus.OpenZen) {
        const dotIdx = fileId.indexOf('.');
        if (dotIdx < 1 || dotIdx >= fileId.length - 1) return null;
        const publisher = fileId.substring(0, dotIdx);
        const slug = fileId.substring(dotIdx + 1);
        return `${publisher}/${slug}/${slug}.xml`;
    }
    if (resolved === Corpus.Cbeta) {
        const nIdx = fileId.indexOf('n');
        if (nIdx < 1) return null;
        const volume = fileId.substring(0, nIdx);
        const canon = volume.replace(/[0-9]/g, '');
        if (!canon) return null;
        return `${canon}/${volume}/${fileId}.xml`;
    }
    return null;
}

/** Joins a base URL with a relative TEI path. */
export function joinBase(base, relPath) {
    if (!base.endsWith('/')) base += '/';
    return base + relPath.replace(/^\/+/, '');
}

/** Source (Chinese) URL for a file ID. */
export function sourceXmlUrl(fileId, corpus) {
    const resolved = corpus || inferCorpus(fileId);
    if (resolved !== Corpus.OpenZen && resolved !== Corpus.Cbeta) return null;
    const rel = xmlUrlForFileId(fileId, resolved);
    if (!rel) return null;
    const base = resolved === Corpus.OpenZen ? OPEN_TEXT_REPO_BASE : TEXT_REPO_BASE;
    return joinBase(base, rel);
}

/** Authoritative translation URL for a file ID. */
export function authoritativeTranslationUrl(fileId, corpus) {
    const resolved = corpus || inferCorpus(fileId);
    if (resolved !== Corpus.OpenZen && resolved !== Corpus.Cbeta) return null;
    const rel = xmlUrlForFileId(fileId, resolved);
    if (!rel) return null;
    const base = resolved === Corpus.OpenZen ? OPEN_TRANSLATION_REPO_BASE : TRANSLATION_REPO_BASE;
    return joinBase(base, rel);
}

/** Community translation URL for a specific translator. */
export function communityTranslationUrl(fileId, translator, corpus) {
    if (!translator) return null;
    const resolved = corpus || inferCorpus(fileId);
    if (resolved !== Corpus.OpenZen && resolved !== Corpus.Cbeta) return null;
    const rel = xmlUrlForFileId(fileId, resolved);
    if (!rel) return null;
    const base = resolved === Corpus.OpenZen
        ? OPEN_COMMUNITY_TRANSLATIONS_BASE
        : COMMUNITY_TRANSLATIONS_BASE;
    return base + encodeURIComponent(translator) + '/' + rel;
}

/** Small delay helper. */
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Fetch text with a single retry on transient failure. Throws on HTTP error
 * status or network error. 404s are treated as non-retryable (they mean
 * "file genuinely missing", not "network blip").
 */
export async function fetchText(url) {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const response = await fetch(url, { cache: 'default' });
            if (response.ok) {
                return await response.text();
            }
            // Don't retry 404 — it's a real "not found".
            if (response.status === 404) {
                throw new Error(`HTTP 404 for ${url}`);
            }
            lastError = new Error(`HTTP ${response.status} for ${url}`);
        } catch (error) {
            lastError = error;
            if (String(error && error.message || '').includes('HTTP 404')) {
                throw error;
            }
        }
        if (attempt === 0) await delay(350);
    }
    throw lastError || new Error('fetchText failed for ' + url);
}

/** Fetch JSON with one retry on transient failure. */
export async function fetchJson(url) {
    const text = await fetchText(url);
    try {
        return JSON.parse(text);
    } catch (error) {
        throw new Error('Invalid JSON from ' + url + ': ' + error.message);
    }
}

/**
 * Fetch star counts for translations in a given corpus.
 * Lists `community/stars/` via GitHub API, fetches each `.jsonl` file via
 * raw.githubusercontent.com, and aggregates into a Map keyed by
 * `fileId:translator` with the count of distinct star entries as the value.
 * Result is cached per session (one fetch per corpus).
 */
const _starCountsCache = {};

export async function fetchStarCounts(corpus) {
    const key = corpus || 'cbeta';
    if (_starCountsCache[key]) return _starCountsCache[key];

    const counts = new Map();
    _starCountsCache[key] = counts; // cache immediately (even if empty) to avoid re-fetch

    try {
        const repo = key === 'open'
            ? 'Fabulu/OpenZenTranslations'
            : 'Fabulu/CbetaZenTranslations';
        const apiUrl = `https://api.github.com/repos/${repo}/contents/community/stars`;
        const res = await fetch(apiUrl, { cache: 'default' });
        if (!res.ok) return counts; // 404 = no stars directory yet

        const items = await res.json();
        const jsonlFiles = items.filter(i => i.name.endsWith('.jsonl') && i.type === 'file');

        const rawBase = `https://raw.githubusercontent.com/${repo}/main/community/stars/`;

        await Promise.all(jsonlFiles.map(async (file) => {
            try {
                const text = await fetchText(rawBase + file.name);
                for (const line of text.split('\n')) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    try {
                        const entry = JSON.parse(trimmed);
                        if (entry.fileId && entry.translator) {
                            const mapKey = entry.fileId + ':' + entry.translator;
                            counts.set(mapKey, (counts.get(mapKey) || 0) + 1);
                        }
                    } catch { /* skip malformed line */ }
                }
            } catch { /* skip unreadable file */ }
        }));
    } catch { /* API unavailable — degrade gracefully */ }

    return counts;
}

/**
 * Fetch the set of file IDs that have translations in the CBETA and OpenZen
 * translation repos. Uses the GitHub API tree endpoint (one call per repo,
 * cached for the session). Returns a Set<string> of fileIds.
 */
let _translatedPromise = null;
export function loadTranslatedFileIds() {
    if (_translatedPromise) return _translatedPromise;
    _translatedPromise = (async () => {
        const ids = new Set();
        const repos = [
            { url: 'https://api.github.com/repos/Fabulu/CbetaZenTranslations/git/trees/main?recursive=1', prefix: 'xml-p5t/' },
            { url: 'https://api.github.com/repos/Fabulu/OpenZenTranslations/git/trees/main?recursive=1', prefix: 'xml-open-t/' },
        ];
        for (const repo of repos) {
            try {
                const res = await fetch(repo.url);
                if (!res.ok) continue;
                const data = await res.json();
                if (!data.tree) continue;
                for (const entry of data.tree) {
                    if (entry.path.startsWith(repo.prefix) && entry.path.endsWith('.xml') && entry.type === 'blob') {
                        // Extract fileId: "xml-p5t/T/T48/T48n2005.xml" → "T48n2005"
                        const fname = entry.path.split('/').pop();
                        if (fname) ids.add(fname.replace(/\.xml$/i, ''));
                    }
                }
            } catch { /* API unavailable — filter won't work, degrade gracefully */ }
        }
        return ids;
    })();
    return _translatedPromise;
}
