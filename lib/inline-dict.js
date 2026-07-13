// lib/inline-dict.js
// Click-to-lookup dictionary for Chinese text in the passage view.
// When a user clicks on Chinese text, the module detects the character at the
// click position, attempts longest-prefix matching (4, 3, 2, 1 chars) against
// the CC-CEDICT shard for the first character, and shows a positioned popup
// with the lookup card. Clicking elsewhere dismisses the popup.

import { loadShard, findMatches, buildCard } from '../views/dictionary.js';
import { renderLookupCard } from './lookup-card.js';
import { escapeHtml } from './format.js';
import { getDictMode } from './reader-prefs.js';
import { loadZenIndex, loadZenEntry, renderZenCard } from './zen-dict.js';

const GRAMMAR_URL =
    'https://raw.githubusercontent.com/Fabulu/CbetaZenTranslations/main/grammar-particles.json';

/** Lazily loaded grammar-particle map: char -> functions[]. */
let grammarMap = null;

async function loadGrammar() {
    if (grammarMap) return grammarMap;
    try {
        const res = await fetch(GRAMMAR_URL);
        if (!res.ok) throw new Error(res.status);
        const arr = await res.json();
        grammarMap = new Map(arr.map(e => [e.char, e.functions]));
    } catch { grammarMap = new Map(); }
    return grammarMap;
}

/** The currently visible popup element, if any. */
let activePopup = null;

/** Generation counter to discard stale lookup results on rapid clicks/hovers. */
let clickGeneration = 0;

/**
 * Detect whether the primary pointing device is "coarse" (touch / pen). On
 * such devices we suppress the synthetic-click lookup, hide the hover path,
 * and require a long-press to open the dictionary as a slide-up drawer.
 *
 * Wrapped in a getter so tests can reset matchMedia between cases without
 * having to reload the module.
 */
function detectCoarsePointer() {
    try {
        return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    } catch { return false; }
}

/** Whether the device supports hover (mouse, not touch). */
const supportsHover = (() => {
    try { return !!(window.matchMedia && window.matchMedia('(hover: hover)').matches); }
    catch { return false; }
})();

/** Whether the device's primary pointer is coarse (touch / stylus). */
const isCoarsePointer = detectCoarsePointer();

/** Whether the next click should be suppressed (synthetic click after touch). */
let suppressNextClick = false;
/** Auto-reset timer for `suppressNextClick`. Some browsers (or routes the
 *  synthetic click into a parent that's no longer mounted) never deliver the
 *  follow-up click, leaving the flag armed and swallowing the next real
 *  click. The timeout puts a hard ceiling on how long the suppression can
 *  linger. */
let suppressClickResetTimer = null;
function armClickSuppression() {
    suppressNextClick = true;
    if (suppressClickResetTimer != null) clearTimeout(suppressClickResetTimer);
    suppressClickResetTimer = setTimeout(() => {
        suppressNextClick = false;
        suppressClickResetTimer = null;
    }, 400);
}
function clearClickSuppression() {
    suppressNextClick = false;
    if (suppressClickResetTimer != null) {
        clearTimeout(suppressClickResetTimer);
        suppressClickResetTimer = null;
    }
}

/** Long-press tracking state for touch/pen pointers. */
const longPress = {
    pointerId: null,
    startX: 0,
    startY: 0,
    timer: null,
    fired: false,
};

/** Long-press timing & movement-slop thresholds (drawer mode). */
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP_PX = 8;

/** Hover debounce timer. */
let hoverTimer = null;

/** Grace period timer for moving from text to popup. */
let leaveTimer = null;

/** Whether the current popup was opened by hover (auto-dismiss) or click (sticky). */
let popupFromHover = false;

/** Whether the active popup is rendered as a drawer (touch/coarse mode). */
let popupAsDrawer = false;

/** Active backdrop element when the popup is shown as a drawer. */
let activeBackdrop = null;

/** Regex to test whether a character is CJK. */
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;

/**
 * Attach click-to-lookup behaviour on a container of Chinese text.
 * Call this after Chinese source text has been rendered into the DOM.
 *
 * @param {HTMLElement} container  The element holding Chinese text (e.g. #source-body).
 */
