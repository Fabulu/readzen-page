// views/master.js
// Renders a rich Zen master profile page.
//
// Data source: masters.json at the root of CbetaZenTranslations repo.
// Contains all 195 masters with names, dates, school, teacher, students,
// biography, region, and reference links.
//
// Route: #/master/{name}
// The user parameter is optional and ignored for the canonical data.

import { DATA_REPO_BASE } from '../lib/github.js';
import * as cache from '../lib/cache.js';
import { escapeHtml } from '../lib/format.js';

const MASTER_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MASTERS_URL = DATA_REPO_BASE + 'masters.json';
const CORPUS_URL = DATA_REPO_BASE + 'master-corpus.json';

/** Route-kind matcher. */
export function match(route) {
    return route && route.kind === 'master';
}

/** Master lookups are instant — no app-first race. */
export function preferAppFirst(_route) {
    return false;
}

/**
 * Render the master profile for `route.name`.
 */
export async function render(route, mount, shell) {
    const name = (route && route.name) || '';
    applyChrome(shell, name);

    if (!name) {
        mount.innerHTML = emptyCard(
            'No master supplied',
            'The master link is missing a name.',
            'Expected shape: #/master/Linji Yixuan'
        );
        return;
    }

    mount.innerHTML = `<article class="panel lookup-card"><p style="opacity:0.5;padding:2rem;">Loading ${escapeHtml(name)}…</p></article>`;

    let masters;
    try {
        masters = await loadMasters();
    } catch (error) {
        const msg = String(error && error.message || '');
        mount.innerHTML = emptyCard('Master lookup failed', msg || 'Could not fetch masters.json.');
        return;
    }

    const master = findMaster(masters, name);
    if (!master) {
        mount.innerHTML = emptyCard(
            `Master "${name}" not found`,
            `No master matching "${name}" was found in the database.`,
            'Check spelling. Chinese names and pinyin variants are both searched.'
        );
        return;
    }

    // Load corpus appearances (non-blocking — render profile first, add appearances after)
    let corpus = null;
    try { corpus = await loadCorpus(); } catch { /* optional */ }
    const appearances = corpus ? (corpus.masters || {})[name] || null : null;

    mount.innerHTML = renderMasterProfile(master, appearances);
}

function applyChrome(shell, name) {
    if (!shell) return;
    shell.setTitle(name ? 'Master · ' + name : 'Zen Master');
    shell.setContext(
        name ? `Zen Master · ${name}` : 'Zen Master',
        'From the Read Zen master database'
    );
    shell.setUpsell(
        'Read Zen is a free desktop app for reading, translating, and studying ' +
        'Chinese Chan Buddhist texts. It includes an interactive lineage web of ' +
        '195 masters, full-corpus text search, hover dictionary, side-by-side ' +
        'translation, and scholar collections. You can <strong>create and share ' +
        'your own master profile links</strong> just like this one — right-click ' +
        'any master and choose "Copy Reddit Link".'
    );
    shell.hideStatus();
}

/** Fetch + cache the corpus appearance index. */
async function loadCorpus() {
    const cacheKey = 'masters:corpus';
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const resp = await fetch(CORPUS_URL);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    cache.set(cacheKey, data, MASTER_CACHE_TTL_MS);
    return data;
}

/** Fetch + cache the canonical masters.json. */
export async function loadMasters() {
    const cacheKey = 'masters:canonical';
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const resp = await fetch(MASTERS_URL);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const masters = data.masters || [];
    cache.set(cacheKey, masters, MASTER_CACHE_TTL_MS);
    return masters;
}

/** Find a master by name. Accepts underscores as spaces for URL-friendly form. */
function findMaster(masters, name) {
    if (!Array.isArray(masters)) return null;
    // Underscores in URL map to spaces in canonical names
    const normalized = name.replace(/_/g, ' ');
    const lower = normalized.toLowerCase();
    for (const m of masters) {
        if (!m || !m.names) continue;
        for (const n of m.names) {
            if (!n) continue;
            if (n === normalized || n === name) return m;
            if (n.toLowerCase() === lower) return m;
        }
    }
    return null;
}

