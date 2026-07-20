// views/canon.js
// Canon list inspector with time-travel.
//
// Route: #/canon            → the current curated Zen-text list
//        #/canon?asOf=<sha> → the list exactly as it existed at commit <sha>
//
// The list itself is NOT bundled in the SPA — it is fetched fresh from the
// data repo's `zen_texts.json`. Time-travel re-fetches that same file pinned
// to a past commit SHA (via `dataFileUrlAtRef`, which swaps `main` for the
// SHA in the raw-GitHub URL). Past versions are enumerated with the GitHub
// commits API scoped to the file's path.
//
// This view is deliberately independent of the `#/dict` route and its WIP
// modules — it shares nothing with lib/zen-dict.js or views/dict-browse.js.

import { escapeHtml } from '../lib/format.js';
import {
    DATA_REPO_BASE,
    fetchJson,
    fetchText,
    dataFileUrlAtRef
} from '../lib/github.js';
import { loadTitlesIndexForCorpus } from '../lib/titles.js';
import { Corpus, inferCorpusForRelPath } from '../lib/corpus.js';
import { renderLookupCard, renderLookupEmpty } from '../lib/lookup-card.js';

// GitHub commits API scoped to zen_texts.json — one call, best-effort. The
// same raw-`fetch` shape lib/github.js already uses for the git-trees endpoint.
const COMMITS_API =
    'https://api.github.com/repos/Fabulu/CbetaZenTranslations/commits?path=zen_texts.json';

const CANON_FILE = 'zen_texts.json';
const CHANGELOG_FILE = 'CHANGELOG-zen-texts.md';

export function match(route) {
    return !!route && route.kind === 'canon';
}

// Canon is a web-only index page; never race the desktop app for it.
export function preferAppFirst(_route) { return false; }

export async function render(route, mount, shell) {
    const asOf = (route && route.asOf) || '';

    if (shell) {
        shell.setTitle('Canon');
        shell.setContext(
            'Zen canon',
            asOf ? 'Viewing a past version of the list.' : 'The curated list of Zen texts.'
        );
        if (typeof shell.hideStatus === 'function') shell.hideStatus();
    }

    mount.innerHTML =
        '<article class="panel lookup-card"><p class="lookup-empty-detail">Loading canon…</p></article>';

    // The canon list is the only hard dependency. Fetch it (pinned to the SHA
    // when time-travelling) and bail cleanly if it cannot be loaded.
    let data;
    try {
        data = await fetchJson(dataFileUrlAtRef(asOf, CANON_FILE));
    } catch (error) {
        renderLookupEmpty({
            title: 'Canon unavailable',
            detail: 'Could not load the canon list'
                + (asOf ? ' as of ' + asOf.slice(0, 7) : '') + '.',
            hint: (error && error.message) || 'Check your connection and try again.'
        }, mount);
        return;
    }

    const paths = Array.isArray(data.Zen) ? data.Zen
        : (Array.isArray(data.zen) ? data.zen : []);

    // Titles + changelog + commit history, all best-effort. A failure in any
    // of these degrades gracefully (bare file IDs, no changelog, current-only
    // version picker) but never blocks the list from rendering.
    const [cbetaTitles, openTitles, changelogText, commits] = await Promise.all([
        loadTitlesIndexForCorpus(Corpus.Cbeta),
        loadTitlesIndexForCorpus(Corpus.OpenZen),
        fetchText(dataFileUrlAtRef(asOf, CHANGELOG_FILE)).catch(() => ''),
        fetchCommits().catch(() => [])
    ]);

    const groups = buildGroups(paths, cbetaTitles, openTitles);
    const listVersion = typeof data.listVersion === 'string' ? data.listVersion : '';
    const listDate = shortDate(data.listVersionDate || data.UpdatedUtc || '');

    const subtitleBits = [`${paths.length} text${paths.length === 1 ? '' : 's'}`];
    if (listVersion) subtitleBits.push(listVersion);
    if (listDate) subtitleBits.push(listDate);

    const sections = [
        { heading: 'Version', content: { html: versionHtml(asOf, listVersion, commits) } }
    ];
    if (changelogText && changelogText.trim()) {
        sections.push({ heading: 'Changelog', content: { html: changelogHtml(changelogText) } });
    }
    if (data.Note) {
        sections.push({ heading: 'About this list', content: String(data.Note) });
    }
    sections.push({
        heading: `Texts (${paths.length})`,
        content: { html: listHtml(groups) }
    });

    renderLookupCard({
        title: 'Zen Canon',
        subtitle: subtitleBits.join(' · '),
        sections
    }, mount);

    // Selecting a version navigates; app.js's hashchange handler re-renders
    // this view as-of the chosen commit (or the current list for the blank
    // "Current" option). No manual re-render needed.
    const sel = mount.querySelector('#canon-version');
    if (sel) {
        sel.addEventListener('change', () => {
            const v = sel.value;
            window.location.hash = v ? '#/canon?asOf=' + encodeURIComponent(v) : '#/canon';
        });
    }
}

/**
 * Group the canon paths by their leading canon section (B, C, T, X, …), each
 * row resolved to its English title. Returns an ordered array of
 * `{ key, rows: [{ fileId, title }] }`, groups A→Z, rows by fileId.
 */