export function attachInlineDict(container) {
    if (!container) return;
    // Guard against duplicate listeners when called multiple times on the
    // same element (e.g. pagination re-renders that keep the container but
    // replace innerHTML). Without this, stacked handlers cause the
    // clickGeneration counter to race and discard every lookup result.
    if (container._inlineDictAttached) return;
    container._inlineDictAttached = true;

    container.addEventListener('click', onContainerClick);

    // Hover activation is DISABLED by design: the dictionary is click-only,
    // in one mutually-exclusive mode (Zen or CC-CEDICT). Nothing pops on
    // hover. Click + long-press (touch/pen) remain the only triggers.

    // Touch / pen long-press handlers. Pointer Events unify mouse, touch, and
    // pen, so we filter on pointerType. Listening on a coarse-only flag would
    // miss hybrid laptops with both mouse and touch — safer to attach
    // unconditionally and branch inside.
    container.addEventListener('pointerdown', onContainerPointerDown);
    container.addEventListener('pointermove', onContainerPointerMove);
    container.addEventListener('pointerup', onContainerPointerUp);
    container.addEventListener('pointercancel', onContainerPointerCancel);
}

/**
 * Dismiss any active popup AND tear down all pending timers (long-press,
 * hover, leave, click-suppression). Call on route changes to prevent stale
 * popups, stale long-press lookups against torn-down DOM, or a leftover
 * suppressNextClick from swallowing the first click on the new view.
 */
export function dismissInlineDict() {
    cancelLongPress();
    if (hoverTimer != null) { clearTimeout(hoverTimer); hoverTimer = null; }
    if (leaveTimer != null) { clearTimeout(leaveTimer); leaveTimer = null; }
    clearClickSuppression();
    dismiss();
    dismissZenPanel();
}

/**
 * Determine the character offset at the click point using the browser's
 * caret-position API (standard) or caretRangeFromPoint (WebKit/Blink).
 * Returns { node, offset } or null.
 */
function caretInfoFromPoint(x, y) {
    // Standard API (Firefox 20+, Chrome 128+)
    if (typeof document.caretPositionFromPoint === 'function') {
        const pos = document.caretPositionFromPoint(x, y);
        if (pos && pos.offsetNode) {
            return { node: pos.offsetNode, offset: pos.offset };
        }
    }
    // WebKit / Blink fallback
    if (typeof document.caretRangeFromPoint === 'function') {
        const range = document.caretRangeFromPoint(x, y);
        if (range) {
            return { node: range.startContainer, offset: range.startOffset };
        }
    }
    return null;
}

/**
 * Extract a substring of up to `len` characters starting at `offset` in the
 * text node's data. Returns the substring (may be shorter than `len` if
 * near the end of the node).
 */
function grabChars(textNode, offset, len) {
    const data = textNode.data || '';
    // Use Array.from for surrogate-pair safety
    const chars = Array.from(data);
    // offset is a UTF-16 offset; convert to code-point index.
    // Walk the chars to find which code-point index corresponds to the
    // UTF-16 offset.
    let utf16 = 0;
    let cpIndex = 0;
    for (; cpIndex < chars.length; cpIndex++) {
        if (utf16 >= offset) break;
        utf16 += chars[cpIndex].length; // 1 for BMP, 2 for surrogate pair
    }
    return chars.slice(cpIndex, cpIndex + len).join('');
}

/** Handle a click inside the Chinese text container. */
async function onContainerClick(evt) {
    // Don't interfere with link clicks.
    if (evt.target.closest('a')) return;
    // Suppress the synthetic click that follows a touch tap or long-press —
    // tap should not open the popup, and long-press has already opened it.
    if (suppressNextClick) {
        clearClickSuppression();
        return;
    }
    clearTimeout(hoverTimer);
    clearTimeout(leaveTimer);

    // In Zen mode, a click on a highlighted `.zen-term` resolves directly by
    // its data-term — this works even when the click lands mid-term or when
    // the term is split across a line-cut (each fragment carries data-term).
    if (getDictMode() === 'zen') {
        const mark = evt.target.closest('.zen-term');
        if (mark) {
            const term = mark.getAttribute('data-term');
            await showZenTerm(term, evt.clientX, evt.clientY);
            return;
        }
    }

    await doLookup(evt.clientX, evt.clientY);
}

/**
 * pointerdown: start the long-press timer for touch/pen, snapshot the press
 * coordinates so a small finger drift doesn't cancel the gesture.
 */
