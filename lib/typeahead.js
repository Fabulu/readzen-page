// lib/typeahead.js — Standalone typeahead/autocomplete module.
import { escapeHtml } from './format.js';
import { OPEN_ZEN_PUBLISHERS } from './corpus.js';

/**
 * Attach typeahead behaviour to an input element.
 * @param {HTMLInputElement} input
 * @param {{ titles: Array<{path:string, zh:string, en:string}>,
 *           masters: Array<{names:string[], school?:string, deathYear?:number}>,
 *           onSelect: (sel:{kind:string, href:string, query?:string})=>void }} opts
 * @returns {{ close: ()=>void }}
 */
export function initTypeahead(input, { titles, masters, onSelect }) {
    // --- pre-compute lowercase blobs ---
    const mBlobs = masters.map(m => {
        const primary = (m.names && m.names[0]) || '';
        const blob = (m.names || []).join(' ').toLowerCase();
        return { m, primary, blob };
    });
    const tBlobs = titles.map(t => {
        const blob = `${t.zh || ''} ${t.en || ''} ${t.path || ''}`.toLowerCase();
        const fileId = fileIdFromPath(t.path);
        return { t, blob, fileId };
    });

    // --- DOM setup ---
    const wrap = document.createElement('div');
    wrap.className = 'ta-wrap';
    wrap.style.position = 'relative';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('autocomplete', 'off');

    const dropdown = document.createElement('div');
    dropdown.className = 'ta-dropdown';
    dropdown.setAttribute('role', 'listbox');
    dropdown.hidden = true;
    wrap.appendChild(dropdown);

    let items = [], activeIdx = -1, timer = null;

    // --- helpers ---
    function fileIdFromPath(p) {
        if (!p) return p;
        const normalized = p.replace(/\\/g, '/');
        const parts = normalized.split('/').filter(Boolean);
        if (parts.length >= 2 && OPEN_ZEN_PUBLISHERS.includes(parts[0].toLowerCase())) {
            return parts[0] + '.' + parts[1];
        }
        const m = p.match(/([^/]+)\.xml$/);
        return m ? m[1] : p;
    }
    function slugify(name) { return name.replace(/ /g, '_'); }

    function close() {
        dropdown.hidden = true;
        dropdown.innerHTML = '';
        items = []; activeIdx = -1;
        input.setAttribute('aria-expanded', 'false');
    }

    function setActive(idx) {
        items.forEach((el, i) => {
            const on = i === idx;
            el.classList.toggle('ta-item--active', on);
            el.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        activeIdx = idx;
        if (items[idx]) items[idx].scrollIntoView({ block: 'nearest' });
    }

    function select(el) {
        const kind = el.dataset.kind;
        const href = el.dataset.href || '';
        close();
        input.value = '';
        onSelect({ kind, href, query: el.dataset.query || undefined });
    }

    function render(q) {
        const lq = q.toLowerCase();
        dropdown.innerHTML = '';
        items = [];

        // Masters — top 3 prefix then substring
        const mHits = mBlobs
            .filter(b => b.blob.includes(lq))
            .sort((a, b) => {
                const ap = a.blob.startsWith(lq) ? 0 : 1;
                const bp = b.blob.startsWith(lq) ? 0 : 1;
                return ap - bp;
            })
            .slice(0, 3);

        if (mHits.length) {
            dropdown.insertAdjacentHTML('beforeend', '<div class="ta-section-label">Masters</div>');
            for (const h of mHits) {
                const slug = slugify(h.primary);
                const meta = [h.m.school, h.m.deathYear ? 'd.\u2009' + h.m.deathYear : ''].filter(Boolean).join(' \u00b7 ');
                const html = `<div class="ta-item ta-item--master" role="option" aria-selected="false" data-kind="master" data-href="#/master/${escapeHtml(encodeURIComponent(slug))}"><span class="ta-item-primary">${escapeHtml(h.primary)}</span><span class="ta-item-meta">${escapeHtml(meta)}</span></div>`;
                dropdown.insertAdjacentHTML('beforeend', html);
            }
        }

        // Titles — top 5 substring
        const tHits = tBlobs.filter(b => b.blob.includes(lq)).slice(0, 5);
        if (tHits.length) {
            dropdown.insertAdjacentHTML('beforeend', '<div class="ta-section-label">Texts</div>');
            for (const h of tHits) {
                const href = '#/' + escapeHtml(h.fileId);
                const html = `<div class="ta-item ta-item--text" role="option" aria-selected="false" data-kind="text" data-href="${href}" data-query="${escapeHtml(q)}"><span class="ta-item-zh">${escapeHtml(h.t.zh || '')}</span><span class="ta-item-en">${escapeHtml(h.t.en || '')}</span></div>`;
                dropdown.insertAdjacentHTML('beforeend', html);
            }
        }

        // Full-text fallback
        const ftHtml = `<div class="ta-item ta-item--action" role="option" aria-selected="false" data-kind="fulltext" data-query="${escapeHtml(q)}">Search full text for \u201c${escapeHtml(q)}\u201d</div>`;
        dropdown.insertAdjacentHTML('beforeend', ftHtml);

        items = [...dropdown.querySelectorAll('.ta-item')];
        activeIdx = -1;
        dropdown.hidden = false;
        input.setAttribute('aria-expanded', 'true');
    }

    // --- events ---
    input.addEventListener('input', () => {
        clearTimeout(timer);
        const q = input.value.trim();
        if (!q) { close(); return; }
        timer = setTimeout(() => render(q), 150);
    });

    input.addEventListener('keydown', (e) => {
        if (dropdown.hidden) return;
        if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(activeIdx + 1, items.length - 1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(activeIdx - 1, 0)); }
        else if (e.key === 'Enter' && activeIdx >= 0) { e.preventDefault(); select(items[activeIdx]); }
        else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });

    dropdown.addEventListener('click', (e) => {
        const el = e.target.closest('.ta-item');
        if (el) select(el);
    });

    document.addEventListener('click', (e) => {
        if (!wrap.contains(e.target)) close();
    });

    return { close };
}
