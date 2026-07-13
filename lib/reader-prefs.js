// lib/reader-prefs.js
// Reader preferences (local only). Currently: lines-per-page for the passage
// reader. Values are whitelisted — anything unknown falls back to the default,
// so stale/corrupt storage can never wedge the reader.

const PAGE_SIZE_KEY = 'zl:page-size';

/** Allowed page sizes. 'all' renders the whole text in one page. */
export const PAGE_SIZE_OPTIONS = [300, 1000, 3000, 10000, 'all'];
export const DEFAULT_PAGE_SIZE = 300;

/** @returns {number|'all'} */
export function getPageSize() {
    try {
        const raw = localStorage.getItem(PAGE_SIZE_KEY);
        if (raw === 'all') return 'all';
        const n = parseInt(raw, 10);
        return PAGE_SIZE_OPTIONS.includes(n) ? n : DEFAULT_PAGE_SIZE;
    } catch {
        return DEFAULT_PAGE_SIZE;
    }
}

/** Persists a whitelisted size; unknown values are ignored. */
export function setPageSize(v) {
    const val = v === 'all' ? 'all' : parseInt(v, 10);
    if (!PAGE_SIZE_OPTIONS.includes(val)) return;
    try { localStorage.setItem(PAGE_SIZE_KEY, String(val)); } catch {}
}

// -- Bilingual alignment mode --------------------------------------------
// 'flow'        two independently scrolling panes, viewport-synced by line id
//               (DEFAULT - each language reads at its natural density)
// 'blocks'      page-flow panes aligned at segment-map block boundaries
//               (falls back to per-line alignment for unmapped texts)
// 'lines'       strict per-line row locking (the original layout)
// 'interleaved' single column: each Chinese line followed by its English

const BILINGUAL_KEY = 'zl:bilingual-mode';
// merged-flow    : merged paragraphs per segment, independent synced panes
// merged-stacked : merged paragraphs, single column, ZH then EN per segment
export const BILINGUAL_MODES = ['flow', 'blocks', 'lines', 'interleaved', 'merged-flow', 'merged-stacked'];
export const DEFAULT_BILINGUAL_MODE = 'merged-flow'; // user ruling 2026-07-09; falls back to 'flow' for unmapped texts

export function getBilingualMode() {
    try {
        const raw = localStorage.getItem(BILINGUAL_KEY);
        return BILINGUAL_MODES.includes(raw) ? raw : DEFAULT_BILINGUAL_MODE;
    } catch {
        return DEFAULT_BILINGUAL_MODE;
    }
}

export function setBilingualMode(v) {
    if (!BILINGUAL_MODES.includes(v)) return;
    try { localStorage.setItem(BILINGUAL_KEY, v); } catch {}
}

// ── Source-only (untranslated) reading mode ──────────────────────────────
// merged : merged paragraphs per segment (heals the ~17-char woodblock line
//          cuts; segment types show as a paragraph-level border, not a per-line
//          indent — so lines stay aligned). Needs a segment map; falls back to
//          'page' without one.
// page   : one row per <lb/>, with per-line segment-type styling (the indents
//          that make quoted speech / verse visually distinct).
const SOURCE_MODE_KEY = 'zl:source-mode';
export const SOURCE_MODES = ['merged', 'page'];
export const DEFAULT_SOURCE_MODE = 'merged'; // clean flowing read by default (falls back to 'page' when unmapped)

export function getSourceMode() {
    try {
        const raw = localStorage.getItem(SOURCE_MODE_KEY);
        return SOURCE_MODES.includes(raw) ? raw : DEFAULT_SOURCE_MODE;
    } catch {
        return DEFAULT_SOURCE_MODE;
    }
}

export function setSourceMode(v) {
    if (!SOURCE_MODES.includes(v)) return;
    try { localStorage.setItem(SOURCE_MODE_KEY, v); } catch {}
}

// ── Dictionary mode (mutually exclusive, click-only) ─────────────────────
// 'zen'    : click a Chinese character to look it up in the Zen termbase
//            dictionary (longest-match against curated terms). DEFAULT.
// 'cedict' : click a Chinese character for the CC-CEDICT per-char lookup.
// The two dictionaries are never active at once, and neither pops on hover.
const DICT_MODE_KEY = 'zl:dict-mode';
export const DICT_MODES = ['zen', 'cedict'];
export const DEFAULT_DICT_MODE = 'zen';

