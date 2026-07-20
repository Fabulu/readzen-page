// views/dict-browse.js
// Browse the whole Zen dictionary (the curated termbase) with a combined
// EN + ZH search bar. Client-side: the termbase is small, so we load it
// wholesale via loadZenDict() and filter in memory. Modeled on
// views/masters-browse.js.
// Route: #/dict  (with no term; #/dict/{term} stays a CC-CEDICT lookup)

import { loadZenDict, buildZenCard, bindZenEvidenceLinks } from '../lib/zen-dict.js';
import { renderLookupCard } from '../lib/lookup-card.js';
import { escapeHtml } from '../lib/format.js';

/** Route-kind matcher used by app.js. */
export function match(route) {
    return route && route.kind === 'dict-browse';
}

/** Instant render — no app-first race. */
export function preferAppFirst() { return false; }

export async function render(route, mount, shell) {
    if (shell) {
        shell.setTitle('Zen Dictionary');
        shell.setContext('Browse the Zen dictionary', 'Search curated terms in Chinese or English');
        shell.setUpsell(
            'This is the community Zen dictionary — curated translations of key terms ' +
            'with senses, explanations, and source occurrences. The desktop app lets you ' +
            '<strong>build and manage your own termbase</strong>, see terms highlighted live ' +
            'while you read, and contribute back. ' +
            '<a href="https://github.com/Fabulu/ReadZen/releases">Download free</a> · ' +
            '<a href="https://ko-fi.com/readzen">Support on Ko-fi</a>'
        );
        shell.hideStatus();
    }

    mount.innerHTML = '<article class="panel lookup-card"><p style="opacity:0.5;padding:2rem;">Loading dictionary…</p></article>';

    let index;
    try {
        index = await loadZenDict();
    } catch (error) {
        mount.innerHTML = `<article class="panel lookup-card"><p>Failed to load dictionary: ${escapeHtml(String(error.message || error))}</p></article>`;
        return;
    }

    const entries = (index && index.entries) || [];
    if (entries.length === 0) {
        mount.innerHTML = `
            <article class="panel lookup-card">
                <header class="lookup-head"><h2 class="lookup-title">Zen Dictionary</h2></header>
                <p class="lookup-empty-detail">The Zen dictionary is empty or unavailable right now.</p>
                <p class="lookup-empty-hint">Check back soon, or open Read Zen to build your own termbase.</p>
            </article>`;
        return;
    }

    for (const e of entries) prepareDictionarySearchEntry(e);

    renderBrowse(mount, entries, route.q || '');
}

/**
 * Layout modes. Cards side-by-side squeeze long entries and leave ragged gaps
 * when neighbours differ in length, so the grid is one option among several
 * rather than the only way to read the dictionary.
 *   cards   — the original responsive grid (fast to scan, cramped to read)
 *   columns — masonry-ish CSS columns: cards flow, so uneven heights leave no holes
 *   list    — one full-width entry per row: nothing is squeezed, best for reading
 *   compact — headword + gloss only, dense: best for finding a term fast
 */
const LAYOUTS = [
    { id: 'cards', label: 'Cards' },
    { id: 'columns', label: 'Columns' },
    { id: 'list', label: 'List' },
    { id: 'compact', label: 'Compact' },
];
const LAYOUT_KEY = 'zl:dict-layout';
// Compact is the default: the dictionary is a reference you scan for a headword,
// not a feed you read card by card.
const DEFAULT_LAYOUT = 'compact';

function getLayout() {
    try {
        const v = localStorage.getItem(LAYOUT_KEY);
        return LAYOUTS.some((l) => l.id === v) ? v : DEFAULT_LAYOUT;
    } catch { return DEFAULT_LAYOUT; }
}
function setLayout(v) {
    try { localStorage.setItem(LAYOUT_KEY, v); } catch { /* private mode */ }
}

