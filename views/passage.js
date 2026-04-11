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
import { lookupTitle } from '../lib/titles.js';

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
    shell.setUpsell(
        'This preview shows one passage. The desktop app gives you the ' +
        'full work, every CBETA text, a hover dictionary while you read, ' +
        'and lets you write your own translations. ' +
        'You can also <strong>create and share links like this one yourself</strong>.'
    );

    // Look up the title from titles.jsonl in the background and update the
    // shell + document title once it arrives. Don't block render on this.
    lookupTitle(route.workId).then((entry) => {
        if (!entry) return;
        const titleText = entry.enShort || entry.en || entry.zh || route.workId;
        const subtitle = entry.zh && titleText !== entry.zh ? entry.zh : '';
        shell.setTitle(subtitle ? `${titleText} · ${subtitle}` : titleText);
        try {
            document.title = `${titleText} · Read Zen Preview`;
        } catch {}
    });
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
            // CBETA's source <head> elements (the table of contents) can't
            // legally be translated, so we can't render a useful bilingual
            // TOC for translated works — the headings would all be in
            // Chinese even when the body text is fully translated. Instead,
            // show a side-by-side preview of the first N body lines, which
            // works whether the text is translated or not and acts as
            // proof-of-value pointing to the desktop app for the full work.
            //
            // Always try loading translation here (regardless of route.mode):
            // a rangeless link to a translated work should still show the
            // translation alongside the source.
            let translationWork = null;
            const tCandidates = [];
            if (route.translator) {
                tCandidates.push(communityTranslationUrl(route.workId, route.translator));
            }
            tCandidates.push(authoritativeTranslationUrl(route.workId));
            for (const turl of tCandidates) {
                if (!turl) continue;
                try {
                    translationWork = await loadXml(turl);
                    shell.setExtraLink('Translation XML', turl);
                    break;
                } catch {
                    // try next
                }
            }

            if (translationWork) {
                // Translated works: side-by-side first N body lines.
                renderRangelessBilingual(sourceWork, translationWork, route, mount);
            } else {
                // Untranslated works: show the source TOC as-is. The headings
                // are in Chinese (CBETA forbids altering them) but they're
                // still useful navigation entry points — each row links to a
                // ranged passage URL. Falls back to first-N-lines if the work
                // has no usable headings.
                const headings = (sourceWork.headings || []).filter((h) => h.lineId);
                if (headings.length >= 3) {
                    renderSourceOutline(sourceWork, headings, route, mount);
                } else {
                    renderFirstNLines(sourceWork, 30, route, mount);
                }
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
 * Source-only TOC for rangeless links to untranslated works. Each row is a
 * navigable link to the ranged passage between this heading's lineId and the
 * next heading's lineId. Headings stay in Chinese — CBETA forbids altering
 * them — but they still act as useful navigation into the body text.
 */
function renderSourceOutline(sourceWork, headings, route, mount) {
    const MAX_ROWS = 30;
    const truncated = headings.length > MAX_ROWS;
    const rows = truncated ? headings.slice(0, MAX_ROWS) : headings;

    const lineOrder = sourceWork.lineOrder;
    const lastLineId = lineOrder.length > 0 ? lineOrder[lineOrder.length - 1] : '';

    // Compute the end-lb for each heading = (lb of next heading). For the
    // last heading we use the last lb in the document. Mode/translator
    // suffixes are honoured so an `/en/{user}` outline keeps the same
    // mode when the user clicks into a section.
    const modeSuffix = route.mode === 'en' ? '/en' : '';
    const translatorSuffix = route.translator ? '/' + encodeURIComponent(route.translator) : '';

    const rowsHtml = rows.map((h, idx) => {
        const nextHeading = headings[idx + 1];
        const endLb = (nextHeading && nextHeading.lineId) || lastLineId || h.lineId;
        const href = '#/' + route.workId + '/' + h.lineId + '-' + endLb + modeSuffix + translatorSuffix;
        const juanLabel = h.juanNumber != null ? `juan ${escapeHtml(String(h.juanNumber))}` : '';

        return `
            <a class="outline-row" href="${escapeHtml(href)}">
                <span class="outline-row-juan">${juanLabel}</span>
                <span class="outline-row-lb">${escapeHtml(h.lineId)}</span>
                <span class="outline-row-text">
                    <span class="outline-row-zh">${escapeHtml(h.text)}</span>
                </span>
            </a>
        `;
    }).join('');

    const titleZh = sourceWork.titleZh || route.workId;
    const titleEn = sourceWork.titleEn || '';
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
 * Side-by-side preview of the first N body lines for a rangeless link to a
 * translated work. Lines are paired by `lineId` so the columns line up — the
 * preview walks the source line order, picks the first N non-empty source
 * lines, and looks up the matching translation line by ID. (CBETA-derived
 * translation files preserve `<lb n="...">` IDs from the source, so the
 * pairing is exact when both sides have content for that line.)
 */
function renderRangelessBilingual(sourceWork, translationWork, route, mount) {
    const N = 30;
    const sourceLines = sliceFirstN(sourceWork.linesById, sourceWork.lineOrder, N);

    // Pair each source line with the matching translation line by ID.
    const tranMap = translationWork.linesById;
    const tranLines = sourceLines.map((src) => {
        if (!src) return { id: '', text: '' };
        const t = tranMap && tranMap.get ? tranMap.get(src.id) : null;
        return { id: src.id, text: (t && t.text) || '' };
    });

    const titleZh = sourceWork.titleZh || route.workId;
    const titleEn = translationWork.titleEn || sourceWork.titleEn || '';

    const wrap = document.querySelector('#outline-wrap') || mount;
    wrap.innerHTML = `
        <div class="outline-banner">
            Preview · first ${sourceLines.length} lines of the body text. Open the full
            work in <a class="text-link text-link--accent" href="https://github.com/Fabulu/ReadZen/releases">Read Zen</a>,
            or share a targeted link with a line range like
            <code>#/${escapeHtml(route.workId)}/0292c22-0293a15/en</code>.
        </div>
        <div class="preview-grid">
            <article class="panel">
                <div class="panel-head">
                    <p class="panel-label">Chinese Source</p>
                    <p class="panel-meta">${escapeHtml(titleZh)}</p>
                </div>
                <div class="panel-title">Chinese source</div>
                <div class="panel-body panel-body--source" id="source-body">
                    ${renderLinesHtml(sourceLines)}
                </div>
            </article>
            <article class="panel">
                <div class="panel-head">
                    <p class="panel-label">Translation</p>
                    <p class="panel-meta">${escapeHtml(titleEn || 'Community translation')}</p>
                </div>
                <div class="panel-title">English rendering · preview</div>
                <div class="panel-body" id="translation-body">
                    ${renderLinesHtml(tranLines)}
                </div>
            </article>
        </div>
    `;

    window.requestAnimationFrame(syncRowHeights);
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

/**
 * Fetch + parse TEI XML with caching. We cache the RAW XML text, not the
 * parsed object — parsed objects contain Map instances that don't survive
 * JSON.stringify into sessionStorage. Re-parsing is fast (~10ms for typical
 * files) and avoids the "linesById.get is not a function" bug after refresh.
 */
async function loadXml(url) {
    let text = cache.get('xml-text:' + url);
    if (typeof text !== 'string') {
        text = await fetchText(url);
        cache.set('xml-text:' + url, text, XML_CACHE_TTL_MS);
    }
    return parseTei(text);
}

/** Render the translation panel (or a not-available notice). */
async function renderTranslation(route, _sourceLines, shell) {
    const panel = document.querySelector('#translation-panel');
    const body = document.querySelector('#translation-body');
    const label = document.querySelector('#translation-label');
    const meta = document.querySelector('#translation-meta');
    const titleEl = document.querySelector('#translation-title');

    // Build candidate URLs in priority order. If a translator was requested,
    // try their personal translation FIRST, then fall back to the community
    // translation. This handles the common case where a user has translated
    // some files but not others.
    const candidates = [];
    if (route.translator) {
        candidates.push({
            url: communityTranslationUrl(route.workId, route.translator),
            label: `Translation by ${route.translator}`
        });
        candidates.push({
            url: authoritativeTranslationUrl(route.workId),
            label: 'Community translation'
        });
    } else {
        candidates.push({
            url: authoritativeTranslationUrl(route.workId),
            label: 'Community translation'
        });
    }

    titleEl.textContent = route.hasExplicitRange ? 'English rendering' : 'English rendering · full work';

    let lastError = null;
    for (const candidate of candidates) {
        if (!candidate.url) continue;
        try {
            const work = await loadXml(candidate.url);
            let lines;
            try {
                lines = sliceLines(work.linesById, work.lineOrder, route.startLine, route.endLine);
            } catch {
                lines = sliceLines(work.linesById, work.lineOrder, '', '');
            }
            label.textContent = candidate.label;
            panel.hidden = false;
            meta.textContent = work.titleEn || work.titleZh || route.workId;
            body.innerHTML = renderLinesHtml(lines);

            if (shell) {
                shell.setExtraLink('Translation XML', candidate.url);
            }
            return; // success
        } catch (err) {
            lastError = err;
            // Try next candidate
        }
    }

    // All candidates failed — render the not-available notice using the last error.
    {
        const error = lastError || new Error('No translation source available.');
        label.textContent = route.translator
            ? `Translation by ${route.translator}`
            : 'Community translation';
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
            ? `Translation by ${route.translator}`
            : 'Community translation';
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
