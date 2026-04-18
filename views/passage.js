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
import { attachInlineDict } from '../lib/inline-dict.js';
import { addToList, removeFromList, isInList, setLastRead } from '../lib/reading-lists.js';

const XML_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_LIST = 'My Reading List';
const VIEW_PREF_KEY = 'zen-view-pref'; // 'zh' | 'en' | 'both'

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
        'full work, every text we index across CBETA and OpenZen, a hover dictionary while you read, ' +
        'and lets you write your own translations. ' +
        'You can also <strong>create and share links like this one yourself</strong>.'
    );

    // Look up the title from titles.jsonl in the background and update the
    // shell + document title once it arrives. Don't block render on this.
    lookupTitle(route.workId, route.corpus).then((entry) => {
        if (!entry) return;
        const titleText = entry.enShort || entry.en || entry.zh || route.workId;
        const subtitle = entry.zh && titleText !== entry.zh ? entry.zh : '';
        shell.setTitle(subtitle ? `${titleText} · ${subtitle}` : titleText);
        try {
            document.title = `${titleText} · Read Zen Preview`;
        } catch {}
    });
    // Toolbar: copy-with-citation + cite buttons
    const toolbar = buildPassageToolbar(route, shell);
    const actionsRow = document.querySelector('.shell-actions-buttons');
    if (actionsRow && toolbar) actionsRow.prepend(toolbar);

    shell.setStatus(
        'Loading preview…',
        'Fetching XML from GitHub and extracting the requested lines.',
        false
    );

    const srcUrl = sourceXmlUrl(route.workId, route.corpus);
    if (!srcUrl) {
        shell.showError(
            'Unrecognised work ID',
            `Could not resolve "${route.workId}" to a ${corpusLabel(route.corpus)} file.`
        );
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
                tCandidates.push(communityTranslationUrl(route.workId, route.translator, route.corpus));
            }
            tCandidates.push(authoritativeTranslationUrl(route.workId, route.corpus));
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
                    renderFirstNLines(sourceWork, 30, route, mount, true);
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
        attachInlineDict(document.querySelector('#source-body'));

        // Only attempt translation loading when the route actually asked for it.
        if (route.mode === 'en') {
            await renderTranslation(route, sourceLines, shell);
        }

        shell.hideStatus();
        window.requestAnimationFrame(syncRowHeights);

        // Bookmark button + scroll tracking
        const titleText = sourceWork.titleZh || sourceWork.titleEn || route.workId;
        mountBookmarkButton(mount, route.workId, titleText);
        trackScrollProgress(mount, route.workId, titleText);
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
 * Side-by-side preview for a rangeless link to a translated work.
 * Shows all lines for small works (<200), otherwise paginates in chunks of 50.
 * Includes bilingual toggle and translator switcher controls.
 */
