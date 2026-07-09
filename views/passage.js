// views/passage.js
// MVP passage reader. Fetches source XML (and translation XML when asked) from
// raw.githubusercontent.com, parses the TEI via lib/tei.js, and renders a
// side-by-side view of the requested line range.
//
// Race behaviour: when `preferAppFirst` is true, app.js fires the zen:// deep
// link via an iframe before calling `render`. If the app takes over the OS
// tab, this view simply never finishes loading — which is fine.

import { escapeHtml, sliceLines, sliceFirstN, renderLinesHtml } from '../lib/format.js';
import { loadSegmentMap } from '../lib/segment-map.js';
import { highlightTextInHtml, scrollToFirstHighlight, scrollToLineId, findPageForTerm, findPageForLineId } from '../lib/highlight.js';
import { parseTei } from '../lib/tei.js';
import {
    sourceXmlUrl,
    authoritativeTranslationUrl,
    communityTranslationUrl,
    fetchText,
    fetchStarCounts
} from '../lib/github.js';
import { buildZenUri, buildLineLinkHash } from '../lib/route.js';
import * as cache from '../lib/cache.js';
import { lookupTitle } from '../lib/titles.js';
import { attachInlineDict } from '../lib/inline-dict.js';
import { attachSelectionMirror } from '../lib/selection-sync.js';
import { addToList, removeFromList, isInList, setLastRead, resumeLastReadTracking } from '../lib/reading-lists.js';
import { CITE_STYLES, buildCitation, getPreferredStyle, setPreferredStyle } from '../lib/citation.js';
import { registerFindNavigator } from '../lib/keyboard.js';
import { getPageSize, PAGE_SIZE_OPTIONS } from '../lib/reader-prefs.js';

const XML_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Same per-module constant as landing.js / shell.js / app.js. The
// translation-not-available notice referenced this WITHOUT declaring it since
// 2026-04-18 — a strict-mode ReferenceError that let the notice's own crash
// replace an already-rendered passage with "Preview failed to load" for every
// ranged view of an untranslated text.
const RELEASES_URL = 'https://github.com/Fabulu/ReadZen/releases';

// Active find-bar global keydown listeners. The mountFindBar handler
// self-removes on the next keystroke after the mount detaches, but if the
// user navigates without typing the listener leaks until then. The router
// calls disposeAllFindBarHandlers() on every hashchange to plug that.
const _findBarDisposers = new Set();

/** Tear down every globally-registered find-bar keydown handler. */
export function disposeAllFindBarHandlers() {
    for (const d of Array.from(_findBarDisposers)) {
        try { d(); } catch {}
    }
    _findBarDisposers.clear();
}

/**
 * Build a short apparatus summary string like " · 12 textual variants, 3 witnesses".
 * Returns empty string when apparatus is empty or missing.
 */
function apparatusSummary(apparatus) {
    if (!apparatus || !apparatus.length) return '';
    const variants = apparatus.length;
    const witnesses = new Set();
    for (const entry of apparatus) {
        for (const rdg of entry.readings) {
            if (rdg.wit) rdg.wit.split(/\s+/).forEach(w => { if (w) witnesses.add(w); });
        }
    }
    const wCount = witnesses.size;
    return ` \u00b7 ${variants} textual variant${variants === 1 ? '' : 's'}`
         + (wCount ? `, ${wCount} witness${wCount === 1 ? '' : 'es'}` : '');
}
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
    resumeLastReadTracking(); // user intentionally opened a text — re-enable progress tracking
    wireLineLinkCopy(mount, route);

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
            document.title = `${titleText} · Read Zen`;
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
                <article class="panel" id="translation-panel" hidden>
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
        // Load source XML + segment map in parallel. The segment map is
        // optional (graceful empty Map on 404) and keyed by lb-ID so
        // renderLinesHtml can apply per-line CSS classes like .line-row--verse.
        // Passed EXPLICITLY to the render helpers below: they are top-level
        // functions, not closures over render(), so a `var` here is invisible
        // to them (strict-mode ReferenceError — broke the rangeless and
        // first-N paths).
        const [sourceWork, segmentMap] = await Promise.all([
            loadXml(srcUrl),
            loadSegmentMap(route.workId)
        ]);

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
            // Fallback: try default community translator if no explicit one given
            if (!route.translator) {
                tCandidates.push(communityTranslationUrl(route.workId, 'Fabulu', route.corpus));
            }
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
                // Translated works: side-by-side paginated view.
                renderRangelessBilingual(sourceWork, translationWork, route, mount, segmentMap);
            } else {
                // Untranslated works: show the full text paginated.
                // No TOC-only view — clicking individual headings one by one
                // is a terrible reading experience for koan collections and
                // recorded sayings with hundreds of sections.
                renderFirstNLines(sourceWork, 30, route, mount, true, segmentMap);
            }
            shell.hideStatus();
            if (!(route.q || route.scroll || route.pos)) window.scrollTo(0, 0);
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

        document.querySelector('#source-meta').textContent = (sourceWork.titleZh || route.workId) + apparatusSummary(sourceWork.apparatus);
        const rangeSearchTerm = route.q || route.highlight || '';
        let sourceHtml = renderLinesHtml(sourceLines, segmentMap, { lineLinks: true });
        if (rangeSearchTerm) sourceHtml = highlightTextInHtml(sourceHtml, rangeSearchTerm);
        document.querySelector('#source-body').innerHTML = sourceHtml;
        attachInlineDict(document.querySelector('#source-body'));
        const srcBody = document.querySelector('#source-body');
        insertApparatusMarkers(srcBody, sourceWork.apparatus);
        attachApparatusPopup(srcBody, sourceWork.apparatus, sourceWork.witnessMap);

        // "View in Full Text" button for ranged views
        if (route.hasExplicitRange) {
            const fullBtn = document.createElement('a');
            fullBtn.className = 'btn btn--small btn--outline';
            fullBtn.style.margin = '0.5rem 1rem';
            fullBtn.textContent = 'View in Full Text';
            const scrollParam = route.startLine ? '?scroll=' + encodeURIComponent(route.startLine) : '';
            const qParam = rangeSearchTerm ? (scrollParam ? '&' : '?') + 'q=' + encodeURIComponent(rangeSearchTerm) : '';
            fullBtn.href = '#/' + route.workId + scrollParam + qParam;
            const grid = document.querySelector('#preview-grid');
            if (grid) grid.parentNode.insertBefore(fullBtn, grid);
        }

        // Always attempt to load translation (show bilingual if available).
        await renderTranslation(route, sourceLines, shell);

        shell.hideStatus();
        if (rangeSearchTerm) {
            scrollToFirstHighlight(document.querySelector('#source-body'));
        } else {
            window.scrollTo(0, 0);
        }
        window.requestAnimationFrame(syncRowHeights);

        // Bookmark button + scroll tracking
        const titleText = sourceWork.titleZh || sourceWork.titleEn || route.workId;
        mountBookmarkButton(mount, route.workId, titleText, route);
        trackScrollProgress(mount, route.workId, titleText, route);

        // In-reader Find (Ctrl+F): single-page ranged view, so allLines === sourceLines.
        mountFindBar(mount, {
            getPanel: () => document.querySelector('#source-body'),
            getAllLines: () => sourceLines,
            getPageSize: () => sourceLines.length || 1,
            getCurrentPage: () => 1,
            goToPage: () => {},
            originalSearchTerm: rangeSearchTerm
        });
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
/**
 * Side-by-side preview for a rangeless link to a translated work.
 * Small works (<200 lines) render in full; larger works paginate with
 * prev/next + page number buttons.
 */
