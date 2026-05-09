// lib/build/extract-text.js
// Node-only port of the desktop's MakeSearchableTextFromXml_Fast
// (Services/SearchIndexService.cs:1095) used at SPA build time to extract
// searchable plain text and lb/pb anchor offsets from TEI XML.
//
// Five bug fixes vs the previous SPA extractor (build/build-pagefind-index.js):
//   1. Skip whole <app>...</app> blocks (depth-tracked), not just <rdg>.
//   2. Self-close tags (tagSlice.endsWith('/')) skip the depth increment.
//   3. Optional entity decode pass when an ampersand was seen.
//   4. Capture lb/pb anchors with offsets pointing at the first char of the
//      new line in the emitted text.
//   5. Hot-path tag-name parse done once at '>' on the slice (not on a
//      growing buffer), and 'app' / 'rdg' detection uses strict equality
//      (not /^rdg[\s>\/]/, which would also match <rdgGroup>).
//
// Pure functions; no fs / I/O. Module is Node-only by convention (build-time).

const ENTITY_RE = /&(?:#x([0-9a-fA-F]+)|#(\d+)|(amp|lt|gt|quot|apos));/g;

/**
 * Extract searchable text from a TEI XML string.
 *
 * @param {string} xml - Full TEI document as a string.
 * @param {object} [opts]
 * @param {boolean} [opts.decodeEntities=true] - When false, do not decode
 *   numeric / named entities (still respects sawAmp short-circuit).
 * @param {boolean} [opts.captureLb=true] - When false, lb/pb anchors are not
 *   collected and lbAnchorMap will be empty.
 * @returns {{text: string, lbAnchorMap: Array<{off:number, kind:'lb'|'pb', lbId:string|null, n:string|null}>}}
 */
export function extractText(xml, opts) {
    const decodeEntities = opts == null || opts.decodeEntities !== false;
    const captureLb = opts == null || opts.captureLb !== false;

    const empty = { text: '', lbAnchorMap: [] };
    if (!xml) return empty;

    // Locate <body ...> ... </body> case-insensitively without lowercasing
    // the whole document (mirrors the C# StringComparison.OrdinalIgnoreCase
    // approach using IndexOf).
    const iBody = indexOfCi(xml, '<body', 0);
    if (iBody < 0) return empty;
    const iStart = xml.indexOf('>', iBody);
    if (iStart < 0) return empty;
    const iEnd = indexOfCi(xml, '</body>', iStart + 1);
    if (iEnd < 0) return empty;

    const result = []; // pushed chars; joined once at end.
    const lbAnchorMap = [];

    let inTag = false;
    let tagStart = -1;       // index into xml of first char after '<'
    let appSkipDepth = 0;
    let prevSpace = true;    // trim leading whitespace
    let sawAmp = false;

    for (let i = iStart + 1; i < iEnd; i++) {
        const ch = xml.charCodeAt(i);

        if (inTag) {
            if (ch === 0x3E /* '>' */) {
                // Examine the tag content slice [tagStart, i).
                if (tagStart >= 0 && i > tagStart) {
                    const tagSlice = xml.substring(tagStart, i);
                    const isSelfClose = tagSlice.charCodeAt(tagSlice.length - 1) === 0x2F; // '/'
                    const isClose = tagSlice.charCodeAt(0) === 0x2F;             // '/'
                    const nameStart = isClose ? 1 : 0;
                    const name = parseTagName(tagSlice, nameStart);
                    if (name === 'app') {
                        if (isClose) {
                            if (appSkipDepth > 0) appSkipDepth--;
                        } else if (!isSelfClose) {
                            appSkipDepth++;
                        }
                        // Self-close <app/> is a no-op (rare; unbalanced anyway).
                    } else if (captureLb && appSkipDepth === 0 &&
                               (name === 'lb' || name === 'pb')) {
                        // Record lb / pb anchor. result.length at this moment
                        // points at the first char of the new line because the
                        // pre-tag space (if any) was emitted at '<' time, and
                        // no further chars have been pushed yet.
                        if (isSelfClose || !isClose) {
                            lbAnchorMap.push({
                                off: result.length,
                                kind: name === 'lb' ? 'lb' : 'pb',
                                lbId: attr(tagSlice, 'xml:id'),
                                n: attr(tagSlice, 'n'),
                            });
                        }
                    }
                }
                inTag = false;
                tagStart = -1;
            }
            continue;
        }

        if (ch === 0x3C /* '<' */) {
            inTag = true;
            tagStart = i + 1;
            if (!prevSpace && appSkipDepth === 0) {
                result.push(' ');
                prevSpace = true;
            }
            continue;
        }

        if (appSkipDepth > 0) continue;

        if (ch === 0x0D) continue;

        if (ch === 0x0A || ch === 0x09 || ch === 0x20 || ch === 0x0C || ch === 0x0B) {
            if (!prevSpace) {
                result.push(' ');
                prevSpace = true;
            }
            continue;
        }

        if (ch === 0x26) sawAmp = true;

        result.push(xml[i]);
        prevSpace = false;
    }

    // Trim trailing space.
    if (result.length > 0 && result[result.length - 1] === ' ') {
        result.pop();
    }

    let text = result.join('');

    if (sawAmp && decodeEntities) {
        text = decodeXmlEntities(text);
    }

    return { text, lbAnchorMap };
}

// =====================================================================
// Helpers
// =====================================================================

/**
 * Parse the tag name out of a tag-content slice (the substring between
 * '<' and '>'), starting at nameStart. Lowercased. Stops at whitespace,
 * '/', or end-of-slice. Returns '' for malformed slices.
 */
function parseTagName(tagSlice, nameStart) {
    const len = tagSlice.length;
    let end = nameStart;
    while (end < len) {
        const c = tagSlice.charCodeAt(end);
        // Stop at whitespace, '/', or '>' (already stripped, but defensive).
        if (c === 0x20 || c === 0x09 || c === 0x0A || c === 0x0D ||
            c === 0x2F /* '/' */ || c === 0x3E /* '>' */) {
            break;
        }
        end++;
    }
    if (end <= nameStart) return '';
    // Lowercase only the slice — not the whole tagSlice.
    return tagSlice.substring(nameStart, end).toLowerCase();
}

/**
 * Extract the value of attribute `name` from a tag-content slice. Returns
 * null if not present. Tolerant to single- or double-quoted values; does
 * not decode entities (caller can if needed). Case-insensitive on name.
 */
function attr(tagSlice, name) {
    const lower = tagSlice.toLowerCase();
    const target = name.toLowerCase();
    let from = 0;
    while (from < lower.length) {
        const idx = lower.indexOf(target, from);
        if (idx < 0) return null;
        // Must be preceded by whitespace or be at the very start of an
        // attribute region (after the tag name). We require a whitespace
        // boundary before the name to avoid matching substrings like
        // 'xml:id' when looking for 'id'.
        if (idx > 0) {
            const prev = lower.charCodeAt(idx - 1);
            const isBoundary = prev === 0x20 || prev === 0x09 ||
                prev === 0x0A || prev === 0x0D;
            if (!isBoundary) {
                from = idx + 1;
                continue;
            }
        } else {
            // idx === 0 means the slice starts with the attr name, which
            // would imply no tag name at all -- treat as no match.
            from = 1;
            continue;
        }
        // Look for '=' allowing whitespace on either side.
        let p = idx + target.length;
        while (p < lower.length) {
            const c = lower.charCodeAt(p);
            if (c === 0x20 || c === 0x09 || c === 0x0A || c === 0x0D) { p++; continue; }
            break;
        }
        if (p >= lower.length || lower.charCodeAt(p) !== 0x3D /* '=' */) {
            from = idx + 1;
            continue;
        }
        p++;
        while (p < lower.length) {
            const c = lower.charCodeAt(p);
            if (c === 0x20 || c === 0x09 || c === 0x0A || c === 0x0D) { p++; continue; }
            break;
        }
        if (p >= lower.length) return null;
        const q = lower.charCodeAt(p);
        if (q !== 0x22 /* '"' */ && q !== 0x27 /* "'" */) {
            from = idx + 1;
            continue;
        }
        const endQuote = tagSlice.indexOf(String.fromCharCode(q), p + 1);
        if (endQuote < 0) return null;
        return tagSlice.substring(p + 1, endQuote);
    }
    return null;
}

/**
 * Case-insensitive indexOf without lowercasing the entire haystack.
 * Compares lowercase needle against lowercased haystack chars on the fly.
 * The needle is assumed already lowercase.
 */
function indexOfCi(haystack, needleLower, fromIndex) {
    const hLen = haystack.length;
    const nLen = needleLower.length;
    if (nLen === 0) return fromIndex | 0;
    const last = hLen - nLen;
    for (let i = fromIndex; i <= last; i++) {
        let match = true;
        for (let j = 0; j < nLen; j++) {
            const hc = haystack.charCodeAt(i + j);
            const nc = needleLower.charCodeAt(j);
            // Lowercase ASCII fold for the haystack char.
            const hcLow = (hc >= 0x41 && hc <= 0x5A) ? (hc | 0x20) : hc;
            if (hcLow !== nc) { match = false; break; }
        }
        if (match) return i;
    }
    return -1;
}

/**
 * Decode the standard XML named entities and numeric (decimal + hex)
 * character references. Hand-rolled — we deliberately do not use DOMParser
 * or any browser-only API, since this module runs in Node at build time.
 *
 * Single-pass on a fixed input; we do NOT iterate to a fixed point, so an
 * input like "&amp;amp;" decodes to "&amp;" (matches C# WebUtility.HtmlDecode).
 */
function decodeXmlEntities(s) {
    return s.replace(ENTITY_RE, (m, hex, dec, named) => {
        if (hex !== undefined) {
            const cp = parseInt(hex, 16);
            if (!Number.isFinite(cp) || cp < 0 || cp > 0x10FFFF) return m;
            try { return String.fromCodePoint(cp); } catch { return m; }
        }
        if (dec !== undefined) {
            const cp = parseInt(dec, 10);
            if (!Number.isFinite(cp) || cp < 0 || cp > 0x10FFFF) return m;
            try { return String.fromCodePoint(cp); } catch { return m; }
        }
        switch (named) {
            case 'amp': return '&';
            case 'lt': return '<';
            case 'gt': return '>';
            case 'quot': return '"';
            case 'apos': return "'";
            default: return m;
        }
    });
}