function renderRangelessBilingual(sourceWork, translationWork, route, mount) {
    const PAGE = 50;
    const allSourceLines = sliceFirstN(sourceWork.linesById, sourceWork.lineOrder, Infinity);
    const totalLines = allSourceLines.length;
    const showAll = totalLines <= 200;
    let shown = showAll ? totalLines : PAGE;

    const tranMap = translationWork.linesById;
    const pairTranslation = (lines) => lines.map((src) => {
        if (!src) return { id: '', text: '' };
        const t = tranMap && tranMap.get ? tranMap.get(src.id) : null;
        return { id: src.id, text: (t && t.text) || '' };
    });

    const titleZh = sourceWork.titleZh || route.workId;
    const titleEn = translationWork.titleEn || sourceWork.titleEn || '';

    const viewPref = readViewPref();

    const wrap = document.querySelector('#outline-wrap') || mount;
    wrap.innerHTML = `
        ${buildViewToggle(viewPref)}
        ${buildTranslatorSwitcher(route)}
        <div class="preview-grid" id="preview-grid">
            <article class="panel" id="source-panel" ${viewPref === 'en' ? 'hidden' : ''}>
                <div class="panel-head">
                    <p class="panel-label">Chinese Source</p>
                    <p class="panel-meta">${escapeHtml(titleZh)}</p>
                </div>
                <div class="panel-title">Chinese source</div>
                <div class="panel-body panel-body--source" id="source-body">
                    ${renderLinesHtml(allSourceLines.slice(0, shown))}
                </div>
            </article>
            <article class="panel" id="translation-panel" ${viewPref === 'zh' ? 'hidden' : ''}>
                <div class="panel-head">
                    <p class="panel-label">Translation</p>
                    <p class="panel-meta">${escapeHtml(titleEn || 'Community translation')}</p>
                </div>
                <div class="panel-title">English rendering</div>
                <div class="panel-body" id="translation-body">
                    ${renderLinesHtml(pairTranslation(allSourceLines.slice(0, shown)))}
                </div>
            </article>
        </div>
        ${shown < totalLines ? buildShowMoreBtn(shown, totalLines) : ''}
        ${buildPassageFooter()}
    `;

    wireViewToggle(wrap);
    wireTranslatorSwitcher(wrap, route);

    if (shown < totalLines) {
        wrap.querySelector('#show-more-btn').addEventListener('click', () => {
            shown = Math.min(shown + PAGE, totalLines);
            document.querySelector('#source-body').innerHTML = renderLinesHtml(allSourceLines.slice(0, shown));
            document.querySelector('#translation-body').innerHTML = renderLinesHtml(pairTranslation(allSourceLines.slice(0, shown)));
            attachInlineDict(document.querySelector('#source-body'));
            if (shown >= totalLines) {
                const btn = wrap.querySelector('#show-more-wrap');
                if (btn) btn.remove();
            } else {
                wrap.querySelector('#show-more-btn').textContent = `Show more (${shown} of ${totalLines} lines shown)`;
            }
            window.requestAnimationFrame(syncRowHeights);
        });
    }

    window.requestAnimationFrame(syncRowHeights);
    attachInlineDict(document.querySelector('#source-body'));
}

/**
 * Fall-back preview when a work has no usable headings. Shows all lines for
 * small works (<200), otherwise paginates in chunks of 50 with a "Show more"
 * button.
 */