function renderRangelessBilingual(sourceWork, translationWork, route, mount, segmentMap) {
    const pref = getPageSize(); // user-selectable lines per page (reader-prefs)
    const PAGE = pref === 'all' ? Infinity : pref;
    const allSourceLines = sliceFirstN(sourceWork.linesById, sourceWork.lineOrder, Infinity);
    const totalLines = allSourceLines.length;
    const totalPages = Math.max(1, Math.ceil(totalLines / PAGE));
    const showAll = pref === 'all' || totalLines <= Math.max(1200, PAGE);
    const searchTerm = route.q || '';
    const scrollLineId = route.scroll || '';
    const resumeLineId = !scrollLineId ? (route.pos || '') : ''; // quiet resume; explicit scroll wins
    const tranMap = translationWork.linesById;
    const pairTranslation = (lines) => lines.map((src) => {
        if (!src) return { id: '', text: '' };
        const t = tranMap && tranMap.get ? tranMap.get(src.id) : null;
        return { id: src.id, text: (t && t.text) || '' };
    });

    // Compute starting page: search both source AND translation for the term
    let currentPage = 1;
    if (!showAll && (scrollLineId || resumeLineId)) {
        currentPage = findPageForLineId(allSourceLines, scrollLineId || resumeLineId, PAGE);
    } else if (!showAll && searchTerm) {
        const srcPage = findPageForTerm(allSourceLines, searchTerm, PAGE);
        const allTranLines = pairTranslation(allSourceLines);
        const trnPage = findPageForTerm(allTranLines, searchTerm, PAGE);
        // Use whichever found a match (lower page = earlier match)
        currentPage = (srcPage === 1 && trnPage > 1) ? trnPage
                    : (trnPage === 1 && srcPage > 1) ? srcPage
                    : Math.min(srcPage, trnPage);
    }

    const titleZh = sourceWork.titleZh || route.workId;
    const titleEn = translationWork.titleEn || sourceWork.titleEn || '';

    const viewPref = readViewPref();

    function pageSlice(page) {
        if (showAll) return allSourceLines;
        const start = (page - 1) * PAGE;
        return allSourceLines.slice(start, start + PAGE);
    }

    function renderPage(page) {
        const lines = pageSlice(page);
        let srcHtml = renderLinesHtml(lines, segmentMap, { lineLinks: true });
        let trnHtml = renderLinesHtml(pairTranslation(lines), undefined, { lineLinks: true });
        if (searchTerm) {
            srcHtml = highlightTextInHtml(srcHtml, searchTerm);
            trnHtml = highlightTextInHtml(trnHtml, searchTerm);
        }
        const srcBody = document.querySelector('#source-body');
        srcBody.innerHTML = srcHtml;
        document.querySelector('#translation-body').innerHTML = trnHtml;
        attachInlineDict(srcBody);
        insertApparatusMarkers(srcBody, sourceWork.apparatus);
        attachApparatusPopup(srcBody, sourceWork.apparatus, sourceWork.witnessMap);
        window.requestAnimationFrame(syncRowHeights);
        updatePaginationUI();
        if (scrollLineId && page === findPageForLineId(allSourceLines, scrollLineId, PAGE)) {
            scrollToLineId(srcBody, scrollLineId);
        } else if (resumeLineId && page === findPageForLineId(allSourceLines, resumeLineId, PAGE)) {
            scrollToLineId(srcBody, resumeLineId, { quiet: true });
        } else if (searchTerm) {
            scrollToFirstHighlight(document.querySelector('#preview-grid') || srcBody);
        } else {
            window.scrollTo(0, 0);
        }
    }

    function updatePaginationUI() {
        const nav = document.querySelector('#page-nav');
        if (!nav) return;
        nav.innerHTML = buildPageButtons(currentPage, totalPages) + buildPageSizeSelect(pref);
        wirePageSizeSelect(nav, route);
        wirePageButtons(nav);
    }

    function wirePageButtons(nav) {
        nav.querySelectorAll('[data-page]').forEach(btn => {
            btn.addEventListener('click', () => {
                const p = parseInt(btn.dataset.page, 10);
                if (p >= 1 && p <= totalPages && p !== currentPage) {
                    currentPage = p;
                    renderPage(currentPage);
                }
            });
        });
        const jumpInput = nav.querySelector('.page-jump');
        if (jumpInput) {
            jumpInput.addEventListener('change', () => {
                const p = parseInt(jumpInput.value, 10);
                if (p >= 1 && p <= totalPages && p !== currentPage) {
                    currentPage = p;
                    renderPage(currentPage);
                }
            });
        }
    }

    const wrap = document.querySelector('#outline-wrap') || mount;
    const initLines = pageSlice(currentPage);
    let initSrcHtml = renderLinesHtml(initLines, segmentMap, { lineLinks: true });
    let initTrnHtml = renderLinesHtml(pairTranslation(initLines), undefined, { lineLinks: true });
    if (searchTerm) {
        initSrcHtml = highlightTextInHtml(initSrcHtml, searchTerm);
        initTrnHtml = highlightTextInHtml(initTrnHtml, searchTerm);
    }
    wrap.innerHTML = `
        ${buildViewToggle(viewPref)}
        ${buildTranslatorSwitcher(route)}
        <div class="preview-grid" id="preview-grid">
            <article class="panel" id="source-panel" ${viewPref === 'en' ? 'hidden' : ''}>
                <div class="panel-head">
                    <p class="panel-label">Chinese Source</p>
                    <p class="panel-meta">${escapeHtml(titleZh)}${apparatusSummary(sourceWork.apparatus)}</p>
                </div>
                <div class="panel-title">Chinese source</div>
                <div class="panel-body panel-body--source" id="source-body">
                    ${initSrcHtml}
                </div>
            </article>
            <article class="panel" id="translation-panel" ${viewPref === 'zh' ? 'hidden' : ''}>
                <div class="panel-head">
                    <p class="panel-label">Translation</p>
                    <p class="panel-meta">${escapeHtml(titleEn || 'Community translation')}</p>
                </div>
                <div class="panel-title">English rendering</div>
                <div class="panel-body" id="translation-body">
                    ${initTrnHtml}
                </div>
            </article>
        </div>
        ${!showAll ? `<nav class="page-nav" id="page-nav">${buildPageButtons(currentPage, totalPages)}</nav>` : ''}
        ${buildPassageFooter()}
    `;

    wireViewToggle(wrap);
    wireTranslatorSwitcher(wrap, route);
    mountLicenseChip(wrap.querySelector('#translator-switcher'), translationWork, route);
    if (!showAll) wirePageButtons(wrap.querySelector('#page-nav'));
    wirePageSizeSelect(wrap, route);

    window.requestAnimationFrame(syncRowHeights);
    const sourceBody = document.querySelector('#source-body');
    const translationBody = document.querySelector('#translation-body');
    attachInlineDict(sourceBody);
    insertApparatusMarkers(sourceBody, sourceWork.apparatus);
    attachApparatusPopup(sourceBody, sourceWork.apparatus, sourceWork.witnessMap);

    // Wave 2.1: dragging a selection in one pane lights up the parallel rows
    // in the other. The mirror self-detaches when the panes leave the DOM.
    if (sourceBody && translationBody) {
        attachSelectionMirror([{ root: sourceBody }, { root: translationBody }]);
    }

    if (scrollLineId) {
        scrollToLineId(sourceBody, scrollLineId);
    } else if (resumeLineId) {
        scrollToLineId(sourceBody, resumeLineId, { quiet: true });
    } else if (searchTerm) {
        scrollToFirstHighlight(document.querySelector('#preview-grid'));
    }

    mountFindBar(mount, {
        getPanel: () => document.querySelector('#source-body'),
        getAllLines: () => allSourceLines,
        getPageSize: () => PAGE,
        getCurrentPage: () => currentPage,
        goToPage: (p) => {
            if (p >= 1 && p <= totalPages && p !== currentPage) {
                currentPage = p;
                renderPage(currentPage);
            }
        },
        showAll,
        originalSearchTerm: searchTerm
    });
}

