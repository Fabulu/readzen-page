// test/selection-sync.test.js
// Unit tests for lib/selection-sync.js. The Node test runner has no native DOM,
// so we build a tiny purpose-built DOM stub that supports just the surface the
// module touches: contains/parentElement/classList, attribute lookup,
// querySelector(All) for `[data-line-id]` and `.line-row.is-active`, and a
// faux `document` that fans out `selectionchange` events. Plus a minimal
// `window.getSelection()` whose Range can be programmed to point at any node.
//
// Keeping this fixture local (rather than in _dom-shim.js) keeps that file
// focused on TEI XML parsing, which is its only other job today.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// --- Tiny DOM stub --------------------------------------------------------

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

class StubText {
    constructor(text, parent) {
        this.nodeType = TEXT_NODE;
        this.textContent = text;
        this.parentElement = parent;
    }
}

class StubClassList {
    constructor(el) { this._el = el; }
    add(cls) { if (!this._el._classes.has(cls)) this._el._classes.add(cls); }
    remove(cls) { this._el._classes.delete(cls); }
    contains(cls) { return this._el._classes.has(cls); }
}

class StubElement {
    constructor(tagName, attrs = {}, classes = []) {
        this.nodeType = ELEMENT_NODE;
        this.tagName = tagName.toUpperCase();
        this._attrs = { ...attrs };
        this._classes = new Set(classes);
        this.children = [];
        this.parentElement = null;
        this.classList = new StubClassList(this);
    }

    appendChild(child) {
        child.parentElement = this;
        this.children.push(child);
        return child;
    }

    hasAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this._attrs, name);
    }

    getAttribute(name) {
        return this.hasAttribute(name) ? this._attrs[name] : null;
    }

    contains(node) {
        if (!node) return false;
        let cur = node;
        while (cur) {
            if (cur === this) return true;
            cur = cur.parentElement;
        }
        return false;
    }

    /** Walk descendants (depth-first) and yield matching elements. */
    *_walk() {
        for (const child of this.children) {
            if (child.nodeType !== ELEMENT_NODE) continue;
            yield child;
            yield* child._walk();
        }
    }

    querySelectorAll(selector) {
        const matches = [];
        for (const el of this._walk()) {
            if (matchSelector(el, selector)) matches.push(el);
        }
        return matches;
    }

    querySelector(selector) {
        for (const el of this._walk()) {
            if (matchSelector(el, selector)) return el;
        }
        return null;
    }
}

/**
 * Implements the small selector subset that selection-sync.js uses:
 *   - `[data-line-id]`                  — attribute presence
 *   - `[data-line-id="<value>"]`        — attribute equality
 *   - `.line-row.is-active`             — multiple class match
 */
function matchSelector(el, selector) {
    // Attribute presence/equality
    let m = /^\[([^=\]]+)\]$/.exec(selector);
    if (m) return el.hasAttribute(m[1]);

    m = /^\[([^=\]]+)="([^"]*)"\]$/.exec(selector);
    if (m) return el.getAttribute(m[1]) === m[2];

    // Multiple class match (e.g., ".line-row.is-active")
    if (selector.startsWith('.')) {
        const classes = selector.slice(1).split('.');
        return classes.every(c => el._classes.has(c));
    }
    return false;
}

// `document` stub with addEventListener and a body that supports `.contains()`.
class StubDocument {
    constructor() {
        this._listeners = new Map();
        this.body = new StubElement('body');
    }
    addEventListener(type, fn) {
        if (!this._listeners.has(type)) this._listeners.set(type, new Set());
        this._listeners.get(type).add(fn);
    }
    removeEventListener(type, fn) {
        const set = this._listeners.get(type);
        if (set) set.delete(fn);
    }
    dispatchEvent(type) {
        const set = this._listeners.get(type);
        if (!set) return;
        for (const fn of [...set]) fn();
    }
}

class StubRange {
    constructor(startContainer, endContainer) {
        this.startContainer = startContainer;
        this.endContainer = endContainer;
    }
}

class StubSelection {
    constructor() {
        this._range = null;
        this.isCollapsed = true;
        this.rangeCount = 0;
    }
    setRange(range) {
        this._range = range;
        this.isCollapsed = false;
        this.rangeCount = 1;
    }
    collapse() {
        this._range = null;
        this.isCollapsed = true;
        this.rangeCount = 0;
    }
    getRangeAt(_i) { return this._range; }
}