function renderFirstNLines(sourceWork, _unused, route, mount, noTranslation) {
    const PAGE = 50;
    const allLines = sliceFirstN(sourceWork.linesById, sourceWork.lineOrder, Infinity);
    const totalLines = allLines.length;
    const showAll = totalLines <= 200;
    let shown = showAll ? totalLines : PAGE;

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
                <p class="outline-sub">${noTranslation ? 'Chinese source \u2014 no English translation available yet' : 'Preview \u00b7 ' + (showAll ? totalLines : shown + ' of ' + totalLines) + ' line' + (totalLines === 1 ? '' : 's')}</p>
            </header>
            <div class="panel-body panel-body--source" id="firstn-source-body">
                ${renderLinesHtml(allLines.slice(0, shown))}
            </div>
        </article>
        ${shown < totalLines ? buildShowMoreBtn(shown, totalLines) : ''}
        ${buildPassageFooter()}
    `;
    attachInlineDict(document.querySelector('#firstn-source-body'));

    if (shown < totalLines) {
        wrap.querySelector('#show-more-btn').addEventListener('click', () => {
            shown = Math.min(shown + PAGE, totalLines);
            document.querySelector('#firstn-source-body').innerHTML = renderLinesHtml(allLines.slice(0, shown));
            attachInlineDict(document.querySelector('#firstn-source-body'));
            if (shown >= totalLines) {
                const btn = wrap.querySelector('#show-more-wrap');
                if (btn) btn.remove();
            } else {
                wrap.querySelector('#show-more-btn').textContent = `Show more (${shown} of ${totalLines} lines shown)`;
            }
        });
    }
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
            url: communityTranslationUrl(route.workId, route.translator, route.corpus),
            label: `Translation by ${route.translator}`
        });
        candidates.push({
            url: authoritativeTranslationUrl(route.workId, route.corpus),
            label: 'Community translation'
        });
    } else {
        candidates.push({
            url: authoritativeTranslationUrl(route.workId, route.corpus),
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
        const translator = route.translator ? `by ${escapeHtml(route.translator)} ` : '';
        body.innerHTML = `
            <div class="panel-empty">
                <p>No English translation ${translator}available for this text yet.</p>
                <p class="panel-empty-hint">
                    This text hasn\u2019t been translated \u2014 you\u2019re seeing the Chinese original only.
                    Translations are contributed by the community and grow over time.
                </p>
                <p class="panel-empty-hint">
                    Want to translate? <a href="${RELEASES_URL}">Download Read Zen</a> to start translating,
                    or <a href="https://ko-fi.com/readzen">support the project on Ko-fi</a>.
                </p>
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

function corpusLabel(corpus) {
    if (corpus === 'openzen') return 'OpenZen';
    if (corpus === 'cbeta') return 'CBETA';
    return 'known';
}

/** Insert a small bookmark toggle above the passage content. */
function mountBookmarkButton(mount, fileId, title) {
    const saved = isInList(DEFAULT_LIST, fileId);
    const btn = document.createElement('button');
    btn.className = 'bookmark-btn';
    btn.textContent = saved ? '\u2605 Saved' : '\u2606 Save';
    btn.addEventListener('click', () => {
        if (isInList(DEFAULT_LIST, fileId)) {
            removeFromList(DEFAULT_LIST, fileId);
            btn.textContent = '\u2606 Save';
        } else {
            addToList(DEFAULT_LIST, fileId, title);
            btn.textContent = '\u2605 Saved';
        }
    });
    mount.prepend(btn);
}

/** Track scroll position so the landing page can offer "Continue reading". */
function trackScrollProgress(mount, fileId, title) {
    let ticking = false;
    window.addEventListener('scroll', () => {
        if (ticking) return;
        ticking = true;
        window.requestAnimationFrame(() => {
            const scrollTop = window.scrollY || document.documentElement.scrollTop;
            const docHeight = document.documentElement.scrollHeight - window.innerHeight;
            const pct = docHeight > 0 ? Math.round((scrollTop / docHeight) * 100) : 0;
            setLastRead(fileId, title, pct);
            ticking = false;
        });
    });
}

/** Build the passage toolbar fragment with Copy and Cite buttons. */
function buildPassageToolbar(route) {
    const frag = document.createDocumentFragment();

    // --- Copy with Citation ---
    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn btn--small';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => {
        const sel = window.getSelection();
        const text = sel && sel.toString().trim()
            ? sel.toString().trim()
            : (document.querySelector('#source-body') || document.querySelector('#view-mount')).innerText.trim();
        const title = document.querySelector('#shell-title')?.textContent || route.workId;
        const url = location.origin + location.pathname + '#/' + (route.rawRoute || route.workId);
        const citation = text + '\n\n\u2014 ' + title + ', ' + route.workId + '. ' + url;
        navigator.clipboard.writeText(citation).then(() => {
            copyBtn.textContent = 'Copied!';
            setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
        });
    });
    frag.appendChild(copyBtn);

    // --- Cite button ---
    const citeBtn = document.createElement('button');
    citeBtn.className = 'btn btn--small';
    citeBtn.textContent = 'Cite';
    citeBtn.addEventListener('click', () => {
        // Remove existing popup
        const old = document.querySelector('.cite-popup');
        if (old) { old.remove(); return; }

        const title = document.querySelector('#shell-title')?.textContent || route.workId;
        const url = location.origin + location.pathname + '#/' + (route.rawRoute || route.workId);
        const chicago = '"' + title + '." In ReadZen. ' + url + '.';

        const popup = document.createElement('div');
        popup.className = 'cite-popup';
        popup.innerHTML =
            '<p class="cite-popup-head">Citation</p>' +
            '<div class="cite-row"><span class="cite-label">Chicago</span>' +
            '<code class="cite-text">' + escapeHtml(chicago) + '</code>' +
            '<button class="btn btn--small cite-copy">Copy</button></div>';
        popup.querySelector('.cite-copy').addEventListener('click', (ev) => {
            navigator.clipboard.writeText(chicago).then(() => {
                ev.target.textContent = 'Copied!';
                setTimeout(() => { ev.target.textContent = 'Copy'; }, 1500);
            });
        });
        citeBtn.parentElement.appendChild(popup);
    });
    frag.appendChild(citeBtn);

    return frag;
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

// ━━ Bilingual view toggle ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function readViewPref() {
    try { return localStorage.getItem(VIEW_PREF_KEY) || 'both'; } catch { return 'both'; }
}

function saveViewPref(pref) {
    try { localStorage.setItem(VIEW_PREF_KEY, pref); } catch {}
}

