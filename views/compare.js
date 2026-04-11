// views/compare.js
// Side-by-side comparison of two translations against the original CBETA XML.
//
// A compare route looks like:
//   #/compare/{workId}/{pane}/{sourceA}/{sourceB}?from=&to=&highlight=
//
// Each source can be:
//   - "me"         : greyed placeholder for the user's local-only copy
//   - "community"  : the authoritative xml-p5t translation
//   - "{username}" : a community translation by that user
//
// Renders 3 columns: Original | Source A | Source B. Line range is honoured.
// This view races the desktop app first (it's a rich preview), like passage.

import { escapeHtml, sliceLines, sliceFirstN, renderLinesHtml } from '../lib/format.js';
import { parseTei } from '../lib/tei.js';
import {
    sourceXmlUrl,
    authoritativeTranslationUrl,
    communityTranslationUrl,
    fetchText
} from '../lib/github.js';
import { buildZenUri } from '../lib/route.js';
import * as cache from '../lib/cache.js';
import { lookupTitle } from '../lib/titles.js';

const XML_CACHE_TTL_MS = 10 * 60 * 1000;

export function match(route) {
    return route && route.kind === 'compare' && !route.incomplete;
}

/** Compare links open the desktop app first — the preview is a fallback. */
export function preferAppFirst(_route) { return true; }

export async function render(route, mount, shell) {
    const workId = route.fileId;
    const sourceA = route.sourceA || '';
    const sourceB = route.sourceB || '';
    // Accept both `from`/`to` (from route parser) and `fromLine`/`toLine` (legacy prop names).
    const startLine = route.from || route.fromLine || '';
    const endLine   = route.to   || route.toLine   || startLine;
    const hasRange = !!startLine;

    shell.setTitle(`Compare · ${workId}`);
    shell.setContext(
        `Comparing ${describeSource(sourceA)} · ${describeSource(sourceB)}`,
        hasRange
            ? (startLine === endLine ? startLine : `${startLine} – ${endLine}`)
            : 'Outline / full work'
    );

    // Background title lookup so the header shows the human title
    lookupTitle(workId).then((entry) => {
        if (!entry) return;
        const t = entry.enShort || entry.en || entry.zh || workId;
        const sub = entry.zh && t !== entry.zh ? entry.zh : '';
        shell.setTitle(`Compare · ${sub ? `${t} · ${sub}` : t}`);
        try { document.title = `Compare · ${t} · Read Zen Preview`; } catch {}
    });
    shell.setStatus('Loading compare preview…', 'Fetching the original and both translations.', false);

    const srcUrl = sourceXmlUrl(workId);
    if (!srcUrl) {
        shell.showError('Unrecognised work ID', `Could not resolve "${workId}" to a CBETA file.`);
        return;
    }
    shell.setExtraLink('Source XML', srcUrl);

    mount.innerHTML = `
        <div class="compare-grid" id="compare-grid">
            <article class="panel">
                <div class="panel-head">
                    <p class="panel-label">Original</p>
                    <p class="panel-meta" id="orig-meta">${escapeHtml(workId)}</p>
                </div>
                <div class="panel-title" id="orig-title">Chinese source</div>
                <div class="panel-body panel-body--source" id="orig-body">
                    <div class="panel-skeleton">Loading source XML…</div>
                </div>
            </article>
            <article class="panel" id="panel-a">
                <div class="panel-head">
                    <p class="panel-label" id="label-a">${escapeHtml(describeSource(sourceA))}</p>
                    <p class="panel-meta" id="meta-a"></p>
                </div>
                <div class="panel-title" id="title-a"></div>
                <div class="panel-body" id="body-a">
                    <div class="panel-skeleton">Loading translation…</div>
                </div>
            </article>
            <article class="panel" id="panel-b">
                <div class="panel-head">
                    <p class="panel-label" id="label-b">${escapeHtml(describeSource(sourceB))}</p>
                    <p class="panel-meta" id="meta-b"></p>
                </div>
                <div class="panel-title" id="title-b"></div>
                <div class="panel-body" id="body-b">
                    <div class="panel-skeleton">Loading translation…</div>
                </div>
            </article>
        </div>
    `;

    try {
        // Kick all three fetches off in parallel.
        const [sourceWork, workA, workB] = await Promise.all([
            loadXml(srcUrl),
            resolveAndLoad(workId, sourceA),
            resolveAndLoad(workId, sourceB)
        ]);

        // Original pane.
        const origMeta = document.querySelector('#orig-meta');
        const origBody = document.querySelector('#orig-body');
        origMeta.textContent = sourceWork.titleZh || workId;

        if (!hasRange) {
            // Outline fallback for rangeless compares: show first 30 non-empty
            // lines from the original, and a note that the user should specify
            // a range for a proper comparison.
            const lines = sliceFirstN(sourceWork.linesById, sourceWork.lineOrder, 30);
            origBody.innerHTML = `
                <div class="outline-banner">
                    No line range specified — showing the first ${lines.length} lines
                    of each side. Add <code>?from=…&amp;to=…</code> for a targeted diff.
                </div>
                ${renderLinesHtml(lines)}
            `;
        } else {
            let lines;
            try {
                lines = sliceLines(sourceWork.linesById, sourceWork.lineOrder, startLine, endLine);
            } catch {
                lines = sliceLines(sourceWork.linesById, sourceWork.lineOrder, '', '');
            }
            origBody.innerHTML = renderLinesHtml(lines);
        }

        // Translation panes.
        fillTranslationPane('a', workA, sourceA, hasRange, startLine, endLine, workId, shell);
        fillTranslationPane('b', workB, sourceB, hasRange, startLine, endLine, workId, shell);

        shell.hideStatus();
        window.requestAnimationFrame(syncCompareRowHeights);
    } catch (error) {
        shell.showError(
            'Compare failed to load',
            (error && error.message) || 'Unknown error while loading comparison data.',
            buildZenUri(route)
        );
    }
}

