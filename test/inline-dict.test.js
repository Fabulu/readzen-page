// test/inline-dict.test.js
// Wave 2.2 — mobile-aware hover dictionary.
//
// The browser-specific behaviour (matchMedia, Pointer Events, document.body,
// caretPositionFromPoint) makes a full DOM simulation expensive, so this
// suite focuses on what we can verify cheaply:
//   1. Static-source assertions: the long-press constants, pointer wiring,
//      and CSS hooks the recon spec requires must actually exist in the
//      shipped module.
//   2. A behavioural test that imports the module under a coarse-pointer
//      matchMedia stub and verifies the long-press timer fires after the
//      configured delay.
//
// The static check protects us against regressions where the module gets
// reshuffled but loses the touch path; the behavioural check protects the
// timing constants and pointerdown listener from being rewired.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_PATH = resolve(__dirname, '..', 'lib', 'inline-dict.js');
const SRC = readFileSync(SRC_PATH, 'utf8');

// ---------- Static source assertions ----------

test('inline-dict source: long-press timing constants match recon spec', () => {
    // 500ms threshold and 8px movement slop are part of the contract.
    assert.match(SRC, /LONG_PRESS_MS\s*=\s*500\b/, 'LONG_PRESS_MS must be 500');
    assert.match(SRC, /LONG_PRESS_SLOP_PX\s*=\s*8\b/, 'LONG_PRESS_SLOP_PX must be 8');
});