function onContainerPointerDown(evt) {
    // Mouse pointers keep the existing hover/click behaviour; nothing to do.
    if (evt.pointerType !== 'touch' && evt.pointerType !== 'pen') return;
    // Don't interfere with link presses.
    if (evt.target.closest && evt.target.closest('a')) return;

    cancelLongPress();
    longPress.pointerId = evt.pointerId;
    longPress.startX = evt.clientX;
    longPress.startY = evt.clientY;
    longPress.fired = false;
    const x = evt.clientX, y = evt.clientY;
    longPress.timer = setTimeout(() => {
        longPress.fired = true;
        // Suppress the synthetic click that the browser fires when the finger
        // is finally lifted; we've already shown the drawer. The arming helper
        // also bounds the suppression with a timeout so a missed follow-up
        // click can't swallow a later legitimate click.
        armClickSuppression();
        doLookup(x, y).catch(() => { /* swallow async errors */ });
    }, LONG_PRESS_MS);
}

/** pointermove: cancel the long-press if the finger moves more than the slop. */
function onContainerPointerMove(evt) {
    if (longPress.timer == null || evt.pointerId !== longPress.pointerId) return;
    const dx = evt.clientX - longPress.startX;
    const dy = evt.clientY - longPress.startY;
    if (dx * dx + dy * dy > LONG_PRESS_SLOP_PX * LONG_PRESS_SLOP_PX) {
        cancelLongPress();
    }
}

/** pointerup: a tap (released before timer) is a no-op. Suppress the click. */
function onContainerPointerUp(evt) {
    if (evt.pointerType !== 'touch' && evt.pointerType !== 'pen') return;
    if (longPress.timer != null && evt.pointerId === longPress.pointerId) {
        // Released early — this is a tap, not a long-press. Cancel & suppress
        // the click so the user doesn't get an accidental popup.
        cancelLongPress();
        armClickSuppression();
    }
}

/** pointercancel: scroll / gesture interruption. Drop the pending long-press. */
function onContainerPointerCancel(evt) {
    if (evt.pointerId === longPress.pointerId) cancelLongPress();
}

/** Drop any pending long-press timer / state. */
function cancelLongPress() {
    if (longPress.timer != null) {
        clearTimeout(longPress.timer);
        longPress.timer = null;
    }
    longPress.pointerId = null;
}

/**
 * Click lookup, routed by the mutually-exclusive dictionary mode.
 *   'zen'    → longest-match the clicked position against the Zen termbase.
 *   'cedict' → CC-CEDICT per-character longest-prefix lookup.
 * In either mode: if nothing matches at the click, show NOTHING (dismiss).
 */
async function doLookup(x, y) {
    const info = caretInfoFromPoint(x, y);
    if (!info || info.node.nodeType !== Node.TEXT_NODE) {
        dismiss();
        return;
    }

    const firstChar = grabChars(info.node, info.offset, 1);
    if (!firstChar || !CJK_RE.test(firstChar)) {
        dismiss();
        return;
    }

    if (getDictMode() === 'zen') {
        await doZenLookup(info, firstChar, x, y);
    } else {
        await doCedictLookup(info, firstChar, x, y);
    }
}

// ── Zen entry side panel ──────────────────────────────────────────────────
// A Zen entry is a full article (senses, explanation, occurrences, related
// terms), not a gloss — it gets a docked panel that stays open while you keep
// reading and clicking. CC-CEDICT fallbacks keep the small anchored popup.

/** The docked panel element, if open. */
let zenPanel = null;

/** Render a Zen entry into the docked side panel, creating it on first use. */
function showZenPanel(entry, term) {
    dismiss(); // a Zen entry supersedes any open CC-CEDICT popup

    if (!zenPanel) {
        zenPanel = document.createElement('aside');
        zenPanel.className = 'zen-panel';
        zenPanel.setAttribute('role', 'complementary');
        zenPanel.setAttribute('aria-label', 'Zen dictionary entry');

        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'zen-panel__close';
        close.setAttribute('aria-label', 'Close dictionary panel');
        close.textContent = '×';
        close.addEventListener('click', dismissZenPanel);

        const body = document.createElement('div');
        body.className = 'zen-panel__body';

        zenPanel.append(close, body);
        document.body.appendChild(zenPanel);
    }

    const body = zenPanel.querySelector('.zen-panel__body');
    body.replaceChildren();
    renderZenCard(entry, body);
    zenPanel.dataset.term = term || '';
    zenPanel.scrollTop = 0;
    document.body.classList.add('has-zen-panel');
}

/** Close the docked Zen panel, if open. */
export function dismissZenPanel() {
    if (!zenPanel) return;
    zenPanel.remove();
    zenPanel = null;
    document.body.classList.remove('has-zen-panel');
}

