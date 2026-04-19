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
    fetchText,
    fetchStarCounts
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
                // Translated works: side-by-side paginated view.
                renderRangelessBilingual(sourceWork, translationWork, route, mount);
            } else {
                // Untranslated works: show the full text paginated.
                // No TOC-only view — clicking individual headings one by one
                // is a terrible reading experience for koan collections and
                // recorded sayings with hundreds of sections.
                renderFirstNLines(sourceWork, 30, route, mount, true);
            }
            shell.hideStatus();
            window.scrollTo(0, 0);
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
        window.scrollTo(0, 0);
        window.requestAnimationFrame(syncRowHeights);

        // Bookmark button + scroll tracking
        const titleText = sourceWork.titleZh || sourceWork.titleEn || route.workId;
        mountBookmarkButton(mount, route.workId, titleText, route);
        trackScrollProgress(mount, route.workId, titleText, route);
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
    const PAGE = 50;
    let shown = Math.min(PAGE, headings.length);

    const lineOrder = sourceWork.lineOrder;
    const lastLineId = lineOrder.length > 0 ? lineOrder[lineOrder.length - 1] : '';

    const modeSuffix = route.mode === 'en' ? '/en' : '';
    const translatorSuffix = route.translator ? '/' + encodeURIComponent(route.translator) : '';

    function buildRowsHtml(rows, startIdx) {
        return rows.map((h, i) => {
            const nextHeading = headings[startIdx + i + 1];
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
    }

    const titleZh = sourceWork.titleZh || route.workId;
    const titleEn = sourceWork.titleEn || '';
    const titleLine = titleEn
        ? `${escapeHtml(titleZh)} <span class="outline-title-en">\u00b7 ${escapeHtml(titleEn)}</span>`
        : escapeHtml(titleZh);

    const totalPages = Math.max(1, Math.ceil(headings.length / PAGE));
    const showAll = headings.length <= PAGE;
    let currentPage = 1;

    function renderPage(page) {
        document.querySelector('#outline-list').innerHTML = buildRowsHtml(
            showAll ? headings : headings.slice((page - 1) * PAGE, page * PAGE),
            showAll ? 0 : (page - 1) * PAGE
        );
        updateNav();
        window.scrollTo(0, 0);
    }

    function updateNav() {
        const nav = document.querySelector('#outline-nav');
        if (!nav) return;
        nav.innerHTML = buildPageButtons(currentPage, totalPages);
        wireOutlineNav(nav);
    }

    function wireOutlineNav(nav) {
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
    wrap.innerHTML = `
        <article class="panel outline-panel">
            <header class="outline-head">
                <h2 class="outline-title">${titleLine}</h2>
                <p class="outline-sub">Table of contents \u00b7 ${headings.length} section${headings.length === 1 ? '' : 's'}</p>
            </header>
            <div class="outline-list" id="outline-list">
                ${buildRowsHtml(showAll ? headings : headings.slice(0, PAGE), 0)}
            </div>
            ${!showAll ? `<nav class="page-nav" id="outline-nav">${buildPageButtons(1, totalPages)}</nav>` : ''}
        </article>
    `;

    if (!showAll) wireOutlineNav(wrap.querySelector('#outline-nav'));
}

/**
 * Side-by-side preview for a rangeless link to a translated work.
 * Small works (<200 lines) render in full; larger works paginate with
 * prev/next + page number buttons.
 */
function renderRangelessBilingual(sourceWork, translationWork, route, mount) {
    const PAGE = 50;
    const allSourceLines = sliceFirstN(sourceWork.linesById, sourceWork.lineOrder, Infinity);
    const totalLines = allSourceLines.length;
    const totalPages = Math.max(1, Math.ceil(totalLines / PAGE));
    const showAll = totalLines <= 200;
    let currentPage = 1;

    const tranMap = translationWork.linesById;
    const pairTranslation = (lines) => lines.map((src) => {
        if (!src) return { id: '', text: '' };
        const t = tranMap && tranMap.get ? tranMap.get(src.id) : null;
        return { id: src.id, text: (t && t.text) || '' };
    });

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
        document.querySelector('#source-body').innerHTML = renderLinesHtml(lines);
        document.querySelector('#translation-body').innerHTML = renderLinesHtml(pairTranslation(lines));
        attachInlineDict(document.querySelector('#source-body'));
        window.requestAnimationFrame(syncRowHeights);
        updatePaginationUI();
        window.scrollTo(0, 0);
    }

    function updatePaginationUI() {
        const nav = document.querySelector('#page-nav');
        if (!nav) return;
        nav.innerHTML = buildPageButtons(currentPage, totalPages);
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
    const initLines = pageSlice(1);
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
                    ${renderLinesHtml(initLines)}
                </div>
            </article>
            <article class="panel" id="translation-panel" ${viewPref === 'zh' ? 'hidden' : ''}>
                <div class="panel-head">
                    <p class="panel-label">Translation</p>
                    <p class="panel-meta">${escapeHtml(titleEn || 'Community translation')}</p>
                </div>
                <div class="panel-title">English rendering</div>
                <div class="panel-body" id="translation-body">
                    ${renderLinesHtml(pairTranslation(initLines))}
                </div>
            </article>
        </div>
        ${!showAll ? `<nav class="page-nav" id="page-nav">${buildPageButtons(1, totalPages)}</nav>` : ''}
        ${buildPassageFooter()}
    `;

    wireViewToggle(wrap);
    wireTranslatorSwitcher(wrap, route);
    if (!showAll) wirePageButtons(wrap.querySelector('#page-nav'));

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
    const totalPages = Math.max(1, Math.ceil(totalLines / PAGE));
    const showAll = totalLines <= 200;
    let currentPage = 1;

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
        document.querySelector('#firstn-source-body').innerHTML = renderLinesHtml(pageSlice(page));
        attachInlineDict(document.querySelector('#firstn-source-body'));
        updateNav();
        window.scrollTo(0, 0);
    }

    function updateNav() {
        const nav = document.querySelector('#page-nav');
        if (!nav) return;
        nav.innerHTML = buildPageButtons(currentPage, totalPages);
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
    wrap.innerHTML = `
        <article class="panel outline-panel">
            <header class="outline-head">
                <h2 class="outline-title">${titleLine}</h2>
                <p class="outline-sub">${subtitle}</p>
            </header>
            <div class="panel-body panel-body--source" id="firstn-source-body">
                ${renderLinesHtml(pageSlice(1))}
            </div>
        </article>
        ${!showAll ? `<nav class="page-nav" id="page-nav">${buildPageButtons(1, totalPages)}</nav>` : ''}
        ${buildPassageFooter()}
    `;
    attachInlineDict(document.querySelector('#firstn-source-body'));
    if (!showAll) wireNav(wrap.querySelector('#page-nav'));
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
            setLastRead(fileId, title, pct, rawRoute);
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

// ━━ Show-more button + footer ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function buildShowMoreBtn(shown, total) {
    return `<div class="show-more-wrap" id="show-more-wrap">
        <button class="btn show-more-btn" id="show-more-btn">Show more (${shown} of ${total} shown)</button>
    </div>`;
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

function buildPassageFooter() {
    return `<div class="passage-footer">
        Full reading experience in
        <a class="text-link text-link--accent" href="https://github.com/Fabulu/ReadZen/releases">Read Zen</a>
        &middot;
        <a class="text-link" href="https://ko-fi.com/readzen">Support on Ko-fi</a>
    </div>`;
}
