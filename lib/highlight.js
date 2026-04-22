// lib/highlight.js
// Client-side search term highlighting and scroll-to-line for passage text.

/**
 * Wrap all occurrences of `term` in <mark class="search-highlight"> tags
 * within .line-text spans only (not .line-id). Operates on the HTML string
 * from renderLinesHtml() BEFORE insertion into the DOM.
 */
export function highlightTextInHtml(html, term) {
    if (!term || !html) return html;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped, 'gi');
    return html.replace(
        /(<span class="line-text">)([\s\S]*?)(<\/span>)/g,
        (match, open, content, close) => {
            return open + content.replace(re, '<mark class="search-highlight">$&</mark>') + close;
        }
    );
}

/**
 * Scroll to the first .search-highlight element within container,
 * or to a specific line by data-line-id.
 */
export function scrollToFirstHighlight(container) {
    if (!container) return;
    // Delay to ensure DOM is laid out (syncRowHeights runs on rAF)
    setTimeout(() => {
        const first = container.querySelector('.search-highlight');
        if (first) {
            first.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }, 500);
}

/**
 * Scroll to a specific line by its data-line-id attribute.
 */
export function scrollToLineId(container, lineId) {
    if (!container || !lineId) return;
    setTimeout(() => {
        const el = container.querySelector(`[data-line-id="${CSS.escape(lineId)}"]`);
        if (el) {
            el.classList.add('scroll-target');
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }, 500);
}

/**
 * Find which 1-based page contains the first occurrence of `term`
 * in the given array of line objects.
 */
export function findPageForTerm(allLines, term, pageSize) {
    if (!term) return 1;
    const lower = term.toLowerCase();
    for (let i = 0; i < allLines.length; i++) {
        if (allLines[i] && allLines[i].text && allLines[i].text.toLowerCase().includes(lower)) {
            return Math.floor(i / pageSize) + 1;
        }
    }
    return 1;
}

/**
 * Find which 1-based page contains a specific line ID.
 */
export function findPageForLineId(allLines, lineId, pageSize) {
    if (!lineId) return 1;
    for (let i = 0; i < allLines.length; i++) {
        if (allLines[i] && allLines[i].id === lineId) {
            return Math.floor(i / pageSize) + 1;
        }
    }
    return 1;
}

/**
 * Extract the raw search term from a Pagefind excerpt HTML string.
 * Pagefind wraps matched terms in <mark>term</mark>.
 */
export function extractTermFromExcerpt(excerptHtml) {
    if (!excerptHtml) return '';
    const match = excerptHtml.match(/<mark>([\s\S]*?)<\/mark>/);
    return match ? match[1] : '';
}