/** CC-CEDICT lookup: longest-prefix (4→1) match against the first char's shard. */
async function doCedictLookup(info, firstChar, x, y) {
    const thisGeneration = ++clickGeneration;

    let shard;
    try {
        shard = await loadShard(firstChar);
    } catch {
        return;
    }

    if (thisGeneration !== clickGeneration) return;

    let matchedTerm = null;
    let matchedEntries = null;
    for (let len = 4; len >= 1; len--) {
        const candidate = grabChars(info.node, info.offset, len);
        if (!candidate) continue;
        const entries = findMatches(shard, candidate);
        if (entries.length > 0) {
            matchedTerm = candidate;
            matchedEntries = entries;
            break;
        }
    }

    if (!matchedTerm) {
        dismiss();
        return;
    }

    showPopup(buildCard(matchedTerm, matchedEntries), matchedTerm, x, y);
}

/**
 * Zen lookup: longest-match the clicked position against the loaded termbase.
 * Best-effort forward match within the clicked text node — a term split across
 * a line-cut is resolved by the `.zen-term` data-term click path instead.
 * No Zen entry at the position ⇒ fall back to CC-CEDICT, so clicking an
 * un-highlighted word still yields the plain gloss. The highlight therefore
 * means exactly one thing: "we have a Zen entry for this."
 */
async function doZenLookup(info, firstChar, x, y) {
    const thisGeneration = ++clickGeneration;

    let index;
    try {
        index = await loadZenIndex();
    } catch {
        await doCedictLookup(info, firstChar, x, y);
        return;
    }

    if (thisGeneration !== clickGeneration) return;

    let matched = null;
    if (index && index.terms && index.terms.size) {
        const maxLen = index.maxLen || 1;
        for (let len = maxLen; len >= 1; len--) {
            const candidate = grabChars(info.node, info.offset, len);
            if (!candidate) continue;
            if (index.terms.has(candidate)) { matched = candidate; break; }
        }
    }

    if (!matched) {
        await doCedictLookup(info, firstChar, x, y);
        return;
    }

    const entry = await loadZenEntry(matched);
    if (thisGeneration !== clickGeneration) return;
    if (!entry) {
        await doCedictLookup(info, firstChar, x, y);
        return;
    }
    showZenPanel(entry, matched);
}

/**
 * Resolve + show a Zen entry by its exact term string. Used by clicks on a
 * highlighted `.zen-term` mark (data-term), which works even mid-term or when
 * the mark is split across a line-cut.
 */
async function showZenTerm(term, x, y) {
    if (!term) { dismiss(); return; }
    const thisGeneration = ++clickGeneration;
    let entry;
    try {
        entry = await loadZenEntry(term);
    } catch {
        dismiss();
        return;
    }
    if (thisGeneration !== clickGeneration) return;
    if (!entry) { dismiss(); return; }
    showZenPanel(entry, term);
}

/**
 * Create and position the popup element showing a pre-built lookup card.
 * @param {object} cardData  payload for renderLookupCard (from buildCard or buildZenCard)
 * @param {string} term      the matched term (drives the single-char grammar hint)
 */
