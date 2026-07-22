// views/master.js
// Renders a rich Zen master profile page.
//
// Data source: masters.json at the root of CbetaZenTranslations repo.
// Contains all 301 masters with names, dates, school, teacher, students,
// biography, region, and reference links.
//
// Route: #/master/{name}
// The user parameter is optional and ignored for the canonical data.

import { DATA_REPO_BASE, loadTranslatedFileIds } from '../lib/github.js';
import * as cache from '../lib/cache.js';
import { escapeHtml } from '../lib/format.js';
import { loadAndSearchXml } from '../lib/search.js';

const MASTER_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MASTERS_URL = DATA_REPO_BASE + 'masters.json';
const CORPUS_INDEX_URL = DATA_REPO_BASE + 'corpus/masters/_index.json';
const CORPUS_SHARD_BASE = DATA_REPO_BASE + 'corpus/masters/';

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

    // Load per-master corpus shard — use the master's canonical name (first in names array)
    // rather than the route name, since the corpus index is keyed by canonical name.
    const canonicalName = (master.names && master.names[0]) || name;
    // Kick off the translated-file-id lookup in parallel (cached session-wide). Used to
    // badge appearance rows that have an English translation and to skip doomed 404s.
    const translatedPromise = loadTranslatedFileIds().catch(() => new Set());
    let appearances = null;
    try { appearances = await loadMasterCorpus(canonicalName); } catch {}
    let translatedIds = new Set();
    try { translatedIds = await translatedPromise; } catch {}

    mount.innerHTML = renderMasterProfile(master, appearances, translatedIds);
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
        'Chinese Chan/Zen texts. It includes an interactive lineage web of ' +
        '301 masters, full-corpus text search, hover dictionary, side-by-side ' +
        'translation, and scholar collections. You can <strong>create and share ' +
        'your own master profile links</strong> just like this one - right-click ' +
        'any master and choose "Copy Reddit Link".'
    );
    shell.hideStatus();
}

/** Fetch the lightweight corpus index (cached). */
async function loadCorpusIndex() {
    const key = 'masters:corpus-index';
    const cached = cache.get(key);
    if (cached) return cached;
    const resp = await fetch(CORPUS_INDEX_URL);
    if (!resp.ok) return null;
    const data = await resp.json();
    cache.set(key, data, MASTER_CACHE_TTL_MS);
    return data;
}

/** Fetch a single master's corpus shard (cached). */
async function loadMasterCorpus(canonicalName) {
    const key = 'masters:corpus:' + canonicalName;
    const cached = cache.get(key);
    if (cached) return cached;

    // Get slug from index, or derive it
    let slug;
    try {
        const idx = await loadCorpusIndex();
        const entry = idx && idx.masters && idx.masters[canonicalName];
        slug = entry && entry.slug;
    } catch {}
    if (!slug) slug = slugify(canonicalName);

    try {
        const resp = await fetch(CORPUS_SHARD_BASE + slug + '.json');
        if (!resp.ok) return null;
        const data = await resp.json();
        cache.set(key, data, MASTER_CACHE_TTL_MS);
        return data;
    } catch { return null; }
}

