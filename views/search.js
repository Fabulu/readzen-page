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
        'This is a title-only preview. The desktop app gives you ' +
        '<strong>full-text search across both corpora</strong>, ' +
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
                    'placeholder="Search work titles\u2026" ' +
                    'value="' + escapeHtml(initialQuery) + '" />' +
                '<button class="btn btn--small" type="submit">Search</button>' +
            '</form>' +
            '<div class="search-filters">' +
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
                '<span class="search-filter-hint">Full-text search in the ' +
                    '<a class="text-link text-link--accent" href="https://github.com/Fabulu/ReadZen/releases">desktop app</a>' +
                '</span>' +
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

    shell.setStatus('Loading titles\u2026', 'Downloading the title index.', false);

    let titles;
    let translatedIds = new Set();
    let zenIds = new Set();
    try {
        const [titlesResult, idsResult, zenResult] = await Promise.all([
            loadAllTitlesAsArray(),
            loadTranslatedFileIds(),
            fetch('zen-texts.json').then(function(r) { return r.ok ? r.json() : []; }).catch(function() { return []; })
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

        // Pagination
        if (totalPages > 1) {
            navEl.hidden = false;
            navEl.innerHTML = buildPageNav(currentPage, totalPages);
            wirePageNav();
        } else {
            navEl.hidden = true;
        }

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