export function getDictMode() {
    try {
        const raw = localStorage.getItem(DICT_MODE_KEY);
        return DICT_MODES.includes(raw) ? raw : DEFAULT_DICT_MODE;
    } catch {
        return DEFAULT_DICT_MODE;
    }
}

export function setDictMode(v) {
    if (!DICT_MODES.includes(v)) return;
    try { localStorage.setItem(DICT_MODE_KEY, v); } catch {}
}

// ── Zen-word highlighting in the reader ──────────────────────────────────
// When on, curated Zen-dictionary terms are visually marked in the Chinese
// source text (cross-woodblock-line-cut aware). Purely visual; independent
// of the click dictionary mode. DEFAULT on.
const ZEN_HIGHLIGHT_KEY = 'zl:zen-highlight';
export const DEFAULT_ZEN_HIGHLIGHT = true;

export function getZenHighlight() {
    try {
        const raw = localStorage.getItem(ZEN_HIGHLIGHT_KEY);
        if (raw === 'on') return true;
        if (raw === 'off') return false;
        return DEFAULT_ZEN_HIGHLIGHT;
    } catch {
        return DEFAULT_ZEN_HIGHLIGHT;
    }
}

export function setZenHighlight(on) {
    try { localStorage.setItem(ZEN_HIGHLIGHT_KEY, on ? 'on' : 'off'); } catch {}
}

// ── Site chrome (header/nav layout) ──────────────────────────────────────
// The header had outgrown its single row: a 2.8rem serif title plus a kicker,
// a search box, four nav links, route chips and a Support button, all competing for the
// same line -- so the nav overflowed and had to be scrolled sideways. Rather
// than guess at one replacement, the layouts below are selectable at runtime.
//
//   compact  : one tight row, small wordmark, search collapses to an icon
//   masthead : two rows -- brand line, then a nav rule beneath it
//   rail     : nav becomes a vertical rail down the left; the top row empties
//   journal  : printed-journal masthead -- centred serif wordmark between rules
//   current  : the existing header, kept so the others can be compared to it
const CHROME_KEY = 'zl:chrome';
export const CHROMES = ['compact', 'masthead', 'rail', 'journal', 'current'];
export const DEFAULT_CHROME = 'compact';

export function getChrome() {
    try {
        const raw = localStorage.getItem(CHROME_KEY);
        return CHROMES.includes(raw) ? raw : DEFAULT_CHROME;
    } catch {
        return DEFAULT_CHROME;
    }
}

export function setChrome(v) {
    if (!CHROMES.includes(v)) return;
    try { localStorage.setItem(CHROME_KEY, v); } catch {}
}

// ── Palette ──────────────────────────────────────────────────────────────
// A palette is a set of colour tokens PLUS the light/dark family it belongs to.
// The family still rides on data-theme, because ~30 component rules are keyed on
// [data-theme="light"] -- a light palette that did not set it would render
// broken. The palette itself rides on a separate data-palette attribute and only
// re-tints the tokens.
const PALETTE_KEY = 'zl:palette';
export const PALETTES = [
    'ink', 'sumi', 'slate', 'jade', 'persimmon', 'indigo',
    'paper', 'woodblock', 'matcha', 'plum',
];
export const PALETTE_FAMILY = {
    ink: 'dark', sumi: 'dark', slate: 'dark',
    jade: 'dark', persimmon: 'dark', indigo: 'dark',
    paper: 'light', woodblock: 'light', matcha: 'light', plum: 'light',
};
export const DEFAULT_PALETTE = 'ink';

export function getPalette() {
    try {
        const raw = localStorage.getItem(PALETTE_KEY);
        return PALETTES.includes(raw) ? raw : DEFAULT_PALETTE;
    } catch {
        return DEFAULT_PALETTE;
    }
}

export function setPalette(v) {
    if (!PALETTES.includes(v)) return;
    try { localStorage.setItem(PALETTE_KEY, v); } catch {}
}