/** Render the full master profile HTML. */
function renderMasterProfile(m, appearances) {
    const names = m.names || [];
    const primary = names[0] || '';
    const chinese = names.filter(n => /[\u4e00-\u9fff]/.test(n));
    const otherNames = names.slice(1).filter(Boolean);
    const floruit = m.floruit || 0;
    const death = m.death || 0;

    const datesText = formatDates(floruit, death);
    const schoolBadge = m.school
        ? `<span class="master-school-badge">${escapeHtml(m.school)}</span>`
        : '';

    let html = `<article class="panel master-profile">`;

    // Header
    html += `<header class="master-header">`;
    if (chinese.length > 0) {
        html += `<p class="master-chinese">${escapeHtml(chinese.join('  '))}</p>`;
    }
    html += `<h2 class="master-name">${escapeHtml(primary)}</h2>`;
    html += `<p class="master-meta">${datesText ? escapeHtml(datesText) : ''}`;
    if (schoolBadge) html += ` ${schoolBadge}`;
    if (m.region) html += ` · ${escapeHtml(m.region)}`;
    html += `</p>`;
    if (otherNames.length > 0) {
        html += `<p class="master-aliases">${escapeHtml(otherNames.join('  ·  '))}</p>`;
    }
    html += `</header>`;

    // Lineage
    if (m.teacher || (m.students && m.students.length > 0)) {
        html += `<section class="master-section">`;
        html += `<h3 class="master-section-heading">Lineage</h3>`;
        if (m.teacher) {
            const teacherLink = buildMasterLink(m.teacher);
            html += `<p class="master-lineage-item"><span class="master-label">Teacher:</span> ${teacherLink}</p>`;
        }
        if (m.students && m.students.length > 0) {
            const studentLinks = m.students.map(s => buildMasterLink(s)).join(', ');
            html += `<p class="master-lineage-item"><span class="master-label">Students:</span> ${studentLinks}</p>`;
        }
        html += `</section>`;
    }

    // Biography
    if (m.notes) {
        html += `<section class="master-section">`;
        html += `<h3 class="master-section-heading">Biography</h3>`;
        html += `<p class="master-bio">${escapeHtml(m.notes)}</p>`;
        html += `</section>`;
    }

    // Links
    if (m.links && m.links.length > 0) {
        html += `<section class="master-section">`;
        html += `<h3 class="master-section-heading">References</h3>`;
        html += `<div class="master-links">`;
        for (const link of m.links) {
            html += `<a href="${escapeHtml(link.url)}" target="_blank" rel="noopener" class="master-link">${escapeHtml(link.label)}</a>`;
        }
        html += `</div>`;
        html += `</section>`;
    }

    // Corpus appearances
    if (appearances) {
        html += `<section class="master-section">`;
        html += `<h3 class="master-section-heading">Text Appearances</h3>`;
        html += `<p class="master-meta">Mentioned in ${appearances.primary_count + appearances.secondary_count} texts (${appearances.total_mentions.toLocaleString()} total mentions)</p>`;

        if (appearances.primary && appearances.primary.length > 0) {
            html += `<p class="master-label" style="margin-top:0.8rem;">Primary texts (author/subject)</p>`;
            html += renderAppearanceList(appearances.primary);
        }
        if (appearances.secondary && appearances.secondary.length > 0) {
            html += `<p class="master-label" style="margin-top:0.8rem;">Also mentioned in</p>`;
            html += renderAppearanceList(appearances.secondary);
        }
        html += `<p class="master-appearance-upsell">Full corpus search in <a href="https://github.com/Fabulu/ReadZen" target="_blank" rel="noopener">Read Zen desktop</a> · <a href="https://ko-fi.com/readzen" target="_blank" rel="noopener">Support on Ko-fi</a></p>`;
        html += `</section>`;
    }

    html += `</article>`;
    return html;
}

