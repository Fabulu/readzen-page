// lib/fnv.js
// FNV-1a 32-bit hash. Used to map CJK bigrams to one of 4096 shards in the
// SPA bigram inverted index (see SYNTHESIS.md section 5).
//
// Iterates UTF-16 code units (charCodeAt), matching the desktop port and
// keeping behavior deterministic across Node + browser. Returns an unsigned
// 32-bit integer via `>>> 0`.

/**
 * FNV-1a 32-bit hash of a string.
 * @param {string} str - Input string (iterated as UTF-16 code units).
 * @returns {number} Unsigned 32-bit integer hash.
 */
export function fnv1a32(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
}