function renderBrowse(mount, entries, activeQ) {
    let layout = getLayout();

    mount.innerHTML = `
        <div class="masters-browse dict-browse">
            <header class="masters-browse-header">
                <div class="masters-browse-title-row">
                    <h2 class="masters-browse-title">Zen Dictionary</h2>
                </div>
                <div class="masters-browse-controls">
                    <input type="text" class="masters-search-input dict-search-input"
                           placeholder="Search Chinese or English…"
                           value="${escapeHtml(activeQ)}" aria-label="Search dictionary" />
                    <div class="dict-layout-switch" role="group" aria-label="Layout">
                        ${LAYOUTS.map((l) => `
                            <button type="button" class="dict-layout-btn" data-layout="${l.id}"
                                    aria-pressed="${l.id === layout}">${l.label}</button>`).join('')}
                    </div>
                    <span class="masters-count"></span>
                </div>
            </header>
            <div class="dict-grid" id="dict-grid"></div>
            <nav class="dict-pager" id="dict-pager" aria-label="Dictionary pages"></nav>
        </div>
    `;

    const grid = mount.querySelector('#dict-grid');
    const input = mount.querySelector('.dict-search-input');
    const countEl = mount.querySelector('.masters-count');
    const pager = mount.querySelector('#dict-pager');

    let page = 0;

    function update() {
        const q = input.value.trim();
        const filtered = q ? searchDictionaryEntries(entries, q) : entries;

        // This is a browser, not a search box: every term is reachable by paging.
        // Compact rows are cheap, so they page in larger chunks than full cards.
        const perPage = layout === 'compact' ? 200 : 60;
        const pages = Math.max(1, Math.ceil(filtered.length / perPage));
        if (page > pages - 1) page = pages - 1;
        if (page < 0) page = 0;
        const start = page * perPage;
        const shown = filtered.slice(start, start + perPage);

        countEl.textContent = filtered.length
            ? `${start + 1}–${start + shown.length} of ${filtered.length} term${filtered.length === 1 ? '' : 's'}`
            : 'no terms';

        grid.className = 'dict-grid dict-grid--' + layout;
        grid.innerHTML = '';
        for (const entry of shown) {
            grid.appendChild(layout === 'compact' ? compactRow(entry) : fullCell(entry));
        }

        renderPager(pager, page, pages, (p) => {
            page = p;
            update();
            grid.scrollIntoView({ block: 'start', behavior: 'smooth' });
        });
    }

    mount.querySelectorAll('.dict-layout-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            layout = btn.dataset.layout;
            setLayout(layout);
            mount.querySelectorAll('.dict-layout-btn').forEach((b) => {
                b.setAttribute('aria-pressed', String(b.dataset.layout === layout));
            });
            page = 0;
            update();
        });
    });

    input.addEventListener('input', () => { page = 0; update(); });
    update();
    if (activeQ) input.focus();
}

