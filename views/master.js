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

    mount.innerHTML = renderMasterProfile(master);
}

function applyChrome(shell, name) {
    if (!shell) return;
    shell.setTitle(name ? 'Master · ' + name : 'Zen Master');
    shell.setContext(
        name ? `Zen Master · ${name}` : 'Zen Master',
        'From the Read Zen master database'
    );
    shell.setUpsell(
        'This is a single Zen master profile. The desktop app gives you an ' +
        'interactive lineage web, corpus text search across all CBETA texts, ' +
        'hover dictionary, side-by-side translation, and the ability to ' +
        '<strong>explore the complete lineage of 195 Chan masters</strong>.'
    );
    shell.hideStatus();
}

/** Fetch + cache the canonical masters.json. */
async function loadMasters() {
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

/** Find a master by name (case-insensitive for pinyin, exact for CJK). */
function findMaster(masters, name) {
    if (!Array.isArray(masters)) return null;
    const lower = name.toLowerCase();
    for (const m of masters) {
        if (!m || !m.names) continue;
        for (const n of m.names) {
            if (!n) continue;
            if (n === name) return m;
            if (n.toLowerCase() === lower) return m;
        }
    }
    return null;
}

/** Render the full master profile HTML. */
function renderMasterProfile(m) {
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

    html += `</article>`;
    return html;
}

/** Build a clickable link to another master's profile. */
function buildMasterLink(name) {
    const href = '#/master/' + encodeURIComponent(name);
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