function buildGroups(paths, cbetaTitles, openTitles) {
    const byKey = new Map();
    for (const path of paths) {
        if (!path || typeof path !== 'string') continue;
        const fileId = fileIdFromPath(path);
        if (!fileId) continue;
        const key = groupKey(path);
        const title = titleFor(path, fileId, cbetaTitles, openTitles);
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push({ fileId, title });
    }
    const keys = Array.from(byKey.keys()).sort((a, b) => a.localeCompare(b));
    return keys.map((key) => ({
        key,
        rows: byKey.get(key).sort((a, b) => a.fileId.localeCompare(b.fileId))
    }));
}

/** First path segment = canon section label (e.g. `T/T48/T48n2005.xml` → `T`). */
function groupKey(path) {
    const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
    return parts.length ? parts[0] : '?';
}

/**
 * Derive the compact file ID from a repo-relative TEI path. CBETA: the
 * basename minus `.xml` (`T/T48/T48n2005.xml` → `T48n2005`). OpenZen:
 * `<publisher>.<slug>` (`ws/gateless-barrier/gateless-barrier.xml` →
 * `ws.gateless-barrier`).
 */
function fileIdFromPath(path) {
    const normalized = path.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    if (parts.length === 0) return '';
    if (inferCorpusForRelPath(normalized) === Corpus.OpenZen && parts.length >= 2) {
        return `${parts[0]}.${parts[1]}`;
    }
    const filename = parts[parts.length - 1];
    const dot = filename.lastIndexOf('.');
    return dot > 0 ? filename.substring(0, dot) : filename;
}

/** Best English title for a path/fileId, falling back to the bare file ID. */
function titleFor(path, fileId, cbetaTitles, openTitles) {
    const entry = cbetaTitles.get(path) || cbetaTitles.get(fileId)
        || openTitles.get(path) || openTitles.get(fileId);
    if (entry) return entry.enShort || entry.en || fileId;
    return fileId;
}

/** Render the grouped, linked text list. */
function listHtml(groups) {
    if (!groups.length) {
        return '<p class="lookup-empty-line">No texts in this version of the list.</p>';
    }
    return groups.map((g) => {
        const rows = g.rows.map((r) => `
            <li class="canon-row">
                <a class="canon-link text-link" href="#/${escapeHtml(r.fileId)}">${escapeHtml(r.title)}</a>
                <span class="canon-id">${escapeHtml(r.fileId)}</span>
            </li>`).join('');
        return `
            <div class="canon-group">
                <p class="canon-group-head">${escapeHtml(g.key)} <span class="canon-group-count">(${g.rows.length})</span></p>
                <ul class="canon-list">${rows}</ul>
            </div>`;
    }).join('');
}

/**
 * Render the time-travel version picker. The blank-valued option is the
 * current (`main`) list; each further option pins a past commit SHA. A note
 * states which version is on screen, with a link back to current when viewing
 * the past.
 */
function versionHtml(asOf, listVersion, commits) {
    const options = [];
    const currentLabel = listVersion ? `Current (${listVersion})` : 'Current';
    options.push(`<option value=""${asOf ? '' : ' selected'}>${escapeHtml(currentLabel)}</option>`);

    let asOfKnown = false;
    for (const c of commits) {
        const selected = asOf && c.sha === asOf;
        if (selected) asOfKnown = true;
        options.push(
            `<option value="${escapeHtml(c.sha)}"${selected ? ' selected' : ''}>`
            + escapeHtml(commitOptionLabel(c)) + '</option>');
    }
    // Viewing a SHA the API didn't return (rate-limited, older than the page,
    // etc.): keep it selectable so the picker still reflects reality.
    if (asOf && !asOfKnown) {
        options.unshift(
            `<option value="${escapeHtml(asOf)}" selected>${escapeHtml('As of ' + asOf.slice(0, 7))}</option>`);
    }

    const note = asOf
        ? `<p class="canon-version-note">Viewing the list as of <code>${escapeHtml(asOf.slice(0, 7))}</code>. `
            + `<a class="text-link" href="#/canon">View current version →</a></p>`
        : '<p class="canon-version-note">Viewing the current version of the list.</p>';

    const pickerHint = commits.length
        ? ''
        : '<p class="canon-version-note canon-version-note--muted">Past-version history is unavailable right now.</p>';

    return `
        <div class="canon-version">
            <label class="canon-version-label" for="canon-version">Time-travel to a past version</label>
            <select id="canon-version" class="canon-version-select">${options.join('')}</select>
            ${note}
            ${pickerHint}
        </div>`;
}

/** One-line label for a commit option: short SHA · date · summary. */
function commitOptionLabel(c) {
    const bits = [c.sha.slice(0, 7)];
    const d = shortDate(c.date);
    if (d) bits.push(d);
    if (c.message) bits.push(c.message);
    return bits.join(' · ');
}

/** Render the changelog as escaped preformatted text inside a collapsible block. */
function changelogHtml(text) {
    return `
        <details class="canon-changelog">
            <summary class="canon-changelog-summary text-link">Show changelog</summary>
            <pre class="canon-changelog-body">${escapeHtml(text.trim())}</pre>
        </details>`;
}

/** Fetch the commit history for zen_texts.json. Best-effort; [] on any failure. */
async function fetchCommits() {
    const res = await fetch(COMMITS_API, { cache: 'default' });
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data.map((c) => ({
        sha: c && c.sha ? String(c.sha) : '',
        date: c && c.commit && c.commit.author ? (c.commit.author.date || '') : '',
        message: c && c.commit ? String(c.commit.message || '').split('\n')[0] : ''
    })).filter((c) => c.sha);
}

/** Trim an ISO timestamp to its YYYY-MM-DD date part. Empty string on miss. */
function shortDate(iso) {
    if (!iso || typeof iso !== 'string') return '';
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
    return m ? m[1] : '';
}
