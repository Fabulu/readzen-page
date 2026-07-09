import test from 'node:test';
import assert from 'node:assert';
import { readFile, readdir } from 'node:fs/promises';

// Regression guard for a bug class that has bitten twice (segmentMap 2026-07,
// RELEASES_URL 2026-04..07): a view module references an identifier in a
// template literal that is neither declared in the file nor imported — a
// strict-mode ReferenceError that surfaces only when that code path runs,
// typically replacing an already-rendered view with an error panel.
// Views are not headless-importable, so this checks the source contract for
// known shared-constant names that exist as per-module copies. Regex literals
// on purpose — a string-built RegExp version of this test passed vacuously.

const CHECKS = [
    {
        name: 'RELEASES_URL',
        used: /\$\{\s*RELEASES_URL\b/,
        declared: /(?:const|let|var)\s+RELEASES_URL\b|import[^;]*\bRELEASES_URL\b/,
    },
];

test('every view referencing a shared constant declares or imports it', async () => {
    const dir = new URL('../views/', import.meta.url);
    let checkedUses = 0;
    for (const fn of await readdir(dir)) {
        if (!fn.endsWith('.js')) continue;
        const src = await readFile(new URL(fn, dir), 'utf8');
        for (const c of CHECKS) {
            if (!c.used.test(src)) continue;
            checkedUses++;
            assert.ok(c.declared.test(src),
                'views/' + fn + ' references ' + c.name + ' without declaring or importing it');
        }
    }
    // Self-guard against vacuous passes: RELEASES_URL is genuinely used in at
    // least landing.js, shell.js, and passage.js today.
    assert.ok(checkedUses >= 3, 'usage detector matched only ' + checkedUses + ' files — the "used" regex has gone stale');
});