test('inline-dict source: queries (pointer: coarse) media for drawer mode', () => {
    assert.match(
        SRC,
        /matchMedia\(['"]\(pointer:\s*coarse\)['"]\)/,
        'must detect coarse pointer via matchMedia'
    );
});

test('inline-dict source: registers pointer listeners for long-press', () => {
    for (const evt of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
        assert.match(
            SRC,
            new RegExp(`addEventListener\\(['"]${evt}['"]`),
            `attachInlineDict must register a ${evt} listener`
        );
    }
});

test('inline-dict source: filters pointer events to touch / pen', () => {
    // Both filter conditions must appear so mouse pointers are not double-handled.
    assert.match(SRC, /pointerType\s*!==\s*['"]touch['"]/);
    assert.match(SRC, /pointerType\s*!==\s*['"]pen['"]/);
});

test('inline-dict source: synthetic click after touch is suppressed', () => {
    assert.match(SRC, /suppressNextClick/, 'suppressNextClick state flag must exist');
    // The click handler must short-circuit when the flag is set, and must
    // clear the flag (either directly or via the clearClickSuppression
    // helper) so a subsequent legitimate click is not also swallowed.
    assert.match(
        SRC,
        /if\s*\(\s*suppressNextClick\s*\)\s*\{[^}]*(suppressNextClick\s*=\s*false|clearClickSuppression\s*\()/,
        'click handler must consume the suppress flag and return early'
    );
});

test('inline-dict source: drawer mode emits the recon-spec CSS hooks', () => {
    assert.match(SRC, /dict-popup--drawer/);
    assert.match(SRC, /dict-drawer-handle/);
    assert.match(SRC, /dict-drawer-close/);
    assert.match(SRC, /dict-drawer-backdrop/);
});

test('inline-dict source: drawer mode skips positionPopup', () => {
    // The "if (!asDrawer) positionPopup(...)" branch is the contract that
    // keeps the drawer's CSS-driven layout from being clobbered by the
    // click-relative positioning math.
    assert.match(
        SRC,
        /if\s*\(\s*!\s*asDrawer\s*\)\s*\{\s*positionPopup\(/,
        'positionPopup must be guarded by !asDrawer'
    );
});

// ---------- Behavioural test (coarse-pointer simulation) ----------

test('inline-dict: long-press timer is armed on touch pointerdown', async (t) => {
    // Snapshot real globals so we can restore them at end-of-test, even on
    // failure. node:test catches throws and runs teardown via t.after.
    const origWindow = globalThis.window;
    const origDocument = globalThis.document;
    const origLocalStorage = globalThis.localStorage;
    const origFetch = globalThis.fetch;

    // Capture every setTimeout call so we can inspect what the module
    // scheduled. We only care about *that* the long-press timer was set up
    // with the right delay; we don't actually need it to fire.
    const timers = [];
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = function (fn, delay, ...rest) {
        timers.push({ fn, delay });
        // Return a sentinel id rather than scheduling — keeps the test
        // deterministic and avoids the timer firing into a half-stubbed DOM.
        return timers.length;
    };

    t.after(() => {
        globalThis.window = origWindow;
        globalThis.document = origDocument;
        globalThis.localStorage = origLocalStorage;
        globalThis.fetch = origFetch;
        globalThis.setTimeout = origSetTimeout;
    });

    // matchMedia stub: report (pointer: coarse) → matches:true.
    const matchMedia = (query) => ({
        matches: query.includes('pointer: coarse'),
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
    });

    globalThis.window = {
        matchMedia,
        innerWidth: 360,
        innerHeight: 640,
        Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    };
    globalThis.localStorage = {
        getItem: () => null,
        setItem() {},
    };
    globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });

    // Capture container.addEventListener calls so we can replay pointerdown.
    const handlers = new Map();
    const container = {
        _inlineDictAttached: false,
        addEventListener(name, fn) { handlers.set(name, fn); },
    };

    // Minimal document stub — the module only touches document inside doLookup
    // (which the synthetic pointerdown won't trigger because we stubbed
    // setTimeout to a no-op).
    globalThis.document = {
        createElement: () => ({
            style: {}, classList: { add() {}, remove() {} },
            setAttribute() {}, addEventListener() {},
            appendChild() {}, append() {},
        }),
        body: { appendChild() {} },
        addEventListener() {},
    };

    // Cache-bust so the module re-evaluates with our stubbed window.
    const mod = await import(`../lib/inline-dict.js?case=longpress&t=${Date.now()}`);
    mod.attachInlineDict(container);

    const pointerdown = handlers.get('pointerdown');
    assert.equal(typeof pointerdown, 'function', 'pointerdown listener must be registered');

    // Simulate a touch press.
    pointerdown({
        pointerType: 'touch',
        pointerId: 1,
        clientX: 100,
        clientY: 200,
        target: {
            closest: () => null,
        },
    });

    // The handler should have armed exactly one timer at LONG_PRESS_MS (500).
    const longPressTimer = timers.find((t) => t.delay === 500);
    assert.ok(
        longPressTimer,
        `expected a setTimeout(..., 500) for long-press, got: ${JSON.stringify(timers.map(t => t.delay))}`
    );

    // Mouse pointerdown must not arm a long-press (regression guard for
    // hybrid laptops where attachInlineDict still wires the listener).
    timers.length = 0;
    pointerdown({
        pointerType: 'mouse',
        pointerId: 2,
        clientX: 50,
        clientY: 50,
        target: { closest: () => null },
    });
    assert.equal(
        timers.length, 0,
        'mouse pointerdown must not arm the long-press timer'
    );
});

// ---------- Gap tests (Wave 2.2 review) ----------

/**
 * Build a controllable timer + DOM environment for inline-dict.
 * Returns helpers to drive pointer/click events and inspect timer state.
 *
 * Each call creates a fresh stub set; pair with an `await import(...)` using
 * a unique query string so the module re-evaluates against this environment.
 */
function buildInlineDictEnv(t) {
    const origWindow = globalThis.window;
    const origDocument = globalThis.document;
    const origLocalStorage = globalThis.localStorage;
    const origFetch = globalThis.fetch;
    const origSetTimeout = globalThis.setTimeout;
    const origClearTimeout = globalThis.clearTimeout;
    const origNode = globalThis.Node;

    // Map of timer-id -> {fn, delay, cancelled}. Tests can manually fire.
    const timers = new Map();
    let nextId = 0;
    globalThis.setTimeout = function (fn, delay) {
        const id = ++nextId;
        timers.set(id, { fn, delay, cancelled: false });
        return id;
    };
    globalThis.clearTimeout = function (id) {
        const t = timers.get(id);
        if (t) t.cancelled = true;
    };

    const matchMedia = (q) => ({
        matches: q.includes('pointer: coarse'),
        media: q,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
    });

    globalThis.window = {
        matchMedia,
        innerWidth: 360,
        innerHeight: 640,
        Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    };
    globalThis.Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 };
    globalThis.localStorage = { getItem: () => null, setItem() {} };
    globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
    globalThis.document = {
        createElement: () => ({
            style: {}, classList: { add() {}, remove() {} },
            setAttribute() {}, addEventListener() {},
            appendChild() {}, append() {}, remove() {},
            querySelector: () => null,
        }),
        body: { appendChild() {}, removeChild() {} },
        addEventListener() {},
        removeEventListener() {},
        // Returning null from caretPositionFromPoint → doLookup calls dismiss
        // and returns without touching the rest of the DOM. Keeps timer
        // tests deterministic.
        caretPositionFromPoint: () => null,
        caretRangeFromPoint: () => null,
    };

    t.after(() => {
        globalThis.window = origWindow;
        globalThis.document = origDocument;
        globalThis.localStorage = origLocalStorage;
        globalThis.fetch = origFetch;
        globalThis.setTimeout = origSetTimeout;
        globalThis.clearTimeout = origClearTimeout;
        globalThis.Node = origNode;
    });

    return {
        timers,
        latestTimer() {
            const ids = [...timers.keys()];
            return ids.length ? timers.get(ids[ids.length - 1]) : null;
        },
        fire(timerId) {
            const t = timers.get(timerId);
            if (!t || t.cancelled) return false;
            t.fn();
            return true;
        }
    };
}

test('inline-dict: long-press timer fires after 500ms with no movement', async (t) => {
    const env = buildInlineDictEnv(t);

    const handlers = new Map();
    const container = {
        _inlineDictAttached: false,
        addEventListener(name, fn) { handlers.set(name, fn); },
    };

    const mod = await import(`../lib/inline-dict.js?case=fires&t=${Date.now()}`);
    mod.attachInlineDict(container);

    // Press without moving.
    handlers.get('pointerdown')({
        pointerType: 'touch', pointerId: 1, clientX: 100, clientY: 200,
        target: { closest: () => null },
    });

    // Find the 500ms timer the long-press handler armed.
    let longPressId = null;
    for (const [id, t] of env.timers) {
        if (t.delay === 500 && !t.cancelled) { longPressId = id; break; }
    }
    assert.ok(longPressId != null, 'pointerdown must arm a 500ms timer');

    // Fire it manually — represents the wall-clock 500ms elapsing with no
    // intervening movement / cancel. The timer body sets longPress.fired
    // and suppressNextClick=true, then invokes doLookup. Our document stub
    // makes caretPositionFromPoint return null, so doLookup short-circuits
    // cleanly.
    let threw = null;
    try { env.fire(longPressId); }
    catch (e) { threw = e; }
    assert.equal(threw, null, 'long-press fire must complete without throwing');
});

test('inline-dict: pointermove >8px before 500ms cancels the long-press', async (t) => {
    const env = buildInlineDictEnv(t);

    const handlers = new Map();
    const container = {
        _inlineDictAttached: false,
        addEventListener(name, fn) { handlers.set(name, fn); },
    };

    const mod = await import(`../lib/inline-dict.js?case=move-cancel&t=${Date.now()}`);
    mod.attachInlineDict(container);

    handlers.get('pointerdown')({
        pointerType: 'touch', pointerId: 1, clientX: 100, clientY: 200,
        target: { closest: () => null },
    });
    let lpId = null;
    for (const [id, tinfo] of env.timers) {
        if (tinfo.delay === 500) { lpId = id; break; }
    }
    assert.ok(lpId != null);
    assert.equal(env.timers.get(lpId).cancelled, false, 'timer not yet cancelled');

    // Move 10px (> 8px slop) — must cancel the timer.
    handlers.get('pointermove')({
        pointerId: 1, clientX: 110, clientY: 200,
    });
    assert.equal(env.timers.get(lpId).cancelled, true,
        'pointermove >8px must cancel the long-press timer');
});

test('inline-dict: pointercancel cancels the long-press timer', async (t) => {
    const env = buildInlineDictEnv(t);

    const handlers = new Map();
    const container = {
        _inlineDictAttached: false,
        addEventListener(name, fn) { handlers.set(name, fn); },
    };

    const mod = await import(`../lib/inline-dict.js?case=cancel&t=${Date.now()}`);
    mod.attachInlineDict(container);

    handlers.get('pointerdown')({
        pointerType: 'touch', pointerId: 7, clientX: 50, clientY: 50,
        target: { closest: () => null },
    });
    let lpId = null;
    for (const [id, tinfo] of env.timers) {
        if (tinfo.delay === 500) { lpId = id; break; }
    }
    assert.ok(lpId != null);

    handlers.get('pointercancel')({ pointerId: 7 });
    assert.equal(env.timers.get(lpId).cancelled, true,
        'pointercancel must cancel the long-press timer');
});

test('inline-dict: synthetic click after long-press is suppressed exactly once', async (t) => {
    const env = buildInlineDictEnv(t);

    const handlers = new Map();
    const container = {
        _inlineDictAttached: false,
        addEventListener(name, fn) { handlers.set(name, fn); },
    };

    const mod = await import(`../lib/inline-dict.js?case=suppress&t=${Date.now()}`);
    mod.attachInlineDict(container);

    // Track caret-resolution attempts as a proxy for "click did real work".
    let caretCalls = 0;
    document.caretPositionFromPoint = () => { caretCalls += 1; return null; };

    // Step 1: pointerdown → long-press timer armed.
    handlers.get('pointerdown')({
        pointerType: 'touch', pointerId: 1, clientX: 100, clientY: 200,
        target: { closest: () => null },
    });
    let lpId = null;
    for (const [id, tinfo] of env.timers) {
        if (tinfo.delay === 500) { lpId = id; break; }
    }
    assert.ok(lpId != null);

    // Step 2: long-press timer fires → suppressNextClick is now true.
    env.fire(lpId);
    const caretAfterLongPress = caretCalls;

    // Step 3: synthetic click follows the touch. It must be suppressed —
    // no doLookup, so caretCalls does NOT increase.
    const clickHandler = handlers.get('click');
    assert.equal(typeof clickHandler, 'function', 'click handler must be registered');
    await clickHandler({
        target: { closest: () => null },
        clientX: 100, clientY: 200,
    });
    assert.equal(caretCalls, caretAfterLongPress,
        'synthetic click after long-press must be suppressed (no caret lookup)');

    // Step 4: a SECOND, real click (mouse user) must NOT be suppressed —
    // suppressNextClick was consumed exactly once in step 3.
    await clickHandler({
        target: { closest: () => null },
        clientX: 50, clientY: 50,
    });
    assert.ok(caretCalls > caretAfterLongPress,
        'subsequent click must run normally; suppress flag is single-use');
});

test('inline-dict source: drawer mode also skips the global outside-click listener', async () => {
    // Complements the existing static check on positionPopup: the same
    // !asDrawer guard must wrap the document.addEventListener('click', ...)
    // outside-click registration, otherwise tapping inside a drawer would
    // race the explicit backdrop close.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, resolve } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, '..', 'lib', 'inline-dict.js'), 'utf8');

    // The wrapped block contains the requestAnimationFrame + addEventListener
    // pair. Match across newlines.
    assert.match(
        src,
        /if\s*\(\s*!\s*asDrawer\s*\)\s*\{\s*requestAnimationFrame\(\s*\(\)\s*=>\s*\{\s*document\.addEventListener\(\s*['"]click['"]/m,
        'global outside-click listener must be guarded by !asDrawer'
    );
});
