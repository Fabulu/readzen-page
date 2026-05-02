// views/masters-browse.js
// Browse all Zen masters with school filtering and name search.
// Route: #/masters  or  #/masters?school=Linji&q=...

import { loadMasters } from './master.js';
import { escapeHtml } from '../lib/format.js';
import { navigate } from '../lib/navigate.js';

const SCHOOL_COLORS = {
    'Linji':      { bg: 'rgba(180, 60, 50, 0.22)', border: 'rgba(180, 60, 50, 0.55)', text: '#f0c0b8' },
    'Caodong':    { bg: 'rgba(55, 100, 170, 0.22)', border: 'rgba(55, 100, 170, 0.55)', text: '#b8d0f0' },
    'Yunmen':     { bg: 'rgba(120, 60, 160, 0.22)', border: 'rgba(120, 60, 160, 0.55)', text: '#d8b8f0' },
    'Fayan':      { bg: 'rgba(40, 140, 120, 0.22)', border: 'rgba(40, 140, 120, 0.55)', text: '#b0e8d8' },
    'Guiyang':    { bg: 'rgba(180, 140, 40, 0.22)', border: 'rgba(180, 140, 40, 0.55)', text: '#f0e0a0' },
    'Hongzhou':   { bg: 'rgba(200, 120, 50, 0.22)', border: 'rgba(200, 120, 50, 0.55)', text: '#f0d0a0' },
    'Niutou':     { bg: 'rgba(80, 160, 80, 0.22)', border: 'rgba(80, 160, 80, 0.55)', text: '#c0e8c0' },
    'Early Chan': { bg: 'rgba(154, 136, 96, 0.22)', border: 'rgba(154, 136, 96, 0.55)', text: '#e0d8c0' },
    'Chan':       { bg: 'rgba(106, 101, 96, 0.22)', border: 'rgba(106, 101, 96, 0.55)', text: '#d8d4cc' },
    'Korean Seon': { bg: 'rgba(26, 122, 106, 0.22)', border: 'rgba(26, 122, 106, 0.55)', text: '#b8e8dc' },
    'Early Korean Buddhism': { bg: 'rgba(58, 104, 88, 0.22)', border: 'rgba(58, 104, 88, 0.55)', text: '#c0d8c8' },
};

function schoolStyle(school) {
    const c = SCHOOL_COLORS[school];
    if (!c) return '';
    return `background:${c.bg};border-color:${c.border};color:${c.text}`;
}

/** Route-kind matcher. */
export function match(route) {
    return route && route.kind === 'masters';
}

export function preferAppFirst() { return false; }

export async function render(route, mount, shell) {
    if (shell) {
        shell.setTitle('Zen Masters');
        shell.setContext('Browse all Zen masters', 'Filter by school or search by name');
        shell.setUpsell(
            'Read Zen is a free desktop app for reading and translating Chinese Zen literature. ' +
            'It includes an interactive lineage web, full-corpus search, hover dictionary, ' +
            'and side-by-side translation. <a href="https://github.com/Fabulu/ReadZen/releases">Download free</a> · ' +
            '<a href="https://ko-fi.com/readzen">Support on Ko-fi</a>'
        );
        shell.hideStatus();
    }

    mount.innerHTML = '<article class="panel lookup-card"><p style="opacity:0.5;padding:2rem;">Loading masters...</p></article>';

    let masters;
    try {
        masters = await loadMasters();
    } catch (error) {
        mount.innerHTML = `<article class="panel lookup-card"><p>Failed to load masters: ${escapeHtml(String(error.message || error))}</p></article>`;
        return;
    }

    const schools = [...new Set(masters.map(m => m.school).filter(Boolean))].sort();
    const initialSchool = route.school || '';
    const initialQ = route.q || '';

    renderBrowse(mount, masters, schools, initialSchool, initialQ);
}

