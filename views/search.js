// views/search.js
// Title-only search across the CBETA corpus.
//
// Fetches `titles.jsonl` from the translations repo, parses it once (cached),
// and filters client-side against the query string. Each row links to the
// passage outline view for that work.
//
// Full-text search stays in the desktop app — this is an informational preview
// that shows "we understood your search", not a corpus scan.

import { escapeHtml } from '../lib/format.js';
import { DATA_REPO_BASE } from '../lib/github.js';
import { streamJsonl } from '../lib/jsonl.js';
import * as cache from '../lib/cache.js';

const TITLES_URL = DATA_REPO_BASE + 'titles.jsonl';
const TITLES_CACHE_KEY = 'titles:main';
const TITLES_TTL_MS = 30 * 60 * 1000;
const MAX_RESULTS = 60;

export function match(route) {
    return route && route.kind === 'search';
}

export function preferAppFirst(_route) { return false; }

export async function render(route, mount, shell) {
    const initialQuery = (route.q || '').trim();
    const corpus = (route.corpus || '').trim().toUpperCase();

    shell.setTitle(initialQuery ? `Search · ${initialQuery}` : 'Search');
    shell.setContext(
        initialQuery ? `Searching for "${initialQuery}"` : 'Search the CBETA corpus',
        corpus ? `Corpus: ${corpus}` : 'Title-only search. Full-text search requires Read Zen.'
    );
    shell.setUpsell(
        'This is a title-only preview. The desktop app gives you ' +
        '<strong>full-text search across every CBETA text</strong>, ' +
        'instant jump-to-passage with ZH/EN side-by-side, the full ' +
        'reading and translation workflow, and the ability to share ' +
        'search links like this one.'
    );
    shell.setExtraLink('titles.jsonl', TITLES_URL);

    mount.innerHTML = `
        <section class="list-wrap search-wrap">
            <form class="search-form" id="search-form" autocomplete="off">
                <input class="search-input" id="search-input" type="text"
                       placeholder="Search work titles…"
                       value="${escapeHtml(initialQuery)}" />
                <button class="btn btn--small" type="submit">Search</button>
            </form>

            <p class="search-disclaimer">
                Title-only search. Full-text search requires the
                <a class="text-link text-link--accent" href="https://github.com/Fabulu/ReadZen/releases">Read Zen desktop app</a>.
            </p>

            <header class="list-head">
                <h2 class="list-title" id="search-title">Results</h2>
                <p class="list-sub" id="search-sub"></p>
            </header>

            <div class="list-body" id="search-body"></div>
            <div class="list-empty" id="search-empty" hidden></div>
        </section>
    `;

    const form = document.querySelector('#search-form');
    const input = document.querySelector('#search-input');
    const body = document.querySelector('#search-body');
    const empty = document.querySelector('#search-empty');
    const subEl = document.querySelector('#search-sub');
    const titleEl = document.querySelector('#search-title');

    shell.setStatus('Loading titles…', 'Downloading the corpus title index.', false);

    let titles;
    try {
        titles = await loadTitles();
    } catch (error) {
        shell.showError(
            'Search index unavailable',
            (error && error.message) || 'Could not load titles.jsonl from the translations repo.'
        );
        return;
    }

    shell.hideStatus();

    function doSearch(query) {
        const trimmed = (query || '').trim();
        if (!trimmed) {
            body.innerHTML = '';
            empty.hidden = false;
            empty.innerHTML = `<p>Enter a query above to search ${titles.length} work titles.</p>`;
            subEl.textContent = `${titles.length} titles indexed`;
            titleEl.textContent = 'Results';
            return;
        }

        const lower = trimmed.toLowerCase();
        const results = [];
        for (const t of titles) {
            if (!t) continue;
            const path = (t.path || t.Path || '').toString();
            if (corpus) {
                const firstLetter = path.charAt(0).toUpperCase();
                if (firstLetter !== corpus) continue;
            }
            const zh = (t.zh || t.Zh || '').toString();
            const en = (t.en || t.En || '').toString();
            const enShort = (t.enShort || t.EnShort || '').toString();
            const blob = (zh + ' ' + en + ' ' + enShort + ' ' + path).toLowerCase();
            if (blob.includes(lower)) {
                results.push(t);
                if (results.length >= MAX_RESULTS) break;
            }
        }

        titleEl.textContent = `Results for "${trimmed}"`;

        if (results.length === 0) {
            body.innerHTML = '';
            empty.hidden = false;
            empty.innerHTML = `<p>No titles match <strong>${escapeHtml(trimmed)}</strong>${corpus ? ` in corpus ${escapeHtml(corpus)}` : ''}.</p>`;
            subEl.textContent = '0 matches';
            return;
        }

        empty.hidden = true;
        subEl.textContent = results.length >= MAX_RESULTS
            ? `Showing first ${MAX_RESULTS} matches (refine your query for more)`
            : `${results.length} match${results.length === 1 ? '' : 'es'}`;

        body.innerHTML = results.map((t) => {
            const zh = (t.zh || t.Zh || '').toString();
            const en = (t.en || t.En || '').toString();
            const enShort = (t.enShort || t.EnShort || '').toString();
            const path = (t.path || t.Path || '').toString();
            const workId = (t.workId || t.WorkId || deriveWorkIdFromPath(path));
            const href = workId ? '#/' + workId : '#';

            const enLine = en || enShort;

            return `
                <a class="search-row" href="${escapeHtml(href)}">
                    <span class="search-row-id">${escapeHtml(workId || '—')}</span>
                    <span class="search-row-text">
                        <span class="search-row-zh">${escapeHtml(zh || '[no title]')}</span>
                        ${enLine ? `<span class="search-row-en">${escapeHtml(enLine)}</span>` : ''}
                    </span>
                    <span class="search-row-path">${escapeHtml(path)}</span>
                </a>
            `;
        }).join('');
    }

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const q = input.value;
        // Update hash without reloading the view.
        const newHash = '#/search' + (q ? '?q=' + encodeURIComponent(q) + (corpus ? '&corpus=' + encodeURIComponent(corpus) : '') : '');
        if (window.location.hash !== newHash) {
            // Use replaceState so we don't spam the history for every keystroke.
            window.history.replaceState(null, '', newHash);
        }
        doSearch(q);
    });

    doSearch(initialQuery);
}

/** Fetch the full titles.jsonl index once per session. */
async function loadTitles() {
    const cached = cache.get(TITLES_CACHE_KEY);
    if (cached) return cached;

    const titles = [];
    for await (const row of streamJsonl(TITLES_URL)) {
        if (row && typeof row === 'object') titles.push(row);
    }
    cache.set(TITLES_CACHE_KEY, titles, TITLES_TTL_MS);
    return titles;
}

/** Best-effort workId extraction from a relative path like "T/T48/T48n2005.xml". */
function deriveWorkIdFromPath(path) {
    if (!path) return '';
    const file = path.split('/').pop() || '';
    return file.replace(/\.xml$/i, '');
}
