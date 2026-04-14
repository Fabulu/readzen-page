// lib/corpus.js
// Corpus identification helpers shared by lib/route.js, lib/github.js,
// and lib/titles.js. Mirrors Services/ZenUriParser.cs in the desktop app.

export const Corpus = Object.freeze({
    Cbeta: 'cbeta',
    OpenZen: 'openzen',
    Unknown: 'unknown'
});

export const OPEN_ZEN_PUBLISHERS = Object.freeze(['ws', 'pd', 'ce', 'mit']);
export const OPEN_ZEN_PUBLISHER_GROUP = '(?:ws|pd|ce|mit)';

export const OPEN_WORK_ID_PATTERN =
    new RegExp('^' + OPEN_ZEN_PUBLISHER_GROUP + '\\.[A-Za-z0-9][A-Za-z0-9-]*$', 'i');

const CBETA_WORK_ID_PATTERN = /^[A-Za-z]{1,3}\d{1,4}n[A-Za-z]?\d{1,5}[A-Za-z]?$/;

/**
 * Returns true if the given file ID is in OpenZen format.
 * The regex anchors the publisher prefix to the OPEN_ZEN_PUBLISHERS set
 * and requires a non-empty slug starting with [A-Za-z0-9], so a successful
 * test guarantees both pieces are valid — no further structural checks
 * needed. Mirrors Services/ZenUriParser.cs IsOpenZenFileId by behaviour,
 * not line-for-line shape.
 * @param {string} fileId
 * @returns {boolean}
 */
export function isOpenZenFileId(fileId) {
    if (!fileId) return false;
    return OPEN_WORK_ID_PATTERN.test(fileId);
}

/**
 * Infers the corpus from a compact file ID.
 * @param {string} fileId
 * @returns {'cbeta'|'openzen'|'unknown'}
 */
export function inferCorpus(fileId) {
    if (!fileId) return Corpus.Unknown;
    if (isOpenZenFileId(fileId)) return Corpus.OpenZen;
    if (CBETA_WORK_ID_PATTERN.test(fileId)) return Corpus.Cbeta;
    return Corpus.Unknown;
}

/**
 * Infers the corpus from a relative path.
 * @param {string} relPath
 * @returns {'cbeta'|'openzen'|'unknown'}
 */
export function inferCorpusForRelPath(relPath) {
    if (!relPath || typeof relPath !== 'string') return Corpus.Unknown;
    const normalized = relPath.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    if (parts.length === 0) return Corpus.Unknown;
    if (OPEN_ZEN_PUBLISHERS.includes(parts[0].toLowerCase())) return Corpus.OpenZen;
    const filename = parts[parts.length - 1];
    const dotIdx = filename.lastIndexOf('.');
    const fileId = dotIdx > 0 ? filename.substring(0, dotIdx) : filename;
    if (CBETA_WORK_ID_PATTERN.test(fileId)) return Corpus.Cbeta;
    return Corpus.Unknown;
}
