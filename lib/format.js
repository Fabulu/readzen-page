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
    return lines
        .filter((line) => line)
        .map((line) => {
            if (line.id && (line.id.startsWith('__lg_break_') || line.id.startsWith('__pb_break_'))) {
                return '<div class="line-row spacer-row"></div>';
            }
            const id = escapeHtml(line.id);
            const content = escapeHtml(line.text);

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

        const zhSpans = g.idxs.map((i) =>
            `<span class="line-text" data-line-id="${escapeHtml(lines[i].id)}">${escapeHtml(lines[i].text)}</span>`
        ).join('');
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
