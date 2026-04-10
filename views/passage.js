// views/passage.js
// MVP passage reader. Fetches source XML (and translation XML when asked) from
// raw.githubusercontent.com, parses the TEI via lib/tei.js, and renders a
// side-by-side view of the requested line range.
//
// Race behaviour: when `preferAppFirst` is true, app.js fires the zen:// deep
// link via an iframe before calling `render`. If the app takes over the OS
// tab, this view simply never finishes loading — which is fine.

import { escapeHtml, sliceLines, sliceFirstN, renderLinesHtml } from '../lib/format.js';
import { parseTei } from '../lib/tei.js';
import {
    sourceXmlUrl,
    authoritativeTranslationUrl,
    communityTranslationUrl,
    fetchText
} from '../lib/github.js';
import { buildZenUri } from '../lib/route.js';
import * as cache from '../lib/cache.js';

const XML_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function match(route) {
    return route && route.kind === 'passage';
}

/** Passage links always try the desktop app first. */
export function preferAppFirst(_route) {
    return true;
}

/**
 * Render the passage preview into `mount`, using `shell` for chrome updates.
 */
export async function render(route, mount, shell) {
    shell.setTitle(route.workId);
    shell.setContext(
        describeRange(route),
        describeMode(route)
    );
    shell.setStatus(
        'Loading preview…',
        'Fetching XML from GitHub and extracting the requested lines.',
        false
    );

    const srcUrl = sourceXmlUrl(route.workId);
    if (!srcUrl) {
        shell.showError('Unrecognised work ID', `Could not resolve "${route.workId}" to a CBETA file.`);
        return;
    }

    shell.setExtraLink('Source XML', srcUrl);

    const isRangeless = !route.startLine;

    // Skeleton immediately so the user sees *something* during the fetch.
    if (isRangeless) {
        mount.innerHTML = `
            <section class="outline-wrap" id="outline-wrap">
                <div class="panel-skeleton">Loading work…</div>
            </section>
        `;
    } else {
        mount.innerHTML = `
            <div class="preview-grid" id="preview-grid">
                <article class="panel">
                    <div class="panel-head">
                        <p class="panel-label">Chinese Source</p>
                        <p class="panel-meta" id="source-meta">${escapeHtml(route.workId)}</p>
                    </div>
                    <div class="panel-title" id="source-title">Chinese source</div>
                    <div class="panel-body panel-body--source" id="source-body">
                        <div class="panel-skeleton">Loading source XML…</div>
                    </div>
                </article>
                <article class="panel" id="translation-panel" ${route.mode === 'en' ? '' : 'hidden'}>
                    <div class="panel-head">
                        <p class="panel-label" id="translation-label">Translation</p>
                        <p class="panel-meta" id="translation-meta"></p>
                    </div>
                    <div class="panel-title" id="translation-title"></div>
                    <div class="panel-body" id="translation-body">
                        <div class="panel-skeleton">Loading translation XML…</div>
                    </div>
                </article>
            </div>
        `;
    }

    try {
        const sourceWork = await loadXml(srcUrl);

        if (isRangeless) {
            // Optionally load the translation work too so outline rows can show
            // English headings when the caller asked for the bilingual mode.
            let translationWork = null;
            if (route.mode === 'en') {
                const translationUrl = route.translator
                    ? communityTranslationUrl(route.workId, route.translator)
                    : authoritativeTranslationUrl(route.workId);
                if (translationUrl) {
                    try {
                        translationWork = await loadXml(translationUrl);
                        shell.setExtraLink('Translation XML', translationUrl);
                    } catch {
                        translationWork = null;
                    }
                }
            }

            const headings = (sourceWork.headings || []).filter((h) => h.lineId);
            if (headings.length >= 3) {
                renderOutline(sourceWork, translationWork, headings, route, mount);
            } else {
                renderFirstNLines(sourceWork, 50, route, mount);
            }
            shell.hideStatus();
            return;
        }

        let sourceLines;
        try {
            sourceLines = sliceLines(
                sourceWork.linesById, sourceWork.lineOrder,
                route.startLine, route.endLine
            );
        } catch (rangeError) {
            // Range not found — fall back to full work but surface a warning.
            shell.setStatus(
                'Line range not found',
                rangeError.message + ' Showing the full work instead.',
                false
            );
            sourceLines = sliceLines(sourceWork.linesById, sourceWork.lineOrder, '', '');
        }

        document.querySelector('#source-meta').textContent = sourceWork.titleZh || route.workId;
        document.querySelector('#source-body').innerHTML = renderLinesHtml(sourceLines);

        // Only attempt translation loading when the route actually asked for it.
        if (route.mode === 'en') {
            await renderTranslation(route, sourceLines, shell);
        }

        shell.hideStatus();
        window.requestAnimationFrame(syncRowHeights);
    } catch (error) {
        const detail = (error && error.message) || 'Unknown error while loading preview data.';
        shell.showError('Preview failed to load', detail, buildZenUri(route));
    }
}

