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
        out.push(line);
    }
    return out;
}

/**
 * Longest-match Zen-term detection over a flat code-point array.
 * Returns an array (same length as `flatChars`) whose entries are the matched
 * term STRING for positions inside a term, or null outside. Greedy left-to-
 * right: at each position the longest term in `matcher.terms` wins.
 *
 * @param {string[]} flatChars   code points (from Array.from), concatenated across lines
 * @param {{terms: Set<string>, maxLen: number}} matcher
 * @returns {(string|null)[]}
 */
function computeZenMarks(flatChars, matcher) {
    const terms = matcher && matcher.terms;
    const maxLen = (matcher && matcher.maxLen) || 0;
    const marks = new Array(flatChars.length).fill(null);
    if (!terms || terms.size === 0 || maxLen === 0) return marks;
    let i = 0;
    while (i < flatChars.length) {
        let matched = null;
        let matchedLen = 0;
        const max = Math.min(maxLen, flatChars.length - i);
        for (let len = max; len >= 1; len--) {
            const cand = flatChars.slice(i, i + len).join('');
            if (terms.has(cand)) { matched = cand; matchedLen = len; break; }
        }
        if (matched) {
            for (let k = 0; k < matchedLen; k++) marks[i + k] = matched;
            i += matchedLen;
        } else {
            i++;
        }
    }
    return marks;
}

/**
 * Build a Map<lineObject, innerHtml> of escaped line text with Zen-term
 * matches wrapped in `<mark class="zen-term" data-term="…">`. The match runs
 * over the CONCATENATION of all supplied lines, so a term that straddles a
 * woodblock line-cut is detected — and the resulting mark is SPLIT at the
 * line (span) boundary, each fragment carrying the same `data-term`.
 *
 * @param {Array<{id:string,text:string}>} textLines  real text lines (no spacer rows)
 * @param {{terms: Set<string>, maxLen: number}} matcher
 * @returns {Map<object,string>}
 */
export function buildZenInnerMap(textLines, matcher) {
    const out = new Map();
    const perLine = textLines.map((l) => Array.from((l && l.text) || ''));
    const flat = [];
    for (const arr of perLine) for (const ch of arr) flat.push(ch);
    const marks = computeZenMarks(flat, matcher);

    let pos = 0;
    for (let li = 0; li < textLines.length; li++) {
        const arr = perLine[li];
        let inner = '';
        let j = 0;
        while (j < arr.length) {
            const term = marks[pos + j];
            if (term == null) {
                const start = j;
                while (j < arr.length && marks[pos + j] == null) j++;
                inner += escapeHtml(arr.slice(start, j).join(''));
            } else {
                const start = j;
                // Same term string ⇒ one contiguous mark fragment (bounded to
                // this line so it never leaks across the span boundary).
                while (j < arr.length && marks[pos + j] === term) j++;
                inner += `<mark class="zen-term" data-term="${escapeHtml(term)}">${escapeHtml(arr.slice(start, j).join(''))}</mark>`;
            }
        }
        out.set(textLines[li], inner);
        pos += arr.length;
    }
    return out;
}

/**
 * Render an array of `{id,text}` lines into the two-column HTML the passage view expects.
 * When a segmentMap (Map<lbId, {type, speaker?, ...}>) is provided, each line-row gets
 * a CSS class `line-row--{type}` and a `data-segment-type` attribute so the stylesheet
 * can differentiate verse, dialogue, commentary, etc. Texts without a segment map render
 * exactly as before (graceful fallback).
 *
 * @param {Array<{id:string, text:string}>} lines
 * @param {Map<string, {type:string, speaker?:string}>} [segmentMap]
 * @param {{lineLinks?: boolean}} [opts] - lineLinks adds a per-line copy-link
 *        button (passage panes only); default off keeps the legacy markup.
 */