/** Normalize reader queries without turning unrelated English words into synonyms. */
export function normalizeDictionaryQuery(value) {
    return String(value || '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[\p{P}\p{S}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Build ranked, field-aware lookup data. SearchAliases are intentionally non-display. */
export function prepareDictionarySearchEntry(entry) {
    if (!entry || entry._dictSearch) return entry;
    const preferred = [];
    const alternates = [];
    const aliases = [];
    const prose = [];
    for (const sense of entry.senses || []) {
        if (sense.preferredTarget) preferred.push(sense.preferredTarget);
        alternates.push(...(sense.alternateTargets || []));
        aliases.push(...(sense.searchAliases || []));
        prose.push(sense.explanation, sense.note, sense.status);
        for (const occ of sense.occurrences || []) {
            if (!occ) continue;
            prose.push(occ.Kwic || occ.kwic || occ.Snippet || occ.snippet || occ.Text || occ.text || '');
        }
    }
    const normList = (items) => items.filter(Boolean).map(normalizeDictionaryQuery).filter(Boolean);
    entry._dictSearch = {
        source: normalizeDictionaryQuery(entry.sourceTerm),
        preferred: normList(preferred),
        alternates: normList(alternates),
        aliases: normList(aliases),
        prose: normalizeDictionaryQuery(prose.filter(Boolean).join(' \u0001 ')),
    };
    return entry;
}

/** Return -1 for no match; larger values rank stronger lexical evidence first. */
export function rankDictionaryEntry(entry, query) {
    const q = normalizeDictionaryQuery(query);
    if (!q) return 0;
    prepareDictionarySearchEntry(entry);
    const s = entry._dictSearch;
    if (s.source === q) return 1000;
    if (s.source.includes(q)) return 950;
    if (s.preferred.includes(q)) return 900;
    if (s.preferred.some((value) => value.includes(q))) return 850;
    if (s.alternates.includes(q)) return 800;
    if (s.alternates.some((value) => value.includes(q))) return 750;
    if (s.aliases.includes(q)) return 700;
    if (s.aliases.some((value) => value.includes(q))) return 650;
    if (s.prose.includes(q)) return 100;
    return -1;
}

/** Stable ranked dictionary search used by the browse view and regression tests. */
export function searchDictionaryEntries(entries, query) {
    return (entries || [])
        .map((entry, index) => ({ entry, index, score: rankDictionaryEntry(entry, query) }))
        .filter((row) => row.score >= 0)
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .map((row) => row.entry);
}

/** Prev / page numbers / Next. Hidden entirely when everything fits on one page. */
function renderPager(mount, page, pages, go) {
    mount.innerHTML = '';
    if (pages <= 1) return;

    const btn = (label, targetPage, opts = {}) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'dict-page-btn' + (opts.current ? ' dict-page-btn--current' : '');
        b.textContent = label;
        if (opts.current) b.setAttribute('aria-current', 'page');
        if (opts.disabled) b.disabled = true;
        else b.addEventListener('click', () => go(targetPage));
        mount.appendChild(b);
    };

    btn('‹ Prev', page - 1, { disabled: page === 0 });

    // First, last, and a window around the current page; gaps become an ellipsis.
    const want = new Set([0, pages - 1, page - 1, page, page + 1]);
    const list = [...want].filter((p) => p >= 0 && p < pages).sort((a, b) => a - b);
    let prev = -1;
    for (const p of list) {
        if (prev !== -1 && p - prev > 1) {
            const gap = document.createElement('span');
            gap.className = 'dict-page-gap';
            gap.textContent = '…';
            mount.appendChild(gap);
        }
        btn(String(p + 1), p, { current: p === page });
        prev = p;
    }

    btn('Next ›', page + 1, { disabled: page === pages - 1 });
}

/** A full entry card, with a permalink to #/dict/{term}. */
function fullCell(entry) {
    const cell = document.createElement('div');
    cell.className = 'dict-cell';
    renderLookupCard(buildZenCard(entry), cell);
    bindZenEvidenceLinks(cell);
    cell.appendChild(permalink(entry.sourceTerm));
    return cell;
}

/** Headword + first gloss, one dense row, the whole row linking to the entry. */
function compactRow(entry) {
    const sense = (entry.senses && entry.senses[0]) || {};
    const row = document.createElement('a');
    row.className = 'dict-compact-row';
    row.href = entryHref(entry.sourceTerm);
    row.innerHTML =
        `<span class="dict-compact-term">${escapeHtml(entry.sourceTerm)}</span>` +
        `<span class="dict-compact-gloss">${escapeHtml(sense.preferredTarget || '')}</span>` +
        (entry.senses && entry.senses.length > 1
            ? `<span class="dict-compact-senses">${entry.senses.length} senses</span>` : '');
    return row;
}

/** The permalink for one entry — this is the link you can share. */
function entryHref(term) {
    return '#/dict/' + encodeURIComponent(term);
}

function permalink(term) {
    const a = document.createElement('a');
    a.className = 'dict-permalink';
    a.href = entryHref(term);
    a.title = `Link to ${term}`;
    a.setAttribute('aria-label', `Link to the entry for ${term}`);
    a.textContent = '#';
    return a;
}