function renderBrowse(mount, masters, schools, activeSchool, activeQ) {
    const schoolOptions = schools.map(s =>
        `<option value="${escapeHtml(s)}"${s === activeSchool ? ' selected' : ''}>${escapeHtml(s)}</option>`
    ).join('');

    mount.innerHTML = `
        <div class="masters-browse">
            <header class="masters-browse-header">
                <div class="masters-browse-title-row">
                    <h2 class="masters-browse-title">Zen Masters</h2>
                    <a href="/lineage" class="masters-browse-link">View Lineage Web &rarr;</a>
                </div>
                <div class="masters-browse-controls">
                    <select class="masters-filter-select" aria-label="Filter by school">
                        <option value="">All schools</option>
                        ${schoolOptions}
                    </select>
                    <input type="text" class="masters-search-input" placeholder="Search by name..."
                           value="${escapeHtml(activeQ)}" aria-label="Search masters" />
                    <span class="masters-count"></span>
                </div>
            </header>
            <div class="masters-grid" id="masters-grid"></div>
        </div>
    `;

    const grid = mount.querySelector('#masters-grid');
    const select = mount.querySelector('.masters-filter-select');
    const input = mount.querySelector('.masters-search-input');
    const countEl = mount.querySelector('.masters-count');

    function update() {
        const school = select.value;
        const q = input.value.trim().toLowerCase();
        const filtered = masters.filter(m => {
            if (school && m.school !== school) return false;
            if (q) {
                const names = (m.names || []).join(' ').toLowerCase();
                if (!names.includes(q)) return false;
            }
            return true;
        });

        countEl.textContent = `${filtered.length} master${filtered.length === 1 ? '' : 's'}`;
        grid.innerHTML = filtered.map(m => renderCard(m)).join('');
    }

    // Bug 3 fix: delegated click for data-href spans inside <a> cards
    grid.addEventListener('click', e => {
        const linkEl = e.target.closest('[data-href]');
        if (linkEl) {
            e.preventDefault();
            e.stopPropagation();
            navigate(linkEl.dataset.href);
        }
    });

    select.addEventListener('change', update);
    input.addEventListener('input', update);
    update();

    if (activeQ) input.focus();
}

function renderCard(m) {
    const names = m.names || [];
    const primary = names[0] || '';
    const chinese = names.filter(n => /[\u4e00-\u9fff]/.test(n));
    const chineseText = chinese.length > 0 ? chinese[0] : '';
    const floruit = m.floruit || 0;
    const death = m.death || 0;
    const dates = floruit && death ? `${floruit}\u2013${death}`
        : floruit ? `fl. ${floruit}`
        : death ? `d. ${death}` : '';

    const slug = primary.replace(/ /g, '_');
    const profileHref = '/master/' + encodeURIComponent(slug);
    const lineageHref = '/lineage?focus=' + encodeURIComponent(slug);

    const badge = m.school
        ? `<span class="master-card-school" style="${schoolStyle(m.school)}">${escapeHtml(m.school)}</span>`
        : '';

    const teacherText = m.teacher
        ? `<span class="master-card-teacher">Teacher: ${escapeHtml(m.teacher)}</span>` : '';
    const studentCount = (m.students && m.students.length) || 0;
    const studentsText = studentCount > 0
        ? `<span class="master-card-students">${studentCount} student${studentCount === 1 ? '' : 's'}</span>` : '';

    return `
        <a href="${profileHref}" class="master-card">
            <div class="master-card-head">
                ${chineseText ? `<span class="master-card-zh">${escapeHtml(chineseText)}</span>` : ''}
                <span class="master-card-name">${escapeHtml(primary)}</span>
            </div>
            <div class="master-card-meta">
                ${dates ? `<span class="master-card-dates">${escapeHtml(dates)}</span>` : ''}
                ${badge}
            </div>
            <div class="master-card-foot">
                ${teacherText}
                ${studentsText}
            </div>
            <span class="master-card-lineage-link" data-href="${lineageHref}" title="View in lineage web">&#x21C8;</span>
        </a>
    `;
}
