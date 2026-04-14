// views/scholar.js
// Rich preview of a scholar collection (or a single passage within one).
//
// Streams `community/collections/{user}.jsonl` from the translations repo
// and renders either:
//   - Collection mode: title + passage list (no passageId set)
//   - Passage mode: one passage's zh/en side-by-side + metadata + prev/next
//
// Does NOT race app-first — the collection view is an instant, informational page.

import { escapeHtml } from '../lib/format.js';
import { DATA_REPO_BASE } from '../lib/github.js';
import { streamJsonl } from '../lib/jsonl.js';
import * as cache from '../lib/cache.js';

const COLLECTION_CACHE_TTL_MS = 10 * 60 * 1000;

export function match(route) {
    return route && route.kind === 'scholar';
}

export function preferAppFirst(_route) { return false; }

export async function render(route, mount, shell) {
    const collectionId = (route.collectionId || '').trim();
    const passageId    = (route.passageId || '').trim();
    const user         = (route.user || '').trim();

    shell.setTitle(
        collectionId
            ? `Scholar · ${collectionId}${passageId ? ' · ' + passageId : ''}`
            : 'Scholar'
    );
    shell.setContext(
        user ? `Collection by ${user}` : 'Scholar collection',
        passageId ? `Passage ${passageId}` : 'Passage list'
    );
    shell.setUpsell(
        'This preview shows one scholar collection. The desktop app lets ' +
        'you <strong>build your own collections</strong>, browse the ' +
        'both Zen text corpora (CBETA and OpenZen) to find passages, edit notes alongside the ' +
        'source, and share collection links like this one with your community.'
    );

    if (!user) {
        shell.showError(
            'Missing user',
            'Scholar links need a username: #/scholar/{collectionId}/{passageId?}/{user}'
        );
        return;
    }

    shell.setStatus('Loading collection…', `Streaming community/collections/${user}.jsonl`, false);

    mount.innerHTML = `
        <section class="list-wrap">
            <header class="list-head" id="scholar-head">
                <h2 class="list-title" id="scholar-title">Loading…</h2>
                <p class="list-sub" id="scholar-sub"></p>
            </header>
            <div class="list-body" id="scholar-body"></div>
            <div class="list-empty" id="scholar-empty" hidden></div>
        </section>
    `;

    const url = `${DATA_REPO_BASE}community/collections/${encodeURIComponent(user)}.jsonl`;
    shell.setExtraLink('Collections JSONL', url);

    try {
        const collections = await loadCollections(user, url);

        // Locate target collection.
        let collection = null;
        if (collectionId) {
            collection = collections.find((c) =>
                (c.id || c.Id) === collectionId ||
                normalizeName(c.name || c.Name) === normalizeName(collectionId)
            ) || null;
        }

        if (!collection) {
            shell.hideStatus();
            const titleEl = document.querySelector('#scholar-title');
            const emptyEl = document.querySelector('#scholar-empty');
            const body = document.querySelector('#scholar-body');
            if (titleEl) titleEl.textContent = `Collection not found`;
            if (body) body.hidden = true;
            if (emptyEl) {
                emptyEl.hidden = false;
                emptyEl.innerHTML = collectionId
                    ? `<p>No collection with ID <code>${escapeHtml(collectionId)}</code> was found in
                       <code>community/collections/${escapeHtml(user)}.jsonl</code>.</p>`
                    : `<p>This scholar link does not reference a specific collection.</p>`;
            }
            return;
        }

        if (passageId) {
            renderPassageMode(collection, passageId, user, shell);
        } else {
            renderCollectionMode(collection, user, shell);
        }
        shell.hideStatus();
    } catch (error) {
        if (String(error && error.message || '').includes('HTTP 404')) {
            shell.hideStatus();
            const body = document.querySelector('#scholar-body');
            const emptyEl = document.querySelector('#scholar-empty');
            const titleEl = document.querySelector('#scholar-title');
            if (titleEl) titleEl.textContent = 'No collections published';
            if (body) body.hidden = true;
            if (emptyEl) {
                emptyEl.hidden = false;
                emptyEl.innerHTML = `
                    <p>No scholar collections published for <strong>${escapeHtml(user)}</strong>.</p>
                    <p class="list-empty-hint">
                        The file <code>community/collections/${escapeHtml(user)}.jsonl</code>
                        does not exist in the translations repo.
                    </p>
                `;
            }
            return;
        }
        shell.showError(
            'Scholar failed to load',
            (error && error.message) || 'Unknown error while streaming collection data.'
        );
    }
}