/**
 * Render the outline / table-of-contents view from extracted headings. Each
 * row links to `#/{workId}/{thisLb}-{nextLb}` where nextLb is the lb of the
 * following heading (or the last lb of the work for the final row).
 */
function renderOutline(sourceWork, translationWork, headings, route, mount) {
    const MAX_ROWS = 30;
    const truncated = headings.length > MAX_ROWS;
    const rows = truncated ? headings.slice(0, MAX_ROWS) : headings;

    // Build a lookup of heading lineId → heading text (EN side) for bilingual.
    const enHeadingsByLineId = new Map();
    if (translationWork && Array.isArray(translationWork.headings)) {
        for (const h of translationWork.headings) {
            if (h && h.lineId) enHeadingsByLineId.set(h.lineId, h.text);
        }
    }

    const lineOrder = sourceWork.lineOrder;
    const lastLineId = lineOrder.length > 0 ? lineOrder[lineOrder.length - 1] : '';

    // Compute the end-lb for each heading = (lb of next heading). For the last
    // heading we use the last lb in the document.
    const modeSuffix = route.mode === 'en' ? '/en' : '';
    const translatorSuffix = route.translator ? '/' + encodeURIComponent(route.translator) : '';

    const rowsHtml = rows.map((h, idx) => {
        const nextHeading = headings[idx + 1];
        let endLb;
        if (nextHeading && nextHeading.lineId) {
            // End one line before the next heading's lineId (still inclusive in
            // the range slice — the reader handles overlap gracefully).
            endLb = nextHeading.lineId;
        } else {
            endLb = lastLineId || h.lineId;
        }
        const href = '#/' + route.workId + '/' + h.lineId + '-' + endLb + modeSuffix + translatorSuffix;

        const juanLabel = h.juanNumber != null ? `juan ${escapeHtml(String(h.juanNumber))}` : '';
        const enText = enHeadingsByLineId.get(h.lineId) || '';
        const enHtml = enText
            ? `<div class="outline-row-en">${escapeHtml(enText)}</div>`
            : '';

        return `
            <a class="outline-row" href="${escapeHtml(href)}">
                <span class="outline-row-juan">${juanLabel}</span>
                <span class="outline-row-lb">${escapeHtml(h.lineId)}</span>
                <span class="outline-row-text">
                    <span class="outline-row-zh">${escapeHtml(h.text)}</span>
                    ${enHtml}
                </span>
            </a>
        `;
    }).join('');

    const titleZh = sourceWork.titleZh || route.workId;
    const titleEn = (translationWork && translationWork.titleEn) || sourceWork.titleEn || '';
    const titleLine = titleEn
        ? `${escapeHtml(titleZh)} <span class="outline-title-en">· ${escapeHtml(titleEn)}</span>`
        : escapeHtml(titleZh);

    const truncatedHtml = truncated
        ? `<p class="outline-truncated">Showing first ${MAX_ROWS} of ${headings.length} sections. Open in Read Zen for the full table of contents.</p>`
        : '';

    const wrap = document.querySelector('#outline-wrap') || mount;
    wrap.innerHTML = `
        <article class="panel outline-panel">
            <header class="outline-head">
                <h2 class="outline-title">${titleLine}</h2>
                <p class="outline-sub">Table of contents · ${headings.length} section${headings.length === 1 ? '' : 's'}</p>
            </header>
            <div class="outline-list">
                ${rowsHtml}
            </div>
            ${truncatedHtml}
        </article>
    `;
}

/**
 * Fall-back preview when a work has no usable headings: show the first N
 * non-empty lines with a banner pointing to the desktop app.
 */
