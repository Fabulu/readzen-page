// lib/lookup-card.js
// Shared card renderer used by the dictionary, termbase, and master views.
// Keeps the three lookup views visually consistent without dragging any of
// them into a shared stylesheet or component framework.
//
// Sections are intentionally flexible: each `{ heading, content }` pair is
// rendered as a labeled block, and `content` may be a plain string, a raw
// HTML string (tagged via `{ html: '...' }`), or an array of strings that
// render as a bulleted list.

import { escapeHtml } from './format.js';

/**
 * Render a lookup card into `mount`. Earlier content is replaced.
 *
 * @param {object} card
 * @param {string} card.title        Large top line (Chinese term, master name, ...).
 * @param {string} [card.subtitle]   Muted second line (pinyin, English rendering, ...).
 * @param {Array<{heading: string, content: string | string[] | {html: string}}>} [card.sections]
 * @param {string} [card.footer]     Attribution line (e.g. "by Fabulu").
 * @param {string} [card.banner]     Optional banner at the top (e.g. fallback notice).
 * @param {HTMLElement} mount
 */
export function renderLookupCard(card, mount) {
    const sections = Array.isArray(card.sections) ? card.sections : [];

    const bannerHtml = card.banner
        ? `<div class="lookup-banner">${escapeHtml(card.banner)}</div>`
        : '';

    const subtitleHtml = card.subtitle
        ? `<p class="lookup-subtitle">${escapeHtml(card.subtitle)}</p>`
        : '';

    const sectionsHtml = sections
        .filter((s) => s && s.heading && s.content != null)
        .map((s) => `
            <div class="lookup-section">
                <p class="lookup-section-heading">${escapeHtml(s.heading)}</p>
                <div class="lookup-section-body">${formatContent(s.content)}</div>
            </div>
        `)
        .join('');

    const footerHtml = card.footer
        ? `<p class="lookup-footer">${escapeHtml(card.footer)}</p>`
        : '';

    mount.innerHTML = `
        <article class="panel lookup-card">
            ${bannerHtml}
            <header class="lookup-head">
                <h2 class="lookup-title">${escapeHtml(card.title || '')}</h2>
                ${subtitleHtml}
            </header>
            <div class="lookup-sections">
                ${sectionsHtml}
            </div>
            ${footerHtml}
        </article>
    `;
}

/**
 * Render a "no result" card. Used as a fallback when the requested entry
 * doesn't exist; the caller still owns whatever hint text makes sense.
 */
export function renderLookupEmpty({ title, detail, hint }, mount) {
    mount.innerHTML = `
        <article class="panel lookup-card lookup-card--empty">
            <header class="lookup-head">
                <h2 class="lookup-title">${escapeHtml(title || 'Not found')}</h2>
            </header>
            <p class="lookup-empty-detail">${escapeHtml(detail || '')}</p>
            ${hint ? `<p class="lookup-empty-hint">${escapeHtml(hint)}</p>` : ''}
        </article>
    `;
}

/** Normalize a section's `content` value into safe HTML. */
function formatContent(content) {
    if (Array.isArray(content)) {
        if (content.length === 0) return '<p class="lookup-empty-line">—</p>';
        const items = content.map((c) => `<li>${escapeHtml(String(c))}</li>`).join('');
        return `<ul class="lookup-list">${items}</ul>`;
    }
    if (content && typeof content === 'object' && 'html' in content) {
        return String(content.html || '');
    }
    return `<p class="lookup-paragraph">${escapeHtml(String(content))}</p>`;
}
