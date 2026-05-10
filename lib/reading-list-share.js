// lib/reading-list-share.js
// Account-free reading-list export. Two output formats:
//
//   1. URL share — encode the list as a UTF-8-safe base64 blob carried in
//      the route hash. Recipients land at `#/list?d=<encoded>` and see the
//      list rendered as a virtual collection.
//   2. JSON download — pretty-printed JSON written to a Blob and offered
//      to the user via `URL.createObjectURL`. Filename includes the date
//      so users can keep multiple snapshots.
//
// Pure functions — no DOM dependency for encode/decode/exportListAsBlob,
// which keeps them unit-testable under Node.

import { addToList } from './reading-lists.js';

const SCHEMA_VERSION = 1;

// Soft warning threshold. 50 entries × ~120 bytes JSON each ≈ 6 KB → 8 KB
// base64. Edge/Chrome tolerate ~2K of address bar before truncation, so
// callers should warn the user past this point.
export const URL_SAFE_MAX_ENTRIES = 50;

// Hard upper bound on the encoded `?d=` payload. A hostile URL with a
// multi-megabyte blob would otherwise force a base64 decode + JSON parse +
// big-array allocation on every visitor. 16 KB comfortably covers a list of
// ~120 entries — well past anything a real user would share.
const MAX_ENCODED_BYTES = 16 * 1024;

// Per-field cap. The decoded title/route/fileId are rendered directly into
// the DOM (after escapeHtml). A 1 MB title field is a perf hazard, not an
// XSS hazard. 500 chars covers any plausible bilingual title.
const MAX_FIELD_CHARS = 500;

/**
 * UTF-8-safe base64 encode. `btoa` only accepts Latin-1, so multi-byte
 * characters in titles (Chinese/Japanese/Korean) need the `unescape +
 * encodeURIComponent` dance first.
 *
 * Falls back to the Node Buffer when running in tests.
 */
function utf8ToBase64(s) {
    if (typeof btoa === 'function') {
        return btoa(unescape(encodeURIComponent(s)));
    }
    // Node fallback (used by tests).
    return Buffer.from(s, 'utf-8').toString('base64');
}

function base64ToUtf8(s) {
    if (typeof atob === 'function') {
        return decodeURIComponent(escape(atob(s)));
    }
    return Buffer.from(s, 'base64').toString('utf-8');
}

function clip(s) {
    if (typeof s !== 'string') return '';
    return s.length > MAX_FIELD_CHARS ? s.slice(0, MAX_FIELD_CHARS) : s;
}

/** Strip an entry down to the fields we share. Drops local-only timestamps. */
function sanitizeEntry(item) {
    if (!item || typeof item !== 'object') return null;
    if (typeof item.fileId !== 'string' || !item.fileId) return null;
    const fileId = clip(item.fileId);
    const title = clip(typeof item.title === 'string' ? item.title : '');
    const rawRoute = typeof item.route === 'string' && item.route ? item.route : fileId;
    return { fileId, title, route: clip(rawRoute) };
}

/**
 * Encode a reading-list array into a URL-safe base64 string.
 * Returns the encoded payload (no `#/list?d=` prefix — that's the caller's
 * job so this stays format-agnostic). Returns `''` if the list is empty
 * or every entry is malformed.
 */
export function encodeListToHash(list) {
    if (!Array.isArray(list)) return '';
    const entries = list.map(sanitizeEntry).filter(Boolean);
    if (entries.length === 0) return '';
    const payload = { v: SCHEMA_VERSION, list: entries };
    const json = JSON.stringify(payload);
    // Use URL-safe base64 (replace + / =) so the result drops cleanly into
    // a query parameter without further percent-encoding.
    return utf8ToBase64(json)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

/**
 * Decode a previously-encoded hash payload. Returns the list array on
 * success, or `null` if the input is malformed, fails base64 decoding,
 * fails JSON parsing, or fails shape validation.
 */
export function decodeListFromHash(encoded) {
    if (typeof encoded !== 'string' || !encoded) return null;
    // Reject oversized payloads up front. Without this a hostile share URL
    // could force an unbounded base64 decode + JSON parse on the recipient.
    if (encoded.length > MAX_ENCODED_BYTES) return null;
    // Restore standard base64 alphabet, repad to a multiple of 4.
    let b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4 !== 0) b64 += '=';

    let json;
    try { json = base64ToUtf8(b64); }
    catch { return null; }

    let parsed;
    try { parsed = JSON.parse(json); }
    catch { return null; }

    // Accept two shapes: bare array (legacy) or { v, list }.
    let raw = null;
    if (Array.isArray(parsed)) {
        raw = parsed;
    } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.list)) {
        raw = parsed.list;
    }
    if (!raw) return null;

    const cleaned = raw.map(sanitizeEntry).filter(Boolean);
    return cleaned.length === 0 ? null : cleaned;
}

/**
 * Builds a JSON Blob for download. Returns `{ blob, filename }`. The
 * filename includes an ISO date (no time/timezone noise) so users can
 * archive multiple snapshots without confusion.
 *
 * In Node test contexts where Blob is undefined the function falls back
 * to returning the raw text under the `blob` key — callers in the
 * browser always get a real Blob.
 */
export function exportListAsBlob(list) {
    const entries = (Array.isArray(list) ? list : []).map(sanitizeEntry).filter(Boolean);
    const payload = {
        version: SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        list: entries
    };
    const json = JSON.stringify(payload, null, 2);
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const filename = `readzen-list-${date}.json`;
    let blob;
    if (typeof Blob !== 'undefined') {
        blob = new Blob([json], { type: 'application/json' });
    } else {
        blob = json; // Node fallback for tests.
    }
    return { blob, filename, json };
}

/**
 * Triggers a download of the given list as JSON. Browser-only. No-op if
 * `document` or `URL.createObjectURL` is unavailable (e.g. SSR).
 */
export function downloadListAsJson(list) {
    if (typeof document === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) return;
    const { blob, filename } = exportListAsBlob(list);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        try { document.body.removeChild(a); } catch {}
        try { URL.revokeObjectURL(url); } catch {}
    }, 0);
}

/**
 * Builds the full shareable URL for a list. Mirrors `lib/share.js` so the
 * recipient can paste the URL into any browser and land on the SPA.
 */
export function buildShareUrl(list) {
    const encoded = encodeListToHash(list);
    if (!encoded) return '';
    const base = (typeof location !== 'undefined')
        ? (location.origin + location.pathname)
        : '';
    return `${base}#/list?d=${encoded}`;
}

/**
 * Copies the share URL to the clipboard. Returns the URL on success.
 * Falls back to the textarea + execCommand path used elsewhere in the
 * codebase for older browsers.
 */
export async function copyShareUrl(list) {
    const url = buildShareUrl(list);
    if (!url) return '';
    try {
        if (typeof navigator !== 'undefined' && navigator.clipboard) {
            await navigator.clipboard.writeText(url);
            return url;
        }
    } catch { /* fall through */ }
    if (typeof document !== 'undefined') {
        const ta = document.createElement('textarea');
        ta.value = url;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch {}
        ta.remove();
    }
    return url;
}

/**
 * Merges a shared list into the user's local "My Reading List" via the
 * existing addToList API. Returns the count of entries actually added
 * (existing fileIds are deduplicated by addToList).
 */
export function mergeIntoLocalList(list, listName = 'My Reading List') {
    const entries = (Array.isArray(list) ? list : []).map(sanitizeEntry).filter(Boolean);
    for (const e of entries) {
        addToList(listName, e.fileId, e.title, e.route);
    }
    return entries.length;
}
