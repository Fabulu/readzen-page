// lib/search-history.js
// Recent-search memory (local only). Recorded on submit and on result click —
// not per keystroke, so search-as-you-type prefixes don't pollute the list.

const KEY = 'zl:recent-searches';
const MAX = 10;

/** @returns {string[]} most-recent-first, at most MAX entries */
export function getRecentSearches() {
    try {
        const raw = localStorage.getItem(KEY);
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr.filter((s) => typeof s === 'string' && s.trim()) : [];
    } catch {
        return [];
    }
}

/** Records a query (trimmed, deduped, capped). Empty/whitespace ignored. */
export function addRecentSearch(q) {
    const trimmed = (q == null ? '' : String(q)).trim();
    if (!trimmed) return;
    try {
        const list = getRecentSearches().filter((s) => s !== trimmed);
        list.unshift(trimmed);
        localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
    } catch {
        // storage unavailable (private mode etc.) — feature degrades silently
    }
}

export function clearRecentSearches() {
    try { localStorage.removeItem(KEY); } catch {}
}