async function showPopup(cardData, term, clickX, clickY) {
    dismiss(); // remove any existing popup first

    // Drawer mode: render as a slide-up sheet on coarse-pointer devices.
    // We re-detect on each show so a tablet that's just been rotated /
    // re-docked picks up the change.
    const asDrawer = detectCoarsePointer();

    const popup = document.createElement('div');
    popup.className = 'dict-popup' + (asDrawer ? ' dict-popup--drawer' : '');

    if (asDrawer) {
        // Drag handle (visual affordance -- actual drag-to-close is a future
        // enhancement; tap on backdrop / close-button already work).
        const handle = document.createElement('div');
        handle.className = 'dict-drawer-handle';
        handle.setAttribute('aria-hidden', 'true');
        popup.appendChild(handle);

        // Close button -- explicit dismissal for accessibility.
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'dict-drawer-close';
        closeBtn.setAttribute('aria-label', 'Close dictionary');
        closeBtn.textContent = '\u00d7';
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            dismiss();
        });
        popup.appendChild(closeBtn);
    }

    // Render the lookup card into a sub-container.
    const cardMount = document.createElement('div');
    renderLookupCard(cardData, cardMount);
    popup.appendChild(cardMount);

    // Upsell line
    const upsell = document.createElement('p');
    upsell.className = 'dict-upsell';
    upsell.innerHTML =
        '\u{1F4A1} Full dictionary + translation tools in ' +
        '<a href="https://github.com/Fabulu/ReadZen/releases">Read Zen</a> \u00b7 ' +
        '<a href="https://ko-fi.com/readzen">Support on Ko-fi</a>';
    popup.appendChild(upsell);

    // Backdrop (drawer mode only) -- tap-to-dismiss area behind the sheet.
    let backdrop = null;
    if (asDrawer) {
        backdrop = document.createElement('div');
        backdrop.className = 'dict-drawer-backdrop';
        backdrop.addEventListener('click', () => dismiss());
        document.body.appendChild(backdrop);
    }

    // Attach to DOM BEFORE any await so dismiss() in a concurrent call can remove it.
    document.body.appendChild(popup);
    activePopup = popup;
    popupFromHover = false; // hover activation is disabled; popups are always sticky
    popupAsDrawer = asDrawer;
    activeBackdrop = backdrop;

    // Grammar particle hint (single-char terms only, lazy-loaded).
    // Loads async but popup is already visible — grammar appends into the live popup.
    if ([...term].length === 1) {
        const gm = await loadGrammar();
        // Bail if a newer popup replaced us during the await.
        if (activePopup !== popup) return;
        const fns = gm.get(term);
        if (fns && fns.length) {
            const box = document.createElement('div');
            box.className = 'dict-grammar';
            // Escape every field \u2014 `grammar-particles.json` is fetched from
            // GitHub and trusted today, but a compromised raw URL would
            // otherwise inject HTML/JS into every reader's page.
            box.innerHTML = '<p class="dict-grammar-label">Grammar roles</p>' +
                fns.map(f =>
                    `<p class="dict-grammar-fn"><b>${escapeHtml(f.role || '')}</b> \u2014 ${escapeHtml(f.gloss || '')}<br>` +
                    `<span class="dict-grammar-ex">${escapeHtml(f.example || '')} (${escapeHtml(f.exampleGloss || '')})</span></p>`
                ).join('');
            // Insert grammar before the upsell line.
            popup.insertBefore(box, upsell);
        }
    }

    // Hover popups: auto-dismiss when mouse leaves both text and popup.
    // Click popups: stay until explicit outside click.
    if (supportsHover) {
        popup.addEventListener('mouseenter', () => clearTimeout(leaveTimer));
        popup.addEventListener('mouseleave', () => {
            if (popupFromHover) {
                leaveTimer = setTimeout(dismiss, 100);
            }
        });
    }

    // Position: place near the click, clamped to viewport. Drawer mode lays
    // out via CSS (fixed bottom sheet) so we skip the click-relative math.
    if (!asDrawer) {
        positionPopup(popup, clickX, clickY);
    }

    // Dismiss on outside click (next tick so this click doesn't trigger it).
    // Drawer mode handles dismissal via the explicit backdrop / close button,
    // so the global outside-click listener would just race them.
    if (!asDrawer) {
        requestAnimationFrame(() => {
            document.addEventListener('click', onOutsideClick, { once: true, capture: true });
        });
    }
}

/**
 * Position the popup near (clickX, clickY), keeping it within the viewport.
 */
function positionPopup(popup, clickX, clickY) {
    // Render off-screen first to measure.
    popup.style.left = '0px';
    popup.style.top = '0px';
    popup.style.visibility = 'hidden';

    const rect = popup.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 8;

    // Prefer placing below and to the right of the click.
    let left = clickX + 4;
    let top = clickY + 16;

    // Clamp right edge.
    if (left + rect.width > vw - margin) {
        left = vw - rect.width - margin;
    }
    // Clamp left edge.
    if (left < margin) left = margin;

    // If below overflows, place above the click.
    if (top + rect.height > vh - margin) {
        top = clickY - rect.height - 8;
    }
    // Clamp top edge.
    if (top < margin) top = margin;

    popup.style.left = left + 'px';
    popup.style.top = top + 'px';
    popup.style.visibility = '';
}

/** Dismiss the active popup (and drawer backdrop, if any). */
function dismiss() {
    if (activePopup) {
        activePopup.remove();
        activePopup = null;
    }
    if (activeBackdrop) {
        activeBackdrop.remove();
        activeBackdrop = null;
    }
    popupAsDrawer = false;
}

/** Click-outside handler. */
function onOutsideClick(evt) {
    if (activePopup && !activePopup.contains(evt.target)) {
        dismiss();
    } else if (activePopup) {
        // Clicked inside popup — re-attach the listener.
        requestAnimationFrame(() => {
            document.addEventListener('click', onOutsideClick, { once: true, capture: true });
        });
    }
}
