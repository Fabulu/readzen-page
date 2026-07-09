// lib/reader-prefs.js
// Reader preferences (local only). Currently: lines-per-page for the passage
// reader. Values are whitelisted — anything unknown falls back to the default,
// so stale/corrupt storage can never wedge the reader.

const PAGE_SIZE_KEY = 'zl:page-size';

/** Allowed page sizes. 'all' renders the whole text in one page. */
export const PAGE_SIZE_OPTIONS = [300, 1000, 3000, 10000, 'all'];
export const DEFAULT_PAGE_SIZE = 300;

/** @returns {number|'all'} */
export function getPageSize() {
    try {
        const raw = localStorage.getItem(PAGE_SIZE_KEY);
        if (raw === 'all') return 'all';
        const n = parseInt(raw, 10);
        return PAGE_SIZE_OPTIONS.includes(n) ? n : DEFAULT_PAGE_SIZE;
    } catch {
        return DEFAULT_PAGE_SIZE;
    }
}

/** Persists a whitelisted size; unknown values are ignored. */
export function setPageSize(v) {
    const val = v === 'all' ? 'all' : parseInt(v, 10);
    if (!PAGE_SIZE_OPTIONS.includes(val)) return;
    try { localStorage.setItem(PAGE_SIZE_KEY, String(val)); } catch {}
}

// -- Bilingual alignment mode --------------------------------------------
// 'flow'        two independently scrolling panes, viewport-synced by line id
//               (DEFAULT - each language reads at its natural density)
// 'blocks'      page-flow panes aligned at segment-map block boundaries
//               (falls back to per-line alignment for unmapped texts)
// 'lines'       strict per-line row locking (the original layout)
// 'interleaved' single column: each Chinese line followed by its English

const BILINGUAL_KEY = 'zl:bilingual-mode';
// merged-flow    : merged paragraphs per segment, independent synced panes
// merged-stacked : merged paragraphs, single column, ZH then EN per segment
export const BILINGUAL_MODES = ['flow', 'blocks', 'lines', 'interleaved', 'merged-flow', 'merged-stacked'];
export const DEFAULT_BILINGUAL_MODE = 'merged-flow'; // user ruling 2026-07-09; falls back to 'flow' for unmapped texts

export function getBilingualMode() {
    try {
        const raw = localStorage.getItem(BILINGUAL_KEY);
        return BILINGUAL_MODES.includes(raw) ? raw : DEFAULT_BILINGUAL_MODE;
    } catch {
        return DEFAULT_BILINGUAL_MODE;
    }
}

export function setBilingualMode(v) {
    if (!BILINGUAL_MODES.includes(v)) return;
    try { localStorage.setItem(BILINGUAL_KEY, v); } catch {}
}
