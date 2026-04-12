// lib/route.js
// Single parser for ALL Read Zen link types.
// Mirrors the grammar of Services/ZenUriParser.cs in the ReadZen desktop app.
//
// Route kinds:
//   passage     — file-id-first, e.g. #/T48n2005/0292a26-0292a29/en/Fabulu
//   compare     — #/compare/{fileId}/{pane}/{sourceA}/{sourceB}?from=&to=&highlight=
//   dictionary  — #/dict/{term}
//   termbase    — #/term/{entry}/{user?}
//   master      — #/master/{name}/{user?}
//   scholar     — #/scholar/{collectionId?}/{passageId?}/{user?}
//   tags        — #/tags/{fileId}/{user?}/{tagId?}
//   search      — #/search?q=...&corpus=...&...
//
// Also accepts a legacy `#/passage/...` prefix for backward compatibility.

import { Corpus, OPEN_WORK_ID_PATTERN, inferCorpus } from './corpus.js';

export const WORK_ID_PATTERN = /^[A-Za-z]{1,3}\d{1,4}n[A-Za-z]?\d{1,5}[A-Za-z]?$/;
export const RANGE_PATTERN = /^([0-9]{4}[abc]\d{2})-([0-9]{4}[abc]\d{2})$/;
export const SINGLE_LB_PATTERN = /^[0-9]{4}[abc]\d{2}$/;
// Re-export the corpus enum + the OpenZen pattern so callers that already
// import from lib/route.js don't have to add a second import line. Direct
// imports from lib/corpus.js still work.
export { Corpus, OPEN_WORK_ID_PATTERN };

const SIDE_ALIASES = new Set(['en', 'tran', 'translated', 'translation']);

/**
 * Reads the active route from window.location.
 * Prefers the hash (SPA form), falls back to path + search (404 redirect form).
 * Returns the raw string with no leading slash.
 */
export function getRawRoute() {
    let raw = window.location.hash.length > 1
        ? window.location.hash.substring(1)
        : (window.location.pathname + window.location.search);
    if (!raw) return '';
    if (raw[0] === '/') raw = raw.substring(1);
    return raw;
}

/** Splits a raw route into its path and query halves. */
function splitRoute(rawRoute) {
    const qIdx = rawRoute.indexOf('?');
    return {
        pathPart: qIdx >= 0 ? rawRoute.substring(0, qIdx) : rawRoute,
        queryPart: qIdx >= 0 ? rawRoute.substring(qIdx + 1) : ''
    };
}

/** Parses a `key=value&key=value` style query string. Empty string returns `{}`. */
function parseQuery(queryPart) {
    const out = {};
    if (!queryPart) return out;
    const pairs = queryPart.split('&');
    for (const pair of pairs) {
        if (!pair) continue;
        const eq = pair.indexOf('=');
        const key = eq >= 0 ? pair.substring(0, eq) : pair;
        const value = eq >= 0 ? pair.substring(eq + 1) : '';
        try {
            out[decodeURIComponent(key)] = decodeURIComponent(value.replace(/\+/g, ' '));
        } catch {
            out[key] = value;
        }
    }
    return out;
}

/** A segment that looks like `0292a26` or `0292a26-0292a29`. */
function isLbSegment(segment) {
    if (!segment) return false;
    const first = segment.split('-')[0];
    return SINGLE_LB_PATTERN.test(first);
}

/** A segment that denotes the translated pane of a passage. */
function isSideSegment(segment) {
    return segment && SIDE_ALIASES.has(segment.toLowerCase());
}

/**
 * Parses a passage route (file-id first).
 *   #/T48n2005/0292a26-0292a29/en/Fabulu
 *   #/T48n2005/0292b29
 *   #/T48n2005
 *
 * Returns the shared `{ kind: 'passage', ... }` shape, or `null` on mismatch.
 */
function parsePassage(pathParts, queryPart, rawRoute) {
    const first = pathParts[0];
    const isOpenZen = OPEN_WORK_ID_PATTERN.test(first);
    const isCbeta = WORK_ID_PATTERN.test(first);
    if (!isOpenZen && !isCbeta) return null;

    // Decompose the file ID into canon / volume / suffix.
    const inner = isCbeta
        ? /^([A-Za-z]{1,3})(\d{1,4})n([A-Za-z]?\d{1,5}[A-Za-z]?)$/.exec(first)
        : null;
    const canon = inner ? inner[1] : '';
    const volume = inner ? inner[2] : '';
    const workSuffix = inner ? inner[3] : '';
    const corpus = isOpenZen ? Corpus.OpenZen : Corpus.Cbeta;

    let startLine = '';
    let endLine = '';
    let hasExplicitRange = false;
    let side = 'zh';
    let translator = '';

    for (let i = 1; i < pathParts.length; i += 1) {
        const seg = pathParts[i];
        if (isLbSegment(seg)) {
            const rangeMatch = seg.match(RANGE_PATTERN);
            if (rangeMatch) {
                startLine = rangeMatch[1];
                endLine = rangeMatch[2];
            } else {
                startLine = seg;
                endLine = seg;
            }
            hasExplicitRange = true;
        } else if (isSideSegment(seg)) {
            side = 'en';
        } else {
            // Last unknown segment is the translator/user name.
            if (i === pathParts.length - 1) {
                try { translator = decodeURIComponent(seg); }
                catch { translator = seg; }
            }
        }
    }

    const query = parseQuery(queryPart);

    return {
        kind: 'passage',
        workId: first,
        canon,
        volume,
        workSuffix,
        corpus,
        startLine,
        endLine,
        hasExplicitRange,
        mode: side,           // 'zh' | 'en'
        translator,
        highlight: query.highlight || '',
        leftContext: query.lctx || '',
        rightContext: query.rctx || '',
        block: query.block ? parseInt(query.block, 10) : null,
        rawRoute
    };
}

