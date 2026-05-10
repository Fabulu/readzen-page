// lib/keyboard.js
// Vim-style global keyboard shortcuts for the SPA.
//
// Bindings (all suppressed when an <input>/<textarea>/[contenteditable] is focused):
//   j         scroll down ~80% of viewport
//   k         scroll up ~80% of viewport
//   g g       (chord, 500 ms timeout) scroll to top
//   G         scroll to bottom
//   /         focus the search input on landing/search; open the inline find
//             bar on the passage view
//   ?         show keyboard help overlay
//   n / N     next / previous match when a find bar (or registered navigator) is active
//   Esc       close help overlay / close find bar / dismiss popups / blur input
//
// View-aware bindings (n, N, /, find) work via a small registry. Views that
// support find-style navigation register a navigator on mount and unregister
// when their mount node is removed from the document.
//
// Public API:
//   installKeyboardNav(routerCtx?)  – idempotent; wires global handlers
//   registerFindNavigator(nav)      – returns a disposer
//   dismissAllPopups()              – called from app.js on hashchange
//   initKeyboard()                  – legacy alias for installKeyboardNav()

import { dismissInlineDict } from './inline-dict.js';

let helpOverlay = null;
let findNavigator = null;
let lastGAt = 0; // timestamp of the most recent solo "g" press for the gg chord
let installed = false;

const CHORD_TIMEOUT_MS = 500;
const SCROLL_FRACTION = 0.8;

const SHORTCUTS = [
    { key: 'j', description: 'Scroll down' },
    { key: 'k', description: 'Scroll up' },
    { key: 'g g', description: 'Scroll to top' },
    { key: 'G', description: 'Scroll to bottom' },
    { key: '/', description: 'Focus search / open find' },
    { key: 'n', description: 'Next match' },
    { key: 'N', description: 'Previous match' },
    { key: '?', description: 'Show this help' },
    { key: 'Esc', description: 'Dismiss popups / close find / blur input' }
];

/** True when the active element is a text-entry control. */
function isTyping(ev) {
    const t = ev.target;
    if (!t) return false;
    const tag = (t.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if (t.isContentEditable) return true;
    return false;
}

/** Honour the user's reduced-motion preference. */
function smoothBehavior() {
    try {
        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            return 'auto';
        }
    } catch { /* matchMedia not available — fall through */ }
    return 'smooth';
}

function viewportHeight() {
    return window.innerHeight || document.documentElement.clientHeight || 600;
}

function scrollByViewport(direction) {
    const delta = Math.max(80, Math.floor(viewportHeight() * SCROLL_FRACTION)) * direction;
    window.scrollBy({ top: delta, left: 0, behavior: smoothBehavior() });
}

function scrollToTop() {
    window.scrollTo({ top: 0, left: 0, behavior: smoothBehavior() });
}

function scrollToBottom() {
    const doc = document.documentElement;
    const body = document.body;
    const max = Math.max(
        (doc && doc.scrollHeight) || 0,
        (body && body.scrollHeight) || 0,
        (doc && doc.offsetHeight) || 0,
        (body && body.offsetHeight) || 0
    );
    window.scrollTo({ top: max, left: 0, behavior: smoothBehavior() });
}

function focusFirstSearchInput() {
    // Order of preference: explicit landing search → search-page search →
    // header search → fall back to navigating to /search.
    const candidates = [
        '#landing-search-input',
        '#search-input',
        '.search-input',
        '#header-search-input',
        '.landing-search-input',
        '.header-search-input'
    ];
    for (const sel of candidates) {
        const el = document.querySelector(sel);
        if (el && typeof el.focus === 'function') {
            try { el.focus(); if (typeof el.select === 'function') el.select(); } catch {}
            return true;
        }
    }
    return false;
}

function dismissHelp() {
    if (helpOverlay) {
        try { helpOverlay.remove(); } catch {}
        helpOverlay = null;
    }
}

function showHelp() {
    if (helpOverlay) { dismissHelp(); return; }
    helpOverlay = document.createElement('div');
    helpOverlay.className = 'shortcuts-overlay';
    const rows = SHORTCUTS.map(
        s => `<tr><td class="shortcuts-key"><kbd>${s.key === ' ' ? 'Space' : s.key}</kbd></td><td>${s.description}</td></tr>`
    ).join('');
    helpOverlay.innerHTML =
        '<div class="shortcuts-backdrop"></div>' +
        '<div class="shortcuts-card">' +
        '<h3>Keyboard shortcuts</h3>' +
        '<table>' + rows + '</table>' +
        '<p class="shortcuts-dismiss">Press <kbd>?</kbd> or <kbd>Esc</kbd> to close</p>' +
        '</div>';
    helpOverlay.querySelector('.shortcuts-backdrop').addEventListener('click', dismissHelp);
    document.body.appendChild(helpOverlay);
}

