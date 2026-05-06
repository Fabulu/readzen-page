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

function formatDate(iso) {
    if (!iso) return '';
    try {
        const d = new Date(iso);
        if (isNaN(d.getTime())) return '';
        return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    } catch { return ''; }
}

function extractWorkId(relPath) {
    if (!relPath) return '';
    const base = relPath.split('/').pop().replace(/\.xml$/i, '');
    return base;
}

const COLLECTION_CACHE_TTL_MS = 10 * 60 * 1000;

async function loadScholarIndex() {
    const key = 'scholar:index';
    const cached = cache.get(key);
    if (cached) return cached;

    // Try INDEX.json first
    try {
        const url = DATA_REPO_BASE + 'community/INDEX.json';
        const resp = await fetch(url);
        if (resp.ok) {
            const data = await resp.json();
            if (data.users && Array.isArray(data.users)) {
                cache.set(key, data.users, 10 * 60 * 1000);
                return data.users;
            }
        }
    } catch {}

    // Fallback: GitHub API directory listing
    try {
        const resp = await fetch('https://api.github.com/repos/Fabulu/CbetaZenTranslations/contents/community/collections');
        if (resp.ok) {
            const entries = await resp.json();
            const users = entries
                .filter(e => e.type === 'file' && e.name.endsWith('.jsonl'))
                .map(e => ({ name: e.name.replace(/\.jsonl$/, ''), collections: 0 }));
            cache.set(key, users, 10 * 60 * 1000);
            return users;
        }
    } catch {}

    return [];
}

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

    if (!user && !collectionId) {
        // Show user selector
        shell.setTitle('Scholar Collections');
        shell.setContext('Community');

        let users = await loadScholarIndex();
        // Filter out users with no collections (empty JSONL files)
        const usersWithCollections = [];
        for (const u of users) {
            const name = u.name || u;
            const count = u.collections || 0;
            if (count > 0) { usersWithCollections.push(u); continue; }
            // Unknown count (fallback path) — check by fetching the JSONL
            try {
                const url = DATA_REPO_BASE + 'community/collections/' + encodeURIComponent(name) + '.jsonl';
                const resp = await fetch(url, { method: 'HEAD' });
                if (resp.ok && parseInt(resp.headers.get('content-length') || '0', 10) > 10) {
                    usersWithCollections.push(u);
                }
            } catch {}
        }
        users = usersWithCollections;
        shell.hideStatus();

        if (users.length === 0) {
            mount.innerHTML = `<section class="list-wrap"><div class="list-empty"><p>No scholar collections have been published yet.</p></div></section>`;
            return;
        }

        const cards = users.map(u => {
            const name = u.name || u;
            const initial = (typeof name === 'string' ? name[0] : '?').toUpperCase();
            const count = u.collections || '';
            const countLabel = count ? `${count} collection${count !== 1 ? 's' : ''}` : 'View collections';
            return `<a class="scholar-user-card" href="#/scholar///${encodeURIComponent(name)}">
                <span class="scholar-user-avatar">${escapeHtml(initial)}</span>
                <span class="scholar-user-info">
                    <span class="scholar-user-name">${escapeHtml(name)}</span>
                    <span class="scholar-user-stats">${escapeHtml(countLabel)}</span>
                </span>
            </a>`;
        }).join('');

        mount.innerHTML = `<section class="list-wrap">
            <header class="list-head">
                <h2 class="list-title">Scholar Collections</h2>
                <p class="list-sub">Browse published research collections from the community</p>
            </header>
            <div class="scholar-user-grid">${cards}</div>
        </section>`;
        return;
    }

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

        if (user && !collectionId) {
            // Show this user's collection list
            shell.setTitle(`${user}'s Collections`);
            shell.hideStatus();

            if (!collections || collections.length === 0) {
                mount.innerHTML = `<section class="list-wrap"><div class="list-empty"><p>No collections found for ${escapeHtml(user)}.</p></div></section>`;
                return;
            }

            // Group collections: roots (no ParentCollectionId) first,
            // then children indented under their parent.
            const childrenByParent = new Map(); // parentId -> [collection]
            const roots = [];
            for (const c of collections) {
                const parentId = c.parentCollectionId || c.ParentCollectionId || '';
                if (parentId) {
                    if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
                    childrenByParent.get(parentId).push(c);
                } else {
                    roots.push(c);
                }
            }

            // Orphaned sub-collections (parent not in this list) render as roots
            for (const [parentId, children] of childrenByParent) {
                const parentExists = collections.some(c => (c.id || c.Id) === parentId);
                if (!parentExists) roots.push(...children);
            }

            function renderCard(c, isChild) {
                const cName = c.name || c.Name || c.id || c.Id || 'Untitled';
                const cId = c.id || c.Id || '';
                const passages = c.passages || c.Passages || [];
                const cTags = c.tags || c.Tags || [];
                const desc = c.description || c.Description || '';
                const indentClass = isChild ? ' scholar-collection-card--child' : '';
                return `<a class="scholar-collection-card${indentClass}" href="#/scholar/${encodeURIComponent(cId)}//${encodeURIComponent(user)}">
                    <span class="scholar-collection-card-title">${escapeHtml(cName)}</span>
                    <span class="scholar-collection-card-meta">${passages.length} passage${passages.length !== 1 ? 's' : ''}${desc ? ' · ' + escapeHtml(desc.slice(0, 60)) : ''}</span>
                    ${cTags.length ? `<span class="scholar-row-tags">${cTags.slice(0, 3).map(t => `<span class="tag-chip">${escapeHtml(t)}</span>`).join('')}</span>` : ''}
                </a>`;
            }

            // Build cards: root, then its children (expandable if it has any)
            let cards = '';
            for (const root of roots) {
                const rootId = root.id || root.Id || '';
                const children = childrenByParent.get(rootId) || [];
                cards += renderCard(root, false);
                if (children.length > 0) {
                    const groupId = 'sub-' + escapeHtml(rootId);
                    cards += `<div class="scholar-subcollection-toggle" data-target="${groupId}">
                        <button class="scholar-toggle-btn" aria-expanded="true" onclick="this.setAttribute('aria-expanded', this.getAttribute('aria-expanded')==='true'?'false':'true'); document.getElementById('${groupId}').hidden = this.getAttribute('aria-expanded')==='false';">
                            <span class="scholar-toggle-arrow">&#9662;</span> ${children.length} sub-collection${children.length !== 1 ? 's' : ''}
                        </button>
                    </div>`;
                    cards += `<div class="scholar-subcollection-group" id="${groupId}">`;
                    for (const child of children) {
                        cards += renderCard(child, true);
                    }
                    cards += `</div>`;
                }
            }

            mount.innerHTML = `<section class="list-wrap">
                <header class="list-head">
                    <h2 class="list-title">${escapeHtml(user)}'s Collections</h2>
                    <p class="list-sub">${collections.length} collection${collections.length !== 1 ? 's' : ''}</p>
                </header>
                <div class="scholar-user-grid">${cards}</div>
            </section>`;
            return;
        }

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
            renderCollectionMode(collection, user, shell, collections);
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

