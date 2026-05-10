// test/keyboard.test.js
// Smoke tests for lib/keyboard.js. We can't drive a real DOM under Node, so
// we install a tiny shim that simulates the bits the module actually touches:
// document.addEventListener, document.querySelector, window.scrollBy/scrollTo,
// matchMedia, document.activeElement.

import { test } from 'node:test';
import assert from 'node:assert/strict';

function installBrowserShim() {
    const handlers = { keydown: [] };
    const scrollLog = [];

    const fakeBody = { contains: () => true, scrollHeight: 5000, offsetHeight: 5000 };
    const docEl = { scrollHeight: 5000, offsetHeight: 5000, clientHeight: 800 };

    globalThis.window = {
        innerHeight: 800,
        scrollBy(opts) { scrollLog.push({ kind: 'by', ...opts }); },
        scrollTo(opts) { scrollLog.push({ kind: 'to', ...opts }); },
        matchMedia: () => ({ matches: false }),
        location: { hash: '' },
        addEventListener: () => {},
        removeEventListener: () => {}
    };

    const inputEl = {
        tagName: 'INPUT',
        focus() { this.focused = true; },
        select() { this.selected = true; },
        blur() { this.focused = false; }
    };

    globalThis.document = {
        body: fakeBody,
        documentElement: docEl,
        activeElement: null,
        addEventListener(type, fn) {
            (handlers[type] = handlers[type] || []).push(fn);
        },
        removeEventListener(type, fn) {
            const list = handlers[type] || [];
            const i = list.indexOf(fn);
            if (i >= 0) list.splice(i, 1);
        },
        querySelector(sel) {
            if (sel === '#search-input' || sel === '#landing-search-input' || sel === '.search-input') {
                return inputEl;
            }
            return null;
        },
        createElement: () => ({
            className: '',
            innerHTML: '',
            querySelector: () => ({ addEventListener: () => {} }),
            remove() { this.removed = true; },
            appendChild: () => {}
        })
    };
    document.body.appendChild = () => {};

    return { handlers, scrollLog, inputEl };
}

function fire(handlers, key, mods = {}) {
    const ev = {
        key,
        ctrlKey: !!mods.ctrl,
        metaKey: !!mods.meta,
        altKey: !!mods.alt,
        target: mods.target || { tagName: 'BODY', isContentEditable: false },
        prevented: false,
        preventDefault() { this.prevented = true; }
    };
    for (const h of handlers.keydown) h(ev);
    return ev;
}

test('installKeyboardNav: j scrolls down by ~80% of viewport', async () => {
    const env = installBrowserShim();
    const mod = await import('../lib/keyboard.js?j-test');
    mod.installKeyboardNav();
    fire(env.handlers, 'j');
    assert.equal(env.scrollLog.length, 1);
    assert.equal(env.scrollLog[0].kind, 'by');
    assert.ok(env.scrollLog[0].top > 0);
    assert.ok(env.scrollLog[0].top >= 0.8 * 800 * 0.99);
});

test('installKeyboardNav: k scrolls up', async () => {
    const env = installBrowserShim();
    const mod = await import('../lib/keyboard.js?k-test');
    mod.installKeyboardNav();
    fire(env.handlers, 'k');
    assert.equal(env.scrollLog.length, 1);
    assert.ok(env.scrollLog[0].top < 0);
});

test('installKeyboardNav: G scrolls to bottom', async () => {
    const env = installBrowserShim();
    const mod = await import('../lib/keyboard.js?G-test');
    mod.installKeyboardNav();
    fire(env.handlers, 'G');
    assert.equal(env.scrollLog.length, 1);
    assert.equal(env.scrollLog[0].kind, 'to');
    assert.ok(env.scrollLog[0].top > 0);
});

test('installKeyboardNav: gg chord scrolls to top', async () => {
    const env = installBrowserShim();
    const mod = await import('../lib/keyboard.js?gg-test');
    mod.installKeyboardNav();
    fire(env.handlers, 'g');
    fire(env.handlers, 'g');
    // First g sets the chord buffer; second g should trigger scrollTo(0).
    const last = env.scrollLog[env.scrollLog.length - 1];
    assert.equal(last.kind, 'to');
    assert.equal(last.top, 0);
});