/**
 * Register a find-style navigator. Views with an inline find bar (or any
 * "next/prev match" affordance) call this on mount and dispose it on unmount.
 *
 * @param {Object} nav
 * @param {() => boolean} [nav.isOpen]    True iff the find UI is currently visible.
 * @param {() => void} [nav.open]         Open / focus the find UI.
 * @param {() => void} [nav.close]        Close the find UI.
 * @param {() => void} [nav.findNext]     Advance to the next match (wraps).
 * @param {() => void} [nav.findPrev]     Advance to the previous match (wraps).
 * @returns {() => void} disposer
 */
export function registerFindNavigator(nav) {
    findNavigator = nav || null;
    return () => {
        if (findNavigator === nav) findNavigator = null;
    };
}

/** Tear down popups owned by this module + delegated dictionary popups. */
export function dismissAllPopups() {
    dismissInlineDict();
    dismissHelp();
    const cite = document.querySelector('.cite-popup');
    if (cite) cite.remove();
    // Drop any find navigator from the previous view; the next view's
    // mountFindBar (if any) will register a fresh one on render.
    findNavigator = null;
}

function handleEscape(ev) {
    // 1. Help overlay first.
    if (helpOverlay) { dismissHelp(); return true; }
    // 2. Active find bar.
    if (findNavigator && typeof findNavigator.isOpen === 'function' && findNavigator.isOpen()) {
        if (typeof findNavigator.close === 'function') {
            try { findNavigator.close(); } catch {}
            return true;
        }
    }
    // 3. Blur a focused text input (also dismisses inline popups).
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) {
        try { active.blur(); } catch {}
        dismissAllPopups();
        return true;
    }
    // 4. Fall back to dismissing inline popups (citation, dict, etc.).
    dismissAllPopups();
    return true;
}

function onKeydown(ev) {
    // Escape always runs, even inside inputs (it lets the user blur out).
    if (ev.key === 'Escape') {
        // Don't preventDefault — allow native form/escape behaviour first.
        handleEscape(ev);
        return;
    }

    if (isTyping(ev)) return;

    // Ignore keys while a modifier is held — those are reserved for browser /
    // app shortcuts (e.g. Ctrl+F handled inside the find bar itself).
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;

    const key = ev.key;

    // ── Help ────────────────────────────────────────────────────────────
    if (key === '?') {
        ev.preventDefault();
        showHelp();
        lastGAt = 0;
        return;
    }

    // ── Search / find ───────────────────────────────────────────────────
    if (key === '/') {
        ev.preventDefault();
        lastGAt = 0;
        // On views with an inline find bar (passage), prefer opening that.
        if (findNavigator && typeof findNavigator.open === 'function') {
            try { findNavigator.open(); return; } catch {}
        }
        if (focusFirstSearchInput()) return;
        // Last resort: bounce to the search route.
        window.location.hash = '#/search';
        return;
    }

    // ── Match navigation ────────────────────────────────────────────────
    if (key === 'n' || key === 'N') {
        if (findNavigator) {
            const fn = key === 'n' ? findNavigator.findNext : findNavigator.findPrev;
            if (typeof fn === 'function') {
                ev.preventDefault();
                try { fn(); } catch {}
                lastGAt = 0;
                return;
            }
        }
        // No active navigator → don't preventDefault; let the key fall through.
    }

    // ── gg chord / G ────────────────────────────────────────────────────
    if (key === 'g') {
        ev.preventDefault();
        const now = Date.now();
        if (now - lastGAt <= CHORD_TIMEOUT_MS) {
            lastGAt = 0;
            scrollToTop();
        } else {
            lastGAt = now;
        }
        return;
    }
    if (key === 'G') {
        ev.preventDefault();
        lastGAt = 0;
        scrollToBottom();
        return;
    }

    // ── Scroll: j / k ───────────────────────────────────────────────────
    if (key === 'j') {
        ev.preventDefault();
        lastGAt = 0;
        scrollByViewport(1);
        return;
    }
    if (key === 'k') {
        ev.preventDefault();
        lastGAt = 0;
        scrollByViewport(-1);
        return;
    }

    // Any other key resets the chord buffer.
    lastGAt = 0;
}

/**
 * Wire the global keyboard handler. Idempotent — calling twice does nothing.
 * @param {Object} [_routerCtx] reserved for future per-route hooks
 */
export function installKeyboardNav(_routerCtx) {
    if (installed) return;
    installed = true;
    document.addEventListener('keydown', onKeydown);
}

/** Legacy alias kept for backwards compatibility with app.js bootstrap. */
export function initKeyboard() {
    installKeyboardNav();
}