/** Render the collection in list mode: title + passage rows. */
function renderCollectionMode(collection, user, shell) {
    const titleEl = document.querySelector('#scholar-title');
    const subEl = document.querySelector('#scholar-sub');
    const body = document.querySelector('#scholar-body');

    const name = collection.name || collection.Name || collection.id || collection.Id || 'Collection';
    const description = collection.description || collection.Description || '';
    const passages = collection.passages || collection.Passages || [];
    const tags = collection.tags || collection.Tags || [];
    const studyNotes = collection.studyNotes || collection.StudyNotes || '';

    titleEl.textContent = name;
    subEl.textContent = `${passages.length} passage${passages.length === 1 ? '' : 's'} · by ${user}`;

    const tagsChips = tags && tags.length
        ? `<div class="scholar-tags">${tags.map((t) => `<span class="tag-chip">${escapeHtml(t)}</span>`).join('')}</div>`
        : '';

    const descHtml = description
        ? `<p class="scholar-description">${escapeHtml(description)}</p>`
        : '';

    const notesHtml = studyNotes
        ? `<div class="scholar-study-notes"><strong>Study notes.</strong> ${escapeHtml(studyNotes)}</div>`
        : '';

    const cid = collection.id || collection.Id || '';
    const passageRows = passages.map((p) => {
        const pid = p.id || p.Id || '';
        const relPath = p.sourceRelPath || p.SourceRelPath || '';
        const zh = p.zhText || p.ZhText || '';
        const en = p.enText || p.EnText || '';
        const notes = p.notes || p.Notes || '';
        const fromLb = p.fromLb || p.FromLb || '';
        const toLb = p.toLb || p.ToLb || '';
        const rangeLabel = fromLb
            ? (toLb && toLb !== fromLb ? `${fromLb} – ${toLb}` : fromLb)
            : '';

        const href = '#/scholar/' + encodeURIComponent(cid) + '/' + encodeURIComponent(pid) + '/' + encodeURIComponent(user);
        const snippet = (zh || en).trim().replace(/\s+/g, ' ').substring(0, 80);
        const snippetHtml = snippet
            ? `<span class="scholar-row-snippet">${escapeHtml(snippet)}${(zh || en).length > 80 ? '…' : ''}</span>`
            : '<span class="scholar-row-snippet scholar-row-snippet--missing">[no text]</span>';

        const notesLine = notes
            ? `<span class="scholar-row-notes">${escapeHtml(notes.substring(0, 120))}${notes.length > 120 ? '…' : ''}</span>`
            : '';

        return `
            <a class="scholar-row" href="${escapeHtml(href)}">
                <span class="scholar-row-meta">
                    <span class="scholar-row-path">${escapeHtml(relPath || '—')}</span>
                    ${rangeLabel ? `<span class="scholar-row-range">${escapeHtml(rangeLabel)}</span>` : ''}
                </span>
                <span class="scholar-row-text">
                    ${snippetHtml}
                    ${notesLine}
                </span>
            </a>
        `;
    }).join('');

    body.innerHTML = `
        ${descHtml}
        ${tagsChips}
        ${notesHtml}
        ${passages.length === 0
            ? '<p class="list-empty-hint">This collection has no passages yet.</p>'
            : `<div class="scholar-list">${passageRows}</div>`}
    `;
}

