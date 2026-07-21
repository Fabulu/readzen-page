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

/**
 * Browse-order modes. English readers navigate by MEANING, so the default
 * sorts entries A–Z by their primary English gloss and labels the thumb
 * tabs with gloss ranges (abbot – Buddha, …). The 字 mode keeps the
 * traditional radical-then-stroke (code point) headword order with Chinese
 * headword-range tabs, for readers who arrive with a character in mind.
 */
const ORDERS = [
    { id: 'en', label: 'English', aria: 'Order by English gloss, A to Z' },
    { id: 'zh', label: '字', aria: 'Order by Chinese headword, radical and stroke' },
];
const ORDER_KEY = 'zl:dict-order';
const DEFAULT_ORDER = 'en';

function getOrder() {
    try {
        const v = localStorage.getItem(ORDER_KEY);
        return ORDERS.some((o) => o.id === v) ? v : DEFAULT_ORDER;
    } catch { return DEFAULT_ORDER; }
}
function setOrder(v) {
    try { localStorage.setItem(ORDER_KEY, v); } catch { /* private mode */ }
}

/** The entry's primary English gloss — the first sense carrying a preferredTarget. */
function primaryGloss(entry) {
    for (const sense of (entry && entry.senses) || []) {
        if (sense && sense.preferredTarget) return sense.preferredTarget;
    }
    return '';
}

/**
 * Strip leading punctuation/quotes and a trivial leading article, preserving
 * case. Punctuation is swept BOTH sides of the article: glosses like
 * `the "cutting off…" phrase` hide a quote behind the article.
 */
function trimGloss(gloss) {
    return String(gloss || '')
        .normalize('NFKC')
        .replace(/^[^\p{L}\p{N}]+/u, '')
        .replace(/^(?:the|an?)\s+/i, '')
        .replace(/^[^\p{L}\p{N}]+/u, '');
}

/**
 * Lowercased alphabetization key for the English browse order. Empty when the
 * entry has no English gloss anywhere — such entries sort LAST, under a '—' tab.
 */
export function dictionaryGlossSortKey(entry) {
    return trimGloss(primaryGloss(entry)).toLowerCase();
}

/**
 * First word of the trimmed gloss (hyphens/apostrophes kept, so
 * "one-cut-two-pieces" stays whole) for a thumb-tab label; '—' when the
 * entry has no English gloss, so a tab label is never empty.
 */
