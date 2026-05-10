// lib/selection-sync.js
// Mirrors text selection across two or more line-aligned reader panes. When
// the user drags across rows in one pane, this module finds the corresponding
// `[data-line-id]` rows in every OTHER pane and applies `.line-row.is-active`
// so the gold accent makes the parallel passage visually pop.
//
// Design notes (per Wave 2.1 recon):
//   - Listens once on `document.selectionchange` (cheap, fires on any mutation).
//   - The "source" pane is whichever contains `range.startContainer`. Cross-
//     pane drags clamp the end row to the source pane so we never highlight a
//     phantom range that crosses both columns.
//   - Setting a class never re-triggers `selectionchange`, so there is no echo.
//   - Self-detaches when ALL provided panes have left the live DOM (e.g. the
//     user routed away). This avoids accumulating stale listeners.
//   - Spacer rows (`__lg_break_*`, `__pb_break_*`) have no `data-line-id`, so
//     they're naturally excluded from the row walk.

/**
 * Walk up from `node` until we hit an element with a `data-line-id` attribute
 * that is also inside `paneRoot`. Returns null if no such ancestor exists.
 *
 * @param {Node|null}        node     Selection container (text node or element).
 * @param {HTMLElement|null} paneRoot The pane whose `.line-row` we want.
 * @returns {HTMLElement|null}
 */
function findLineRow(node, paneRoot) {
    if (!node || !paneRoot) return null;
    let el = node.nodeType === 1 /* ELEMENT_NODE */ ? node : node.parentElement;
    while (el && el !== paneRoot) {
        if (el.nodeType === 1 && el.hasAttribute && el.hasAttribute('data-line-id')) {
            return el;
        }
        el = el.parentElement;
    }
    return null;
}

/**
 * Find which pane contains `node`. Returns the matching pane object from
 * `panes` or null if `node` lives outside all of them.
 */
function findOwningPane(node, panes) {
    if (!node) return null;
    for (const pane of panes) {
        if (pane && pane.root && pane.root.contains(node)) {
            return pane;
        }
    }
    return null;
}

/** Remove `.is-active` from every line row across `panes`. */
function clearAll(panes) {
    for (const pane of panes) {
        if (!pane || !pane.root) continue;
        const active = pane.root.querySelectorAll('.line-row.is-active');
        for (const el of active) el.classList.remove('is-active');
    }
}

/**
 * Attach selection mirroring across the given panes.
 *
 * @param {Array<{root: HTMLElement}>} panes Two or more line-aligned panes.
 * @returns {() => void} Detach function. Idempotent.
 */
export function attachSelectionMirror(panes) {
    if (!Array.isArray(panes) || panes.length < 2) {
        return () => {};
    }

    const handler = () => {
        // Self-detach when none of the provided panes are in the live DOM
        // anymore (typical on view route changes that replace the mount).
        const anyAttached = panes.some(p => p && p.root && document.body && document.body.contains(p.root));
        if (!anyAttached) {
            document.removeEventListener('selectionchange', handler);
            return;
        }

        const sel = (typeof window !== 'undefined' && window.getSelection)
            ? window.getSelection()
            : null;

        // Collapsed selection (single click, no drag) → clear everything.
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
            clearAll(panes);
            return;
        }

        const range = sel.getRangeAt(0);
        const sourcePane = findOwningPane(range.startContainer, panes);
        if (!sourcePane) {
            // Selection started outside any pane → clear cross-pane highlights.
            clearAll(panes);
            return;
        }

        const startRow = findLineRow(range.startContainer, sourcePane.root);
        if (!startRow) {
            clearAll(panes);
            return;
        }

        // Clamp endRow to the source pane. If the user drags out of the pane
        // (e.g. into the other column), `range.endContainer` may be in another
        // pane or in dead space — fall back to the start row in that case.
        let endRow = null;
        if (sourcePane.root.contains(range.endContainer)) {
            endRow = findLineRow(range.endContainer, sourcePane.root);
        }
        if (!endRow) endRow = startRow;

        // Walk every [data-line-id] in the source pane and pick the slice
        // [startRow .. endRow] (inclusive, document order). Using
        // querySelectorAll keeps order deterministic regardless of nesting.
        const allRows = Array.from(sourcePane.root.querySelectorAll('[data-line-id]'));
        const startIdx = allRows.indexOf(startRow);
        const endIdx = allRows.indexOf(endRow);
        if (startIdx < 0 || endIdx < 0) {
            clearAll(panes);
            return;
        }
        const lo = Math.min(startIdx, endIdx);
        const hi = Math.max(startIdx, endIdx);

        // Collect the line IDs within the slice.
        const ids = [];
        for (let i = lo; i <= hi; i += 1) {
            const id = allRows[i].getAttribute('data-line-id');
            if (id) ids.push(id);
        }

        // Mirror to all OTHER panes. Clear stale highlights first so a shrinking
        // selection doesn't leave orphaned rows lit up.
        for (const pane of panes) {
            if (!pane || !pane.root) continue;
            if (pane === sourcePane) continue;
            const stale = pane.root.querySelectorAll('.line-row.is-active');
            for (const el of stale) el.classList.remove('is-active');
            for (const id of ids) {
                const safe = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(id) : id;
                const el = pane.root.querySelector(`[data-line-id="${safe}"]`);
                if (el) el.classList.add('is-active');
            }
        }

        // Also clear highlights in the source pane itself — the native browser
        // selection already provides the visual cue there, and stray
        // `.is-active` from a previous drag would otherwise linger.
        const sourceStale = sourcePane.root.querySelectorAll('.line-row.is-active');
        for (const el of sourceStale) el.classList.remove('is-active');
    };

    document.addEventListener('selectionchange', handler);

    let detached = false;
    return () => {
        if (detached) return;
        detached = true;
        document.removeEventListener('selectionchange', handler);
        clearAll(panes);
    };
}