/** Render one passage with zh/en side-by-side + metadata + prev/next nav. */
function renderPassageMode(collection, passageId, user, _shell) {
    const titleEl = document.querySelector('#scholar-title');
    const subEl = document.querySelector('#scholar-sub');
    const body = document.querySelector('#scholar-body');
    const emptyEl = document.querySelector('#scholar-empty');

    const passages = collection.passages || collection.Passages || [];
    const idx = passages.findIndex((p) => (p.id || p.Id) === passageId);
    if (idx < 0) {
        titleEl.textContent = `Passage not found`;
        body.hidden = true;
        emptyEl.hidden = false;
        emptyEl.innerHTML = `
            <p>No passage with ID <code>${escapeHtml(passageId)}</code> was found in
            collection <strong>${escapeHtml(collection.name || collection.Name || '')}</strong>.</p>
        `;
        return;
    }

    const p = passages[idx];
    const cname = collection.name || collection.Name || collection.id || collection.Id || 'Collection';
    const cid = collection.id || collection.Id || '';
    titleEl.textContent = cname;
    subEl.textContent = `Passage ${idx + 1} of ${passages.length} · by ${user}`;

    const relPath = p.sourceRelPath || p.SourceRelPath || '';
    const fromLb = p.fromLb || p.FromLb || '';
    const toLb = p.toLb || p.ToLb || '';
    const zh = p.zhText || p.ZhText || '';
    const en = p.enText || p.EnText || '';
    const notes = p.notes || p.Notes || '';
    const tags = p.tags || p.Tags || [];
    const masters = p.masterNames || p.MasterNames || [];
    const doctrinalTopic = p.doctrinalTopic || p.DoctrinalTopic || '';
    const literaryForm = p.literaryForm || p.LiteraryForm || '';
    const lineage = p.lineage || p.Lineage || '';
    const rhetoricalFunction = p.rhetoricalFunction || p.RhetoricalFunction || '';

    const prev = passages[idx - 1];
    const next = passages[idx + 1];

    function navHref(target) {
        if (!target) return null;
        const pid = target.id || target.Id || '';
        return '#/scholar/' + encodeURIComponent(cid) + '/' + encodeURIComponent(pid) + '/' + encodeURIComponent(user);
    }

    const prevHref = navHref(prev);
    const nextHref = navHref(next);

    const metaLines = [];
    if (relPath) metaLines.push(`<dt>Source</dt><dd>${escapeHtml(relPath)}</dd>`);
    if (fromLb || toLb) {
        const range = toLb && toLb !== fromLb ? `${fromLb} – ${toLb}` : (fromLb || toLb);
        metaLines.push(`<dt>Range</dt><dd>${escapeHtml(range)}</dd>`);
    }
    if (doctrinalTopic) metaLines.push(`<dt>Doctrine</dt><dd>${escapeHtml(doctrinalTopic)}</dd>`);
    if (literaryForm)   metaLines.push(`<dt>Form</dt><dd>${escapeHtml(literaryForm)}</dd>`);
    if (lineage)        metaLines.push(`<dt>Lineage</dt><dd>${escapeHtml(lineage)}</dd>`);
    if (rhetoricalFunction) metaLines.push(`<dt>Function</dt><dd>${escapeHtml(rhetoricalFunction)}</dd>`);

    const tagsHtml = tags && tags.length
        ? `<div class="scholar-tags">${tags.map((t) => `<span class="tag-chip">${escapeHtml(t)}</span>`).join('')}</div>`
        : '';
    const mastersHtml = masters && masters.length
        ? `<div class="scholar-masters"><strong>Masters:</strong> ${escapeHtml(masters.join(', '))}</div>`
        : '';

    body.innerHTML = `
        <nav class="scholar-nav">
            ${prevHref ? `<a class="text-link" href="${escapeHtml(prevHref)}">← Previous</a>` : '<span class="text-link" aria-disabled="true">← Previous</span>'}
            ${nextHref ? `<a class="text-link" href="${escapeHtml(nextHref)}">Next →</a>`     : '<span class="text-link" aria-disabled="true">Next →</span>'}
        </nav>

        <div class="preview-grid scholar-passage-grid">
            <article class="panel">
                <div class="panel-head"><p class="panel-label">Chinese</p></div>
                <div class="panel-body panel-body--source">
                    ${zh ? `<div class="scholar-text-block">${escapeHtml(zh)}</div>` : '<div class="panel-empty">No zh text.</div>'}
                </div>
            </article>
            <article class="panel">
                <div class="panel-head"><p class="panel-label">English</p></div>
                <div class="panel-body">
                    ${en ? `<div class="scholar-text-block">${escapeHtml(en)}</div>` : '<div class="panel-empty">No en text.</div>'}
                </div>
            </article>
        </div>

        ${tagsHtml}
        ${mastersHtml}
        ${metaLines.length ? `<dl class="scholar-meta">${metaLines.join('')}</dl>` : ''}
        ${notes ? `<div class="scholar-notes"><strong>Notes.</strong> ${escapeHtml(notes)}</div>` : ''}
    `;
}

/** Stream the full JSONL once, cache the parsed array. */
async function loadCollections(user, url) {
    const key = 'scholar:' + user;
    const cached = cache.get(key);
    if (cached) return cached;

    const rows = [];
    for await (const row of streamJsonl(url)) {
        if (row && typeof row === 'object') rows.push(row);
    }
    cache.set(key, rows, COLLECTION_CACHE_TTL_MS);
    return rows;
}

function normalizeName(s) {
    return String(s || '').trim().toLowerCase();
}
