// lib/reading-lists.js
// LocalStorage-backed reading lists (bookmarks) and reading progress tracker.
// Zero network fetches — everything stays on the client.

const LISTS_KEY = 'readzen-reading-lists';
const LAST_READ_KEY = 'readzen-last-read';

// --- Reading lists ---

function _load() {
    try {
        const raw = localStorage.getItem(LISTS_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
}

function _save(lists) {
    try { localStorage.setItem(LISTS_KEY, JSON.stringify(lists)); } catch {}
}

/** Add a text to a named list. Stores the full route for deep linking. */
export function addToList(listName, fileId, title, route) {
    const lists = _load();
    if (!lists[listName]) lists[listName] = [];
    // Replace existing entry for same fileId (route may have changed)
    lists[listName] = lists[listName].filter((i) => i.fileId !== fileId);
    lists[listName].push({ fileId, title, route: route || fileId, addedAt: Date.now() });
    _save(lists);
}

/** Remove a text from a named list. */
export function removeFromList(listName, fileId) {
    const lists = _load();
    if (!lists[listName]) return;
    lists[listName] = lists[listName].filter((i) => i.fileId !== fileId);
    if (lists[listName].length === 0) delete lists[listName];
    _save(lists);
}

/** Returns all lists as { listName: [{ fileId, title, addedAt }] }. */
export function getLists() {
    return _load();
}

/** Check if a fileId is in a specific list. */
export function isInList(listName, fileId) {
    const lists = _load();
    if (!lists[listName]) return false;
    return lists[listName].some((i) => i.fileId === fileId);
}

// --- Reading progress ---

/** When true, setLastRead is suppressed (user dismissed the banner this session). */
let _lastReadSuppressed = false;

/** Record the user's last-read position with the full route. */
export function setLastRead(fileId, title, scrollPercent, route) {
    if (_lastReadSuppressed) return;
    try {
        localStorage.setItem(LAST_READ_KEY, JSON.stringify({
            fileId, title, scrollPercent, route: route || fileId, timestamp: Date.now()
        }));
    } catch {}
}

/** Clear last-read position and suppress further tracking this session. */
export function clearLastRead() {
    _lastReadSuppressed = true;
    try { localStorage.removeItem(LAST_READ_KEY); } catch {}
}

/** Get last-read position, or null. */
export function getLastRead() {
    try {
        const raw = localStorage.getItem(LAST_READ_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch { return null; }
}
