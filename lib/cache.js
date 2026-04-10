// lib/cache.js
// Two-layer cache: in-memory Map (authoritative, LRU) backed by sessionStorage.
// sessionStorage is wiped when the tab closes, which is fine for a preview
// page — we don't want stale content to survive across sessions.
//
// Capped at ~4 MB total across both layers.

const MAX_BYTES = 4 * 1024 * 1024;
const STORAGE_PREFIX = 'rzc:';   // "read zen cache"

// Map preserves insertion order, which we abuse for LRU eviction:
// on `get`, we delete + re-set the key to bump it to the tail.
const mem = new Map();
let memBytes = 0;

/** Rough byte count for a JS value. */
function sizeOf(value) {
    try {
        if (typeof value === 'string') return value.length * 2;
        return JSON.stringify(value).length * 2;
    } catch {
        return 0;
    }
}

/** Drop the least-recently-used entry from the memory cache. */
function evictOne() {
    const firstKey = mem.keys().next().value;
    if (firstKey === undefined) return false;
    const entry = mem.get(firstKey);
    mem.delete(firstKey);
    if (entry) memBytes -= entry.bytes || 0;
    try { sessionStorage.removeItem(STORAGE_PREFIX + firstKey); } catch {}
    return true;
}

/** Evict until we have room for `incoming` bytes. */
function ensureCapacity(incoming) {
    while (memBytes + incoming > MAX_BYTES && mem.size > 0) {
        if (!evictOne()) break;
    }
}

/**
 * Look up a cached value by key. Returns `undefined` on miss or after TTL
 * expiry. Bumps the entry's LRU position on hit.
 */
export function get(key) {
    // Memory hit.
    if (mem.has(key)) {
        const entry = mem.get(key);
        if (entry.expiresAt && Date.now() > entry.expiresAt) {
            mem.delete(key);
            memBytes -= entry.bytes || 0;
            try { sessionStorage.removeItem(STORAGE_PREFIX + key); } catch {}
            return undefined;
        }
        // LRU bump.
        mem.delete(key);
        mem.set(key, entry);
        return entry.value;
    }

    // Session storage hit.
    try {
        const raw = sessionStorage.getItem(STORAGE_PREFIX + key);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed.expiresAt && Date.now() > parsed.expiresAt) {
                sessionStorage.removeItem(STORAGE_PREFIX + key);
                return undefined;
            }
            // Promote into memory.
            const bytes = sizeOf(parsed.value);
            ensureCapacity(bytes);
            mem.set(key, { value: parsed.value, expiresAt: parsed.expiresAt, bytes });
            memBytes += bytes;
            return parsed.value;
        }
    } catch {
        // sessionStorage unavailable or malformed entry — ignore.
    }

    return undefined;
}

/**
 * Store a value under `key`. `ttlMs` is optional (no TTL = lives until eviction
 * or session end). Values beyond the per-entry budget are stored in memory
 * only to avoid blowing out sessionStorage.
 */
export function set(key, value, ttlMs) {
    const bytes = sizeOf(value);
    const expiresAt = ttlMs ? Date.now() + ttlMs : 0;

    // Over-large entries can still go in memory (they'll be evicted soon
    // enough), but we skip sessionStorage to avoid a QuotaExceeded throw.
    ensureCapacity(bytes);
    if (mem.has(key)) {
        const old = mem.get(key);
        memBytes -= old.bytes || 0;
        mem.delete(key);
    }
    mem.set(key, { value, expiresAt, bytes });
    memBytes += bytes;

    if (bytes < 1 * 1024 * 1024) {
        try {
            sessionStorage.setItem(
                STORAGE_PREFIX + key,
                JSON.stringify({ value, expiresAt })
            );
        } catch {
            // Quota exceeded or JSON issue — memory layer still holds the value.
        }
    }
}

/** Remove a specific key from both layers. */
export function remove(key) {
    if (mem.has(key)) {
        const entry = mem.get(key);
        memBytes -= entry.bytes || 0;
        mem.delete(key);
    }
    try { sessionStorage.removeItem(STORAGE_PREFIX + key); } catch {}
}

/** Drop everything. Useful in tests / dev tools. */
export function clear() {
    mem.clear();
    memBytes = 0;
    try {
        const keys = [];
        for (let i = 0; i < sessionStorage.length; i += 1) {
            const k = sessionStorage.key(i);
            if (k && k.startsWith(STORAGE_PREFIX)) keys.push(k);
        }
        keys.forEach((k) => sessionStorage.removeItem(k));
    } catch {}
}
