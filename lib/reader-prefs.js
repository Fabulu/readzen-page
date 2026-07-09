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