/** Convert a corpus path like "T/T49/T49n2035.xml" or "ws/gateless-barrier/..." to a fileId. */
function fileIdFromPath(path) {
    if (!path) return null;
    const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.length === 0) return null;
    // OpenZen: ws/gateless-barrier/... → ws.gateless-barrier
    if (parts.length >= 2 && /^(ws|pd|ce|mit)$/i.test(parts[0])) return `${parts[0]}.${parts[1]}`;
    // CBETA: T/T49/T49n2035.xml → T49n2035
    const filename = parts[parts.length - 1];
    const dot = filename.lastIndexOf('.');
    return dot > 0 ? filename.substring(0, dot) : filename;
}

const INITIAL_SHOW = 10;
const SHOW_MORE_STEP = 20;

/** Render a list of text appearances with progressive disclosure. */
function renderAppearanceList(items) {
    const listId = 'app-list-' + (++renderAppearanceList._seq);
    let html = `<div class="master-appearances" id="${listId}">`;
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const title = item.title_zh || item.title || item.path;
        const sub = item.title && item.title_zh ? item.title : '';
        const fileId = fileIdFromPath(item.path);
        const hidden = i >= INITIAL_SHOW ? ' style="display:none" data-app-hidden' : '';
        html += `<div class="master-appearance"${hidden}>`;
        if (fileId) {
            html += `<a href="#/${encodeURIComponent(fileId)}" class="master-appearance-title">${escapeHtml(title)}</a>`;
        } else {
            html += `<span class="master-appearance-title">${escapeHtml(title)}</span>`;
        }
        if (sub) html += ` <span class="master-appearance-sub">${escapeHtml(sub)}</span>`;
        html += ` <span class="master-appearance-count">${item.mentions}x</span>`;
        if (item.snippet) {
            html += `<p class="master-appearance-snippet">${escapeHtml(item.snippet)}</p>`;
        }
        html += `</div>`;
    }
    if (items.length > INITIAL_SHOW) {
        const remaining = items.length - INITIAL_SHOW;
        html += `<button class="master-appearance-showmore" data-list="${listId}" data-shown="${INITIAL_SHOW}" onclick="(function(btn){`
            + `var list=document.getElementById(btn.dataset.list);`
            + `var shown=parseInt(btn.dataset.shown,10);`
            + `var next=shown+${SHOW_MORE_STEP};`
            + `var items=list.querySelectorAll('[data-app-hidden]');`
            + `for(var i=0;i<items.length&&shown<next;i++,shown++){items[i].style.display='';items[i].removeAttribute('data-app-hidden');}`
            + `btn.dataset.shown=''+shown;`
            + `var left=list.querySelectorAll('[data-app-hidden]').length;`
            + `if(!left){btn.remove();}else{btn.textContent='Show more ('+left+' remaining)';}`
            + `})(this)">Show more (${remaining} remaining)</button>`;
    }
    html += `</div>`;
    return html;
}
renderAppearanceList._seq = 0;

/** Build a clickable link to another master's profile using underscore URLs. */
function buildMasterLink(name) {
    // Use underscores for cleaner URLs: "Fayan Wenyi" -> "Fayan_Wenyi"
    const slug = name.replace(/ /g, '_');
    const href = '#/master/' + encodeURIComponent(slug).replace(/%20/g, '_');
    return `<a href="${href}" class="master-lineage-link">${escapeHtml(name)}</a>`;
}

function formatDates(floruit, death) {
    if (floruit && death) return `${floruit}–${death}`;
    if (floruit) return `fl. ${floruit}`;
    if (death) return `d. ${death}`;
    return '';
}

function emptyCard(title, detail, hint) {
    return `
        <article class="panel lookup-card lookup-card--empty">
            <header class="lookup-head">
                <h2 class="lookup-title">${escapeHtml(title || 'Not found')}</h2>
            </header>
            <p class="lookup-empty-detail">${escapeHtml(detail || '')}</p>
            ${hint ? `<p class="lookup-empty-hint">${escapeHtml(hint)}</p>` : ''}
        </article>
    `;
}