/**
 * Parses any route string into a normalized object.
 * Returns `null` for an empty string, or `{ kind: 'unknown', rawRoute }` if no
 * kind could be identified.
 */
export function parseRoute(rawRoute) {
    if (!rawRoute) return null;

    const { pathPart, queryPart } = splitRoute(rawRoute);
    let parts = pathPart.split('/').filter(Boolean);
    if (parts.length === 0) return null;

    // Accept legacy `#/passage/...` prefix — strip and retry.
    if (parts[0].toLowerCase() === 'passage' && parts.length > 1) {
        parts = parts.slice(1);
    }

    // Scholar routes preserve empty path segments so the legacy form
    // `#/scholar/{collectionId}//{user}` (empty passageId slot) still
    // parses correctly. `filter(Boolean)` above would collapse the empty
    // middle segment and misread the user as the passageId.
    let rawParts = null;
    if (parts[0] && parts[0].toLowerCase() === 'scholar') {
        // Re-split without filtering to keep empty middle slots intact.
        const trimmed = pathPart.replace(/^\/+/, '').replace(/\/+$/, '');
        rawParts = trimmed.split('/');
    }

    const first = parts[0];
    const query = parseQuery(queryPart);

    // Explicit keyword-prefixed kinds.
    switch (first.toLowerCase()) {
        case 'dict':
            return {
                kind: 'dictionary',
                term: parts[1] ? safeDecode(parts[1]) : '',
                rawRoute
            };

        case 'term':
            return {
                kind: 'termbase',
                entry: parts[1] ? safeDecode(parts[1]) : '',
                user: parts[2] ? safeDecode(parts[2]) : '',
                rawRoute
            };

        case 'master':
            return {
                kind: 'master',
                name: parts[1] ? safeDecode(parts[1]) : '',
                user: parts[2] ? safeDecode(parts[2]) : '',
                rawRoute
            };

        case 'scholar': {
            // Use the unfiltered segments so empty middle slots (legacy
            // `//` passageId placeholder) are preserved. Also accept
            // `?user=...` as a fallback so the canonical form
            // `#/scholar/{collectionId}[/{passageId}]?user=...` works.
            const segs = rawParts || parts;
            return {
                kind: 'scholar',
                collectionId: segs[1] ? safeDecode(segs[1]) : '',
                passageId: segs[2] ? safeDecode(segs[2]) : '',
                user: (segs[3] ? safeDecode(segs[3]) : '') || (query.user || ''),
                rawRoute
            };
        }

        case 'tags':
            return {
                kind: 'tags',
                fileId: parts[1] || '',
                corpus: inferCorpus(parts[1]),
                user: parts[2] ? safeDecode(parts[2]) : (query.user || ''),
                tagId: parts[3] ? safeDecode(parts[3]) : (query.tagId || query.tag || ''),
                rawRoute
            };

        case 'search':
            return {
                kind: 'search',
                q: query.q || '',
                corpus: query.corpus || '',
                orig: query.orig || '',
                tran: query.tran || '',
                zenOnly: query.zen || '',
                statusIndex: query.status || query.statusIndex || '',
                tagId: query.tag || query.tagId || '',
                translationSource: query.src || query.translationSource || '',
                contextWidth: query.ctxw || query.contextWidth || '',
                rawRoute
            };

        case 'compare': {
            // zen://compare/{fileId}/{pane}/{sourceA}/{sourceB}?from=&to=&highlight=
            if (parts.length < 5) {
                return { kind: 'compare', rawRoute, incomplete: true };
            }
            return {
                kind: 'compare',
                fileId: parts[1],
                corpus: inferCorpus(parts[1]),
                pane: parts[2] ? parts[2].toLowerCase() : 'orig',
                sourceA: safeDecode(parts[3]),
                sourceB: safeDecode(parts[4]),
                from: query.from || '',
                to: query.to || '',
                highlight: query.highlight || '',
                rawRoute
            };
        }
    }

    // Fall through: passage (file-id-first) form.
    const passage = parsePassage(parts, queryPart, rawRoute);
    if (passage) return passage;

    return { kind: 'unknown', rawRoute };
}

function safeDecode(s) {
    try { return decodeURIComponent(s); }
    catch { return s; }
}

/** Builds the canonical `zen://` URI for a parsed route. */
export function buildZenUri(route) {
    if (!route || !route.rawRoute) return null;
    return 'zen://' + route.rawRoute.replace(/^\/+/, '');
}

/** Human-facing label used in the header chip. */
export function describeRoute(route) {
    if (!route) return '';
    switch (route.kind) {
        case 'passage':
            return route.hasExplicitRange
                ? `${route.workId} · ${route.startLine}${route.endLine && route.endLine !== route.startLine ? '-' + route.endLine : ''}`
                : route.workId;
        case 'dictionary': return `Dictionary · ${route.term || ''}`;
        case 'termbase':   return `Termbase · ${route.entry || ''}`;
        case 'master':     return `Zen Master · ${route.name || ''}`;
        case 'scholar':    return `Scholar · ${route.collectionId || ''}`;
        case 'tags':       return `Tags · ${route.fileId || ''}`;
        case 'search':     return `Search · ${route.q || ''}`;
        case 'compare':    return `Compare · ${route.fileId || ''}`;
        default:           return route.rawRoute || '';
    }
}