export function renderLinesHtml(lines, segmentMap, opts) {
    const lineLinks = !!(opts && opts.lineLinks);
    const rowClass = opts && opts.rowClass ? ' ' + String(opts.rowClass) : '';
    const kept = lines.filter((line) => line);

    // Zen-term highlighting (source side only). Concatenate the real text lines
    // and match across them so a term spanning a line-cut is wrapped correctly.
    const zenMatcher = opts && opts.zenMatcher;
    let zenInner = null;
    if (zenMatcher && zenMatcher.terms && zenMatcher.terms.size) {
        const textLines = kept.filter((l) =>
            !(l.id && (l.id.startsWith('__lg_break_') || l.id.startsWith('__pb_break_'))));
        zenInner = buildZenInnerMap(textLines, zenMatcher);
    }

    return kept
        .map((line) => {
            if (line.id && (line.id.startsWith('__lg_break_') || line.id.startsWith('__pb_break_'))) {
                return '<div class="line-row spacer-row"></div>';
            }
            const id = escapeHtml(line.id);
            const content = zenInner && zenInner.has(line)
                ? zenInner.get(line)
                : escapeHtml(line.text);

            // Segment-type overlay: add CSS class + data attribute when map is available.
            // Type is sanitized to alphanumeric+hyphen to prevent CSS class injection.
            const seg = segmentMap ? segmentMap.get(line.id) : undefined;
            const safeType = seg && seg.type ? seg.type.replace(/[^a-zA-Z0-9_-]/g, '') : '';
            const segClass = safeType ? ` line-row--${safeType}` : '';
            const segAttr = safeType ? ` data-segment-type="${escapeHtml(seg.type)}"` : '';
            const speakerAttr = seg && seg.speaker ? ` data-speaker="${escapeHtml(seg.speaker)}"` : '';

            // Hidden until row hover (CSS); absolutely positioned so it never
            // affects the row grid or cross-pane height sync.
            const linkBtn = lineLinks
                ? `<button class="line-link" type="button" data-link-id="${id}" title="Copy link to this line" aria-label="Copy link to line ${id}">&#128279;</button>`
                : '';

            return `<div class="line-row${segClass}${rowClass}" data-line-id="${id}"${segAttr}${speakerAttr}><span class="line-id" title="${id}">${id}</span><span class="line-text">${content}</span>${linkBtn}</div>`;
        }).join('');
}

/**
 * Merged reading renderer: heals the 17-character woodblock cuts by joining
 * each SEGMENT's lines into one flowing paragraph, desktop-reading-layout
 * style. Every line survives as an inline <span class="line-text"
 * data-line-id> inside the paragraph, so deep links, ?scroll=/?pos=, search
 * highlighting, and KWIC jumps keep their anchors.
 *
 * Grouping: consecutive lines whose lb maps to the same segment unit form a
 * group; unmapped lines join the running group (same semantics as the
 * desktop's merged preview). Callers must ensure segmentMap is non-empty -
 * without a map there is nothing to merge (fall back to line layouts).
 *
 * @param {Array<{id:string,text:string}>} lines - source-side lines (page slice)
 * @param {Map<string,object>} segmentMap - lbId -> {unitId, type, ...}
 * @param {Array<{id:string,text:string}>|null} translations - per-line EN (same order), or null
 * @param {{stacked?: boolean, side?: 'zh'|'en', headingIds?: Set<string>}} [opts]
 *        stacked: emit ZH paragraph followed by EN paragraph per segment.
 *        side: emit only that side's paragraph per segment (for flow panes).
 *        headingIds: line ids that are HEADINGS (from parseTei) - they break
 *        out of the running paragraph as standalone heading blocks. Without
 *        this, the segment maps' carried-lb semantics swallow case titles
 *        into the following body paragraph and chapter boundaries vanish.
 * @returns {string}
 */
