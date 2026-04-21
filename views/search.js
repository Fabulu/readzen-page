// views/search.js
// Federated search across Masters, Titles, and Full-text.
// Empty search shows all titles (filtered by translation status).
// Active query shows three stacked sections: Masters, Titles, Full-text.

import { escapeHtml } from '../lib/format.js';
import { DATA_REPO_BASE, OPEN_DATA_REPO_BASE, loadTranslatedFileIds } from '../lib/github.js';
import { inferCorpusForRelPath } from '../lib/corpus.js';
import { loadAllTitlesAsArray } from '../lib/titles.js';
import { federatedSearch } from '../lib/search.js';
import { loadMasters } from './master.js';

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
    const corpusFilter = cfNamed || '';

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

    shell.setStatus('Loading titles\u2026', 'Downloading the title index.', false);

    let titles;
    let translatedIds = new Set();
    let zenIds = new Set();
    let mastersData = [];
    try {
        const [titlesResult, idsResult, zenResult, mastersResult] = await Promise.all([
            loadAllTitlesAsArray(),
            loadTranslatedFileIds(),
            fetch(DATA_REPO_BASE + 'zen_texts.json').then(function(r) {
                if (!r.ok) return [];
                return r.json().then(function(data) {
                    return (data.Zen || data.zen || []).map(function(p) {
                        var fname = p.split('/').pop() || '';
                        return fname.replace(/\.xml$/i, '');
                    });
                });
            }).catch(function() { return []; }),
            loadMasters().catch(function() { return []; })
        ]);
        titles = titlesResult;
        translatedIds = idsResult;
        zenIds = new Set(zenResult);
        mastersData = mastersResult || [];
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

    function isZenOnly() {
        return zenCheckbox && zenCheckbox.checked;
    }

    // ── Current search state ──
    let lastResults = [];
    let currentPage = 1;

    async function doSearch(query, page) {
        const trimmed = (query || '').trim();

        // Empty query: show all titles (existing browse behavior)
        if (!trimmed) {
            doBrowseAll(page);
            return;
        }

        const masterFilter = route.master || '';
        // Map filter radio values to the 'true'/'false'/undefined expected by lib/search.js
        var transVal = getTransFilter();
        var transParam = transVal === 'translated' ? 'true'
            : transVal === 'untranslated' ? 'false'
            : undefined;
        const results = await federatedSearch(trimmed, {
            masters: mastersData,
            titles: titles,
            filters: {
                translated: transParam,
                zen: isZenOnly(),
                corpus: corpusFilter
            },
            masterFilter: masterFilter
        });

        renderFederatedResults(trimmed, results, page);
    }

    /** Browse all titles with filters (no query). */
    function doBrowseAll(page) {
        const transFilter = getTransFilter();

        titleEl.textContent = transFilter === 'translated' ? 'Translated texts'
            : transFilter === 'untranslated' ? 'Untranslated texts' : 'All texts';

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
            if (isZenOnly() && !zenIds.has(getWorkId(t))) continue;
            results.push(t);
        }

        lastResults = results;
        currentPage = Math.max(1, Math.min(page || 1, Math.ceil(results.length / PAGE_SIZE) || 1));

        if (results.length === 0) {
            body.innerHTML = '';
            navEl.hidden = true;
            subEl.textContent = '0 matches';
            body.innerHTML = '<div class="list-empty"><p>No titles match' +
                (corpusLabel ? ' in corpus ' + escapeHtml(corpusLabel) : '') +
                ' with this filter.</p></div>';
            return;
        }

        subEl.textContent = results.length + ' text' + (results.length === 1 ? '' : 's');
        renderBrowsePage();
    }

    function renderBrowsePage() {
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

            var displayId = workId || '\u2014';
            if (isOpenZen && (enLine || zh)) {
                displayId = '';
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

    /** Render federated results in three stacked sections. */
    function renderFederatedResults(query, results, page) {
        var html = '';

        // Master filter chip
        if (route.master) {
            var masterName = route.master.replace(/_/g, ' ');
            html += '<div class="search-filter-chip">' +
                'Filtered by: ' + escapeHtml(masterName) +
                ' <a href="#/search?q=' + encodeURIComponent(query) + '">\u00d7</a>' +
                '</div>';
        }

        // Section 1: Masters (if any match)
        if (results.masters.length > 0) {
            html += '<div class="search-section-label">Zen Masters</div>';
            html += '<div class="search-masters-strip">';
            for (var i = 0; i < results.masters.length; i++) {
                var m = results.masters[i];
                var name = (m.names && m.names[0]) || '';
                var slug = name.replace(/ /g, '_');
                var zh = (m.names && m.names[1]) || '';
                var dates = m.death ? 'd. ' + m.death : (m.floruit ? 'fl. ' + m.floruit : '');
                html += '<a class="search-master-card" href="#/master/' + encodeURIComponent(slug) + '">';
                html += '<span class="search-master-name">' + escapeHtml(name) + '</span>';
                if (zh) html += ' <span class="search-master-zh">' + escapeHtml(zh) + '</span>';
                html += '<span class="search-master-meta">' + escapeHtml([m.school, dates].filter(Boolean).join(' \u00b7 ')) + '</span>';
                html += '</a>';
            }
            html += '</div>';
        }

        // Section 2: Title matches (paginated)
        if (results.titles.length > 0) {
            html += '<div class="search-section-label">Title Matches (' + results.titles.length + ')</div>';
            var pageSize = 30;
            var totalPages = Math.ceil(results.titles.length / pageSize);
            var safePage = Math.max(1, Math.min(page || 1, totalPages));
            var start = (safePage - 1) * pageSize;
            var pageItems = results.titles.slice(start, start + pageSize);

            for (var j = 0; j < pageItems.length; j++) {
                var t = pageItems[j];
                var fileId = t.fileId || t.fileID || t.workId || '';
                var href = fileId ? '#/' + fileId : '#';
                var tZh = (t.zh || t.Zh || '').toString();
                var tEn = (t.en || t.En || t.enShort || t.EnShort || '').toString();
                var tPath = (t.path || t.Path || '').toString();
                var tTranslated = translatedIds.has(fileId);
                var tIsOpenZen = t.corpus === 'openzen';
                var tBadges = '';
                if (tTranslated) tBadges += '<span class="search-row-badge">EN</span>';
                if (tIsOpenZen) tBadges += '<span class="search-row-badge search-row-badge--oz">OZ</span>';

                var tDisplayId = fileId || '\u2014';
                if (tIsOpenZen && (tEn || tZh)) {
                    tDisplayId = '';
                }

                html += '<a class="search-row" href="' + escapeHtml(href) + '">';
                html += (tDisplayId ? '<span class="search-row-id">' + escapeHtml(tDisplayId) + '</span>' : '<span class="search-row-id search-row-id--oz">OpenZen</span>');
                html += '<span class="search-row-text">';
                html += '<span class="search-row-zh">' + escapeHtml(tZh || '[no title]') + '</span>';
                if (tEn) html += '<span class="search-row-en">' + escapeHtml(tEn) + '</span>';
                html += '</span>';
                html += tBadges;
                html += '<span class="search-row-path">' + escapeHtml(tPath) + '</span>';
                html += '</a>';
            }

            // Pagination for titles
            if (totalPages > 1) {
                html += '<nav class="page-nav" id="title-page-nav">';
                html += buildTitlePagination(safePage, totalPages, query);
                html += '</nav>';
            }
        } else {
            html += '<div class="search-section-label">Title Matches (0)</div>';
            html += '<p class="muted" style="padding:0.5rem 1rem;">No title matches.</p>';
        }

        // Section 3: Full-text (async, rendered when ready)
        html += '<div class="search-section-label" id="ft-section-label">';
        html += 'Full-Text Matches <span class="ft-loading-dot" id="ft-loading"></span>';
        html += '</div>';
        html += '<div id="ft-results"><p class="muted" style="padding:0.5rem 1rem;">Searching full corpus\u2026</p></div>';

        // Update header
        titleEl.textContent = 'Results for \u201c' + query + '\u201d';
        subEl.textContent = '';
        navEl.hidden = true;

        body.innerHTML = html;

        // Track clicks on results
        body.querySelectorAll('.search-row').forEach(function(row) {
            row.addEventListener('click', function() { resultClickedThisSession = true; });
        });

        // Wire title pagination clicks
        wireTitlePageClicks(query);

        // Load full-text results async
        results.fulltext.then(function(ftResults) {
            var ftContainer = mount.querySelector('#ft-results');
            var ftLabel = mount.querySelector('#ft-section-label');
            if (!ftContainer) return;

            if (ftResults.length === 0) {
                ftContainer.innerHTML = '<p class="muted" style="padding:0.5rem 1rem;">No full-text matches.</p>';
                if (ftLabel) {
                    var dot = ftLabel.querySelector('.ft-loading-dot');
                    if (dot) dot.remove();
                    ftLabel.textContent = 'Full-Text Matches (0)';
                }
                return;
            }

            if (ftLabel) {
                ftLabel.innerHTML = 'Full-Text Matches (' + ftResults.length + ')';
            }

            var ftHtml = '';
            var ftSlice = ftResults.slice(0, 30);
            for (var k = 0; k < ftSlice.length; k++) {
                var r = ftSlice[k];
                var meta = r.meta || {};
                var fFileId = meta.file_id || '';
                var fHref = fFileId ? '#/' + fFileId : '#';
                var fTitle = meta.title || fFileId || '';
                var fTitleEn = meta.title_en || '';
                ftHtml += '<a class="search-row search-row--fulltext" href="' + escapeHtml(fHref) + '">';
                ftHtml += (fFileId ? '<span class="search-row-id">' + escapeHtml(fFileId) + '</span>' : '');
                ftHtml += '<span class="search-row-text">';
                ftHtml += '<span class="search-row-zh">' + escapeHtml(fTitle) + '</span>';
                if (fTitleEn) ftHtml += '<span class="search-row-en">' + escapeHtml(fTitleEn) + '</span>';
                ftHtml += '</span>';
                if (r.excerpt) ftHtml += '<div class="search-row-excerpt">' + r.excerpt + '</div>';
                ftHtml += '</a>';
            }

            if (ftResults.length > 30) {
                ftHtml += '<p class="muted" style="padding:0.5rem 1rem;">Showing first 30 of ' + ftResults.length + ' results.</p>';
            }

            ftContainer.innerHTML = ftHtml;

            // Track clicks on full-text results
            ftContainer.querySelectorAll('.search-row').forEach(function(row) {
                row.addEventListener('click', function() { resultClickedThisSession = true; });
            });

            maybeShowSupportPrompt(body);
        }).catch(function() {
            var ftContainer = mount.querySelector('#ft-results');
            if (ftContainer) {
                ftContainer.innerHTML = '<p class="muted" style="padding:0.5rem 1rem;">Full-text search not available.</p>';
            }
            var ftLabel = mount.querySelector('#ft-section-label');
            if (ftLabel) {
                var dot = ftLabel.querySelector('.ft-loading-dot');
                if (dot) dot.remove();
            }
        });

        maybeShowSupportPrompt(body);
        window.scrollTo(0, 0);
    }

    function buildTitlePagination(current, total, query) {
        var btns = [];
        btns.push('<button class="page-btn" data-title-page="' + (current - 1) + '"' + (current <= 1 ? ' disabled' : '') + '>\u2190 Prev</button>');
        var pages = new Set([1, total, current, current - 1, current + 1]);
        var sorted = Array.from(pages).filter(function(p) { return p >= 1 && p <= total; }).sort(function(a, b) { return a - b; });
        var last = 0;
        for (var i = 0; i < sorted.length; i++) {
            var p = sorted[i];
            if (p - last > 1) btns.push('<span class="page-ellipsis">\u2026</span>');
            btns.push('<button class="page-btn' + (p === current ? ' page-btn--active' : '') + '" data-title-page="' + p + '">' + p + '</button>');
            last = p;
        }
        btns.push('<button class="page-btn" data-title-page="' + (current + 1) + '"' + (current >= total ? ' disabled' : '') + '>Next \u2192</button>');
        btns.push('<span class="page-info">' + current + ' of ' + total + '</span>');
        return btns.join('');
    }

    function wireTitlePageClicks(query) {
        var titleNav = mount.querySelector('#title-page-nav');
        if (!titleNav) return;
        titleNav.querySelectorAll('[data-title-page]').forEach(function(btn) {
            btn.addEventListener('click', function() {
                var p = parseInt(btn.dataset.titlePage, 10);
                if (p >= 1) {
                    doSearch(query, p);
                }
            });
        });
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
                    renderBrowsePage();
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
                    renderBrowsePage();
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

    // Initial search -- empty query with "translated" filter shows all translated texts
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
