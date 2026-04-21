// views/search.js
// Title-only search across the CBETA and OpenZen corpora.
// Empty search shows all titles (filtered by translation status).
// Results are paginated with prev/next and jump-to-page controls.

import { escapeHtml } from '../lib/format.js';
import { DATA_REPO_BASE, OPEN_DATA_REPO_BASE, loadTranslatedFileIds } from '../lib/github.js';
import { inferCorpusForRelPath } from '../lib/corpus.js';
import { loadAllTitlesAsArray } from '../lib/titles.js';

const TITLES_URL = DATA_REPO_BASE + 'titles.jsonl';
const OPEN_TITLES_URL = OPEN_DATA_REPO_BASE + 'titles.jsonl';
const PAGE_SIZE = 50;

// ── Session tracking for support prompt ──
let resultClickedThisSession = false;

export function match(route) {
    return route && route.kind === 'search';
}

export function preferAppFirst(_route) { return false; }

export async function render(route, mount, shell) {
    const initialQuery = (route.q || '').trim();
    const cf = (route.corpus || '').trim();
    const cfLower = cf.toLowerCase();
    const cfNamed =
        cfLower === 'cbeta' ? 'cbeta' :
        (cfLower === 'openzen' || cfLower === 'open' || cfLower === 'o') ? 'openzen' :
        null;
    const corpusLabel = cfNamed === 'cbeta'
        ? 'CBETA'
        : (cfNamed === 'openzen' ? 'OpenZen' : (cf || ''));

    shell.setTitle(initialQuery ? 'Search \u00b7 ' + initialQuery : 'Search');
    shell.setContext(
        initialQuery ? 'Searching for "' + initialQuery + '"' : 'Search CBETA + OpenZen',
        corpusLabel ? 'Corpus: ' + corpusLabel : 'Browse and search work titles.'
    );
    shell.setUpsell(
        'The desktop app gives you ' +
        'instant jump-to-passage with ZH/EN side-by-side, the full ' +
        'reading and translation workflow, and the ability to share ' +
        'search links like this one.'
    );
    shell.setExtraLink('titles.jsonl', cfNamed === 'openzen' ? OPEN_TITLES_URL : TITLES_URL);

    // Default to "translated" filter when no query is provided (first-time visitors
    // see English-available texts immediately).
    const defaultFilter = initialQuery ? 'all' : 'translated';

    mount.innerHTML =
        '<section class="list-wrap search-wrap">' +
            '<form class="search-form" id="search-form" autocomplete="off">' +
                '<input class="search-input" id="search-input" type="text" ' +
                    'placeholder="Search titles or full text\u2026" ' +
                    'value="' + escapeHtml(initialQuery) + '" />' +
                '<button class="btn btn--small" type="submit">Search</button>' +
            '</form>' +
            '<div class="search-filters">' +
                '<div class="search-mode-toggle">' +
                    '<label class="search-filter-label">' +
                        '<input type="radio" name="search-mode" value="titles" checked /> Titles' +
                    '</label>' +
                    '<label class="search-filter-label">' +
                        '<input type="radio" name="search-mode" value="fulltext" /> Full Text' +
                    '</label>' +
                '</div>' +
                '<div class="search-filter-separator"></div>' +
                '<label class="search-filter-label">' +
                    '<input type="radio" name="trans-filter" value="all"' + (defaultFilter === 'all' ? ' checked' : '') + ' /> All' +
                '</label>' +
                '<label class="search-filter-label">' +
                    '<input type="radio" name="trans-filter" value="translated"' + (defaultFilter === 'translated' ? ' checked' : '') + ' /> Translated' +
                '</label>' +
                '<label class="search-filter-label">' +
                    '<input type="radio" name="trans-filter" value="untranslated"' + (defaultFilter === 'untranslated' ? ' checked' : '') + ' /> Untranslated' +
                '</label>' +
                '<label class="search-filter-label search-filter-zen">' +
                    '<input type="checkbox" id="zen-only" /> Zen texts only' +
                '</label>' +
            '</div>' +
            '<header class="list-head">' +
                '<h2 class="list-title" id="search-title">Results</h2>' +
                '<p class="list-sub" id="search-sub"></p>' +
            '</header>' +
            '<div class="list-body" id="search-body"></div>' +
            '<nav class="page-nav" id="search-nav" hidden></nav>' +
        '</section>';

    const form = document.querySelector('#search-form');
    const input = document.querySelector('#search-input');
    const body = document.querySelector('#search-body');
    const subEl = document.querySelector('#search-sub');
    const titleEl = document.querySelector('#search-title');
    const navEl = document.querySelector('#search-nav');
    const filterRadios = mount.querySelectorAll('input[name="trans-filter"]');
    const zenCheckbox = document.querySelector('#zen-only');

    // ── Search mode state ──
    let searchMode = 'titles'; // 'titles' or 'fulltext'
    let pagefindLoaded = null;

    const modeRadios = mount.querySelectorAll('input[name="search-mode"]');
    modeRadios.forEach(function(r) {
        r.addEventListener('change', function() {
            searchMode = r.value;
            doSearch(input.value, 1);
        });
    });

    shell.setStatus('Loading titles\u2026', 'Downloading the title index.', false);

    let titles;
    let translatedIds = new Set();
    let zenIds = new Set();
    try {
        const [titlesResult, idsResult, zenResult] = await Promise.all([
            loadAllTitlesAsArray(),
            loadTranslatedFileIds(),
            fetch(DATA_REPO_BASE + 'zen_texts.json').then(function(r) {
                if (!r.ok) return [];
                return r.json().then(function(data) {
                    // Extract fileIds from paths like "T/T48/T48n2005.xml" -> "T48n2005"
                    return (data.Zen || data.zen || []).map(function(p) {
                        var fname = p.split('/').pop() || '';
                        return fname.replace(/\.xml$/i, '');
                    });
                });
            }).catch(function() { return []; })
        ]);
        titles = titlesResult;
        translatedIds = idsResult;
        zenIds = new Set(zenResult);
    } catch (error) {
        shell.showError(
            'Search index unavailable',
            (error && error.message) || 'Could not load titles.jsonl from the translations repo.'
        );
        return;
    }

    shell.hideStatus();

    function getTransFilter() {
        for (const r of filterRadios) { if (r.checked) return r.value; }
        return 'all';
    }

    function getWorkId(t) {
        const path = (t.path || t.Path || '').toString();
        return (t.fileId || t.fileID || t.workId || t.WorkId || deriveWorkIdFromPath(path));
    }

    function isTranslated(t) {
        return translatedIds.has(getWorkId(t));
    }

    // ── Current search state ──
    let lastResults = [];
    let currentPage = 1;

    function doSearch(query, page) {
        const trimmed = (query || '').trim();

        // Empty query always falls back to title browse
        if (!trimmed) {
            searchMode = 'titles';
            var titlesRadio = mount.querySelector('input[name="search-mode"][value="titles"]');
            if (titlesRadio) titlesRadio.checked = true;
        }

        if (searchMode === 'fulltext' && trimmed) {
            doFullTextSearch(trimmed, page);
            return;
        }

        const transFilter = getTransFilter();
        const lower = trimmed.toLowerCase();

        // Build filtered results (no cap — pagination handles display)
        const results = [];
        for (const t of titles) {
            if (!t) continue;
            const path = (t.path || t.Path || '').toString();
            if (cfNamed) {
                if ((t.corpus || inferCorpusForRelPath(path)) !== cfNamed) continue;
            } else if (cf && /^[A-Za-z]$/.test(cf)) {
                if (path.charAt(0).toUpperCase() !== cf.toUpperCase()) continue;
            }
            if (transFilter === 'translated' && !isTranslated(t)) continue;
            if (transFilter === 'untranslated' && isTranslated(t)) continue;
            if (zenCheckbox && zenCheckbox.checked && !zenIds.has(getWorkId(t))) continue;

            if (trimmed) {
                const zh = (t.zh || t.Zh || '').toString();
                const en = (t.en || t.En || '').toString();
                const enShort = (t.enShort || t.EnShort || '').toString();
                const blob = (zh + ' ' + en + ' ' + enShort + ' ' + path).toLowerCase();
                if (!blob.includes(lower)) continue;
            }
            results.push(t);
        }

        lastResults = results;
        currentPage = Math.max(1, Math.min(page || 1, Math.ceil(results.length / PAGE_SIZE) || 1));

        // Title
        if (trimmed) {
            titleEl.textContent = 'Results for "' + trimmed + '"';
        } else {
            var filterLabel = transFilter === 'translated' ? 'Translated texts'
                : transFilter === 'untranslated' ? 'Untranslated texts' : 'All texts';
            titleEl.textContent = filterLabel;
        }

        if (results.length === 0) {
            body.innerHTML = '';
            navEl.hidden = true;
            subEl.textContent = '0 matches';
            body.innerHTML = '<div class="list-empty"><p>No titles match' +
                (trimmed ? ' <strong>' + escapeHtml(trimmed) + '</strong>' : '') +
                (corpusLabel ? ' in corpus ' + escapeHtml(corpusLabel) : '') +
                ' with this filter.</p></div>';
            return;
        }

        subEl.textContent = results.length + ' text' + (results.length === 1 ? '' : 's');
        renderPage();
    }

    function renderPage() {
        const totalPages = Math.max(1, Math.ceil(lastResults.length / PAGE_SIZE));
        const start = (currentPage - 1) * PAGE_SIZE;
        const pageItems = lastResults.slice(start, start + PAGE_SIZE);

        body.innerHTML = pageItems.map(function(t) {
            var zh = (t.zh || t.Zh || '').toString();
            var en = (t.en || t.En || '').toString();
            var enShort = (t.enShort || t.EnShort || '').toString();
            var path = (t.path || t.Path || '').toString();
            var workId = getWorkId(t);
            var href = workId ? '#/' + workId : '#';
            var enLine = en || enShort;
            var translated = translatedIds.has(workId);
            var isOpenZen = t.corpus === 'openzen';
            var badges = '';
            if (translated) badges += '<span class="search-row-badge">EN</span>';
            if (isOpenZen) badges += '<span class="search-row-badge search-row-badge--oz">OZ</span>';

            // Clean display ID: "ws.gateless-barrier" → "Gateless Barrier" if we have a title
            var displayId = workId || '\u2014';
            if (isOpenZen && (enLine || zh)) {
                displayId = ''; // hide cryptic ID when we have a title
            }

            return '<a class="search-row" href="' + escapeHtml(href) + '">' +
                (displayId ? '<span class="search-row-id">' + escapeHtml(displayId) + '</span>' : '<span class="search-row-id search-row-id--oz">OpenZen</span>') +
                '<span class="search-row-text">' +
                    '<span class="search-row-zh">' + escapeHtml(zh || '[no title]') + '</span>' +
                    (enLine ? '<span class="search-row-en">' + escapeHtml(enLine) + '</span>' : '') +
                '</span>' +
                badges +
                '<span class="search-row-path">' + escapeHtml(path) + '</span>' +
            '</a>';
        }).join('');

        // Track clicks on results to gate the support prompt
        body.querySelectorAll('.search-row').forEach(function(row) {
            row.addEventListener('click', function() { resultClickedThisSession = true; });
        });

        // Pagination
        if (totalPages > 1) {
            navEl.hidden = false;
            navEl.innerHTML = buildPageNav(currentPage, totalPages);
            wirePageNav();
        } else {
            navEl.hidden = true;
        }

        maybeShowSupportPrompt(body);
        window.scrollTo(0, 0);
    }

    function buildPageNav(current, total) {
        var btns = [];
        btns.push('<button class="page-btn" data-page="' + (current - 1) + '"' + (current <= 1 ? ' disabled' : '') + '>\u2190 Prev</button>');
        var pages = new Set([1, total, current, current - 1, current + 1]);
        var sorted = Array.from(pages).filter(function(p) { return p >= 1 && p <= total; }).sort(function(a, b) { return a - b; });
        var last = 0;
        for (var i = 0; i < sorted.length; i++) {
            var p = sorted[i];
            if (p - last > 1) btns.push('<span class="page-ellipsis">\u2026</span>');
            btns.push('<button class="page-btn' + (p === current ? ' page-btn--active' : '') + '" data-page="' + p + '">' + p + '</button>');
            last = p;
        }
        btns.push('<button class="page-btn" data-page="' + (current + 1) + '"' + (current >= total ? ' disabled' : '') + '>Next \u2192</button>');
        if (total > 5) {
            btns.push('<input class="page-jump" type="number" min="1" max="' + total + '" value="' + current + '" title="Jump to page" />');
        }
        btns.push('<span class="page-info">' + current + ' of ' + total + '</span>');
        return btns.join('');
    }

    function wirePageNav() {
        navEl.querySelectorAll('[data-page]').forEach(function(btn) {
            btn.addEventListener('click', function() {
                var p = parseInt(btn.dataset.page, 10);
                var totalPages = Math.ceil(lastResults.length / PAGE_SIZE);
                if (p >= 1 && p <= totalPages && p !== currentPage) {
                    currentPage = p;
                    renderPage();
                }
            });
        });
        var jumpInput = navEl.querySelector('.page-jump');
        if (jumpInput) {
            jumpInput.addEventListener('change', function() {
                var p = parseInt(jumpInput.value, 10);
                var totalPages = Math.ceil(lastResults.length / PAGE_SIZE);
                if (p >= 1 && p <= totalPages && p !== currentPage) {
                    currentPage = p;
                    renderPage();
                }
            });
        }
    }

    // ── Full-text search via Pagefind ──
    async function doFullTextSearch(q, page) {
        // Lazy-load Pagefind
        if (!pagefindLoaded) {
            try {
                body.innerHTML = '<p class="muted" style="padding:12px;">Loading search index\u2026</p>';
                pagefindLoaded = await import('/pagefind/pagefind.js');
                await pagefindLoaded.options({ excerptLength: 20 });
            } catch (err) {
                body.innerHTML = '<p class="search-error">Full-text search index not available. Try title search.</p>';
                console.error('Pagefind load failed:', err);
                navEl.hidden = true;
                return;
            }
        }

        body.innerHTML = '<p class="muted" style="padding:12px;">Searching full corpus\u2026</p>';

        try {
            const filters = {};
            if (zenCheckbox && zenCheckbox.checked) filters.zen = 'true';
            var transRadio = mount.querySelector('input[name="trans-filter"]:checked');
            if (transRadio && transRadio.value === 'translated') filters.translated = 'true';
            if (transRadio && transRadio.value === 'untranslated') filters.translated = 'false';

            var search = await pagefindLoaded.search(q, { filters });

            var pageSize = PAGE_SIZE;
            var totalPages = Math.ceil(search.results.length / pageSize) || 1;
            var safePage = Math.max(1, Math.min(page || 1, totalPages));
            var start = (safePage - 1) * pageSize;
            var pageResults = search.results.slice(start, start + pageSize);

            var loaded = await Promise.all(pageResults.map(function(r) { return r.data(); }));

            // Update header
            titleEl.textContent = 'Full-text results for \u201c' + q + '\u201d';
            subEl.textContent = search.results.length + ' result' + (search.results.length === 1 ? '' : 's');
            shell.setContext(
                'Full-text search',
                search.results.length + ' results for \u201c' + q + '\u201d'
            );

            if (loaded.length === 0) {
                body.innerHTML = '<div class="list-empty"><p>No results found in full text.</p></div>';
                navEl.hidden = true;
                return;
            }

            body.innerHTML = loaded.map(function(r) {
                var meta = r.meta || {};
                var title = meta.title || meta.file_id || 'Unknown';
                var titleEn = meta.title_en || '';
                var fileId = meta.file_id || '';
                var href = fileId ? '#/' + fileId : '#';
                var excerpt = r.excerpt || '';

                return '<a class="search-row search-row--fulltext" href="' + escapeHtml(href) + '">' +
                    (fileId ? '<span class="search-row-id">' + escapeHtml(fileId) + '</span>' : '') +
                    '<span class="search-row-text">' +
                        '<span class="search-row-zh">' + escapeHtml(title) + '</span>' +
                        (titleEn ? '<span class="search-row-en">' + escapeHtml(titleEn) + '</span>' : '') +
                    '</span>' +
                    '<div class="search-row-excerpt">' + excerpt + '</div>' +
                '</a>';
            }).join('');

            // Track clicks on full-text results to gate the support prompt
            body.querySelectorAll('.search-row').forEach(function(row) {
                row.addEventListener('click', function() { resultClickedThisSession = true; });
            });
            maybeShowSupportPrompt(body);

            // Pagination
            if (totalPages > 1) {
                navEl.hidden = false;
                navEl.innerHTML = buildPageNav(safePage, totalPages);
                // Wire pagination for full-text mode
                navEl.querySelectorAll('[data-page]').forEach(function(btn) {
                    btn.addEventListener('click', function() {
                        var p = parseInt(btn.dataset.page, 10);
                        if (p >= 1 && p <= totalPages && p !== safePage) {
                            doFullTextSearch(q, p);
                        }
                    });
                });
                var jumpInput = navEl.querySelector('.page-jump');
                if (jumpInput) {
                    jumpInput.addEventListener('change', function() {
                        var p = parseInt(jumpInput.value, 10);
                        if (p >= 1 && p <= totalPages && p !== safePage) {
                            doFullTextSearch(q, p);
                        }
                    });
                }
            } else {
                navEl.hidden = true;
            }

            window.scrollTo(0, 0);
        } catch (err) {
            body.innerHTML = '<p class="search-error">Search failed: ' + escapeHtml(err.message) + '</p>';
            console.error('Pagefind search error:', err);
        }
    }

    form.addEventListener('submit', function(e) {
        e.preventDefault();
        var q = input.value;
        var corpusParam = cf ? '&corpus=' + encodeURIComponent(cf) : '';
        var newHash = '#/search' + (q ? '?q=' + encodeURIComponent(q) + corpusParam : '');
        if (window.location.hash !== newHash) {
            window.history.replaceState(null, '', newHash);
        }
        doSearch(q, 1);
    });

    // Re-run search when filter changes
    filterRadios.forEach(function(r) {
        r.addEventListener('change', function() { doSearch(input.value, 1); });
    });
    if (zenCheckbox) {
        zenCheckbox.addEventListener('change', function() { doSearch(input.value, 1); });
    }

    // Initial search — empty query with "translated" filter shows all translated texts
    doSearch(initialQuery, 1);
}