export function renderMergedHtml(lines, segmentMap, translations, opts) {
    const stacked = !!(opts && opts.stacked);
    const side = (opts && opts.side) || 'zh';
    const headingIds = (opts && opts.headingIds) || null;
    const bylineIds = (opts && opts.bylineIds) || null;
    const zenMatcher = (opts && opts.zenMatcher) || null;
    const zenOn = !!(zenMatcher && zenMatcher.terms && zenMatcher.terms.size);

    // Group consecutive line indices by segment unit.
    const groups = [];
    let cur = null;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        if (line.id && (line.id.startsWith('__lg_break_') || line.id.startsWith('__pb_break_'))) continue;
        if (headingIds && headingIds.has(line.id)) {
            groups.push({ heading: true, idxs: [i], key: 'head:' + i, type: '' });
            cur = null; // the heading ends the running paragraph; body restarts after it
            continue;
        }
        if (bylineIds && bylineIds.has(line.id)) {
            groups.push({ byline: true, idxs: [i], key: 'byl:' + i, type: '' });
            cur = null; // attribution stands alone; body restarts after it
            continue;
        }
        const seg = segmentMap.get(line.id);
        const key = seg && seg.unitId ? seg.unitId : (cur ? cur.key : 'solo:' + i);
        if (!cur || key !== cur.key) {
            cur = { key, type: seg && seg.type ? seg.type : '', idxs: [] };
            groups.push(cur);
        } else if (!cur.type && seg && seg.type) {
            cur.type = seg.type;
        }
        cur.idxs.push(i);
    }

    return groups.map((g) => {
        if (g.heading) {
            const i = g.idxs[0];
            const hid = escapeHtml(lines[i].id);
            const zh = `<span class="line-text" data-line-id="${hid}">${escapeHtml(lines[i].text)}</span>`;
            const t = translations && translations[i];
            const en = t && t.text && (stacked || side === 'en')
                ? ` <span class="merged-head-en">${escapeHtml(t.text)}</span>` : '';
            const body = side === 'en' && t && t.text
                ? `<span class="line-text" data-line-id="${hid}">${escapeHtml(t.text)}</span>`
                : zh + en;
            return `<div class="merged-head" data-seg-first="${hid}">${body}</div>`;
        }
        if (g.byline) {
            const i = g.idxs[0];
            const bid = escapeHtml(lines[i].id);
            return `<div class="merged-byline" data-seg-first="${bid}"><span class="line-text" data-line-id="${bid}">${escapeHtml(lines[i].text)}</span></div>`;
        }
        const safeType = g.type ? g.type.replace(/[^a-zA-Z0-9_-]/g, '') : '';
        const typeClass = safeType ? ` merged-seg--${safeType}` : '';
        const typeAttr = safeType ? ` data-segment-type="${escapeHtml(g.type)}"` : '';
        const firstId = escapeHtml(lines[g.idxs[0]].id);

        // Zen-term highlighting: concatenate this segment's lines and match
        // across them so a term straddling a line-cut is split across the
        // sibling spans (each fragment keeps the same data-term).
        const groupLines = g.idxs.map((i) => lines[i]);
        const zenInner = zenOn ? buildZenInnerMap(groupLines, zenMatcher) : null;
        const zhSpans = groupLines.map((ln) => {
            const inner = zenInner && zenInner.has(ln) ? zenInner.get(ln) : escapeHtml(ln.text);
            return `<span class="line-text" data-line-id="${escapeHtml(ln.id)}">${inner}</span>`;
        }).join('');
        const zhPara = `<p class="merged-text merged-text--zh">${zhSpans}</p>`;

        let enPara = '';
        if (translations && (stacked || side === 'en')) {
            const enSpans = g.idxs.map((i) => {
                const t = translations[i];
                if (!t || !t.text) return '';
                return `<span class="line-text" data-line-id="${escapeHtml(t.id)}">${escapeHtml(t.text)}</span>`;
            }).filter(Boolean).join(' ');
            if (enSpans) enPara = `<p class="merged-text merged-text--en">${enSpans}</p>`;
        }

        const body = stacked ? zhPara + enPara : (side === 'en' ? (enPara || '<p class="merged-text merged-text--en merged-text--missing">(untranslated)</p>') : zhPara);
        const linkBtn = `<button class="line-link line-link--seg" type="button" data-link-id="${firstId}" title="Copy link to this passage" aria-label="Copy link to passage at ${firstId}">&#128279;</button>`;
        return `<div class="merged-seg${typeClass}"${typeAttr} data-seg-first="${firstId}">${linkBtn}${body}</div>`;
    }).join('');
}