test('installKeyboardNav: typing in input suppresses bindings', async () => {
    const env = installBrowserShim();
    const mod = await import('../lib/keyboard.js?input-test');
    mod.installKeyboardNav();
    fire(env.handlers, 'j', { target: { tagName: 'INPUT', isContentEditable: false } });
    assert.equal(env.scrollLog.length, 0);
});

test('installKeyboardNav: ctrl+key suppressed (reserved for browser)', async () => {
    const env = installBrowserShim();
    const mod = await import('../lib/keyboard.js?ctrl-test');
    mod.installKeyboardNav();
    fire(env.handlers, 'j', { ctrl: true });
    assert.equal(env.scrollLog.length, 0);
});

test('installKeyboardNav: / focuses search input when no navigator registered', async () => {
    const env = installBrowserShim();
    const mod = await import('../lib/keyboard.js?slash-test');
    mod.installKeyboardNav();
    fire(env.handlers, '/');
    assert.equal(env.inputEl.focused, true);
});

test('registerFindNavigator: n / N drive findNext / findPrev', async () => {
    const env = installBrowserShim();
    const mod = await import('../lib/keyboard.js?nav-test');
    mod.installKeyboardNav();

    let nextCalls = 0;
    let prevCalls = 0;
    const dispose = mod.registerFindNavigator({
        isOpen: () => true,
        open: () => {},
        close: () => {},
        findNext: () => { nextCalls += 1; },
        findPrev: () => { prevCalls += 1; }
    });

    fire(env.handlers, 'n');
    fire(env.handlers, 'N');
    assert.equal(nextCalls, 1);
    assert.equal(prevCalls, 1);

    dispose();
    fire(env.handlers, 'n');
    assert.equal(nextCalls, 1, 'after dispose, n should not call findNext');
});

test('registerFindNavigator: / prefers navigator.open() over input focus', async () => {
    const env = installBrowserShim();
    const mod = await import('../lib/keyboard.js?slashnav-test');
    mod.installKeyboardNav();

    let opened = 0;
    mod.registerFindNavigator({
        isOpen: () => false,
        open: () => { opened += 1; },
        close: () => {},
        findNext: () => {},
        findPrev: () => {}
    });

    fire(env.handlers, '/');
    assert.equal(opened, 1);
    assert.equal(env.inputEl.focused, undefined);
});

test('Escape closes find bar via navigator', async () => {
    const env = installBrowserShim();
    const mod = await import('../lib/keyboard.js?esc-test');
    mod.installKeyboardNav();

    let closed = 0;
    let isOpen = true;
    mod.registerFindNavigator({
        isOpen: () => isOpen,
        open: () => {},
        close: () => { closed += 1; isOpen = false; },
        findNext: () => {},
        findPrev: () => {}
    });

    fire(env.handlers, 'Escape');
    assert.equal(closed, 1);
});

// ---------- Gap tests (Wave 2.5 review) ----------

test('gg chord: timing out (>500ms between presses) does NOT scroll to top', async () => {
    const env = installBrowserShim();
    const mod = await import('../lib/keyboard.js?gg-timeout-test');
    mod.installKeyboardNav();

    // Mock Date.now so the timestamps under our control are advance-able.
    // The lib stores `lastGAt = Date.now()` on first g, then compares
    // `now - lastGAt <= CHORD_TIMEOUT_MS` (500) on second g.
    const origNow = Date.now;
    let fakeNow = 1_000_000;
    Date.now = () => fakeNow;
    try {
        fire(env.handlers, 'g');
        // Advance past the chord window (600 ms > 500 ms threshold).
        fakeNow += 600;
        fire(env.handlers, 'g');
        // After the second g, lastGAt is reset OR refreshed; either way no
        // scroll should have happened (the chord did not complete).
        const tos = env.scrollLog.filter(s => s.kind === 'to' && s.top === 0);
        assert.equal(tos.length, 0,
            'gg with >500ms gap must not trigger scrollTo(top=0)');
    } finally {
        Date.now = origNow;
    }
});

