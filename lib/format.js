// lib/format.js
// Tiny text helpers used across the views.

/** HTML-escape a string for safe innerHTML insertion. */
export function escapeHtml(text) {
    return String(text == null ? '' : text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Collapse TEI-style whitespace: trim, strip stray \r, fold runs of spaces,
 * and keep inter-line spacing reasonable.
 */
export function normalizeText(text) {
    return String(text == null ? '' : text)
        .replace(/\r/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
}

/**
 * Slice an ordered list of lines by start/end line IDs (inclusive).
 * If either ID is missing, throws — callers should decide whether to
 * fall back to the full work.
 *
 * @param linesById Map<string, {id, text}>
 * @param lineOrder string[] of line IDs in document order
 * @param startId   string | ''  (empty → start at first line)
 * @param endId     string | ''  (empty → end at last line)
 * @returns {Array<{id:string,text:string}>}
 */
export function sliceLines(linesById, lineOrder, startId, endId) {
    if (!startId && !endId) {
        return lineOrder.map((id) => linesById.get(id));
    }

    let startIdx = -1;
    let endIdx = -1;

    for (let i = 0; i < lineOrder.length; i += 1) {
        const id = lineOrder[i];
        if (id === startId && startIdx === -1) startIdx = i;
        if (id === endId) endIdx = i;
    }

    if (startIdx === -1) {
        throw new Error(`Start line "${startId}" not found in work`);
    }
    if (endIdx === -1) {
        // If only one line was requested, treat startId==endId when the range was
        // actually a single-line hit.
        if (startId && !endId) endIdx = startIdx;
        else throw new Error(`End line "${endId}" not found in work`);
    }
    if (endIdx < startIdx) {
        throw new Error(`End line "${endId}" occurs before start line "${startId}"`);
    }

    return lineOrder.slice(startIdx, endIdx + 1).map((id) => linesById.get(id));
}

/**
 * Return the first `n` non-empty lines (by order) from a TEI parse result.
 * Empty buckets are skipped so the preview looks meaningful. If fewer than
 * `n` non-empty lines exist, returns all of them.
 *
 * @param linesById Map<string, {id, text}>
 * @param lineOrder string[] of line IDs in document order
 * @param n         integer max number of lines to return
 * @returns {Array<{id:string,text:string}>}
 */
export function sliceFirstN(linesById, lineOrder, n) {
    const out = [];
    const limit = n === Infinity ? lineOrder.length : Math.max(0, n | 0);
    for (let i = 0; i < lineOrder.length && out.length < limit; i += 1) {
        const line = linesById.get(lineOrder[i]);
        if (!line) continue;
        if (line.text && line.text.trim().length > 0) {
            out.push(line);
        }
    }
    return out;
}

/** Render an array of `{id,text}` lines into the two-column HTML the passage view expects. */
export function renderLinesHtml(lines) {
    return lines
        .filter((line) => line && line.text && line.text.trim().length > 0)
        .map((line) => {
            const id = escapeHtml(line.id);
            const content = escapeHtml(line.text);
            return `<div class="line-row" data-line-id="${id}"><span class="line-id">${id}</span><span class="line-text">${content}</span></div>`;
        }).join('');
}