export function dictionaryGlossLabel(entry) {
    const m = trimGloss(primaryGloss(entry)).match(/^[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/u);
    return m ? m[0] : '—';
}

function renderBrowse(mount, entries, activeQ) {
    let layout = getLayout();
    let order = getOrder();

    // Two browse orders, both monotonic so the thumb-index ranges read true.
    // The ORIGINAL array is kept for search so ranked tie-breaks stay stable.
    //   zh — headword code point order; for CJK that is KangXi radical-then-
    //        stroke, the traditional dictionary ordering.
    //   en — A–Z by primary English gloss (article-stripped, lowercased);
    //        entries with no gloss sort last, tie-broken by headword.
    const byHeadword = [...entries].sort((a, b) =>
        a.sourceTerm < b.sourceTerm ? -1 : a.sourceTerm > b.sourceTerm ? 1 : 0);
    // localeCompare('en') files diacritics under their base letter, so
    // Śākyamuni sits with the S's instead of after z (code-point order would
    // exile every accented gloss past the end of the alphabet).
    const byGloss = [...entries].sort((a, b) => {
        const ka = dictionaryGlossSortKey(a);
        const kb = dictionaryGlossSortKey(b);
        if (!ka !== !kb) return ka ? -1 : 1;
        return ka.localeCompare(kb, 'en')
            || (a.sourceTerm < b.sourceTerm ? -1 : a.sourceTerm > b.sourceTerm ? 1 : 0);
    });

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
                    <div class="dict-order-switch" role="group" aria-label="Browse order">
                        ${ORDERS.map((o) => `
                            <button type="button" class="dict-order-btn" data-order="${o.id}"
                                    aria-pressed="${o.id === order}" aria-label="${o.aria}"
                                    title="${o.aria}">${o.label}</button>`).join('')}
                    </div>
                    <div class="dict-layout-switch" role="group" aria-label="Layout">
                        ${LAYOUTS.map((l) => `
                            <button type="button" class="dict-layout-btn" data-layout="${l.id}"
                                    aria-pressed="${l.id === layout}">${l.label}</button>`).join('')}
                    </div>
                    <span class="masters-count" aria-live="polite"></span>
                </div>
            </header>
            <nav class="dict-thumb-strip" id="dict-thumbs" aria-label="Jump to a range of entries"></nav>
            <div class="dict-grid" id="dict-grid" tabindex="0" role="region"
                 aria-label="Dictionary entries. With this list focused, use Left and Right arrows to change page, Home for the first page, End for the last."
                 aria-keyshortcuts="ArrowLeft ArrowRight Home End"></div>
            <nav class="dict-pager" id="dict-pager" aria-label="Dictionary pages"></nav>
        </div>
    `;

    const root = mount.querySelector('.dict-browse');
    const grid = mount.querySelector('#dict-grid');
    const input = mount.querySelector('.dict-search-input');
    const countEl = mount.querySelector('.masters-count');
    const thumbs = mount.querySelector('#dict-thumbs');
    const pager = mount.querySelector('#dict-pager');

    let page = 0;
    let pageCount = 1;

    function update() {
        const q = input.value.trim();
        const filtered = q ? searchDictionaryEntries(entries, q)
            : (order === 'zh' ? byHeadword : byGloss);

        // This is a browser, not a search box: every term is reachable by paging.
        // Compact rows are cheap, so they page in larger chunks than full cards.
        const perPage = layout === 'compact' ? 200 : 60;
        const pages = Math.max(1, Math.ceil(filtered.length / perPage));
        pageCount = pages;
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

        // Thumb index only for the unfiltered browse: search results are
        // ranked, not alphabetical, so range tabs there would mislead.
        thumbs.setAttribute('aria-label', order === 'zh'
            ? 'Jump to a headword range' : 'Jump to an English gloss range');
        renderThumbStrip(thumbs, q ? [] : pageRangeLabels(filtered, perPage, order), page, goTo);
        renderPager(pager, page, pages, goTo);
    }

    /** Single navigation entry point used by the pager, thumbs, and keyboard. */
    function goTo(target, opts = {}) {
        const next = Math.max(0, Math.min(pageCount - 1, target));
        if (next === page) return;
        page = next;
        update();
        grid.scrollIntoView({ block: 'start', behavior: opts.instant ? 'auto' : 'smooth' });
        if (opts.focusGrid) grid.focus({ preventScroll: true });
    }

    // Keyboard paging anywhere in the view except while typing in a field.
    // Focus returns to the grid after a keyboard jump so a re-rendered pager
    // button losing focus never strands the shortcut chain on <body>.
    root.addEventListener('keydown', (e) => {
        if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
        const tag = e.target && e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        let target = null;
        if (e.key === 'ArrowLeft') target = page - 1;
        else if (e.key === 'ArrowRight') target = page + 1;
        else if (e.key === 'Home') target = 0;
        else if (e.key === 'End') target = pageCount - 1;
        if (target === null) return;
        e.preventDefault();
        goTo(target, { instant: true, focusGrid: true });
    });

    mount.querySelectorAll('.dict-order-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            if (btn.dataset.order === order) return;
            order = btn.dataset.order;
            setOrder(order);
            mount.querySelectorAll('.dict-order-btn').forEach((b) => {
                b.setAttribute('aria-pressed', String(b.dataset.order === order));
            });
            page = 0; // a new ordering is a new book — start at its first page
            update();
        });
    });

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

/**
 * The thumb index — the cut tabs of a paper dictionary. One tab per page,
 * labeled with the range that page covers (from its first and last entries),
 * so a reader leaps to a REGION of the dictionary instead of clicking through
 * page numbers. In English order the tab shows a gloss range (abbot – Buddha);
 * in 字 order the first characters of the headwords (㘞–上). Rendered only for
 * the sorted, unfiltered browse; hidden (with the strip collapsed) otherwise.
 */
export function pageRangeLabels(list, perPage, order) {
    const tab = order === 'zh'
        ? (e) => [...e.sourceTerm][0]
        : (e) => dictionaryGlossLabel(e);
    const sep = order === 'zh' ? '–' : ' – ';
    const labels = [];
    for (let start = 0; start < list.length; start += perPage) {
        const first = tab(list[start]);
        const last = tab(list[Math.min(start + perPage, list.length) - 1]);
        labels.push(first === last ? first : `${first}${sep}${last}`);
    }
    return labels;
}

function renderThumbStrip(mount, labels, page, go) {
    mount.innerHTML = '';
    mount.hidden = labels.length <= 1;
    if (mount.hidden) return;
    labels.forEach((label, p) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'dict-thumb' + (p === page ? ' dict-thumb--current' : '');
        b.textContent = label;
        b.setAttribute('aria-label', `Page ${p + 1}, entries ${label}`);
        if (p === page) b.setAttribute('aria-current', 'page');
        b.addEventListener('click', () => go(p));
        mount.appendChild(b);
    });
}

/**
 * First / prev / numbered window / next / last, plus an editable "Page N of M"
 * jump field. Hidden entirely when everything fits on one page.
 */
function renderPager(mount, page, pages, go) {
    mount.innerHTML = '';
    if (pages <= 1) return;

    const btn = (label, targetPage, opts = {}) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'dict-page-btn'
            + (opts.current ? ' dict-page-btn--current' : '')
            + (opts.nav ? ' dict-page-btn--nav' : '');
        b.textContent = label;
        if (opts.aria) b.setAttribute('aria-label', opts.aria);
        if (opts.current) b.setAttribute('aria-current', 'page');
        if (opts.disabled) b.disabled = true;
        else b.addEventListener('click', () => go(targetPage));
        mount.appendChild(b);
    };

    btn('«', 0, { disabled: page === 0, nav: true, aria: 'First page' });
    btn('‹', page - 1, { disabled: page === 0, nav: true, aria: 'Previous page' });

    // First, last, and a window around the current page; gaps become an ellipsis.
    const want = new Set([0, pages - 1, page - 1, page, page + 1]);
    const list = [...want].filter((p) => p >= 0 && p < pages).sort((a, b) => a - b);
    let prev = -1;
    for (const p of list) {
        if (prev !== -1 && p - prev > 1) {
            const gap = document.createElement('span');
            gap.className = 'dict-page-gap';
            gap.textContent = '…';
            gap.setAttribute('aria-hidden', 'true');
            mount.appendChild(gap);
        }
        btn(String(p + 1), p, { current: p === page, aria: `Page ${p + 1}` });
        prev = p;
    }

    btn('›', page + 1, { disabled: page === pages - 1, nav: true, aria: 'Next page' });
    btn('»', pages - 1, { disabled: page === pages - 1, nav: true, aria: 'Last page' });

    // Direct jump: the page number in "Page N of M" IS the input.
    const jump = document.createElement('label');
    jump.className = 'dict-page-jump';
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.inputMode = 'numeric';
    inp.min = '1';
    inp.max = String(pages);
    inp.value = String(page + 1);
    inp.setAttribute('aria-label', `Go to page, 1 to ${pages}`);
    const commit = () => {
        const v = Math.round(Number(inp.value));
        if (Number.isFinite(v) && v >= 1 && v <= pages && v - 1 !== page) go(v - 1);
        else inp.value = String(page + 1);
    };
    inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
    });
    inp.addEventListener('change', commit);
    const pre = document.createElement('span');
    pre.textContent = 'Page';
    const post = document.createElement('span');
    post.textContent = `of ${pages}`;
    jump.append(pre, inp, post);
    mount.appendChild(jump);

    const hint = document.createElement('span');
    hint.className = 'dict-pager-hint';
    hint.setAttribute('aria-hidden', 'true');
    hint.textContent = '← → page · Home/End first/last (with the list focused)';
    mount.appendChild(hint);
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