test('gg chord: g, j, g resets the chord buffer (non-g interrupts)', async () => {
    const env = installBrowserShim();
    const mod = await import('../lib/keyboard.js?gg-interrupt-test');
    mod.installKeyboardNav();

    fire(env.handlers, 'g');     // sets buffer
    fire(env.handlers, 'j');     // unrelated key — must reset chord buffer
    fire(env.handlers, 'g');     // first g of a NEW chord, not the second of old

    const topScrolls = env.scrollLog.filter(s => s.kind === 'to' && s.top === 0);
    assert.equal(topScrolls.length, 0,
        'g, j, g should not trigger gg scroll-to-top');
    // And j itself should have produced exactly one scrollBy.
    const downScrolls = env.scrollLog.filter(s => s.kind === 'by' && s.top > 0);
    assert.equal(downScrolls.length, 1, 'j should still scroll once');
});

test('Ctrl+G is NOT treated as a gg chord start (modifier suppression)', async () => {
    const env = installBrowserShim();
    const mod = await import('../lib/keyboard.js?ctrlg-test');
    mod.installKeyboardNav();

    fire(env.handlers, 'g', { ctrl: true });   // modifier → ignored entirely
    fire(env.handlers, 'g');                   // unmodified — only first half of a chord

    const topScrolls = env.scrollLog.filter(s => s.kind === 'to' && s.top === 0);
    assert.equal(topScrolls.length, 0,
        'Ctrl+G must not arm the chord; subsequent solo g should still wait for a partner');
});

test('Esc with no overlay/input/navigator falls through to dismissAllPopups', async () => {
    const env = installBrowserShim();
    const mod = await import('../lib/keyboard.js?esc-fallthrough-test');
    mod.installKeyboardNav();

    // No navigator registered. activeElement is null. helpOverlay is null.
    // The handler should still complete without throwing — dismissAllPopups
    // queries .cite-popup (returns null in the shim) and clears findNavigator.
    let threw = null;
    try { fire(env.handlers, 'Escape'); }
    catch (e) { threw = e; }
    assert.equal(threw, null, 'Escape must not throw when nothing is open');
});

test('installKeyboardNav called twice installs only one listener (idempotent)', async () => {
    const env = installBrowserShim();
    const mod = await import('../lib/keyboard.js?idempotent-test');
    mod.installKeyboardNav();
    mod.installKeyboardNav();
    mod.installKeyboardNav();

    // The shim records every addEventListener call into env.handlers.keydown.
    // Idempotent install means the count stays at 1.
    assert.equal(env.handlers.keydown.length, 1,
        'duplicate installKeyboardNav calls must not stack listeners');

    // Sanity: firing once still produces exactly one scroll (not three).
    fire(env.handlers, 'j');
    assert.equal(env.scrollLog.length, 1,
        'single keydown should produce exactly one scroll under idempotent install');
});

test('registerFindNavigator: disposer removes only the matching navigator', async () => {
    const env = installBrowserShim();
    const mod = await import('../lib/keyboard.js?disposer-test');
    mod.installKeyboardNav();

    let aCalls = 0, bCalls = 0;
    const navA = {
        isOpen: () => true, open: () => {}, close: () => {},
        findNext: () => { aCalls += 1; }, findPrev: () => {}
    };
    const navB = {
        isOpen: () => true, open: () => {}, close: () => {},
        findNext: () => { bCalls += 1; }, findPrev: () => {}
    };

    const disposeA = mod.registerFindNavigator(navA);
    // Verify navA is the active one.
    fire(env.handlers, 'n');
    assert.equal(aCalls, 1);

    // Register B (overwrites A in the single-slot registry).
    mod.registerFindNavigator(navB);
    fire(env.handlers, 'n');
    assert.equal(bCalls, 1);
    assert.equal(aCalls, 1, 'A should not fire after B replaces it');

    // Calling A's disposer must NOT clobber B (the active nav).
    disposeA();
    fire(env.handlers, 'n');
    assert.equal(bCalls, 2, 'B must remain registered after A.dispose()');
});
