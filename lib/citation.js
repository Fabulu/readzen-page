// lib/citation.js
// Multi-style academic citation formatter for ReadZen passages.

/** All supported citation style keys, in display order. */
export const CITE_STYLES = ['Chicago', 'APA', 'MLA', 'BibTeX', 'CBETA'];

/** localStorage key used to persist the user's preferred style. */
const STORAGE_KEY = 'readzen-cite-style';

/**
 * Return the user's preferred citation style from localStorage,
 * falling back to 'Chicago' if nothing is stored or the stored value
 * is no longer a known style.
 *
 * @returns {string} One of the values in CITE_STYLES.
 */
export function getPreferredStyle() {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored && CITE_STYLES.includes(stored)) return stored;
    } catch (_) {
        // localStorage unavailable (SSR / private-browsing edge case).
    }
    return 'Chicago';
}

/**
 * Persist the user's preferred citation style to localStorage.
 *
 * @param {string} style - One of the values in CITE_STYLES.
 */
export function setPreferredStyle(style) {
    try {
        localStorage.setItem(STORAGE_KEY, style);
    } catch (_) {
        // Swallow — non-fatal.
    }
}

/**
 * Build a citation string for the given style.
 *
 * @param {string} style   - One of the values in CITE_STYLES.
 * @param {string} title   - Human-readable passage title.
 * @param {string} workId  - CBETA canonical ID, e.g. "T48n2005".
 * @param {string} url     - Shareable URL for this passage.
 * @returns {string} Formatted citation string.
 */
export function buildCitation(style, title, workId, url) {
    switch (style) {
        case 'Chicago':
            return '\u201c' + title + '.\u201d CBETA ' + workId + '. ReadZen. ' + url + '.';

        case 'APA':
            return title + ' (' + workId + '). ReadZen. Retrieved from ' + url;

        case 'MLA': {
            const date = new Date().toLocaleDateString('en-US', {
                year: 'numeric', month: 'long', day: 'numeric'
            });
            return '\u201c' + title + '.\u201d ReadZen, ' + url + '. Accessed ' + date + '.';
        }

        case 'BibTeX':
            return (
                '@misc{readzen:' + workId + ',\n' +
                '  title        = {' + title + '},\n' +
                '  howpublished = {' + url + '},\n' +
                '  note         = {CBETA ' + workId + '}\n' +
                '}'
            );

        case 'CBETA':
            return workId;

        default:
            return '';
    }
}