function installDomGlobals() {
    globalThis.document = new StubDocument();
    const sel = new StubSelection();
    globalThis.window = { getSelection: () => sel };
    globalThis.CSS = { escape: (s) => String(s).replace(/"/g, '\\"') };
    return sel;
}

function buildPaneWithLines(ids) {
    const pane = new StubElement('div', { id: 'pane' }, ['panel-body']);
    const rows = new Map();
    for (const id of ids) {
        const row = new StubElement('div', { 'data-line-id': id }, ['line-row']);
        const text = new StubText(`text-${id}`, row);
        row.appendChild(text);
        pane.appendChild(row);
        rows.set(id, { row, text });
    }
    return { pane, rows };
}

// --- Tests ----------------------------------------------------------------

test('attachSelectionMirror: ZH selection lights up matching EN rows', async () => {
    const sel = installDomGlobals();
    const ids = ['l1', 'l2', 'l3', 'l4', 'l5'];
    const a = buildPaneWithLines(ids);
    const b = buildPaneWithLines(ids);
    document.body.appendChild(a.pane);
    document.body.appendChild(b.pane);

    const { attachSelectionMirror } = await import('../lib/selection-sync.js');
    const detach = attachSelectionMirror([{ root: a.pane }, { root: b.pane }]);

    // Drag from text of l2 → text of l4 in pane A.
    sel.setRange(new StubRange(a.rows.get('l2').text, a.rows.get('l4').text));
    document.dispatchEvent('selectionchange');

    for (const id of ['l2', 'l3', 'l4']) {
        assert.ok(
            b.rows.get(id).row.classList.contains('is-active'),
            `pane B row ${id} should have is-active`
        );
    }
    for (const id of ['l1', 'l5']) {
        assert.equal(
            b.rows.get(id).row.classList.contains('is-active'),
            false,
            `pane B row ${id} should NOT have is-active`
        );
    }
    // Source pane should not retain `is-active` (browser selection draws there).
    for (const id of ids) {
        assert.equal(
            a.rows.get(id).row.classList.contains('is-active'),
            false,
            `pane A row ${id} should not have is-active`
        );
    }

    detach();
});

test('attachSelectionMirror: collapsed selection clears highlights', async () => {
    const sel = installDomGlobals();
    const ids = ['l1', 'l2', 'l3'];
    const a = buildPaneWithLines(ids);
    const b = buildPaneWithLines(ids);
    document.body.appendChild(a.pane);
    document.body.appendChild(b.pane);

    const { attachSelectionMirror } = await import('../lib/selection-sync.js');
    const detach = attachSelectionMirror([{ root: a.pane }, { root: b.pane }]);

    // First, mirror a real selection so pane B has `is-active` rows.
    sel.setRange(new StubRange(a.rows.get('l1').text, a.rows.get('l2').text));
    document.dispatchEvent('selectionchange');
    assert.ok(b.rows.get('l1').row.classList.contains('is-active'));
    assert.ok(b.rows.get('l2').row.classList.contains('is-active'));

    // Now collapse — every `is-active` should disappear.
    sel.collapse();
    document.dispatchEvent('selectionchange');
    for (const id of ids) {
        assert.equal(
            b.rows.get(id).row.classList.contains('is-active'),
            false,
            `pane B row ${id} should be cleared after collapse`
        );
    }
    detach();
});

test('attachSelectionMirror: 3-pane mirror lights up both other panes', async () => {
    const sel = installDomGlobals();
    const ids = ['l1', 'l2', 'l3', 'l4'];
    const orig = buildPaneWithLines(ids);
    const a = buildPaneWithLines(ids);
    const b = buildPaneWithLines(ids);
    document.body.appendChild(orig.pane);
    document.body.appendChild(a.pane);
    document.body.appendChild(b.pane);

    const { attachSelectionMirror } = await import('../lib/selection-sync.js');
    const detach = attachSelectionMirror([
        { root: orig.pane },
        { root: a.pane },
        { root: b.pane }
    ]);

    sel.setRange(new StubRange(orig.rows.get('l2').text, orig.rows.get('l3').text));
    document.dispatchEvent('selectionchange');

    for (const id of ['l2', 'l3']) {
        assert.ok(
            a.rows.get(id).row.classList.contains('is-active'),
            `pane A row ${id} should be lit`
        );
        assert.ok(
            b.rows.get(id).row.classList.contains('is-active'),
            `pane B row ${id} should be lit`
        );
    }
    detach();
});

test('attachSelectionMirror: cross-pane drag clamps end to source pane', async () => {
    const sel = installDomGlobals();
    const ids = ['l1', 'l2', 'l3', 'l4'];
    const a = buildPaneWithLines(ids);
    const b = buildPaneWithLines(ids);
    document.body.appendChild(a.pane);
    document.body.appendChild(b.pane);

    const { attachSelectionMirror } = await import('../lib/selection-sync.js');
    const detach = attachSelectionMirror([{ root: a.pane }, { root: b.pane }]);

    // Selection starts in A.l2 but the drag continues into B.l4 (cross-pane).
    sel.setRange(new StubRange(a.rows.get('l2').text, b.rows.get('l4').text));
    document.dispatchEvent('selectionchange');

    // Source = A. End clamps to start row → only l2 highlights in B.
    assert.ok(b.rows.get('l2').row.classList.contains('is-active'));
    for (const id of ['l1', 'l3', 'l4']) {
        assert.equal(
            b.rows.get(id).row.classList.contains('is-active'),
            false,
            `pane B row ${id} should not be lit when end is in another pane`
        );
    }
    detach();
});

test('attachSelectionMirror: detach() removes listener and clears highlights', async () => {
    const sel = installDomGlobals();
    const ids = ['l1', 'l2'];
    const a = buildPaneWithLines(ids);
    const b = buildPaneWithLines(ids);
    document.body.appendChild(a.pane);
    document.body.appendChild(b.pane);

    const { attachSelectionMirror } = await import('../lib/selection-sync.js');
    const detach = attachSelectionMirror([{ root: a.pane }, { root: b.pane }]);

    sel.setRange(new StubRange(a.rows.get('l1').text, a.rows.get('l2').text));
    document.dispatchEvent('selectionchange');
    assert.ok(b.rows.get('l1').row.classList.contains('is-active'));

    detach();

    // After detach: highlights cleared, and another selectionchange has no effect.
    assert.equal(b.rows.get('l1').row.classList.contains('is-active'), false);
    assert.equal(b.rows.get('l2').row.classList.contains('is-active'), false);

    sel.setRange(new StubRange(a.rows.get('l1').text, a.rows.get('l2').text));
    document.dispatchEvent('selectionchange');
    assert.equal(
        b.rows.get('l1').row.classList.contains('is-active'),
        false,
        'no further mirroring after detach'
    );
});

test('attachSelectionMirror: self-detaches when panes leave the DOM', async () => {
    const sel = installDomGlobals();
    const ids = ['l1', 'l2'];
    const a = buildPaneWithLines(ids);
    const b = buildPaneWithLines(ids);
    document.body.appendChild(a.pane);
    document.body.appendChild(b.pane);

    const { attachSelectionMirror } = await import('../lib/selection-sync.js');
    attachSelectionMirror([{ root: a.pane }, { root: b.pane }]);

    // Simulate routing away: panes detached from body.
    document.body.children = [];
    a.pane.parentElement = null;
    b.pane.parentElement = null;

    // Dispatching now should no-op without throwing AND remove the listener.
    sel.setRange(new StubRange(a.rows.get('l1').text, a.rows.get('l2').text));
    document.dispatchEvent('selectionchange');

    // Listener is gone — the second dispatch should hit zero handlers.
    const remaining = document._listeners.get('selectionchange');
    assert.equal(
        remaining ? remaining.size : 0,
        0,
        'selectionchange listener should self-remove once panes are detached'
    );
});

test('attachSelectionMirror: less than 2 panes returns a no-op detach', async () => {
    installDomGlobals();
    const { attachSelectionMirror } = await import('../lib/selection-sync.js');
    const detach1 = attachSelectionMirror([]);
    const detach2 = attachSelectionMirror([{ root: new StubElement('div') }]);
    assert.equal(typeof detach1, 'function');
    assert.equal(typeof detach2, 'function');
    detach1();
    detach2();
    // No listeners should have been registered.
    const set = document._listeners.get('selectionchange');
    assert.equal(set ? set.size : 0, 0);
});

test('attachSelectionMirror: clamps when range starts outside any pane', async () => {
    const sel = installDomGlobals();
    const ids = ['l1', 'l2'];
    const a = buildPaneWithLines(ids);
    const b = buildPaneWithLines(ids);
    document.body.appendChild(a.pane);
    document.body.appendChild(b.pane);
    const stray = new StubElement('div');
    document.body.appendChild(stray);

    const { attachSelectionMirror } = await import('../lib/selection-sync.js');
    const detach = attachSelectionMirror([{ root: a.pane }, { root: b.pane }]);

    // Pre-light pane B so we can confirm the clear path runs.
    sel.setRange(new StubRange(a.rows.get('l1').text, a.rows.get('l2').text));
    document.dispatchEvent('selectionchange');
    assert.ok(b.rows.get('l1').row.classList.contains('is-active'));

    // Selection starts in stray div (outside any pane) → clear all panes.
    sel.setRange(new StubRange(stray, stray));
    document.dispatchEvent('selectionchange');
    for (const id of ids) {
        assert.equal(
            b.rows.get(id).row.classList.contains('is-active'),
            false,
            `pane B row ${id} should be cleared when selection starts outside`
        );
    }
    detach();
});

test('attachSelectionMirror: selection inside <mark> still resolves the line row', async () => {
    // Find-bar wraps matching text in <mark>. Make sure walking up still finds
    // the enclosing `[data-line-id]` row.
    const sel = installDomGlobals();
    const a = buildPaneWithLines(['l1', 'l2', 'l3']);
    const b = buildPaneWithLines(['l1', 'l2', 'l3']);

    // Replace the text node of A.l2 with a <mark>text</mark> structure.
    const row = a.rows.get('l2').row;
    row.children = [];
    const mark = new StubElement('mark');
    const inner = new StubText('found', mark);
    mark.appendChild(inner);
    row.appendChild(mark);

    document.body.appendChild(a.pane);
    document.body.appendChild(b.pane);

    const { attachSelectionMirror } = await import('../lib/selection-sync.js');
    const detach = attachSelectionMirror([{ root: a.pane }, { root: b.pane }]);

    sel.setRange(new StubRange(inner, inner));
    document.dispatchEvent('selectionchange');

    assert.ok(
        b.rows.get('l2').row.classList.contains('is-active'),
        'B.l2 should highlight even when source range starts inside <mark>'
    );
    detach();
});