/**
 * Show a subtle inline support prompt at the bottom of the results list,
 * but only after the user has clicked through to at least one result.
 */
function maybeShowSupportPrompt(container) {
    if (!resultClickedThisSession) return;

    var key = 'readzen-support-dismissed';
    var dismissed = localStorage.getItem(key);
    if (dismissed) {
        var ts = parseInt(dismissed, 10);
        if (Date.now() - ts < 30 * 24 * 3600 * 1000) return; // 30 day cooldown
    }

    // Only show once per page render
    if (container.querySelector('.support-prompt')) return;

    var div = document.createElement('div');
    div.className = 'support-prompt';
    div.innerHTML =
        '<span class="support-prompt-text">ReadZen is free and open source.</span>' +
        ' <a href="#" class="support-prompt-link" id="support-prompt-link">\u2661 Support on Ko-fi</a>' +
        ' <button class="support-prompt-dismiss" aria-label="Dismiss">\u00d7</button>';
    container.appendChild(div);

    div.querySelector('.support-prompt-dismiss').addEventListener('click', function() {
        div.remove();
        localStorage.setItem(key, String(Date.now()));
    });

    div.querySelector('#support-prompt-link').addEventListener('click', function(e) {
        e.preventDefault();
        var supportBtn = document.querySelector('#support-btn');
        if (supportBtn) supportBtn.click();
    });
}

/** Best-effort workId extraction from a relative path. */
function deriveWorkIdFromPath(path) {
    if (!path) return '';
    var normalized = path.replace(/\\/g, '/');
    var parts = normalized.split('/').filter(Boolean);
    if (inferCorpusForRelPath(normalized) === 'openzen' && parts.length >= 2) {
        return parts[0] + '.' + parts[1];
    }
    var file = parts.pop() || '';
    return file.replace(/\.xml$/i, '');
}