function renderFirstNLines(sourceWork, n, route, mount) {
    const lines = sliceFirstN(sourceWork.linesById, sourceWork.lineOrder, n);
    const titleZh = sourceWork.titleZh || route.workId;
    const titleEn = sourceWork.titleEn || '';
    const titleLine = titleEn
        ? `${escapeHtml(titleZh)} <span class="outline-title-en">· ${escapeHtml(titleEn)}</span>`
        : escapeHtml(titleZh);

    const wrap = document.querySelector('#outline-wrap') || mount;
    wrap.innerHTML = `
        <article class="panel outline-panel">
            <header class="outline-head">
                <h2 class="outline-title">${titleLine}</h2>
                <p class="outline-sub">Preview · first ${lines.length} line${lines.length === 1 ? '' : 's'}</p>
            </header>
            <div class="outline-banner">
                Showing first ${lines.length} lines. Open in Read Zen for the full text.
            </div>
            <div class="panel-body panel-body--source">
                ${renderLinesHtml(lines)}
            </div>
        </article>
    `;
}

/** Fetch + parse TEI XML with caching. */
async function loadXml(url) {
    const cached = cache.get('xml:' + url);
    if (cached) return cached;

    const text = await fetchText(url);
    const parsed = parseTei(text);
    cache.set('xml:' + url, parsed, XML_CACHE_TTL_MS);
    return parsed;
}

/** Render the translation panel (or a not-available notice). */
async function renderTranslation(route, _sourceLines, shell) {
    const panel = document.querySelector('#translation-panel');
    const body = document.querySelector('#translation-body');
    const label = document.querySelector('#translation-label');
    const meta = document.querySelector('#translation-meta');
    const titleEl = document.querySelector('#translation-title');

    const translationUrl = route.translator
        ? communityTranslationUrl(route.workId, route.translator)
        : authoritativeTranslationUrl(route.workId);

    const labelText = route.translator
        ? `Community Translation · ${route.translator}`
        : 'Authoritative Translation';

    label.textContent = labelText;
    titleEl.textContent = route.hasExplicitRange ? 'English rendering' : 'English rendering · full work';

    if (!translationUrl) {
        panel.hidden = true;
        return;
    }

    try {
        const work = await loadXml(translationUrl);
        let lines;
        try {
            lines = sliceLines(work.linesById, work.lineOrder, route.startLine, route.endLine);
        } catch {
            lines = sliceLines(work.linesById, work.lineOrder, '', '');
        }
        panel.hidden = false;
        meta.textContent = work.titleEn || work.titleZh || route.workId;
        body.innerHTML = renderLinesHtml(lines);

        if (shell) {
            shell.setExtraLink('Translation XML', translationUrl);
        }
    } catch (error) {
        panel.hidden = false;
        meta.textContent = '—';
        body.innerHTML = `
            <div class="panel-empty">
                <p>No matching translation XML was found at the expected path.</p>
                <p class="panel-empty-hint">${escapeHtml(error.message || '')}</p>
            </div>
        `;
    }
}

function describeRange(route) {
    if (!route.startLine) return 'Outline / full work';
    if (route.endLine && route.endLine !== route.startLine) {
        return `${route.startLine} – ${route.endLine}`;
    }
    return route.startLine;
}

function describeMode(route) {
    if (route.mode === 'en') {
        return route.translator
            ? `Community translation by ${route.translator}`
            : 'Authoritative English translation';
    }
    return 'Chinese source preview';
}

/** Sync min-heights of parallel lines so rows line up across the two panels. */
function syncRowHeights() {
    const sourceRows = document.querySelectorAll('#source-body .line-row');
    const translationRows = document.querySelectorAll('#translation-body .line-row');
    const count = Math.min(sourceRows.length, translationRows.length);
    if (!count) return;

    for (let i = 0; i < count; i += 1) {
        sourceRows[i].style.minHeight = '';
        translationRows[i].style.minHeight = '';
    }
    for (let j = 0; j < count; j += 1) {
        const h = Math.max(sourceRows[j].offsetHeight, translationRows[j].offsetHeight);
        sourceRows[j].style.minHeight = h + 'px';
        translationRows[j].style.minHeight = h + 'px';
    }
}