function buildViewToggle(active) {
    const opts = [
        { value: 'zh', label: 'Chinese' },
        { value: 'both', label: 'Both' },
        { value: 'en', label: 'English' }
    ];
    const btns = opts.map((o) =>
        `<button class="view-seg${o.value === active ? ' view-seg--active' : ''}" data-view="${o.value}">${o.label}</button>`
    ).join('');
    return `<div class="view-toggle" id="view-toggle">${btns}</div>`;
}

function wireViewToggle(container) {
    const toggle = container.querySelector('#view-toggle');
    if (!toggle) return;
    toggle.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-view]');
        if (!btn) return;
        const pref = btn.dataset.view;
        saveViewPref(pref);

        // Update active class
        toggle.querySelectorAll('.view-seg').forEach((b) => b.classList.remove('view-seg--active'));
        btn.classList.add('view-seg--active');

        // Show/hide panels
        const src = document.querySelector('#source-panel');
        const trn = document.querySelector('#translation-panel');
        const grid = document.querySelector('#preview-grid');
        if (src) src.hidden = pref === 'en';
        if (trn) trn.hidden = pref === 'zh';

        // Adjust grid columns when showing single panel
        if (grid) {
            grid.style.gridTemplateColumns = pref === 'both'
                ? 'minmax(0, 1fr) minmax(0, 1fr)'
                : '1fr';
        }
        window.requestAnimationFrame(syncRowHeights);
    });
}

// ━━ Translator switcher ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Cache for discovered translator usernames (one API call per session). */
let _translatorsCache = null;

async function discoverTranslators(corpus) {
    if (_translatorsCache) return _translatorsCache;
    try {
        const repo = corpus === 'open'
            ? 'Fabulu/OpenZenTranslations'
            : 'Fabulu/CbetaZenTranslations';
        const res = await fetch(
            `https://api.github.com/repos/${repo}/contents/community/translations`,
            { cache: 'default' });
        if (!res.ok) throw new Error(res.status);
        const items = await res.json();
        _translatorsCache = items
            .filter(i => i.type === 'dir')
            .map(i => i.name);
    } catch {
        _translatorsCache = [];
    }
    return _translatorsCache;
}

function buildTranslatorSwitcher(route) {
    return `
        <div class="translator-switcher" id="translator-switcher">
            <label class="translator-label">
                Translation source
                <select class="translator-select" id="translator-select">
                    <option value="">Community translation</option>
                </select>
            </label>
            <span class="translator-hint">Loading available translations\u2026</span>
        </div>
    `;
}

function wireTranslatorSwitcher(container, route) {
    const select = container.querySelector('#translator-select');
    const hint = container.querySelector('.translator-hint');
    if (!select) return;

    const corpus = route.workId?.startsWith('ws.') || route.workId?.startsWith('pd.') ||
                   route.workId?.startsWith('ce.') || route.workId?.startsWith('mit.')
        ? 'open' : 'cbeta';

    discoverTranslators(corpus).then(users => {
        users.forEach(u => {
            const opt = document.createElement('option');
            opt.value = u;
            opt.textContent = u;
            if (u === route.translator) opt.selected = true;
            select.appendChild(opt);
        });
        if (!route.translator) select.value = '';
        if (hint) hint.textContent = users.length
            ? `${users.length} translator${users.length === 1 ? '' : 's'} available`
            : 'No community translators yet';
    });

    select.addEventListener('change', () => {
        const user = select.value;
        const base = '#/' + route.workId;
        const rangePart = route.startLine
            ? '/' + route.startLine + (route.endLine && route.endLine !== route.startLine ? '-' + route.endLine : '')
            : '';
        const modePart = '/en';
        const translatorPart = user ? '/' + encodeURIComponent(user) : '';
        location.hash = base + rangePart + modePart + translatorPart;
    });
}

// ━━ Show-more button + footer ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function buildShowMoreBtn(shown, total) {
    return `<div class="show-more-wrap" id="show-more-wrap">
        <button class="btn show-more-btn" id="show-more-btn">Show more (${shown} of ${total} lines shown)</button>
    </div>`;
}

function buildPassageFooter() {
    return `<div class="passage-footer">
        Full reading experience in
        <a class="text-link text-link--accent" href="https://github.com/Fabulu/ReadZen/releases">Read Zen</a>
        &middot;
        <a class="text-link" href="https://ko-fi.com/readzen">Support on Ko-fi</a>
    </div>`;
}
