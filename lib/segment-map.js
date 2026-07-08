// lib/segment-map.js
// Fetches and parses semantic segment-map JSONL files for CBETA texts.
// Segment maps live in the CbetaZenTranslations repo at:
//   segments/<canon>/<volume>/<workId>.segments.jsonl
//
// Returns a Map<lbId, {type, subType?, speaker?, labelZh?, confidence}>
// keyed by individual lb-ID (expanded from lb_range arrays). Texts without
// segment maps return an empty Map — rendering falls through to default styling.

import { DATA_REPO_BASE } from './github.js';

/** In-memory cache keyed by workId. */
const _cache = new Map();

/**
 * Derive the segments URL from a CBETA work ID like "T48n2005".
 * Convention: segments/<canon>/<volume>/<workId>.segments.jsonl
 * Canon = leading letters (T, J, X, B, etc.)
 * Volume = canon + leading digits before 'n' (T48, J24, B07, etc.)
 */
function segmentsUrl(workId) {
    if (!workId || typeof workId !== 'string') return null;
    // Extract canon prefix (letters) and volume (letters + digits before 'n')
    const m = workId.match(/^([A-Za-z]+)(\d+)n/);
    if (!m) return null;
    const canon = m[1];
    const volume = canon + m[2];
    return `${DATA_REPO_BASE}segments/${canon}/${volume}/${workId}.segments.jsonl`;
}

/**
 * Fetch and parse a segment map for the given work ID.
 * Returns a Map<lbId, SegmentInfo> where SegmentInfo is
 * { type, subType, speaker, labelZh, confidence, unitId }.
 * Returns an empty Map on 404, network error, or parse failure.
 *
 * @param {string} workId  e.g. "T48n2005"
 * @returns {Promise<Map<string, object>>}
 */
export async function loadSegmentMap(workId) {
    if (!workId) return new Map();

    // Cache hit
    if (_cache.has(workId)) return _cache.get(workId);

    const url = segmentsUrl(workId);
    if (!url) return new Map();

    const map = new Map();
    try {
        const resp = await fetch(url);
        if (!resp.ok) {
            _cache.set(workId, map);
            return map;
        }
        const text = await resp.text();
        const lines = text.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            let entry;
            try { entry = JSON.parse(trimmed); }
            catch { continue; }

            const info = {
                unitId: entry.unit_id || '',
                type: entry.type || 'unknown',
                subType: entry.sub_type || null,
                speaker: entry.speaker || null,
                labelZh: entry.label_zh || null,
                confidence: entry.confidence ?? 1.0
            };

            // Expand lb_range so each lb-ID maps to this segment info
            const range = entry.lb_range;
            if (Array.isArray(range)) {
                for (const lbId of range) {
                    if (lbId && typeof lbId === 'string') {
                        map.set(lbId, info);
                    }
                }
            }
        }
    } catch {
        // Network error, CORS, etc. — graceful empty map
    }

    _cache.set(workId, map);
    return map;
}

/** Clear the in-memory cache (useful for testing). */
export function clearSegmentCache() {
    _cache.clear();
}
