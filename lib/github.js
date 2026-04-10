// lib/github.js
// Raw-GitHub fetch helpers. All URLs point at public repos served with CORS,
// so the browser can request them directly with no auth.

export const TEXT_REPO_BASE =
    'https://raw.githubusercontent.com/Fabulu/CbetaZenTexts/main/xml-p5/';
export const TRANSLATION_REPO_BASE =
    'https://raw.githubusercontent.com/Fabulu/CbetaZenTranslations/main/xml-p5t/';
export const COMMUNITY_TRANSLATIONS_BASE =
    'https://raw.githubusercontent.com/Fabulu/CbetaZenTranslations/main/community/translations/';
export const DATA_REPO_BASE =
    'https://raw.githubusercontent.com/Fabulu/CbetaZenTranslations/main/';

/**
 * Converts a compact file ID like `T48n2005` into the canonical relative
 * TEI path `T/T48/T48n2005.xml`. Mirrors FileIdToRelPath in ZenUriParser.cs.
 * Returns `null` if the file ID cannot be decomposed.
 */
export function xmlUrlForFileId(fileId) {
    if (!fileId) return null;
    const nIdx = fileId.indexOf('n');
    if (nIdx < 1) return null;
    const volume = fileId.substring(0, nIdx);
    const canon = volume.replace(/[0-9]/g, '');
    if (!canon) return null;
    return `${canon}/${volume}/${fileId}.xml`;
}

/** Joins a base URL with a relative TEI path. */
export function joinBase(base, relPath) {
    if (!base.endsWith('/')) base += '/';
    return base + relPath.replace(/^\/+/, '');
}

/** Source (Chinese) URL for a file ID. */
export function sourceXmlUrl(fileId) {
    const rel = xmlUrlForFileId(fileId);
    return rel ? joinBase(TEXT_REPO_BASE, rel) : null;
}

/** Authoritative translation URL for a file ID. */
export function authoritativeTranslationUrl(fileId) {
    const rel = xmlUrlForFileId(fileId);
    return rel ? joinBase(TRANSLATION_REPO_BASE, rel) : null;
}

/** Community translation URL for a specific translator. */
export function communityTranslationUrl(fileId, translator) {
    if (!translator) return null;
    const rel = xmlUrlForFileId(fileId);
    if (!rel) return null;
    return COMMUNITY_TRANSLATIONS_BASE + encodeURIComponent(translator) + '/' + rel;
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