function slugify(name) {
    return name.toLowerCase()
        .replace(/[\u2019']/g, '')
        .replace(/[/\\]/g, '')
        .replace(/ /g, '_');
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
function renderMasterProfile(m, appearances, translatedIds) {
    const names = m.names || [];
    const primary = names[0] || '';
    const chinese = names.filter(n => /[\u4e00-\u9fff]/.test(n));
    const otherNames = names.slice(1).filter(Boolean);
    const datesText = formatDates(m);
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

    // Action buttons
    const slug = primary.replace(/ /g, '_');
    html += '<div class="master-actions">';
    html += '<a class="btn btn--small" href="#/search?master=' + encodeURIComponent(slug) + '">Search Texts</a>';
    html += ' <a class="btn btn--small btn--outline" href="#/lineage?focus=' + encodeURIComponent(slug) + '">View in Lineage</a>';
    html += '</div>';

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
            html += renderAppearanceList(appearances.primary, chinese, translatedIds);
        }
        if (appearances.secondary && appearances.secondary.length > 0) {
            html += `<p class="master-label" style="margin-top:0.8rem;">Also mentioned in</p>`;
            html += renderAppearanceList(appearances.secondary, chinese, translatedIds);
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

const PAGE_SIZE = 30;

const MAX_KWIC = 5; // passages shown per text before "show more"

/**
 * Render a paginated list of text appearances. Each row is collapsible; on first
 * expand it fetches LIVE, highlighted KWIC passages from the current search engine
 * (lib/search.js#loadAndSearchXml) for the master's Chinese names, replacing the
 * stale pre-baked snippet. `zhNames` are the master's Chinese names to search for.
 * `translatedIds` (may be empty if the GitHub tree API was unavailable) flags which
 * texts have an English translation — used to badge rows and gate the KWIC EN fetch.
 */
function renderAppearanceList(items, zhNames, translatedIds) {
    const listId = 'app-list-' + (++renderAppearanceList._seq);
    const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    let currentPage = 1;

    function renderItems(page) {
        const start = (page - 1) * PAGE_SIZE;
        const slice = items.slice(start, start + PAGE_SIZE);
        let html = '';
        for (const item of slice) {
            const title = item.title_zh || item.title || item.path;
            const sub = item.title && item.title_zh ? item.title : '';
            const fileId = fileIdFromPath(item.path);
            const canKwic = !!fileId && Array.isArray(zhNames) && zhNames.length > 0;
            html += '<div class="master-appearance"' + (fileId ? ' data-file-id="' + escapeHtml(fileId) + '"' : '') + '>';
            html += '<div class="mapp-head">';
            if (canKwic) {
                html += '<button class="mapp-toggle" aria-expanded="false" aria-label="Show passages" title="Show passages"></button>';
            } else {
                html += '<span class="mapp-toggle mapp-toggle--none"></span>';
            }
            if (fileId) {
                html += '<a href="#/' + encodeURIComponent(fileId) + '" class="master-appearance-title">' + escapeHtml(title) + '</a>';
            } else {
                html += '<span class="master-appearance-title">' + escapeHtml(title) + '</span>';
            }
            if (sub) html += ' <span class="master-appearance-sub">' + escapeHtml(sub) + '</span>';
            html += ' <span class="master-appearance-count">' + escapeHtml(String(item.mentions)) + '×</span>';
            if (fileId && translatedIds && translatedIds.has(fileId)) {
                html += '<span class="mapp-en-badge" title="An English translation is available">EN</span>';
            }
            html += '</div>'; // .mapp-head
            if (canKwic) {
                html += '<div class="mapp-kwic" hidden data-loaded="0"></div>';
            }
            html += '</div>'; // .master-appearance
        }
        return html;
    }

    function buildNav(page, total) {
        if (total <= 1) return '';
        const btns = [];
        btns.push('<button class="page-btn" data-page="' + (page - 1) + '"' + (page <= 1 ? ' disabled' : '') + '>\u2190 Prev</button>');
        const pages = new Set([1, total, page, page - 1, page + 1]);
        const sorted = [...pages].filter(p => p >= 1 && p <= total).sort((a, b) => a - b);
        let last = 0;
        for (const p of sorted) {
            if (p - last > 1) btns.push('<span class="page-ellipsis">\u2026</span>');
            btns.push('<button class="page-btn' + (p === page ? ' page-btn--active' : '') + '" data-page="' + p + '">' + p + '</button>');
            last = p;
        }
        btns.push('<button class="page-btn" data-page="' + (page + 1) + '"' + (page >= total ? ' disabled' : '') + '>Next \u2192</button>');
        if (total > 5) {
            btns.push('<input class="page-jump" type="number" min="1" max="' + total + '" value="' + page + '" title="Jump to page" />');
        }
        btns.push('<span class="page-info">' + page + ' of ' + total + '</span>');
        return '<nav class="page-nav">' + btns.join('') + '</nav>';
    }

    function wireNav(container) {
        const nav = container.querySelector('.page-nav');
        if (!nav) return;
        nav.querySelectorAll('[data-page]').forEach(btn => {
            btn.addEventListener('click', () => {
                const p = parseInt(btn.dataset.page, 10);
                if (p >= 1 && p <= totalPages && p !== currentPage) {
                    currentPage = p;
                    update();
                }
            });
        });
        const jumpInput = nav.querySelector('.page-jump');
        if (jumpInput) {
            jumpInput.addEventListener('change', () => {
                const p = parseInt(jumpInput.value, 10);
                if (p >= 1 && p <= totalPages && p !== currentPage) {
                    currentPage = p;
                    update();
                }
            });
        }
    }

    function update() {
        const list = document.getElementById(listId);
        if (!list) return;
        const body = list.querySelector('.master-appearances-body');
        if (body) body.innerHTML = renderItems(currentPage);
        const navWrap = list.querySelector('.master-appearances-nav');
        if (navWrap) navWrap.innerHTML = buildNav(currentPage, totalPages);
        wireNav(list);
        wireExpanders(list, zhNames, translatedIds);
    }

    const wrapHtml = '<div class="master-appearances" id="' + listId + '">'
        + '<div class="master-appearances-body">' + renderItems(1) + '</div>'
        + '<div class="master-appearances-nav">' + buildNav(1, totalPages) + '</div>'
        + '</div>';

    // Defer wiring until DOM is ready
    setTimeout(() => {
        const el = document.getElementById(listId);
        if (el) { wireNav(el); wireExpanders(el, zhNames, translatedIds); }
    }, 0);

    return wrapHtml;
}
renderAppearanceList._seq = 0;

/** Wire the collapse/expand toggles for a rendered appearance list; loads live KWIC on first open. */
function wireExpanders(container, zhNames, translatedIds) {
    // If we have a translated-id set, only ask for the EN alignment on texts we know are
    // translated (skips a doomed 404 per untranslated text). If the set is empty (API was
    // unavailable), fall back to asking unconditionally so EN never silently disappears.
    const haveSet = translatedIds && translatedIds.size > 0;
    container.querySelectorAll('.master-appearance').forEach(row => {
        const toggle = row.querySelector('.mapp-toggle');
        const body = row.querySelector('.mapp-kwic');
        if (!toggle || !body || toggle.classList.contains('mapp-toggle--none')) return;
        toggle.addEventListener('click', () => {
            if (body.hasAttribute('hidden')) {
                body.removeAttribute('hidden');
                toggle.setAttribute('aria-expanded', 'true');
                if (body.dataset.loaded === '0') {
                    body.dataset.loaded = '1';
                    const countEl = row.querySelector('.master-appearance-count');
                    const includeTr = haveSet ? translatedIds.has(row.dataset.fileId) : true;
                    loadKwicInto(body, row.dataset.fileId, zhNames, countEl, includeTr); // fire-and-forget; manages its own DOM
                }
            } else {
                body.setAttribute('hidden', '');
                toggle.setAttribute('aria-expanded', 'false');
            }
        });
    });
}

/**
 * Fetch live KWIC passages for `fileId` across the master's Chinese names, merge/dedupe
 * them, and render highlighted windows (bilingual where a translation exists) into `body`.
 * Updates the count badge to the live hit count. Aborts if the row leaves the DOM.
 */
async function loadKwicInto(body, fileId, zhNames, countEl, includeTranslation) {
    body.innerHTML = '<p class="mapp-kwic-loading">Loading passages…</p>';
    const terms = Array.isArray(zhNames) ? zhNames.filter(Boolean) : [];
    if (!fileId || terms.length === 0) {
        body.innerHTML = '<p class="mapp-kwic-empty">No searchable name for this master.</p>';
        return;
    }
    try {
        const merged = [];
        const seen = new Set();
        const trans = new Map();
        for (const term of terms) {
            let r;
            try {
                r = await loadAndSearchXml(fileId, term, { includeTranslation: !!includeTranslation });
            } catch {
                continue; // one alias failing shouldn't sink the rest
            }
            if (!document.body.contains(body)) return; // route changed mid-load
            for (const p of (r.passages || [])) {
                // Key by position (line + left-context), NOT the matched term, so overlapping
                // aliases (e.g. 臨濟 ⊂ 臨濟義玄) at the same spot collapse to one row. The
                // canonical (first) name wins the highlight since it's searched first.
                const key = JSON.stringify([p.lineId || '', p.left || '']);
                if (seen.has(key)) continue;
                seen.add(key);
                merged.push(p);
            }
            if (r.translatedPassages) {
                for (const [k, v] of r.translatedPassages) {
                    if (!trans.has(k)) trans.set(k, v);
                }
            }
        }
        if (!document.body.contains(body)) return;
        if (merged.length === 0) {
            const baked = countEl ? countEl.textContent : '';
            body.innerHTML = '<p class="mapp-kwic-empty">No live matches in this text' + (baked ? ' (indexed ' + escapeHtml(baked) + ')' : '') + '.</p>';
            return;
        }
        merged.sort((a, b) => String(a.startLb).localeCompare(String(b.startLb)));
        if (countEl) countEl.textContent = merged.length + '×';
        body.innerHTML = renderKwicRows(merged, trans, MAX_KWIC, fileId);
        const more = body.querySelector('.mapp-showmore');
        if (more) {
            more.addEventListener('click', () => {
                body.innerHTML = renderKwicRows(merged, trans, merged.length, fileId);
            });
        }
    } catch {
        body.innerHTML = '<p class="mapp-kwic-empty mapp-kwic-error">Couldn’t load passages.</p>';
    }
}

/** Render up to `limit` KWIC rows; append a "show more" button when more remain. */
function renderKwicRows(passages, trans, limit, fileId) {
    const shown = passages.slice(0, limit);
    let html = shown.map(p => renderKwicRow(p, trans, fileId)).join('');
    if (passages.length > limit) {
        html += '<button class="mapp-showmore">Show ' + (passages.length - limit) + ' more</button>';
    }
    return html;
}

/** One KWIC window (Chinese, match highlighted) with an optional aligned English row.
 *  Each row links into the reader at its exact line, mirroring the search view. */
function renderKwicRow(p, trans, fileId) {
    let lbRange = p.startLb;
    if (p.endLb && p.endLb !== p.startLb) lbRange = p.startLb + '-' + p.endLb;
    const href = '#/' + encodeURIComponent(fileId) + '/' + lbRange + '?q=' + encodeURIComponent(p.match || '');
    const en = trans && trans.get(p.startLb);
    let row = '<a class="mapp-kwic-row' + (en ? ' mapp-kwic-row--bi' : '') + '" href="' + escapeHtml(href) + '">'
        + '<span class="mapp-kwic-left">' + escapeHtml(p.left || '') + '</span>'
        + '<mark class="search-highlight mapp-kwic-match">' + escapeHtml(p.match || '') + '</mark>'
        + '<span class="mapp-kwic-right">' + escapeHtml(p.right || '') + '</span>'
        + '<span class="mapp-kwic-lb">' + escapeHtml(p.lineId || '') + '</span>';
    if (en) {
        row += '<span class="mapp-kwic-en"><span class="mapp-kwic-en-label">EN</span>' + escapeHtml(en) + '</span>';
    }
    row += '</a>';
    return row;
}

/** Build a clickable link to another master's profile using underscore URLs. */
function buildMasterLink(name) {
    // Use underscores for cleaner URLs: "Fayan Wenyi" -> "Fayan_Wenyi"
    const slug = name.replace(/ /g, '_');
    const href = '#/master/' + encodeURIComponent(slug).replace(/%20/g, '_');
    return `<a href="${href}" class="master-lineage-link">${escapeHtml(name)}</a>`;
}

// Kept byte-for-byte in step with lineage-data.js#formatDates and the desktop's
// LineageGraphBuilder.FormatDates. It is NOT imported from lineage-data.js on
// purpose: that module bundles the whole 943-record roster, which this view has
// no reason to pull in just to format four numbers.
//
// The version this replaces took (floruit, death) and never saw `birth`, which
// was wrong twice over. It hid a birth year we hold on 252 masters (Songshan Puji
// showed "d. 739" while his record says 651). Worse, `floruit && death` rendered
// a floruit as the left side of a range on 286 masters: Daoan (fl. 312, b. 314,
// d. 385) displayed "312–385", which reads as a birth year and is off by two.
// A floruit is "active around", never a birth. It only renders alone, as "fl.".
function formatDates(m) {
    const b = m.birth || 0;
    const d = m.death || 0;
    const f = m.floruit || 0;
    const c = m.dates_conjectural ? 'c. ' : '';
    if (b && d) return `${c}${b}–${d}`;
    if (d) return `${c}d. ${d}`;
    if (b) return `${c}b. ${b}`;
    if (f) return `${c}fl. ${f}`;
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