/**
 * Render one translation column. `workResult` can be one of:
 *   - { kind: 'me' }           → render the "local only" placeholder
 *   - { kind: 'work', work }   → render the translated lines
 *   - { kind: 'error', error } → render the not-available notice
 */
function fillTranslationPane(key, workResult, sourceLabel, hasRange, startLine, endLine, workId, shell) {
    const body = document.querySelector('#body-' + key);
    const meta = document.querySelector('#meta-' + key);
    const title = document.querySelector('#title-' + key);

    if (!workResult || workResult.kind === 'me') {
        body.innerHTML = `
            <div class="panel-empty compare-me-placeholder">
                <p><strong>Your local copy.</strong></p>
                <p>Install Read Zen to compare your edits against other translations in this tab.</p>
            </div>
        `;
        meta.textContent = '— local only —';
        title.textContent = '';
        return;
    }

    if (workResult.kind === 'error') {
        body.innerHTML = `
            <div class="panel-empty">
                <p>No matching translation XML was found at the expected path.</p>
                <p class="panel-empty-hint">${escapeHtml((workResult.error && workResult.error.message) || '')}</p>
            </div>
        `;
        meta.textContent = '—';
        title.textContent = '';
        return;
    }

    const work = workResult.work;
    meta.textContent = work.titleEn || work.titleZh || workId;
    title.textContent = hasRange ? 'English rendering' : 'English rendering · preview';

    let lines;
    if (!hasRange) {
        lines = sliceFirstN(work.linesById, work.lineOrder, 30);
    } else {
        try {
            lines = sliceLines(work.linesById, work.lineOrder, startLine, endLine);
        } catch {
            lines = sliceLines(work.linesById, work.lineOrder, '', '');
        }
    }
    body.innerHTML = renderLinesHtml(lines);

    if (workResult.url && shell) {
        shell.setExtraLink(
            key === 'a' ? 'Translation A XML' : 'Translation B XML',
            workResult.url
        );
    }
}

/**
 * Resolve a compare source identifier into a loaded work. Returns a uniform
 * `{ kind, work?, url?, error? }` shape so the caller doesn't care whether
 * the source is "me", community, or a named user.
 */
async function resolveAndLoad(workId, source) {
    const lower = String(source || '').toLowerCase();

    if (!source || lower === 'me') {
        return { kind: 'me' };
    }

    let url = null;
    if (lower === 'community' || lower === 'authoritative' || lower === 'auth') {
        url = authoritativeTranslationUrl(workId);
    } else {
        url = communityTranslationUrl(workId, source);
    }

    if (!url) {
        return { kind: 'error', error: new Error('No translation URL resolved for source "' + source + '"') };
    }

    try {
        const work = await loadXml(url);
        return { kind: 'work', work, url };
    } catch (error) {
        return { kind: 'error', error };
    }
}

/**
 * Fetch + parse TEI XML with caching. Caches the raw XML text rather than
 * the parsed object — parsed TEI contains Map instances that don't survive
 * sessionStorage's JSON round-trip.
 */
async function loadXml(url) {
    const cacheKey = 'xml-text:' + url;
    let text = cache.get(cacheKey);
    if (typeof text !== 'string') {
        text = await fetchText(url);
        cache.set(cacheKey, text, XML_CACHE_TTL_MS);
    }
    return parseTei(text);
}

/** Human label for a compare source id. */
function describeSource(source) {
    if (!source) return '—';
    const lower = source.toLowerCase();
    if (lower === 'me') return 'My copy (local only)';
    if (lower === 'community' || lower === 'authoritative' || lower === 'auth') return 'Authoritative';
    return 'Community · ' + source;
}

/** Align row heights across all three compare columns. */
function syncCompareRowHeights() {
    const origRows = document.querySelectorAll('#orig-body .line-row');
    const aRows = document.querySelectorAll('#body-a .line-row');
    const bRows = document.querySelectorAll('#body-b .line-row');
    const count = Math.min(origRows.length, aRows.length, bRows.length);
    if (!count) return;

    for (let i = 0; i < count; i += 1) {
        origRows[i].style.minHeight = '';
        aRows[i].style.minHeight = '';
        bRows[i].style.minHeight = '';
    }
    for (let j = 0; j < count; j += 1) {
        const h = Math.max(
            origRows[j].offsetHeight,
            aRows[j].offsetHeight,
            bRows[j].offsetHeight
        );
        const px = h + 'px';
        origRows[j].style.minHeight = px;
        aRows[j].style.minHeight = px;
        bRows[j].style.minHeight = px;
    }
}
