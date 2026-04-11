// lib/tei.js
// Minimal TEI parser tailored for CBETA corpus files.
// Adapted from pageidea/app.js (parseWorkXml). Returns a structured view of
// the document: title, line-id → text map, and an ordered list of line IDs.

import { normalizeText } from './format.js';

const TEI_NS = 'http://www.tei-c.org/ns/1.0';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

/**
 * Parse a CBETA TEI XML string into `{ titleZh, titleEn, linesById, lineOrder }`.
 *
 * Elements honoured:
 *   <lb n="...">  — starts a new line bucket
 *   <pb>          — skipped (page break)
 *   <note>        — skipped unless place="inline"
 *   <g>           — unicode glyph replacement (textContent)
 *   <anchor>, <head>, <p xml:id>, etc. — treated as structural, recurse into children
 *   entities and CDATA — handled natively by DOMParser
 *
 * Throws on parse error or missing <body>.
 */
export function parseTei(xmlText) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, 'application/xml');

    const parseError = doc.getElementsByTagName('parsererror')[0];
    if (parseError) {
        throw new Error('XML parse error: ' + (parseError.textContent || '').trim().slice(0, 200));
    }

    const body = doc.getElementsByTagNameNS(TEI_NS, 'body')[0];
    if (!body) {
        throw new Error('TEI document is missing a <body> element');
    }

    const linesById = new Map();
    const lineOrder = [];
    const current = { id: null };
    const headings = [];
    let currentJuan = null;

    function ensureLine(id) {
        if (!id) return;
        if (!linesById.has(id)) {
            linesById.set(id, { id, text: '' });
            lineOrder.push(id);
        }
    }

    function append(text) {
        if (!current.id || !text) return;
        ensureLine(current.id);
        const bucket = linesById.get(current.id);
        bucket.text += text;
    }

    /**
     * Collect heading text — descend but skip <note> (unless place="inline"),
     * <lb>, <pb>. Glyph replacements are honoured.
     */
    function collectHeadingText(node, out) {
        if (node.nodeType === Node.TEXT_NODE) {
            out.push(node.nodeValue || '');
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const ln = node.localName;
        if (ln === 'lb' || ln === 'pb' || ln === 'note') return;
        if (ln === 'g') {
            out.push(node.textContent || '');
            return;
        }
        for (let i = 0; i < node.childNodes.length; i += 1) {
            collectHeadingText(node.childNodes[i], out);
        }
    }

    function walk(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            append(node.nodeValue || '');
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;

        const localName = node.localName;

        if (localName === 'lb') {
            const n = node.getAttribute('n');
            if (n) {
                current.id = n;
                ensureLine(n);
            }
            return;
        }

        if (localName === 'pb') return;

        // <cb:juan n="1"> — namespace-insensitive match on localName.
        if (localName === 'juan') {
            const n = node.getAttribute('n');
            if (n) {
                const parsed = parseInt(n, 10);
                currentJuan = Number.isFinite(parsed) ? parsed : n;
            }
            // juan markers often have no text content, but recurse anyway.
            for (let i = 0; i < node.childNodes.length; i += 1) {
                walk(node.childNodes[i]);
            }
            return;
        }

        if (localName === 'milestone') {
            const unit = node.getAttribute('unit');
            if (unit === 'juan') {
                const n = node.getAttribute('n');
                if (n) {
                    const parsed = parseInt(n, 10);
                    currentJuan = Number.isFinite(parsed) ? parsed : n;
                }
            }
            return;
        }

        if (localName === 'head') {
            const parts = [];
            collectHeadingText(node, parts);
            const text = normalizeText(parts.join(''));
            if (text) {
                headings.push({
                    lineId: current.id || '',
                    text,
                    level: 1,
                    juanNumber: currentJuan
                });
            }
            // Also let the <head> contents flow into the normal line buckets
            // so body text isn't lost — same as before (recurse).
            for (let i = 0; i < node.childNodes.length; i += 1) {
                walk(node.childNodes[i]);
            }
            return;
        }

        if (localName === 'note') {
            // Skip ALL notes — including place="inline". CBETA uses inline
            // notes for editorial commentary that gets mixed into the body
            // text if recursed into. The desktop app treats these as
            // separate annotations; the preview just suppresses them.
            return;
        }

        if (localName === 'g') {
            append(node.textContent || '');
            return;
        }

        // <anchor>, <p>, <lg>, <l>, <seg>, etc. — recurse.
        for (let i = 0; i < node.childNodes.length; i += 1) {
            walk(node.childNodes[i]);
        }
    }

    walk(body);

    // Normalise once at the end so we don't pay for repeated trimming.
    for (const id of lineOrder) {
        const bucket = linesById.get(id);
        bucket.text = normalizeText(bucket.text);
    }

    const { titleZh, titleEn } = extractTitles(doc);

    return {
        titleZh,
        titleEn,
        linesById,
        lineOrder,
        headings
    };
}

/**
 * Reusable headings extractor — parses the given TEI XML and returns only the
 * headings array. Useful when callers want a TOC without the full line map.
 * Delegates to `parseTei` for correctness (the extra linesById cost is small
 * compared to the parse itself).
 */
export function extractHeadings(xmlText) {
    const parsed = parseTei(xmlText);
    return parsed.headings || [];
}

/**
 * Extract Chinese and English titles from the TEI titleStmt. Prefers
 * xml:lang="zh"/"en" but falls back to the first non-empty title.
 */
function extractTitles(doc) {
    const titleStmt = doc.getElementsByTagNameNS(TEI_NS, 'titleStmt')[0];
    if (!titleStmt) return { titleZh: '', titleEn: '' };

    const titles = titleStmt.getElementsByTagNameNS(TEI_NS, 'title');
    let zh = '';
    let en = '';
    let fallback = '';

    for (let i = 0; i < titles.length; i += 1) {
        const t = titles[i];
        const text = normalizeText(t.textContent || '');
        if (!text) continue;
        if (!fallback) fallback = text;

        const lang = t.getAttribute('xml:lang')
            || t.getAttributeNS(XML_NS, 'lang')
            || t.getAttribute('lang')
            || '';

        const lower = lang.toLowerCase();
        if (!zh && (lower === 'zh' || lower.startsWith('zh-') || lower === 'chi')) zh = text;
        if (!en && (lower === 'en' || lower.startsWith('en-') || lower === 'eng')) en = text;
    }

    return {
        titleZh: zh || fallback,
        titleEn: en
    };
}
