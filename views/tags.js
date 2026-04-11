// views/tags.js
// Rich preview of a user's tags for a given work.
//
// Streams `community/tags/{user}.jsonl` from the translations repo and
// filters entries that match the requested workId (and optional tagId).
// Also fetches the user's tag vocabulary (`community/tag-vocabularies/{user}.json`)
// so each row can render the tag's display name + colour.
//
// Does NOT race app-first — the tag list is an instant, informational view.

import { escapeHtml } from '../lib/format.js';
import { parseTei } from '../lib/tei.js';
import {
    DATA_REPO_BASE,
    sourceXmlUrl,
    fetchText,
    fetchJson,
    xmlUrlForFileId
} from '../lib/github.js';
import { streamJsonl } from '../lib/jsonl.js';
import * as cache from '../lib/cache.js';
import { lookupTitle } from '../lib/titles.js';

const XML_CACHE_TTL_MS = 10 * 60 * 1000;
const VOCAB_CACHE_TTL_MS = 10 * 60 * 1000;

const DEFAULT_TAG_COLOR = '#3498DB';

/**
 * Validate a user-supplied color hex (e.g. "#RRGGBB"). Accepts only 3-, 4-,
 * 6-, and 8-digit hex forms so a malicious vocabulary entry can't inject
 * arbitrary CSS when interpolated into an inline `style="background:${color}"`.
 * Returns the (normalized) color on success, or `null` on rejection.
 */
