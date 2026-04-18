// lib/inline-dict.js
// Click-to-lookup dictionary for Chinese text in the passage view.
// When a user clicks on Chinese text, the module detects the character at the
// click position, attempts longest-prefix matching (4, 3, 2, 1 chars) against
// the CC-CEDICT shard for the first character, and shows a positioned popup
// with the lookup card. Clicking elsewhere dismisses the popup.

import { loadShard, findMatches, buildCard } from '../views/dictionary.js';
import { renderLookupCard } from './lookup-card.js';

/** The currently visible popup element, if any. */
let activePopup = null;

/** Generation counter to discard stale lookup results on rapid clicks. */
let clickGeneration = 0;

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
    container.addEventListener('click', onContainerClick);
}

/**
 * Dismiss any active popup. Call on route changes to prevent stale
 * popups persisting across hash navigation.
 */
export function dismissInlineDict() {
    dismiss();
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

    const info = caretInfoFromPoint(evt.clientX, evt.clientY);
    if (!info || info.node.nodeType !== Node.TEXT_NODE) {
        dismiss();
        return;
    }

    const firstChar = grabChars(info.node, info.offset, 1);
    if (!firstChar || !CJK_RE.test(firstChar)) {
        dismiss();
        return;
    }

    // Guard against rapid clicks: each click increments the generation.
    // If a newer click arrives while the shard is loading, the stale
    // result is discarded.
    const thisGeneration = ++clickGeneration;

    // Try longest match first: 4, 3, 2, 1.
    let shard;
    try {
        shard = await loadShard(firstChar);
    } catch {
        // No shard for this character — silently ignore.
        return;
    }

    // Discard if a newer click superseded this one during the await.
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

    showPopup(matchedTerm, matchedEntries, evt.clientX, evt.clientY);
}

/**
 * Create and position the popup element showing the lookup card.
 */
function showPopup(term, entries, clickX, clickY) {
    dismiss(); // remove any existing popup first

    const popup = document.createElement('div');
    popup.className = 'dict-popup';

    // Render the lookup card into a sub-container.
    const cardMount = document.createElement('div');
    renderLookupCard(buildCard(term, entries), cardMount);
    popup.appendChild(cardMount);

    // Upsell line
    const upsell = document.createElement('p');
    upsell.className = 'dict-upsell';
    upsell.innerHTML =
        '\u{1F4A1} Full hover dictionary in ' +
        '<a href="https://github.com/Fabulu/ReadZen/releases">Read Zen</a> \u00b7 ' +
        '<a href="https://ko-fi.com/readzen">Support on Ko-fi</a>';
    popup.appendChild(upsell);

    document.body.appendChild(popup);
    activePopup = popup;

    // Position: place near the click, clamped to viewport.
    positionPopup(popup, clickX, clickY);

    // Dismiss on outside click (next tick so this click doesn't trigger it).
    requestAnimationFrame(() => {
        document.addEventListener('click', onOutsideClick, { once: true, capture: true });
    });
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

/** Dismiss the active popup. */
function dismiss() {
    if (activePopup) {
        activePopup.remove();
        activePopup = null;
    }
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
