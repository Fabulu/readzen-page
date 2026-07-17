// views/search.js
// Federated search across Masters, Titles, and Full-text.
// Empty search shows all titles (filtered by translation status).
// Active query shows three stacked sections: Masters, Titles, Full-text.

import { escapeHtml } from '../lib/format.js';
import { DATA_REPO_BASE, OPEN_DATA_REPO_BASE, loadTranslatedFileIds } from '../lib/github.js';
import { inferCorpusForRelPath } from '../lib/corpus.js';
import { loadAllTitlesAsArray, getWorkId } from '../lib/titles.js';
import { federatedSearch, loadAndSearchXml } from '../lib/search.js';
import { verifyDocPhrase, getManifestInfo } from '../lib/bigram-search.js';
import { normalizeString, isCjk } from '../lib/cjk-normalize.js';
import { getRecentSearches, addRecentSearch } from '../lib/search-history.js';
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

    function isTranslated(t) {
        return translatedIds.has(getWorkId(t));
    }

    function isZenOnly() {
        return zenCheckbox && zenCheckbox.checked;
    }

    // ── Current search state ──
    let lastResults = [];
    let currentPage = 1;
    // Auto-expand first FT group once per query. Re-streaming during
    // incremental updates must NOT reopen what the user just closed, so we
    // gate on this flag (reset at the top of every doSearch call).
    let _autoExpandedThisQuery = false;
    // Per-search AbortController. A new doSearch aborts the previous one so
    // its in-flight onProgress callbacks don't paint stale rows over the
    // new query's results, and pending shard fetches stop wasting bandwidth.
    let _activeSearchCtl = null;
    // Per-query full-text stats (from onFulltextStats): {indexVersion,
    // builtAt, candidateCount, returnedCount, truncated, cap, latinIgnored}.
    // Read by both the streaming and final full-text renderers.
    let _ftStats = null;
    // Verify-on-demand state (audit #1, display half). One text-shard
    // verification per displayed docId per query, memoized so streaming
    // re-renders never re-fetch. Map<docId, exactCount|Promise<exactCount|null>>.
    // A could-not-verify (null) resolution is removed from the map so a later
    // re-render can retry instead of sticking with a failed lookup.
    let _ftVerify = new Map();
    // docIds whose verification came back 0 — their groups are removed from
    // the DOM and skipped by later re-renders.
    let _ftDeadDocs = new Set();
    // AbortSignal of the current search, used by verifyDocPhrase calls.
    let _ftSignal = null;

    async function doSearch(query, page) {
        const trimmed = (query || '').trim();

        // Cancel any prior search (its onProgress callbacks become no-ops
        // and its pending fetches abort).
        if (_activeSearchCtl) _activeSearchCtl.abort();
        const ctl = new AbortController();
        _activeSearchCtl = ctl;

        // Reset the auto-expand guard on each new search so the first FT
        // group of the new query auto-opens once.
        _autoExpandedThisQuery = false;
        // Reset per-query full-text stats + verification memos.
        _ftStats = null;
        _ftVerify = new Map();
        _ftDeadDocs = new Set();
        _ftSignal = ctl.signal;

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
        // Streaming state: accumulated full-text groups across onProgress
        // batches. Each verified text-shard's hits arrive here as soon as the
        // shard fetch + indexOf finish, so the UI can paint rows
        // incrementally instead of waiting for the full search to complete.
        const streamingGroups = new Map();
        const onFulltextProgress = function (batch) {
            // Drop callbacks from any prior search whose AbortController
            // we already aborted. They'd paint stale rows otherwise.
            if (ctl.signal.aborted) return;
            mergeIntoStreamingGroups(streamingGroups, batch);
            renderStreamingFulltext(streamingGroups, trimmed, /*finalized=*/ false);
        };
        // Fires once per query with candidate/truncation/latin-ignored info.
        const onFulltextStats = function (stats) {
            if (ctl.signal.aborted) return;
            _ftStats = stats;
        };

        let results;
        try {
            results = await federatedSearch(trimmed, {
                masters: mastersData,
                titles: titles,
                filters: {
                    translated: transParam,
                    zen: isZenOnly(),
                    corpus: corpusFilter
                },
                masterFilter: masterFilter,
                translatedIds: translatedIds,
                zenIds: zenIds,
                signal: ctl.signal,
                onFulltextProgress: onFulltextProgress,
                onFulltextStats: onFulltextStats,
            });
        } catch (err) {
            // Aborted by a newer search — leave the new query to render.
            if (err && err.name === 'AbortError') return;
            throw err;
        }

        // Final paint only if we're still the active search.
        if (ctl.signal.aborted) return;
        renderFederatedResults(trimmed, results, page);
    }

    /** Merge one streaming batch of result rows into the running groups Map.
     *  Key is `fileId|side|translator` so canonical CBETA, en-side, and per-
     *  community-translator rows stay distinct (per Filter Wave A B10). */
    function mergeIntoStreamingGroups(groups, batch) {
        for (var k = 0; k < batch.length; k++) {
            var r = batch[k];
            var meta = r.meta || {};
            var fid = meta.file_id || '';
            var sd  = meta.side || '';
            var tr  = meta.translator || '';
            if (!fid) continue;
            var key = fid + '|' + sd + '|' + tr;
            if (!groups.has(key)) {
                groups.set(key, {
                    fileId: fid,
                    side: sd,
                    translator: tr,
                    url: r.url || '',
                    title: meta.title || fid,
                    titleEn: meta.title_en || '',
                    excerpt: r.excerpt || '',
                    hitCount: r.hitCount || 0,
                    // Group key (fileId|side|translator) maps 1:1 to a docId,
                    // so the first row's docId identifies the whole group.
                    docId: (typeof r.docId === 'number' ? r.docId : -1),
                });
            } else {
                groups.get(key).hitCount += r.hitCount || 0;
            }
        }
    }

    /** Render the full-text section from the running groups Map. Called from
     *  both the per-shard onProgress callback and the final await. */
    function renderStreamingFulltext(groups, query, finalized) {
        var ftContainer = mount.querySelector('#ft-results');
        var ftLabel = mount.querySelector('#ft-section-label');
        if (!ftContainer) return;

        var groupArr = Array.from(groups.values()).filter(function (g) {
            // Skip groups whose displayed-row verification came back 0.
            return !(typeof g.docId === 'number' && g.docId >= 0 && _ftDeadDocs.has(g.docId));
        });
        // Sort by hitCount desc so the most relevant matches surface first
        // even mid-stream. (Order may shuffle as more shards land.)
        groupArr.sort(function (a, b) { return (b.hitCount || 0) - (a.hitCount || 0); });

        if (groupArr.length === 0 && finalized) {
            ftContainer.innerHTML = '<p class="muted" style="padding:0.5rem 1rem;">No full-text matches.</p>' +
                buildEmptyStateHelp(query);
            if (ftLabel) {
                var spinner = ftLabel.querySelector('#ft-loading');
                if (spinner) spinner.remove();
                ftLabel.textContent = 'Full-Text Matches (0)';
            }
            return;
        }
        if (groupArr.length === 0) return;

        if (ftLabel) {
            // Show the running count plus a still-searching dot when not finalized.
            var label = 'Full-Text Matches (' + groupArr.length + ' text' +
                (groupArr.length === 1 ? '' : 's') + ')';
            // Audit #2: surface silent truncation (VERIFICATION_CAP) in the label.
            if (_ftStats && _ftStats.truncated) {
                label += ', showing top ' + _ftStats.cap + ' of ' +
                    _ftStats.candidateCount + ' matching texts';
            }
            if (!finalized) {
                label += ' <span class="ft-loading-spinner" id="ft-loading" aria-label="Searching"></span>';
            }
            ftLabel.innerHTML = label;
        }

        // Capture the set of currently-open group keys BEFORE clobbering
        // innerHTML — we restore them after re-render so the user's
        // expanded groups don't flicker shut on each streaming batch.
        var openKeys = new Set();
        var existing = ftContainer.querySelectorAll('.search-group[open]');
        for (var i = 0; i < existing.length; i++) {
            var k = existing[i].getAttribute('data-group-key');
            if (k) openKeys.add(k);
        }

        var ftHtml = '';
        for (var g = 0; g < groupArr.length; g++) {
            ftHtml += buildSearchGroup(groupArr[g], query);
        }
        ftContainer.innerHTML = ftHtml;
        appendCoverageNote(ftContainer, query);

        // Re-apply open state to the same groups (matched by data-group-key,
        // not position — streaming reorder may have shuffled the top result).
        if (openKeys.size > 0) {
            var groupsAfter = ftContainer.querySelectorAll('.search-group');
            for (var j = 0; j < groupsAfter.length; j++) {
                var gk = groupsAfter[j].getAttribute('data-group-key');
                if (gk && openKeys.has(gk)) groupsAfter[j].setAttribute('open', '');
            }
        }

        wireGroupExpanders(ftContainer, query);
        maybeAutoExpandFirstGroup(ftContainer);
        verifyDisplayedGroups(ftContainer, query);
    }

    /** Honest coverage note (§4.4). Two states, driven entirely by the
     *  full-text stats:
     *   - Word-capable index (indexVersion >= 4): English IS searched, but only
     *     where a translation exists — say so plainly rather than implying
     *     corpus-wide English completeness.
     *   - Pre-v4 fallback with a mixed query (latinIgnored set): the CJK-only
     *     leg matched the Chinese runs and the English remainder was not
     *     searched on this index. State the limitation without scolding.
     *  Replaces the former "Non-Chinese text … was ignored" banner. */
    function appendCoverageNote(ftContainer, query) {
        if (!_ftStats) return;
        var note = null;
        if (_ftStats.latinIgnored) {
            note = 'Matched the Chinese terms; English text isn’t searched on this index yet.';
        } else if (typeof _ftStats.indexVersion === 'number' && _ftStats.indexVersion >= 4 &&
                   /[a-z]/i.test(query || '')) {
            note = 'English searched where translated.';
        }
        if (!note) return;
        var notice = document.createElement('p');
        notice.className = 'search-ft-notice muted';
        notice.textContent = note;
        ftContainer.appendChild(notice);
    }

    /** Extract maximal CJK runs from the normalized query (same 3-range BMP
     *  predicate the bigram backend uses via lib/cjk-normalize.js#isCjk). */
    function cjkRunsOf(query) {
        var normalized = normalizeString(query == null ? '' : String(query));
        var runs = [];
        var cur = '';
        for (var i = 0; i < normalized.length; i++) {
            if (isCjk(normalized.charCodeAt(i))) {
                cur += normalized[i];
            } else if (cur) {
                runs.push(cur);
                cur = '';
            }
        }
        if (cur) runs.push(cur);
        return runs;
    }

    /** Verify-on-demand (audit #1, display half): exact-count the TOP 10
     *  rendered groups via one text-shard fetch per docId per query.
     *  Skipped entirely for single-term-exact queries (exactly one 2-char or
     *  1-char CJK run) — their index tf IS the exact count — and for queries
     *  with no CJK content (latin rows carry no docId and verifyDocPhrase
     *  would report 0 for them). Results are memoized in _ftVerify so
     *  streaming re-renders re-apply without re-fetching. */
    function verifyDisplayedGroups(ftContainer, query) {
        var runs = cjkRunsOf(query);
        if (runs.length === 0) return;
        if (runs.length === 1 && runs[0].length <= 2) return; // exact from index
        var verifyMap = _ftVerify;
        var deadSet = _ftDeadDocs;
        var signal = _ftSignal;
        var groups = ftContainer.querySelectorAll('.search-group');
        var top = Math.min(groups.length, 10);
        for (var i = 0; i < top; i++) {
            verifyOneGroup(groups[i], query, verifyMap, deadSet, signal);
        }
    }

    function verifyOneGroup(details, query, verifyMap, deadSet, signal) {
        var docId = parseInt(details.getAttribute('data-doc-id') || '', 10);
        if (isNaN(docId) || docId < 0) return;
        var known = verifyMap.get(docId);
        if (typeof known === 'number') {
            applyVerifiedCount(details, docId, known, deadSet);
            return;
        }
        if (known) {
            // Verification already in flight from an earlier render of this
            // query — re-apply to THIS render's element when it resolves.
            known.then(function (count) {
                if (typeof count === 'number') {
                    applyVerifiedCount(details, docId, count, deadSet);
                }
            }).catch(function () { /* abort/network: keep index estimate */ });
            return;
        }
        var p = verifyDocPhrase(docId, query, { signal: signal }).then(function (count) {
            if (count == null) {
                // Could-not-verify (text shard fetch failed / doc absent /
                // aborted) is NOT a verified zero: keep the index estimate,
                // and clear the memo so a later re-render may retry.
                verifyMap.delete(docId);
                return null;
            }
            verifyMap.set(docId, count);
            applyVerifiedCount(details, docId, count, deadSet);
            return count;
        });
        // Memoize the promise immediately so concurrent re-renders never
        // trigger a second text-shard fetch for the same docId.
        verifyMap.set(docId, p);
        p.catch(function () { /* abort/network: swallow silently */ });
    }

    /** Apply an exact verified count to a rendered group: 0 (a GENUINE
     *  scanned-the-text zero — verifyDocPhrase returns null, never 0, when
     *  it could not verify) → remove the group and mark its docId dead
     *  (later re-renders skip it); >0 → replace the index estimate in
     *  .search-group-count. */
    function applyVerifiedCount(details, docId, count, deadSet) {
        if (count == null) return; // could-not-verify: keep index estimate
        if (count === 0) {
            deadSet.add(docId);
            if (details.parentNode) details.parentNode.removeChild(details);
            return;
        }
        if (!details.parentNode) return; // stale element from a clobbered render
        var label = count + ' match' + (count === 1 ? '' : 'es');
        var countEl = details.querySelector('.search-group-count');
        if (countEl) {
            countEl.textContent = label;
        } else {
            var metaEl = details.querySelector('.search-group-meta');
            if (metaEl) {
                var badge = document.createElement('span');
                badge.className = 'search-group-count';
                badge.textContent = label;
                metaEl.insertBefore(badge, metaEl.firstChild);
            }
        }
    }

    /** Auto-open the first FT group on initial render so the user lands on
     *  KWICs without an extra click. Gated by `_autoExpandedThisQuery` so
     *  re-streaming during incremental updates doesn't reopen what the user
     *  just manually closed. The flag is reset per-query in doSearch. */
    function maybeAutoExpandFirstGroup(ftContainer) {
        if (_autoExpandedThisQuery) return;
        var first = ftContainer.querySelector('.search-group');
        if (!first) return;
        // Only set the flag once we successfully open. Otherwise an empty
        // first batch would burn the auto-expand for the rest of the query.
        if (first.hasAttribute('open')) {
            _autoExpandedThisQuery = true;
            return;
        }
        _autoExpandedThisQuery = true;
        first.setAttribute('open', '');
    }

    /** Browse all titles with filters (no query). */
    /** Zero-result recovery: when a filter is active, offer to search everything. */
    function buildEmptyStateHelp(q) {
        var filterActive = getTransFilter() !== 'all' || isZenOnly() || !!corpusFilter;
        if (!q || !q.trim() || !filterActive) return '';
        return '<p class="muted search-empty-help" style="padding:0 1rem 0.5rem;">' +
            'Filters are limiting this search. ' +
            '<button type="button" class="btn btn--small" id="search-all-instead">Search all texts</button></p>';
    }

    /** Recent-searches chip row for the empty-query browse state. */
    function buildRecentChips() {
        var recent = getRecentSearches();
        if (!recent.length) return '';
        var chips = recent.map(function(q) {
            return '<button type="button" class="btn btn--small search-recent-chip" data-q="' +
                escapeHtml(q) + '">' + escapeHtml(q) + '</button>';
        }).join(' ');
        return '<div class="search-recent-row" style="padding:0.35rem 1rem 0.6rem;">' +
            '<span class="muted" style="font-size:0.82rem;margin-right:0.4rem;">Recent:</span>' + chips + '</div>';
    }

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

        body.innerHTML = buildRecentChips() + pageItems.map(function(t) {
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
                var fileId = getWorkId(t);
                var href = fileId ? '#/' + fileId + (query ? '?q=' + encodeURIComponent(query) : '') : '#';
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
        html += 'Full-Text Matches <span class="ft-loading-spinner" id="ft-loading" aria-label="Searching"></span>';
        html += '</div>';
        html += '<div id="ft-results"><div class="ft-progress" role="status">';
        html += '<div class="ft-progress-bar"><div class="ft-progress-fill"></div></div>';
        html += '<p class="ft-progress-text muted">Searching full corpus\u2026</p>';
        html += '</div></div>';

        // Update header
        titleEl.textContent = 'Results for \u201c' + query + '\u201d';
        subEl.textContent = '';
        // Audit #6: surface index staleness. Fire-and-forget \u2014 must never
        // block or fail the search (manifest is cached after first query).
        getManifestInfo().then(function (info) {
            if (!info || !info.builtAt) return;
            var prev = subEl.querySelector('.search-index-built');
            if (prev) prev.remove();
            var stamp = document.createElement('span');
            stamp.className = 'search-index-built muted';
            stamp.textContent = 'Index built ' + String(info.builtAt).slice(0, 10);
            subEl.appendChild(stamp);
        }).catch(function () { /* staleness line is best-effort */ });
        navEl.hidden = true;

        body.innerHTML = html;

        // Track clicks on results
        body.querySelectorAll('.search-row').forEach(function(row) {
            row.addEventListener('click', function() { resultClickedThisSession = true; });
        });

        // Wire title pagination clicks
        wireTitlePageClicks(query);

        // Load full-text results async — grouped by book with expandable KWIC.
        // Capture this render's search signal: doSearch aborts the previous
        // controller BEFORE resetting per-query state, so `aborted` reliably
        // marks this handler stale (a newer query owns the DOM and the
        // _ftVerify/_ftDeadDocs maps by then).
        var searchSignal = _ftSignal;
        results.fulltext.then(function(ftResults) {
            if (searchSignal && searchSignal.aborted) return;
            var ftContainer = mount.querySelector('#ft-results');
            var ftLabel = mount.querySelector('#ft-section-label');
            if (!ftContainer) return;

            if (ftResults.length === 0) {
                ftContainer.innerHTML = '<p class="muted" style="padding:0.5rem 1rem;">No full-text matches.</p>';
                if (ftLabel) {
                    var spinner = ftLabel.querySelector('#ft-loading');
                    if (spinner) spinner.remove();
                    ftLabel.textContent = 'Full-Text Matches (0)';
                }
                return;
            }

            // Group results by (file_id, side, translator). Canonical and
            // community translations of the same source must remain
            // distinguishable so the user sees `[CN]`, `[EN]`, and
            // `[EN by Alice]` as separate rows rather than a single
            // editorially-fraudulent merger.
            var groups = new Map();
            for (var k = 0; k < ftResults.length; k++) {
                var r = ftResults[k];
                var meta = r.meta || {};
                var fid = meta.file_id || '';
                var sd  = meta.side || '';
                var tr  = meta.translator || '';
                if (!fid) continue;
                // Skip groups already verified to zero exact matches during
                // the streaming phase (group key maps 1:1 to a docId).
                if (typeof r.docId === 'number' && _ftDeadDocs.has(r.docId)) continue;
                var key = fid + '|' + sd + '|' + tr;
                if (!groups.has(key)) {
                    groups.set(key, {
                        fileId: fid,
                        side: sd,
                        translator: tr,
                        url: r.url || '',
                        title: meta.title || fid,
                        titleEn: meta.title_en || '',
                        excerpt: r.excerpt || '',
                        hitCount: r.hitCount || 0,
                        docId: (typeof r.docId === 'number' ? r.docId : -1)
                    });
                } else {
                    // Accumulate hit counts from duplicate entries.
                    var existing = groups.get(key);
                    existing.hitCount += r.hitCount || 0;
                }
            }

            var groupArr = Array.from(groups.values());

            if (ftLabel) {
                var finalLabel = 'Full-Text Matches (' + groupArr.length + ' text' + (groupArr.length === 1 ? '' : 's') + ')';
                // Audit #2: surface silent truncation (VERIFICATION_CAP).
                if (_ftStats && _ftStats.truncated) {
                    finalLabel += ' \u2014 showing top ' + _ftStats.cap + ' of ' +
                        _ftStats.candidateCount + ' matching texts';
                }
                ftLabel.innerHTML = finalLabel;
            }

            // Render every grouped book \u2014 the bigram backend already bounds the
            // candidate set upstream, and KWIC fetches are lazy on expand.
            var ftHtml = '';
            for (var g = 0; g < groupArr.length; g++) {
                ftHtml += buildSearchGroup(groupArr[g], query);
            }
            ftContainer.innerHTML = ftHtml;
            appendCoverageNote(ftContainer, query);

            // Wire expand handlers on all groups
            wireGroupExpanders(ftContainer, query);
            maybeAutoExpandFirstGroup(ftContainer);
            verifyDisplayedGroups(ftContainer, query);

            maybeShowSupportPrompt(body);
        }).catch(function() {
            var ftContainer = mount.querySelector('#ft-results');
            if (ftContainer) {
                ftContainer.innerHTML = '<p class="muted" style="padding:0.5rem 1rem;">Full-text search not available.</p>';
            }
            var ftLabel = mount.querySelector('#ft-section-label');
            if (ftLabel) {
                var spinner = ftLabel.querySelector('#ft-loading');
                if (spinner) spinner.remove();
            }
        });

        maybeShowSupportPrompt(body);
        window.scrollTo(0, 0);
    }

    /** Build HTML for a single expandable search group (book-level). */
    function buildSearchGroup(group, query) {
        // Preserve side+translator when navigating into the reader so the
        // "Open text" link lands on the correct translation variant.
        var qsep = query ? ('?q=' + encodeURIComponent(query)) : '';
        var sideQs = '';
        if (group.side === 'community' && group.translator) {
            sideQs = (qsep ? '&' : '?') + 'side=community&translator=' + encodeURIComponent(group.translator);
        } else if (group.side === 'en') {
            sideQs = (qsep ? '&' : '?') + 'side=en';
        }
        var fHref = '#/' + group.fileId + qsep + sideQs;
        var hits = group.hitCount || 0;
        var countLabel = hits > 0 ? hits + ' match' + (hits === 1 ? '' : 'es') : '';
        // Side badge text: [CN] for source, [EN] for canonical, [EN by X] for community.
        // Density v2: badge collapsed INTO the row-id pill so the summary has
        // exactly 3 grid children (id+badge / title / meta) — also fixes the
        // latent grid-arity bug where summary had 4 items in a 3-col grid.
        var badgeText = '';
        if (group.side === 'community' && group.translator) {
            badgeText = 'EN by ' + group.translator;
        } else if (group.side === 'en') {
            badgeText = 'EN';
        } else {
            badgeText = 'CN';
        }
        var idCell =
            '<span class="search-row-id-cell">' +
                '<span class="search-row-id" title="' + escapeHtml(group.fileId) + '">' + escapeHtml(group.fileId) + '</span>' +
                '<span class="search-row-badge search-row-badge--side">' + escapeHtml(badgeText) + '</span>' +
            '</span>';
        // Density v2: excerpt no longer rendered in summary (was creating an
        // empty 0-height layout artifact). Stash the bigram pre-excerpt so we
        // can render it INSIDE .search-group-body on first expand.
        var stashExcerpt = group.excerpt ? ' data-initial-excerpt="' + escapeHtml(group.excerpt) + '"' : '';
        var groupKey = group.fileId + '|' + (group.side || '') + '|' + (group.translator || '');
        // docId enables verify-on-demand (verifyDocPhrase) for displayed rows;
        // absent for rows without one (e.g. latin-corpus results).
        var docIdAttr = (typeof group.docId === 'number' && group.docId >= 0)
            ? ' data-doc-id="' + group.docId + '"'
            : '';
        return '<details class="search-group" data-file-id="' + escapeHtml(group.fileId) +
            '" data-side="' + escapeHtml(group.side || '') +
            '" data-translator="' + escapeHtml(group.translator || '') +
            '" data-group-key="' + escapeHtml(groupKey) + '"' + docIdAttr + '>' +
            '<summary>' +
                idCell +
                '<span class="search-group-title">' +
                    '<span class="search-group-zh">' + escapeHtml(group.title) + '</span>' +
                    (group.titleEn ? '<span class="search-group-en">' + escapeHtml(group.titleEn) + '</span>' : '') +
                '</span>' +
                '<span class="search-group-meta">' +
                    (countLabel ? '<span class="search-group-count">' + escapeHtml(countLabel) + '</span>' : '') +
                    '<a class="search-group-open" href="' + escapeHtml(fHref) + '" onclick="event.stopPropagation();" title="Open the full text">Open →</a>' +
                '</span>' +
            '</summary>' +
            '<div class="search-group-body" data-loaded="false"' + stashExcerpt + '>' +
                '<div class="search-group-loading">Loading passages\u2026</div>' +
            '</div>' +
        '</details>';
    }

    /** Wire toggle handlers on <details> groups to lazy-load KWIC passages. */
    function wireGroupExpanders(container, query) {
        container.querySelectorAll('.search-group').forEach(function(details) {
            if (details._wired) return;
            details._wired = true;

            details.addEventListener('toggle', function() {
                if (!details.open) return;

                var groupBody = details.querySelector('.search-group-body');
                if (!groupBody || groupBody.dataset.loaded === 'true') return;
                groupBody.dataset.loaded = 'true';

                var fileId = details.dataset.fileId;
                // Bilingual KWIC: only when this is a source-side (CJK) hit
                // AND the corpus has an authoritative translation on file.
                // For 'en'/'community' groups the KWIC must search the ENGLISH
                // document the hits actually live in (side passed through) \u2014
                // searching the Chinese source for a latin query always found
                // zero passages ("No passage-level matches found").
                var sideAttr = details.dataset.side || '';
                var translatorAttr = details.dataset.translator || '';
                var bilingual = !sideAttr && translatedIds && translatedIds.has(fileId);
                loadAndSearchXml(fileId, query, {
                    includeTranslation: bilingual,
                    side: sideAttr,
                    translator: translatorAttr
                }).then(function(result) {
                    if (!result || result.passages.length === 0) {
                        var sideQ = sideAttr === 'community' && translatorAttr
                            ? '&side=community&translator=' + encodeURIComponent(translatorAttr)
                            : (sideAttr === 'en' ? '&side=en' : '');
                        groupBody.innerHTML = '<p class="muted" style="padding:0.5rem 1rem 0.5rem 10.1rem;">No passage-level matches found. <a href="#/' + escapeHtml(fileId) + '?q=' + encodeURIComponent(query) + sideQ + '">Open full text \u2192</a></p>';
                        return;
                    }

                    // Update hit count badge — replace the bigram-backend pre-count
                    // with the precise post-KWIC count.
                    var countEl = details.querySelector('.search-group-count');
                    if (countEl) {
                        countEl.textContent = result.totalHits + ' match' + (result.totalHits === 1 ? '' : 'es');
                    } else {
                        // Create one if it didn't exist
                        var metaEl = details.querySelector('.search-group-meta');
                        if (metaEl) {
                            var badge = document.createElement('span');
                            badge.className = 'search-group-count';
                            badge.textContent = result.totalHits + ' match' + (result.totalHits === 1 ? '' : 'es');
                            metaEl.insertBefore(badge, metaEl.firstChild);
                        }
                    }

                    // Density v2: render the lazy excerpt INSIDE the body
                    // (above the KWIC rows) instead of inside the summary —
                    // this avoids the empty 0-height layout artifact and
                    // keeps the collapsed row tight.
                    var excerptInline = '';
                    var stashedExcerpt = groupBody.dataset.initialExcerpt;
                    if (stashedExcerpt) {
                        excerptInline = sanitizeExcerpt(stashedExcerpt);
                    } else if (result.passages.length > 0) {
                        var p0 = result.passages[0];
                        excerptInline = sanitizeExcerpt(
                            (p0.left || '') + '<mark>' + (p0.match || '') + '</mark>' + (p0.right || '')
                        );
                    }
                    var excerptHeader = excerptInline
                        ? '<div class="search-group-excerpt">' + excerptInline + '</div>'
                        : '';

                    // Render KWIC rows — show first 5, "show more" for rest
                    var MAX_KWIC = 5;
                    var passages = result.passages;
                    var translated = result.translatedPassages || null;
                    // If we asked for translations but got nothing aligned, drop a
                    // faint hint so the user understands why the EN row is absent.
                    var noAlignmentHint = (bilingual && (!translated || translated.size === 0))
                        ? '<div class="kwic-no-alignment">(no translation aligned)</div>'
                        : '';
                    var kwicHtml = excerptHeader + noAlignmentHint;

                    for (var i = 0; i < Math.min(passages.length, MAX_KWIC); i++) {
                        kwicHtml += buildKwicRow(passages[i], fileId, query, translated);
                    }

                    if (passages.length > MAX_KWIC) {
                        kwicHtml += '<div class="kwic-hidden" style="display:none;">';
                        for (var j = MAX_KWIC; j < passages.length; j++) {
                            kwicHtml += buildKwicRow(passages[j], fileId, query, translated);
                        }
                        kwicHtml += '</div>';
                        kwicHtml += '<button class="search-show-more kwic-show-more">Show ' + (passages.length - MAX_KWIC) + ' more match' + (passages.length - MAX_KWIC === 1 ? '' : 'es') + '\u2026</button>';
                    }

                    groupBody.innerHTML = kwicHtml;

                    // Wire "show more" within this group
                    var showMore = groupBody.querySelector('.kwic-show-more');
                    if (showMore) {
                        showMore.addEventListener('click', function() {
                            var hidden = groupBody.querySelector('.kwic-hidden');
                            if (hidden) hidden.style.display = '';
                            showMore.remove();
                        });
                    }

                    // Track clicks
                    groupBody.querySelectorAll('.kwic-row').forEach(function(row) {
                        row.addEventListener('click', function() { resultClickedThisSession = true; });
                    });
                }).catch(function() {
                    groupBody.innerHTML = '<p class="muted" style="padding:0.5rem 1rem 0.5rem 10.1rem;">Could not load passage data.</p>';
                });
            });
        });
    }

    /** Build a single KWIC row linking to a specific passage.
     *  When `translatedMap` is non-null AND has an aligned EN entry for this
     *  passage's startLb, render two stacked rows ([CN] + [EN]) inside a
     *  single .kwic-pair link so the click-to-open behaviour stays unified. */
    function buildKwicRow(passage, fileId, query, translatedMap) {
        var lbRange = passage.startLb;
        if (passage.endLb && passage.endLb !== passage.startLb) {
            lbRange = passage.startLb + '-' + passage.endLb;
        }
        var href = '#/' + fileId + '/' + lbRange + '?q=' + encodeURIComponent(query);
        var enText = translatedMap ? (translatedMap.get(passage.startLb) || '') : '';
        // Bilingual mode is "armed" for the whole group when translatedMap
        // is non-null; if THIS passage didn't align (e.g. translator
        // skipped that lb), still render a bilingual frame so rows line up
        // visually, but show a per-row hint instead of silently dropping
        // to a monolingual row that looks like an unrelated entry.
        var bilingualMode = !!translatedMap;

        if (bilingualMode && enText) {
            // Bilingual paired row — CN top + EN bottom, both aligned by lb.
            // The EN row uses .kwic-side-en for the smaller-font, soft-tone
            // styling matching the desktop "Secondary" row treatment.
            return '<a class="kwic-row kwic-row--bilingual" href="' + escapeHtml(href) + '">' +
                '<span class="kwic-side-label kwic-side-label--cn">CN</span>' +
                '<span class="kwic-left">' + escapeHtml(passage.left) + '</span>' +
                '<span class="kwic-match">' + escapeHtml(passage.match) + '</span>' +
                '<span class="kwic-right">' + escapeHtml(passage.right) + '</span>' +
                '<span class="kwic-lb">' + escapeHtml(passage.lineId) + '</span>' +
                '<span class="kwic-side-label kwic-side-label--en">EN</span>' +
                '<span class="kwic-en">' + escapeHtml(enText) + '</span>' +
            '</a>';
        }

        if (bilingualMode) {
            // Translation file loaded but THIS passage's lb has no aligned
            // line (translator skipped it). Keep the bilingual frame and
            // place a quiet hint where the EN text would go.
            return '<a class="kwic-row kwic-row--bilingual" href="' + escapeHtml(href) + '">' +
                '<span class="kwic-side-label kwic-side-label--cn">CN</span>' +
                '<span class="kwic-left">' + escapeHtml(passage.left) + '</span>' +
                '<span class="kwic-match">' + escapeHtml(passage.match) + '</span>' +
                '<span class="kwic-right">' + escapeHtml(passage.right) + '</span>' +
                '<span class="kwic-lb">' + escapeHtml(passage.lineId) + '</span>' +
                '<span class="kwic-side-label kwic-side-label--en">EN</span>' +
                '<span class="kwic-en kwic-en--missing">(no aligned translation for this line)</span>' +
            '</a>';
        }

        return '<a class="kwic-row" href="' + escapeHtml(href) + '">' +
            '<span class="kwic-left">' + escapeHtml(passage.left) + '</span>' +
            '<span class="kwic-match">' + escapeHtml(passage.match) + '</span>' +
            '<span class="kwic-right">' + escapeHtml(passage.right) + '</span>' +
            '<span class="kwic-lb">' + escapeHtml(passage.lineId) + '</span>' +
        '</a>';
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

    function syncHashAndSearch(q) {
        var corpusParam = cf ? '&corpus=' + encodeURIComponent(cf) : '';
        var newHash = '#/search' + (q.trim() ? '?q=' + encodeURIComponent(q) + corpusParam : '');
        if (window.location.hash !== newHash) {
            // replaceState keeps the URL shareable without firing hashchange
            // (which would re-render the view and steal input focus) and
            // without one history entry per keystroke.
            window.history.replaceState(null, '', newHash);
        }
        doSearch(q, 1);
    }

    // Search-as-you-type: a v3 query costs ~25ms and a few hundred KB, so
    // waiting for Enter is a v2-era relic. Debounced; doSearch's per-query
    // AbortController already cancels superseded searches mid-flight, and
    // streaming results paint incrementally.
    var typeTimer = null;
    var lastRan = initialQuery;
    input.addEventListener('input', function() {
        clearTimeout(typeTimer);
        typeTimer = setTimeout(function() {
            var q = input.value;
            if (q === lastRan) return;
            lastRan = q;
            syncHashAndSearch(q);
        }, 250);
    });

    form.addEventListener('submit', function(e) {
        e.preventDefault();
        clearTimeout(typeTimer); // Enter supersedes a pending debounce tick
        lastRan = input.value;
        addRecentSearch(input.value);
        syncHashAndSearch(input.value);
    });

    // Delegated: recent-search chips, filter-recovery button, and recording a
    // query as "worth remembering" when a result actually gets clicked.
    body.addEventListener('click', function(e) {
        var chip = e.target.closest ? e.target.closest('.search-recent-chip') : null;
        if (chip) {
            input.value = chip.dataset.q || '';
            lastRan = input.value;
            syncHashAndSearch(input.value);
            return;
        }
        if (e.target.id === 'search-all-instead') {
            filterRadios.forEach(function(r) { r.checked = r.value === 'all'; });
            if (zenCheckbox) zenCheckbox.checked = false;
            doSearch(input.value, 1);
            return;
        }
        var resultLink = e.target.closest ? e.target.closest('a.search-group-open, .search-group summary, a.title-row') : null;
        if (resultLink && input.value.trim()) addRecentSearch(input.value);
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

/** Sanitize excerpt HTML: allow only <mark> tags, escape everything else;
 *  truncate to ~160 chars centered on the first <mark> window. */
function sanitizeExcerpt(html) {
    if (!html) return '';
    var safe = html.replace(/<mark>/g, '\x00MARK\x00').replace(/<\/mark>/g, '\x00/MARK\x00')
        .replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/\x00MARK\x00/g, '<mark>').replace(/\x00\/MARK\x00/g, '</mark>');
    var MAX = 160;
    var plain = safe.replace(/<\/?mark>/g, '');
    if (plain.length <= MAX) return safe;
    var m = safe.match(/[\s\S]{0,60}<mark>[\s\S]*?<\/mark>[\s\S]{0,60}/);
    return (m ? m[0] : safe.slice(0, MAX)) + '…';
}