/** Render the collection in list mode: title + passage rows + sub-collections. */
function renderCollectionMode(collection, user, shell, allCollections) {
    const titleEl = document.querySelector('#scholar-title');
    const subEl = document.querySelector('#scholar-sub');
    const body = document.querySelector('#scholar-body');

    const name = collection.name || collection.Name || collection.id || collection.Id || 'Collection';
    const description = collection.description || collection.Description || '';
    const passages = collection.passages || collection.Passages || [];
    const tags = collection.tags || collection.Tags || [];
    const studyNotes = collection.studyNotes || collection.StudyNotes || '';

    titleEl.textContent = name;

    // Breadcrumb: if this is a sub-collection, show link back to parent
    const parentId = collection.parentCollectionId || collection.ParentCollectionId || '';
    if (parentId && allCollections) {
        const parent = allCollections.find(c => (c.id || c.Id) === parentId);
        if (parent) {
            const parentName = parent.name || parent.Name || 'Parent';
            subEl.innerHTML = `<a href="#/scholar/${encodeURIComponent(parentId)}//${encodeURIComponent(user)}" style="color:var(--accent,#6EAFF8);text-decoration:none">\u2190 ${escapeHtml(parentName)}</a> · ${passages.length} passage${passages.length === 1 ? '' : 's'} · by ${escapeHtml(user)}`;
        } else {
            subEl.textContent = `${passages.length} passage${passages.length === 1 ? '' : 's'} · by ${user}`;
        }
    } else {
        subEl.textContent = `${passages.length} passage${passages.length === 1 ? '' : 's'} · by ${user}`;
    }

    // Graph button (shown if the collection has links, concepts, or extra masters)
    const links = collection.links || collection.Links || [];
    const concepts = collection.concepts || collection.Concepts || [];
    const extraMasters = collection.extraMasters || collection.ExtraMasters || [];
    if (links.length > 0 || concepts.length > 0 || extraMasters.length > 0) {
        const cid = collection.id || collection.Id || '';
        const graphHref = '#/scholar/' + encodeURIComponent(cid) + '/graph/' + encodeURIComponent(user);
        const headEl = document.querySelector('#scholar-head');
        if (headEl) {
            const graphLink = document.createElement('a');
            graphLink.className = 'btn btn--small';
            graphLink.href = graphHref;
            graphLink.textContent = 'View Graph';
            headEl.appendChild(graphLink);
        }
    }

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

    // Sub-collections within this collection
    const subCollections = (allCollections || []).filter(c => {
        const parentId = c.parentCollectionId || c.ParentCollectionId || '';
        return parentId === cid;
    });
    const subCollectionHtml = subCollections.length > 0
        ? `<div class="scholar-subcollections">
            <div style="font-size:0.82rem;color:var(--muted,#888);margin-bottom:0.4rem">${subCollections.length} sub-collection${subCollections.length !== 1 ? 's' : ''}</div>
            ${subCollections.map(sc => {
                const scId = sc.id || sc.Id || '';
                const scName = sc.name || sc.Name || 'Untitled';
                const scPassages = sc.passages || sc.Passages || [];
                const scDesc = sc.description || sc.Description || '';
                return `<a class="scholar-collection-card scholar-collection-card--child" href="#/scholar/${encodeURIComponent(scId)}//${encodeURIComponent(user)}">
                    <span class="scholar-collection-card-title">${escapeHtml(scName)}</span>
                    <span class="scholar-collection-card-meta">${scPassages.length} passage${scPassages.length !== 1 ? 's' : ''}${scDesc ? ' \u00b7 ' + escapeHtml(scDesc.slice(0, 60)) : ''}</span>
                </a>`;
            }).join('')}
        </div>`
        : '';

    const passageRows = passages.map((p) => {
        const pid = p.id || p.Id || '';
        const relPath = p.sourceRelPath || p.SourceRelPath || '';
        const zh = p.zhText || p.ZhText || '';
        const en = p.enText || p.EnText || '';
        const fromLb = p.fromLb || p.FromLb || '';
        const toLb = p.toLb || p.ToLb || '';
        const rangeLabel = fromLb
            ? (toLb && toLb !== fromLb ? `${fromLb} – ${toLb}` : fromLb)
            : '';

        const summary = p.summary || p.Summary || '';
        const readingStatus = (p.readingStatus || p.ReadingStatus || '').toLowerCase();
        const importance = Math.min(5, Math.max(0, parseInt(p.importance || p.Importance || '0', 10)));
        const pTags = p.tags || p.Tags || [];
        const masters = p.masterNames || p.MasterNames || [];

        const displayTitle = summary || (zh.length > 60 ? zh.slice(0, 60) + '\u2026' : zh) || (en.length > 60 ? en.slice(0, 60) + '\u2026' : en) || '(untitled)';

        const href = '#/scholar/' + encodeURIComponent(cid) + '/' + encodeURIComponent(pid) + '/' + encodeURIComponent(user);

        return `<a class="scholar-row" href="${escapeHtml(href)}">
    ${readingStatus ? `<span class="scholar-row-status"><span class="status-dot status-dot--${escapeHtml(readingStatus)}"></span></span>` : ''}
    <span class="scholar-row-body">
        <span class="scholar-row-summary">${escapeHtml(displayTitle)}</span>
        <span class="scholar-row-meta-line">
            <span class="scholar-row-path">${escapeHtml(relPath || '\u2014')}</span>
            ${rangeLabel ? `<span class="scholar-row-range">${escapeHtml(rangeLabel)}</span>` : ''}
            ${masters.length ? `<span class="scholar-row-masters">${escapeHtml(masters.slice(0, 2).join(', '))}${masters.length > 2 ? ' +' + (masters.length - 2) : ''}</span>` : ''}
        </span>
        ${pTags.length ? `<span class="scholar-row-tags">${pTags.slice(0, 3).map(t => `<span class="tag-chip">${escapeHtml(t)}</span>`).join('')}${pTags.length > 3 ? `<span class="tag-chip">+${pTags.length - 3}</span>` : ''}</span>` : ''}
    </span>
    ${importance > 0 ? `<span class="scholar-row-importance">${'\u2605'.repeat(importance)}${'\u2606'.repeat(5 - importance)}</span>` : ''}
</a>`;
    }).join('');

    body.innerHTML = `
        ${descHtml}
        ${tagsChips}
        ${notesHtml}
        ${subCollectionHtml}
        ${passages.length === 0 && subCollections.length === 0
            ? '<p class="list-empty-hint">This collection has no passages yet.</p>'
            : passages.length === 0
                ? ''
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
    const summary = p.summary || p.Summary || '';
    const readingStatus = (p.readingStatus || p.ReadingStatus || '').toLowerCase();
    const importance = Math.min(5, Math.max(0, parseInt(p.importance || p.Importance || '0', 10)));
    const annotationType = (p.annotationType || p.AnnotationType || '').toLowerCase();
    const linkedTexts = p.linkedTexts || p.LinkedTexts || [];
    const apparatus = p.apparatus || p.Apparatus || [];
    const createdBy = p.createdBy || p.CreatedBy || '';
    const addedUtc = p.addedUtc || p.AddedUtc || '';
    const modifiedUtc = p.modifiedUtc || p.ModifiedUtc || '';

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
    if (readingStatus) metaLines.push(`<dt>Status</dt><dd><span class="status-dot status-dot--${escapeHtml(readingStatus)}"></span> ${escapeHtml(readingStatus)}</dd>`);
    if (importance > 0) metaLines.push(`<dt>Importance</dt><dd class="scholar-stars">${'\u2605'.repeat(importance)}${'\u2606'.repeat(5 - importance)}</dd>`);
    if (doctrinalTopic) metaLines.push(`<dt>Doctrine</dt><dd>${escapeHtml(doctrinalTopic)}</dd>`);
    if (literaryForm)   metaLines.push(`<dt>Form</dt><dd>${escapeHtml(literaryForm)}</dd>`);
    if (lineage)        metaLines.push(`<dt>Lineage</dt><dd>${escapeHtml(lineage)}</dd>`);
    if (rhetoricalFunction) metaLines.push(`<dt>Function</dt><dd>${escapeHtml(rhetoricalFunction)}</dd>`);
    if (createdBy) metaLines.push(`<dt>Added by</dt><dd>${escapeHtml(createdBy)}</dd>`);
    if (addedUtc) metaLines.push(`<dt>Added</dt><dd>${formatDate(addedUtc)}</dd>`);
    if (modifiedUtc && modifiedUtc !== addedUtc) metaLines.push(`<dt>Modified</dt><dd>${formatDate(modifiedUtc)}</dd>`);

    const tagsHtml = tags && tags.length
        ? `<div class="scholar-tags">${tags.map((t) => `<span class="tag-chip">${escapeHtml(t)}</span>`).join('')}</div>`
        : '';
    const mastersHtml = masters && masters.length
        ? `<div class="scholar-masters"><strong>Masters:</strong> ${escapeHtml(masters.join(', '))}</div>`
        : '';

    const annotationHtml = annotationType ? `<span class="scholar-annotation-label">[${escapeHtml(annotationType.toUpperCase())}]</span> ` : '';

    const linkedTextsHtml = linkedTexts.length ? `<details class="scholar-linked-texts">
    <summary>Appears in ${linkedTexts.length} text${linkedTexts.length !== 1 ? 's' : ''}</summary>
    <ul>${linkedTexts.map(t => `<li>${escapeHtml(t)}</li>`).join('')}</ul>
</details>` : '';

    const workId = extractWorkId(relPath);
    const readerHref = workId && fromLb ? `#/${encodeURIComponent(workId)}/${encodeURIComponent(fromLb)}${toLb && toLb !== fromLb ? '-' + encodeURIComponent(toLb) : ''}` : '';
    const openReaderHtml = readerHref ? `<a class="btn btn--small scholar-open-reader" href="${readerHref}">Open in Reader \u2197</a>` : '';

    body.innerHTML = `
        <nav class="scholar-nav">
            ${prevHref ? `<a class="text-link" href="${escapeHtml(prevHref)}">← Previous</a>` : '<span class="text-link" aria-disabled="true">← Previous</span>'}
            ${nextHref ? `<a class="text-link" href="${escapeHtml(nextHref)}">Next →</a>`     : '<span class="text-link" aria-disabled="true">Next →</span>'}
        </nav>

        ${summary ? `<div class="scholar-summary-box">${escapeHtml(summary)}</div>` : ''}

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
        ${linkedTextsHtml}
        ${notes ? `<div class="scholar-notes">${annotationHtml}<strong>Notes.</strong> ${escapeHtml(notes)}</div>` : ''}
        ${apparatus.length ? `<div class="scholar-apparatus"><strong>Textual Variants</strong><ul>${apparatus.map(e => {
            const lem = e.lemma || e.Lemma || '';
            const readings = e.readings || e.Readings || [];
            return readings.map(r => {
                const rdg = r.reading || r.Reading || '';
                const wit = r.witnessId || r.WitnessId || r.witness_id || '';
                return `<li>Lem: ${escapeHtml(lem)} / Variant: ${escapeHtml(rdg)}${wit ? ` [${escapeHtml(wit)}]` : ''}</li>`;
            }).join('');
        }).join('')}</ul></div>` : ''}
        ${openReaderHtml}
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
    return String(s || '').trim().toLowerCase().replace(/[_-]/g, ' ');
}