/**
 * Fall-back preview when a work has no usable headings. Shows all lines for
 * small works (<200), otherwise paginates in chunks of 50 with a "Show more"
 * button.
 */
function renderFirstNLines(sourceWork, _unused, route, mount, noTranslation, segmentMap) {
    const pref = getPageSize(); // user-selectable lines per page (reader-prefs)
    const PAGE = pref === 'all' ? Infinity : pref;
    const allLines = sliceFirstN(sourceWork.linesById, sourceWork.lineOrder, Infinity);
    const totalLines = allLines.length;
    const totalPages = Math.max(1, Math.ceil(totalLines / PAGE));
    const showAll = pref === 'all' || totalLines <= Math.max(1200, PAGE);
    const searchTerm2 = route.q || '';
    const scrollLineId2 = route.scroll || '';
    const resumeLineId2 = !scrollLineId2 ? (route.pos || '') : '';
    let currentPage = 1;
    if (!showAll && (scrollLineId2 || resumeLineId2)) {
        currentPage = findPageForLineId(allLines, scrollLineId2 || resumeLineId2, PAGE);
    } else if (!showAll && searchTerm2) {
        currentPage = findPageForTerm(allLines, searchTerm2, PAGE);
    }

    const titleZh = sourceWork.titleZh || route.workId;
    const titleEn = sourceWork.titleEn || '';
    const titleLine = titleEn
        ? `${escapeHtml(titleZh)} <span class="outline-title-en">\u00b7 ${escapeHtml(titleEn)}</span>`
        : escapeHtml(titleZh);

    const subtitle = noTranslation
        ? 'Chinese source \u2014 no English translation available yet'
        : totalLines + ' line' + (totalLines === 1 ? '' : 's');

    function pageSlice(page) {
        if (showAll) return allLines;
        const start = (page - 1) * PAGE;
        return allLines.slice(start, start + PAGE);
    }

    function renderPage(page) {
        let html = renderLinesHtml(pageSlice(page), segmentMap, { lineLinks: true });
        if (searchTerm2) html = highlightTextInHtml(html, searchTerm2);
        const body = document.querySelector('#firstn-source-body');
        body.innerHTML = html;
        attachInlineDict(body);
        insertApparatusMarkers(body, sourceWork.apparatus);
        attachApparatusPopup(body, sourceWork.apparatus, sourceWork.witnessMap);
        updateNav();
        if (scrollLineId2 && page === findPageForLineId(allLines, scrollLineId2, PAGE)) {
            scrollToLineId(body, scrollLineId2);
        } else if (resumeLineId2 && page === findPageForLineId(allLines, resumeLineId2, PAGE)) {
            scrollToLineId(body, resumeLineId2, { quiet: true });
        } else if (searchTerm2) {
            scrollToFirstHighlight(body);
        } else {
            window.scrollTo(0, 0);
        }
    }

    function updateNav() {
        const nav = document.querySelector('#page-nav');
        if (!nav) return;
        nav.innerHTML = buildPageButtons(currentPage, totalPages) + buildPageSizeSelect(pref);
        wirePageSizeSelect(nav, route);
        wireNav(nav);
    }

    function wireNav(nav) {
        nav.querySelectorAll('[data-page]').forEach(btn => {
            btn.addEventListener('click', () => {
                const p = parseInt(btn.dataset.page, 10);
                if (p >= 1 && p <= totalPages && p !== currentPage) {
                    currentPage = p;
                    renderPage(currentPage);
                }
            });
        });
        const jumpInput = nav.querySelector('.page-jump');
        if (jumpInput) {
            jumpInput.addEventListener('change', () => {
                const p = parseInt(jumpInput.value, 10);
                if (p >= 1 && p <= totalPages && p !== currentPage) {
                    currentPage = p;
                    renderPage(currentPage);
                }
            });
        }
    }

    const wrap = document.querySelector('#outline-wrap') || mount;
    let initHtml = renderLinesHtml(pageSlice(currentPage), segmentMap, { lineLinks: true });
    if (searchTerm2) initHtml = highlightTextInHtml(initHtml, searchTerm2);
    wrap.innerHTML = `
        <article class="panel outline-panel">
            <header class="outline-head">
                <h2 class="outline-title">${titleLine}</h2>
                <p class="outline-sub">${subtitle}${apparatusSummary(sourceWork.apparatus)}</p>
            </header>
            <div class="panel-body panel-body--source" id="firstn-source-body">
                ${initHtml}
            </div>
        </article>
        ${!showAll ? `<nav class="page-nav" id="page-nav">${buildPageButtons(currentPage, totalPages)}</nav>` : ''}
        ${buildPassageFooter()}
    `;
    attachInlineDict(document.querySelector('#firstn-source-body'));
    insertApparatusMarkers(document.querySelector('#firstn-source-body'), sourceWork.apparatus);
    attachApparatusPopup(document.querySelector('#firstn-source-body'), sourceWork.apparatus, sourceWork.witnessMap);
    if (!showAll) wireNav(wrap.querySelector('#page-nav'));
    wirePageSizeSelect(wrap, route);

    if (scrollLineId2) {
        scrollToLineId(document.querySelector('#firstn-source-body'), scrollLineId2);
    } else if (resumeLineId2) {
        scrollToLineId(document.querySelector('#firstn-source-body'), resumeLineId2, { quiet: true });
    } else if (searchTerm2) {
        scrollToFirstHighlight(document.querySelector('#firstn-source-body'));
    }

    mountFindBar(mount, {
        getPanel: () => document.querySelector('#firstn-source-body'),
        getAllLines: () => allLines,
        getPageSize: () => PAGE,
        getCurrentPage: () => currentPage,
        goToPage: (p) => {
            if (p >= 1 && p <= totalPages && p !== currentPage) {
                currentPage = p;
                renderPage(currentPage);
            }
        },
        showAll,
        originalSearchTerm: searchTerm2
    });
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

/**
 * Insert apparatus markers (◆) into the rendered source HTML.
 * Each marker is a <sup> with data-idx pointing into the apparatus array.
 * Only call this on the Chinese source panel, not the translation panel.
 */
function insertApparatusMarkers(container, apparatus) {
    if (!apparatus || !apparatus.length) return;
    for (let i = 0; i < apparatus.length; i += 1) {
        const entry = apparatus[i];
        if (!entry.lineId) continue;
        const row = container.querySelector(`.line-row[data-line-id="${CSS.escape(entry.lineId)}"]`);
        if (!row) continue;
        const textSpan = row.querySelector('.line-text');
        if (!textSpan) continue;
        // Insert a marker sup at the end of the line text.
        const marker = document.createElement('sup');
        marker.className = 'apparatus-marker';
        marker.dataset.idx = String(i);
        marker.textContent = '\u25C6'; // ◆
        textSpan.appendChild(marker);
    }
}

/** Currently visible apparatus popup, if any. */
let activeApparatusPopup = null;

/**
 * Attach click handler for apparatus markers on the given container.
 * Guards against duplicate listeners on the same element.
 * @param {HTMLElement} container  Source body element.
 * @param {Array} apparatus       Apparatus array from parseTei.
 */
function attachApparatusPopup(container, apparatus, witnessMap) {
    if (!apparatus || !apparatus.length) return;
    if (container._apparatusAttached) return;
    container._apparatusAttached = true;
    // Store apparatus on the element so the handler can read it after
    // pagination re-renders (the array never changes for a given work).
    container._apparatusData = apparatus;
    container.addEventListener('click', (evt) => {
        const marker = evt.target.closest('.apparatus-marker');
        if (!marker) return;
        evt.stopPropagation();
        const idx = parseInt(marker.dataset.idx, 10);
        const entry = apparatus[idx];
        if (!entry) return;
        showApparatusPopup(entry, evt.clientX, evt.clientY, witnessMap);
    });
}

function resolveWitLabel(witAttr, witnessMap) {
    if (!witAttr) return '';
    const ids = witAttr.split(/\s+/).filter(Boolean);
    const labels = ids.map(id => {
        const clean = id.replace(/^#/, '');
        if (witnessMap && witnessMap.has(clean)) return witnessMap.get(clean);
        return id;
    });
    return labels.join(', ');
}

function showApparatusPopup(entry, clickX, clickY, witnessMap) {
    dismissApparatusPopup();
    const popup = document.createElement('div');
    popup.className = 'apparatus-popup';

    let html = '';
    if (entry.lem) {
        html += `<p class="apparatus-lem"><b>Base text:</b> ${escapeHtml(entry.lem)}</p>`;
    }
    for (const rdg of entry.readings) {
        const label = resolveWitLabel(rdg.wit, witnessMap);
        const wit = label ? ` <span class="apparatus-wit">[${escapeHtml(label)}]</span>` : '';
        html += `<p class="apparatus-rdg"><b>Variant:</b> ${escapeHtml(rdg.text || '\u2014')}${wit}</p>`;
    }
    popup.innerHTML = html;
    document.body.appendChild(popup);
    activeApparatusPopup = popup;

    // Position near click, clamped to viewport (same logic as dict popup).
    popup.style.left = '0px';
    popup.style.top = '0px';
    popup.style.visibility = 'hidden';
    const rect = popup.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 8;
    let left = clickX + 4;
    let top = clickY + 16;
    if (left + rect.width > vw - margin) left = vw - rect.width - margin;
    if (left < margin) left = margin;
    if (top + rect.height > vh - margin) top = clickY - rect.height - 8;
    if (top < margin) top = margin;
    popup.style.left = left + 'px';
    popup.style.top = top + 'px';
    popup.style.visibility = '';

    // Dismiss on outside click.
    requestAnimationFrame(() => {
        document.addEventListener('click', onApparatusOutsideClick, { once: true, capture: true });
    });
}

function dismissApparatusPopup() {
    if (activeApparatusPopup) {
        activeApparatusPopup.remove();
        activeApparatusPopup = null;
    }
}

function onApparatusOutsideClick(evt) {
    if (activeApparatusPopup && !activeApparatusPopup.contains(evt.target)) {
        dismissApparatusPopup();
    } else if (activeApparatusPopup) {
        requestAnimationFrame(() => {
            document.addEventListener('click', onApparatusOutsideClick, { once: true, capture: true });
        });
    }
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

            // Mount license chip into the translation panel head if data is present.
            const head = panel.querySelector('.panel-head');
            if (head) mountLicenseChip(head, work, route);

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

// -- Per-line copy-link (delegated once per mount; content re-renders freely) --
// Copies a ?scroll= deep link for the clicked line: opens with full reading
// context, auto-pages, and scroll-highlights (the same machinery every other
// inbound line link uses).
function wireLineLinkCopy(mount, route) {
    mount._lineLinkRoute = route; // refresh per render; the listener reads live
    if (mount._lineLinkWired) return;
    mount._lineLinkWired = true;
    mount.addEventListener('click', (e) => {
        const btn = e.target && e.target.closest ? e.target.closest('.line-link') : null;
        if (!btn) return;
        e.preventDefault();
        const r = mount._lineLinkRoute;
        const hash = buildLineLinkHash(r, btn.dataset.linkId || '');
        if (!hash) return;
        const url = location.origin + location.pathname + hash;
        const done = () => {
            btn.textContent = '✓';
            btn.classList.add('line-link--copied');
            setTimeout(() => {
                btn.innerHTML = '&#128279;';
                btn.classList.remove('line-link--copied');
            }, 1200);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url).then(done).catch(() => {});
        } else {
            // Ancient-browser fallback: put the URL in the location bar territory
            // via a prompt the user can copy from.
            window.prompt('Copy link:', url);
        }
    });
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
function mountBookmarkButton(mount, fileId, title, route) {
    const rawRoute = route && route.rawRoute ? route.rawRoute : fileId;
    const saved = isInList(DEFAULT_LIST, fileId);
    const btn = document.createElement('button');
    btn.className = 'bookmark-btn';
    btn.title = 'Save to your reading list (shown on the home page)';
    btn.textContent = saved ? '\u2605 Saved to reading list' : '\u2606 Save to reading list';
    btn.addEventListener('click', () => {
        if (isInList(DEFAULT_LIST, fileId)) {
            removeFromList(DEFAULT_LIST, fileId);
            btn.textContent = '\u2606 Save to reading list';
        } else {
            addToList(DEFAULT_LIST, fileId, title, rawRoute);
            btn.textContent = '\u2605 Saved to reading list';
        }
    });
    mount.prepend(btn);
}

/** Track scroll position so the landing page can offer "Continue reading". */
function trackScrollProgress(mount, fileId, title, route) {
    const rawRoute = route && route.rawRoute ? route.rawRoute : fileId;
    let ticking = false;
    window.addEventListener('scroll', () => {
        if (ticking) return;
        ticking = true;
        window.requestAnimationFrame(() => {
            const scrollTop = window.scrollY || document.documentElement.scrollTop;
            const docHeight = document.documentElement.scrollHeight - window.innerHeight;
            const pct = docHeight > 0 ? Math.round((scrollTop / docHeight) * 100) : 0;
            // Topmost visible line: one elementFromPoint probe per throttled
            // frame, so "continue reading" can resume the exact position.
            let topLineId = '';
            const probe = document.elementFromPoint(Math.floor(window.innerWidth / 2), 110);
            const row = probe && probe.closest ? probe.closest('.line-row') : null;
            if (row && row.dataset.lineId) topLineId = row.dataset.lineId;
            setLastRead(fileId, title, pct, rawRoute, topLineId);
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
        // Toggle: remove existing popup on second click.
        const old = document.querySelector('.cite-popup');
        if (old) { old.remove(); return; }

        const title = document.querySelector('#shell-title')?.textContent || route.workId;
        const url = location.origin + location.pathname + '#/' + (route.rawRoute || route.workId);

        const popup = document.createElement('div');
        popup.className = 'cite-popup';

        // Build popup header.
        const head = document.createElement('p');
        head.className = 'cite-popup-head';
        head.textContent = 'Citation';
        popup.appendChild(head);

        // Build tab row.
        const tabRow = document.createElement('div');
        tabRow.className = 'cite-tabs';
        popup.appendChild(tabRow);

        // Citation text block.
        const citeCode = document.createElement('code');
        citeCode.className = 'cite-text cite-text--block';
        popup.appendChild(citeCode);

        // Copy button row.
        const copyRow = document.createElement('div');
        copyRow.className = 'cite-actions';
        const citeCopyBtn = document.createElement('button');
        citeCopyBtn.className = 'btn btn--small cite-copy';
        citeCopyBtn.textContent = 'Copy';
        copyRow.appendChild(citeCopyBtn);
        popup.appendChild(copyRow);

        // Track current active style.
        let activeStyle = getPreferredStyle();

        function renderStyle(style) {
            activeStyle = style;
            setPreferredStyle(style);

            // Update tab states.
            for (const tab of tabRow.querySelectorAll('.cite-tab')) {
                tab.classList.toggle('cite-tab--active', tab.dataset.style === style);
            }

            // Update citation text.
            const text = buildCitation(style, title, route.workId, url);
            citeCode.textContent = text;

            // Wire copy button.
            citeCopyBtn.onclick = () => {
                navigator.clipboard.writeText(text).then(() => {
                    citeCopyBtn.textContent = 'Copied!';
                    setTimeout(() => { citeCopyBtn.textContent = 'Copy'; }, 1500);
                });
            };
        }

        // Create tabs.
        for (const style of CITE_STYLES) {
            const tab = document.createElement('button');
            tab.className = 'cite-tab';
            tab.dataset.style = style;
            tab.textContent = style;
            tab.addEventListener('click', () => renderStyle(style));
            tabRow.appendChild(tab);
        }

        // Render initial style.
        renderStyle(activeStyle);

        citeBtn.parentElement.appendChild(popup);

        // Close popup when clicking outside.
        function onDocClick(ev) {
            if (!popup.contains(ev.target) && ev.target !== citeBtn) {
                popup.remove();
                document.removeEventListener('click', onDocClick, true);
            }
        }
        // Delay registration so the current click doesn't immediately trigger it.
        setTimeout(() => document.addEventListener('click', onDocClick, true), 0);
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

    Promise.all([
        discoverTranslators(corpus),
        fetchStarCounts(corpus)
    ]).then(([users, starCounts]) => {
        // Determine star count per translator for this work
        const translatorStars = new Map();
        for (const u of users) {
            const key = route.workId + ':' + u;
            const count = starCounts.get(key) || 0;
            translatorStars.set(u, count);
        }

        // Find most-starred translator for auto-selection
        let mostStarred = '';
        let mostStarredCount = 0;
        for (const [u, count] of translatorStars) {
            if (count > mostStarredCount) {
                mostStarred = u;
                mostStarredCount = count;
            }
        }

        users.forEach(u => {
            const opt = document.createElement('option');
            opt.value = u;
            const stars = translatorStars.get(u) || 0;
            opt.textContent = stars > 0 ? `${u} (${stars}\u2605)` : u;
            if (u === route.translator) opt.selected = true;
            select.appendChild(opt);
        });

        // Auto-select most-starred translator when none specified in URL
        if (!route.translator && mostStarred) {
            select.value = mostStarred;
            select.dispatchEvent(new Event('change'));
        } else if (!route.translator) {
            select.value = '';
        }

        const hasStars = mostStarredCount > 0;
        if (hint) hint.textContent = users.length
            ? `${users.length} translator${users.length === 1 ? '' : 's'} available` +
              (hasStars ? ` \u00b7 \u2605 = community stars` : '')
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

// ━━ License chip ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Mount a small `<a class="passage-license-chip">` into `host` describing the
 * translation's license. Renders nothing when license metadata is absent —
 * fail-open per spec, the data isn't yet on titles.jsonl for most works.
 *
 * @param {HTMLElement} host                The container to append the chip to.
 * @param {Object} translationWork          parseTei result for the translation.
 * @param {Object} route                    Active route (used for translator/author).
 */
function mountLicenseChip(host, translationWork, route) {
    if (!host || !translationWork) return;
    const license = (translationWork.license || '').trim();
    const licenseUrl = (translationWork.licenseUrl || '').trim();

    // Drop any prior chip on this host so re-renders don't stack.
    const stale = host.querySelector('.passage-license-chip, .passage-license-chip--placeholder');
    if (stale) stale.remove();

    if (!license && !licenseUrl) return; // fail-open: no chip when no data

    const shortLabel = shortenLicense(license) || 'License';
    const author = route && route.translator ? route.translator : '';

    // Defense-in-depth: only honor http(s) URLs. A community translation
    // could ship `<licence target="javascript:…">` — drop to a span chip
    // rather than execute on click.
    const safeUrl = (typeof licenseUrl === 'string' && /^https?:\/\//i.test(licenseUrl))
        ? licenseUrl : '';

    let chip;
    if (safeUrl) {
        chip = document.createElement('a');
        chip.href = safeUrl;
        chip.target = '_blank';
        chip.rel = 'noopener noreferrer';
    } else {
        chip = document.createElement('span');
    }
    chip.className = 'passage-license-chip';
    chip.textContent = shortLabel;
    const tooltipParts = [];
    if (license) tooltipParts.push(license);
    if (author) tooltipParts.push(`Translation by ${author}`);
    if (tooltipParts.length) chip.title = tooltipParts.join(' · ');
    host.appendChild(chip);
}

/**
 * Compress a verbose license string ("Creative Commons Attribution-ShareAlike
 * 4.0 International License") into a chip-friendly short form ("CC-BY-SA 4.0").
 * Returns the input verbatim when it's already short.
 */
function shortenLicense(s) {
    if (!s) return '';
    const t = s.trim();
    // Already short — pass through.
    if (t.length <= 20) return t;
    const lower = t.toLowerCase();
    // Common Creative Commons mappings. Order matters: most-specific first
    // so e.g. "Attribution-NonCommercial-ShareAlike 4.0" matches CC-BY-NC-SA
    // before the looser "Attribution-ShareAlike" pattern.
    const ccPatterns = [
        { re: /attribution[\s-]+noncommercial[\s-]+sharealike[\s-]*([0-9.]+)/i, out: (m) => `CC-BY-NC-SA ${m[1]}` },
        { re: /attribution[\s-]+noncommercial[\s-]+noderivatives?[\s-]*([0-9.]+)/i, out: (m) => `CC-BY-NC-ND ${m[1]}` },
        { re: /attribution[\s-]+noncommercial[\s-]*([0-9.]+)/i, out: (m) => `CC-BY-NC ${m[1]}` },
        { re: /attribution[\s-]+sharealike[\s-]*([0-9.]+)/i, out: (m) => `CC-BY-SA ${m[1]}` },
        { re: /attribution[\s-]+noderivatives?[\s-]*([0-9.]+)/i, out: (m) => `CC-BY-ND ${m[1]}` },
        { re: /attribution[\s-]*([0-9.]+)/i, out: (m) => `CC-BY ${m[1]}` }
    ];
    for (const p of ccPatterns) {
        const m = t.match(p.re);
        if (m) return p.out(m);
    }
    if (lower.includes('cc0') || lower.includes('public domain')) return 'Public Domain';
    // Last-ditch: take the first ~20 characters.
    return t.slice(0, 20).trim() + '…';
}

// ━━ Show-more button + footer ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// -- Lines-per-page selector (user preference; reader-prefs.js) --
function buildPageSizeSelect(pref) {
    const opts = PAGE_SIZE_OPTIONS.map((v) => {
        const label = v === 'all' ? 'All (may lag on huge texts)'
            : v === 10000 ? '10000 (slow)'
            : String(v);
        const sel = (v === pref) ? ' selected' : '';
        return `<option value="${v}"${sel}>${label}</option>`;
    }).join('');
    return `<label class="page-size-ctl">Lines per page
        <select id="page-size-select">${opts}</select></label>`;
}

function wirePageSizeSelect(container, route) {
    const sel = container.querySelector('#page-size-select');
    if (!sel) return;
    sel.addEventListener('change', () => {
        import('../lib/reader-prefs.js').then(({ setPageSize }) => {
            setPageSize(sel.value);
            // Re-render at the same reading position: capture the topmost
            // visible line and navigate to a quiet ?pos= link. replace() fires
            // hashchange only when the hash differs; reload() covers the rest.
            let topLineId = '';
            const probe = document.elementFromPoint(Math.floor(window.innerWidth / 2), 110);
            const row = probe && probe.closest ? probe.closest('.line-row') : null;
            if (row && row.dataset.lineId) topLineId = row.dataset.lineId;
            const base = '#/' + (route.rawRoute || route.workId).replace(/^\/+/, '');
            const stripped = base.replace(/([?&])(pos|scroll)=[^&]*/g, '$1').replace(/[?&]+$/, '').replace(/\?&/, '?');
            const glue = stripped.includes('?') ? '&' : '?';
            const newHash = topLineId ? stripped + glue + 'pos=' + encodeURIComponent(topLineId) : stripped;
            if (window.location.hash !== newHash) window.location.replace(newHash);
            else window.location.reload();
        });
    });
}

function buildPageButtons(current, total) {
    const btns = [];
    btns.push(`<button class="page-btn" data-page="${current - 1}" ${current <= 1 ? 'disabled' : ''}>\u2190 Prev</button>`);

    // Show first, last, current, and neighbors; ellipsis for gaps
    const pages = new Set([1, total, current, current - 1, current + 1]);
    const sorted = [...pages].filter(p => p >= 1 && p <= total).sort((a, b) => a - b);
    let last = 0;
    for (const p of sorted) {
        if (p - last > 1) btns.push('<span class="page-ellipsis">\u2026</span>');
        btns.push(`<button class="page-btn ${p === current ? 'page-btn--active' : ''}" data-page="${p}">${p}</button>`);
        last = p;
    }

    btns.push(`<button class="page-btn" data-page="${current + 1}" ${current >= total ? 'disabled' : ''}>Next \u2192</button>`);
    if (total > 5) {
        btns.push(`<input class="page-jump" type="number" min="1" max="${total}" value="${current}" title="Jump to page" />`);
    }
    btns.push(`<span class="page-info">${current} of ${total}</span>`);
    return btns.join('');
}

// ━━ In-reader Find (Ctrl+F) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Mount a per-passage Find bar (Ctrl+F / Cmd+F) onto `mount`. The bar reuses
 * the passage's pagination so matches across pages are reachable.
 *
 * @param {HTMLElement} mount  Root passage container; the find bar is appended
 *                             here and key handlers are scoped to `document`.
 * @param {Object} ctx
 * @param {() => HTMLElement} ctx.getPanel        Source body element (live).
 * @param {() => Array} ctx.getAllLines           All paginated lines.
 * @param {() => number} ctx.getPageSize          Lines per page.
 * @param {() => number} ctx.getCurrentPage       1-based current page.
 * @param {(p: number) => void} ctx.goToPage      Switches to page `p` and re-renders.
 * @param {boolean} [ctx.showAll]                 True when no pagination is in effect.
 * @param {string} [ctx.originalSearchTerm]       The ?q= term (for muted coexistence).
 */
function mountFindBar(mount, ctx) {
    // Idempotent: tear down any prior bar on this mount.
    const existing = mount.querySelector('.find-bar');
    if (existing) existing.remove();
    if (mount._findKeyHandler) {
        document.removeEventListener('keydown', mount._findKeyHandler, true);
        mount._findKeyHandler = null;
    }

    const bar = document.createElement('div');
    bar.className = 'find-bar';
    bar.hidden = true;
    bar.innerHTML = `
        <input class="find-input" type="search" placeholder="Find in passage…" aria-label="Find in passage" />
        <span class="find-counter" aria-live="polite">0 / 0</span>
        <button class="find-prev" type="button" title="Previous match (Shift+Enter)" aria-label="Previous match">‹</button>
        <button class="find-next" type="button" title="Next match (Enter)" aria-label="Next match">›</button>
        <button class="find-close" type="button" title="Close (Esc)" aria-label="Close find bar">×</button>
    `;
    mount.appendChild(bar);

    const input = bar.querySelector('.find-input');
    const counter = bar.querySelector('.find-counter');
    const prevBtn = bar.querySelector('.find-prev');
    const nextBtn = bar.querySelector('.find-next');
    const closeBtn = bar.querySelector('.find-close');

    /** Cached match list. Each match: { page, lineId, line, occurrence }. */
    let matches = [];
    let active = -1;
    let currentTerm = '';
    let lastFocusedBeforeOpen = null;

    function rebuildMatches(term) {
        matches = [];
        active = -1;
        currentTerm = term || '';
        if (!currentTerm) {
            counter.textContent = '0 / 0';
            return;
        }
        const lower = currentTerm.toLowerCase();
        const allLines = ctx.getAllLines() || [];
        const pageSize = Math.max(1, ctx.getPageSize() | 0);
        for (let i = 0; i < allLines.length; i += 1) {
            const line = allLines[i];
            if (!line || !line.text) continue;
            const text = line.text.toLowerCase();
            let from = 0;
            let occ = 0;
            while (true) {
                const idx = text.indexOf(lower, from);
                if (idx < 0) break;
                matches.push({
                    page: ctx.showAll ? 1 : (Math.floor(i / pageSize) + 1),
                    lineId: line.id,
                    occurrence: occ
                });
                occ += 1;
                from = idx + Math.max(1, lower.length);
            }
        }
        updateCounter();
    }

    function updateCounter() {
        const n = matches.length;
        counter.textContent = `${n === 0 ? 0 : active + 1} / ${n}`;
        prevBtn.disabled = n === 0;
        nextBtn.disabled = n === 0;
    }

    /** Apply find-highlight marks to the currently rendered panel. */
    function paintMarks() {
        const panel = ctx.getPanel();
        if (!panel) return;
        clearMarks(panel);
        if (!currentTerm) return;
        panel.classList.add('find-active');
        const re = buildFindRegex(currentTerm);
        if (!re) return;
        const lineSpans = panel.querySelectorAll('.line-text');
        lineSpans.forEach((span) => {
            wrapMatchesInTextNodes(span, re);
        });
    }

    function clearMarks(panel) {
        if (!panel) return;
        panel.classList.remove('find-active');
        const marks = panel.querySelectorAll('mark.find-highlight, mark.find-highlight--active');
        marks.forEach((m) => {
            const parent = m.parentNode;
            if (!parent) return;
            while (m.firstChild) parent.insertBefore(m.firstChild, m);
            parent.removeChild(m);
            parent.normalize && parent.normalize();
        });
    }

    /**
     * Walk text nodes inside `el` and wrap regex matches in <mark>. We only
     * touch text nodes so existing structure (spans, sups for apparatus, etc.)
     * is preserved — this is the same pattern that makes highlightTextInHtml
     * safe for our renderLinesHtml output but applied imperatively after the
     * DOM exists.
     */
    function wrapMatchesInTextNodes(el, re) {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
        const targets = [];
        let node = walker.nextNode();
        while (node) {
            if (node.nodeValue && re.test(node.nodeValue)) targets.push(node);
            re.lastIndex = 0;
            node = walker.nextNode();
        }
        for (const text of targets) {
            const value = text.nodeValue;
            const frag = document.createDocumentFragment();
            let last = 0;
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(value)) !== null) {
                if (m.index > last) frag.appendChild(document.createTextNode(value.slice(last, m.index)));
                const mark = document.createElement('mark');
                mark.className = 'find-highlight';
                mark.textContent = m[0];
                frag.appendChild(mark);
                last = m.index + m[0].length;
                if (m[0].length === 0) re.lastIndex += 1; // safety
            }
            if (last < value.length) frag.appendChild(document.createTextNode(value.slice(last)));
            text.parentNode.replaceChild(frag, text);
        }
    }

    function buildFindRegex(term) {
        if (!term) return null;
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(escaped, 'gi');
    }

    /** Locate the DOM mark for the active match index and pulse it. */
    function focusActiveMatch() {
        if (active < 0 || active >= matches.length) return;
        const target = matches[active];
        const panel = ctx.getPanel();
        if (!panel) return;
        // Find the row for the match's line.
        const row = panel.querySelector(`.line-row[data-line-id="${CSS.escape(target.lineId)}"]`);
        if (!row) return;
        const marksInRow = row.querySelectorAll('mark.find-highlight, mark.find-highlight--active');
        // Remove any prior active class on this panel.
        panel.querySelectorAll('mark.find-highlight--active').forEach((m) => {
            m.classList.remove('find-highlight--active');
            m.classList.add('find-highlight');
        });
        const mark = marksInRow[target.occurrence] || marksInRow[0];
        if (!mark) {
            // Fall back to scrolling the row into view.
            row.classList.add('scroll-target');
            row.scrollIntoView({ behavior: 'smooth', block: 'center' });
            setTimeout(() => row.classList.remove('scroll-target'), 2000);
            return;
        }
        mark.classList.remove('find-highlight');
        mark.classList.add('find-highlight--active');
        mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    /** Move active to `idx`, switching pages if necessary. */
    function jumpTo(idx) {
        if (!matches.length) return;
        const wrapped = ((idx % matches.length) + matches.length) % matches.length;
        active = wrapped;
        const target = matches[active];
        if (!ctx.showAll && target.page !== ctx.getCurrentPage()) {
            ctx.goToPage(target.page);
            // Double-rAF: the page's renderPage may schedule its own row-
            // height sync inside an inner rAF. Wait two frames before we
            // paint marks so we land on the settled DOM rather than a
            // mid-reflow snapshot.
            requestAnimationFrame(() => requestAnimationFrame(() => {
                paintMarks();
                updateCounter();
                focusActiveMatch();
            }));
        } else {
            paintMarks();
            updateCounter();
            focusActiveMatch();
        }
    }

    function open() {
        bar.hidden = false;
        lastFocusedBeforeOpen = document.activeElement;
        // Pre-fill from existing original search term so the user can refine.
        if (ctx.originalSearchTerm && !input.value) {
            input.value = ctx.originalSearchTerm;
            rebuildMatches(input.value);
            paintMarks();
            if (matches.length) jumpTo(0);
        }
        input.focus();
        input.select();
    }

    function close() {
        bar.hidden = true;
        // Clear the input so a subsequent open() goes through the
        // pre-fill-from-originalSearchTerm path (or starts blank), and
        // rebuildMatches doesn't think we already searched for this term.
        input.value = '';
        currentTerm = '';
        matches = [];
        active = -1;
        const panel = ctx.getPanel();
        if (panel) clearMarks(panel);
        updateCounter();
        if (lastFocusedBeforeOpen && lastFocusedBeforeOpen.focus) {
            try { lastFocusedBeforeOpen.focus(); } catch {}
        }
    }

    // Wire input events.
    let debounceTimer = null;
    input.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            rebuildMatches(input.value);
            paintMarks();
            if (matches.length) jumpTo(0);
            else updateCounter();
        }, 120);
    });

    input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
            ev.preventDefault();
            if (!matches.length) return;
            jumpTo(active < 0 ? 0 : (ev.shiftKey ? active - 1 : active + 1));
        } else if (ev.key === 'Escape') {
            ev.preventDefault();
            close();
        }
    });

    nextBtn.addEventListener('click', () => jumpTo(active < 0 ? 0 : active + 1));
    prevBtn.addEventListener('click', () => jumpTo(active < 0 ? 0 : active - 1));
    closeBtn.addEventListener('click', () => close());

    // Capture-phase Ctrl+F / Cmd+F. Self-removes when the mount has been
    // detached from the document (e.g. user routed to a different view) so
    // we don't accumulate stale handlers and break the browser-native Find
    // on subsequent views.
    const handler = (ev) => {
        if (!document.body.contains(mount)) {
            document.removeEventListener('keydown', handler, true);
            if (typeof disposeNav === 'function') disposeNav();
            return;
        }
        const isFind = (ev.ctrlKey || ev.metaKey) && (ev.key === 'f' || ev.key === 'F');
        if (!isFind) return;
        ev.preventDefault();
        if (bar.hidden) open();
        else { input.focus(); input.select(); }
    };
    document.addEventListener('keydown', handler, true);
    mount._findKeyHandler = handler;

    // Register a find navigator so global vim-style bindings (/, n, N, Esc)
    // can drive this find bar from anywhere on the page.
    const disposeNav = registerFindNavigator({
        isOpen: () => !bar.hidden,
        open,
        close,
        findNext: () => {
            if (!matches.length) return;
            jumpTo(active < 0 ? 0 : active + 1);
        },
        findPrev: () => {
            if (!matches.length) return;
            jumpTo(active < 0 ? 0 : active - 1);
        }
    });

    // Track this mount's tear-down so the router can flush all find-bar
    // handlers on a hashchange even when the user never types again.
    const dispose = () => {
        document.removeEventListener('keydown', handler, true);
        if (typeof disposeNav === 'function') {
            try { disposeNav(); } catch {}
        }
        if (mount._findKeyHandler === handler) mount._findKeyHandler = null;
        _findBarDisposers.delete(dispose);
    };
    _findBarDisposers.add(dispose);
}

function buildPassageFooter() {
    return `<div class="passage-footer">
        Full reading experience in
        <a class="text-link text-link--accent" href="https://github.com/Fabulu/ReadZen/releases">Read Zen</a>
        &middot;
        <a class="text-link" href="https://ko-fi.com/readzen">Support on Ko-fi</a>
    </div>`;
}