function safeColor(c) {
    if (typeof c !== 'string') return null;
    if (!/^#[0-9A-Fa-f]{3,8}$/.test(c)) return null;
    return c;
}

export function match(route) {
    return route && route.kind === 'tags' && !!route.fileId;
}

/** Tags view renders immediately; no desktop-first race. */
export function preferAppFirst(_route) {
    return false;
}

export async function render(route, mount, shell) {
    const workId = route.fileId;
    const user = route.user || '';
    const tagIdFilter = (route.tagId || '').trim();

    shell.setTitle(`Tags · ${workId}`);
    shell.setContext(
        user ? `Tags in ${workId} by ${user}` : `Tags in ${workId}`,
        tagIdFilter ? `Filtered to tag "${tagIdFilter}"` : 'Community tags from the Read Zen corpus'
    );

    // Background title lookup
    lookupTitle(workId).then((entry) => {
        if (!entry) return;
        const t = entry.enShort || entry.en || entry.zh || workId;
        const sub = entry.zh && t !== entry.zh ? entry.zh : '';
        shell.setTitle(`Tags · ${sub ? `${t} · ${sub}` : t}`);
        shell.setContext(
            user ? `Tags in ${t} by ${user}` : `Tags in ${t}`,
            tagIdFilter ? `Filtered to tag "${tagIdFilter}"` : 'Community tags from the Read Zen corpus'
        );
        try { document.title = `Tags · ${t} · Read Zen Preview`; } catch {}
    });

    if (!user) {
        shell.showError(
            'Missing user',
            'Tag views need a username: #/tags/{workId}/{user}[/{tagId}]'
        );
        return;
    }

    shell.setStatus(
        'Loading tags…',
        `Streaming community/tags/${user}.jsonl`,
        false
    );

    // Scaffold + live list container.
    mount.innerHTML = `
        <section class="list-wrap">
            <header class="list-head" id="tags-head">
                <h2 class="list-title">Tags in ${escapeHtml(workId)}</h2>
                <p class="list-sub" id="tags-sub">Loading…</p>
            </header>
            <div class="list-body" id="tags-list"></div>
            <div class="list-empty" id="tags-empty" hidden></div>
        </section>
    `;

    const listEl = document.querySelector('#tags-list');
    const subEl = document.querySelector('#tags-sub');
    const emptyEl = document.querySelector('#tags-empty');

    // Start loading the vocabulary and source XML in parallel so rows can be
    // enriched with tag names + source text as soon as they arrive.
    const vocabPromise = loadVocabulary(user).catch(() => null);
    const sourceXmlPromise = loadSourceXml(workId).catch(() => null);

    const tagsUrl = `${DATA_REPO_BASE}community/tags/${encodeURIComponent(user)}.jsonl`;
    shell.setExtraLink('Tags JSONL', tagsUrl);

    // Build the work-id → relPath comparators. ReadZen may store RelPath as
    // "T48/T48n2005.xml" (2-part) while our xmlUrlForFileId produces
    // "T/T48/T48n2005.xml" (3-part). Accept either by comparing the file name.
    const workFileName = workId + '.xml';
    const expectedRels = [];
    const rel = xmlUrlForFileId(workId);   // e.g. "T/T48/T48n2005.xml"
    if (rel) expectedRels.push(rel.toLowerCase());
    // Also the 2-part form (trim leading canon/).
    if (rel) {
        const parts = rel.split('/');
        if (parts.length > 1) expectedRels.push(parts.slice(1).join('/').toLowerCase());
    }

    function matchesWork(relPath) {
        if (!relPath) return false;
        const lower = String(relPath).replace(/\\/g, '/').toLowerCase();
        if (lower === workFileName.toLowerCase()) return true;
        if (expectedRels.includes(lower)) return true;
        // Fall back: any tail match on the file name.
        return lower.endsWith('/' + workFileName.toLowerCase());
    }

    // Resolve the vocabulary once; used to enrich rows as we render them.
    let vocab = null;
    const pendingRows = [];
    let totalMatched = 0;
    let sourceWork = null;
    let sourceWorkTried = false;

    async function ensureSource() {
        if (sourceWorkTried) return sourceWork;
        sourceWorkTried = true;
        try { sourceWork = await sourceXmlPromise; }
        catch { sourceWork = null; }
        return sourceWork;
    }

    // Kick off vocabulary load in background; when it arrives, rewrite rows.
    vocabPromise.then((v) => {
        vocab = v;
        // Re-render any already-emitted rows so their tag names/colours update.
        const rows = listEl.querySelectorAll('.tag-row');
        rows.forEach((row) => {
            const tagId = row.getAttribute('data-tag-id') || '';
            applyVocabularyToRow(row, tagId, vocab);
        });
        // Update page header if we're filtered to a specific tag.
        if (tagIdFilter && vocab) {
            const def = findTag(vocab, tagIdFilter);
            if (def) {
                const headTitle = document.querySelector('#tags-head .list-title');
                if (headTitle) {
                    const safe = safeColor(def.color) || DEFAULT_TAG_COLOR;
                    headTitle.innerHTML =
                        `Tag <span class="tag-chip" style="background:${safe}20;border-color:${safe}">${escapeHtml(def.name || tagIdFilter)}</span> in ${escapeHtml(workId)}`;
                }
            }
        }
    });

    try {
        for await (const tag of streamJsonl(tagsUrl)) {
            if (!tag || typeof tag !== 'object') continue;
            if (!matchesWork(tag.relPath || tag.RelPath)) continue;

            const tagIdValue = tag.tagId || tag.TagId || '';
            if (tagIdFilter && tagIdValue !== tagIdFilter) continue;

            totalMatched += 1;

            const row = buildRow(tag, workId, user);
            listEl.appendChild(row);
            applyVocabularyToRow(row, tagIdValue, vocab);

            // Lazy-enrich with source text once the XML is ready.
            ensureSource().then((work) => {
                if (!work) return;
                fillSourceSnippet(row, tag, work);
            });

            // Progressive feedback.
            if (totalMatched === 1) {
                subEl.textContent = `${totalMatched} tag found so far…`;
            } else if (totalMatched % 5 === 0) {
                subEl.textContent = `${totalMatched} tags found so far…`;
            }
        }

        shell.hideStatus();

        if (totalMatched === 0) {
            listEl.hidden = true;
            emptyEl.hidden = false;
            emptyEl.innerHTML = `
                <p>No tags found for this file by <strong>${escapeHtml(user)}</strong>.</p>
                <p class="list-empty-hint">
                    The file may not be tagged, the user may not exist, or
                    the community JSONL has not been published yet.
                </p>
            `;
            subEl.textContent = '0 tags';
        } else {
            subEl.textContent = `${totalMatched} tag${totalMatched === 1 ? '' : 's'}`;
        }
    } catch (error) {
        // 404 = user has no shared tags. Treat as "empty", not as a hard error.
        if (String(error && error.message || '').includes('HTTP 404')) {
            shell.hideStatus();
            listEl.hidden = true;
            emptyEl.hidden = false;
            emptyEl.innerHTML = `
                <p>No tags published for <strong>${escapeHtml(user)}</strong>.</p>
                <p class="list-empty-hint">
                    The file <code>community/tags/${escapeHtml(user)}.jsonl</code>
                    does not exist in the translations repo.
                </p>
            `;
            subEl.textContent = '0 tags';
            return;
        }
        shell.showError(
            'Tags failed to load',
            (error && error.message) || 'Unknown error while streaming tag data.'
        );
    }
}

/** Fetch the tag vocabulary JSON, cached. Returns null on 404. */
async function loadVocabulary(user) {
    const url = `${DATA_REPO_BASE}community/tag-vocabularies/${encodeURIComponent(user)}.json`;
    const key = 'tagvocab:' + url;
    const cached = cache.get(key);
    if (cached) return cached;

    try {
        const json = await fetchJson(url);
        cache.set(key, json, VOCAB_CACHE_TTL_MS);
        return json;
    } catch (error) {
        if (String(error && error.message || '').includes('HTTP 404')) {
            cache.set(key, null, VOCAB_CACHE_TTL_MS);
            return null;
        }
        throw error;
    }
}

/** Look up a tag definition by ID, tolerating both PascalCase and camelCase. */
function findTag(vocab, tagId) {
    if (!vocab || !tagId) return null;
    const tags = vocab.tags || vocab.Tags || [];
    for (const t of tags) {
        if (!t) continue;
        if ((t.id || t.Id) === tagId) return { id: t.id || t.Id, name: t.name || t.Name, color: t.color || t.Color };
    }
    return null;
}

/** Fetch and parse the source XML for a given work id. Cached. */
async function loadSourceXml(workId) {
    const url = sourceXmlUrl(workId);
    if (!url) return null;
    const cacheKey = 'xml:' + url;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const text = await fetchText(url);
    const parsed = parseTei(text);
    cache.set(cacheKey, parsed, XML_CACHE_TTL_MS);
    return parsed;
}

/** Build a DOM row for a tag entry. */
function buildRow(tag, workId, user) {
    const fromLb = tag.fromLb || tag.FromLb || '';
    const toLb   = tag.toLb   || tag.ToLb   || fromLb;
    const tagId  = tag.tagId  || tag.TagId  || '';
    const rangeLabel = fromLb && toLb && fromLb !== toLb
        ? `${fromLb} – ${toLb}`
        : (fromLb || '');

    const href = '#/' + workId + '/' + fromLb + (toLb && toLb !== fromLb ? '-' + toLb : '') + '/en/' + encodeURIComponent(user);

    const row = document.createElement('a');
    row.className = 'tag-row';
    row.href = href;
    row.setAttribute('data-tag-id', tagId);
    row.setAttribute('data-from-lb', fromLb);
    row.setAttribute('data-to-lb', toLb);
    row.innerHTML = `
        <span class="tag-row-range">${escapeHtml(rangeLabel)}</span>
        <span class="tag-row-body">
            <span class="tag-row-tag" data-role="chip">
                <span class="tag-chip tag-chip--placeholder">${escapeHtml(tagId || 'tag')}</span>
            </span>
            <span class="tag-row-snippet" data-role="snippet">Loading source…</span>
        </span>
    `;
    return row;
}

/** Apply vocabulary lookup to a tag row's chip. Safe to call repeatedly. */
function applyVocabularyToRow(row, tagId, vocab) {
    const chipWrap = row.querySelector('[data-role="chip"]');
    if (!chipWrap) return;
    if (!vocab) return;
    const def = findTag(vocab, tagId);
    if (!def) return;
    const color = safeColor(def.color) || DEFAULT_TAG_COLOR;
    chipWrap.innerHTML =
        `<span class="tag-chip" style="background:${color}22;border-color:${color};color:${color}">${escapeHtml(def.name || tagId)}</span>`;
}

/** Fill the source snippet in a row once the TEI XML has parsed. */
function fillSourceSnippet(row, tag, work) {
    const snippetEl = row.querySelector('[data-role="snippet"]');
    if (!snippetEl) return;

    const fromLb = tag.fromLb || tag.FromLb || '';
    const toLb = tag.toLb || tag.ToLb || fromLb;
    if (!fromLb) {
        snippetEl.textContent = '';
        return;
    }

    const order = work.lineOrder || [];
    const map = work.linesById;
    if (!map) { snippetEl.textContent = ''; return; }

    const startIdx = order.indexOf(fromLb);
    if (startIdx < 0) {
        snippetEl.textContent = '[line not found]';
        snippetEl.classList.add('tag-row-snippet--missing');
        return;
    }
    let endIdx = toLb ? order.indexOf(toLb) : startIdx;
    if (endIdx < 0) endIdx = startIdx;
    if (endIdx < startIdx) endIdx = startIdx;

    const parts = [];
    for (let i = startIdx; i <= endIdx && parts.join('').length < 160; i += 1) {
        const line = map.get(order[i]);
        if (line && line.text) parts.push(line.text);
    }
    let snippet = parts.join(' ');
    if (snippet.length > 80) snippet = snippet.substring(0, 80) + '…';
    snippetEl.textContent = snippet || '[empty]';
}
