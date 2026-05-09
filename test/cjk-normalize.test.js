// test/cjk-normalize.test.js
// Unit tests for lib/cjk-normalize.js — strip set + index map + CJK detection.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    normalize,
    normalizeString,
    rawIndexFromNormalizedPos,
    isCjk,
    containsCjk
} from '../lib/cjk-normalize.js';

// ---------- normalizeString ----------

test('normalizeString: strips CJK editorial period (parity gate for W3.4)', () => {
    // 無 U+7121, 門 U+9580, 。 U+3002, 關 U+95DC
    assert.equal(normalizeString('無門。關'), '無門關');
});

test('normalizeString: strips ASCII spaces', () => {
    assert.equal(normalizeString('  a  b  '), 'ab');
});

test('normalizeString: ideographic space (U+3000) is stripped', () => {
    // 甲 U+7532, U+3000, 乙 U+4E59
    const input = '甲　乙';
    assert.equal(normalizeString(input), '甲乙');
});

test('normalizeString: null and empty inputs return empty string', () => {
    assert.equal(normalizeString(null), '');
    assert.equal(normalizeString(undefined), '');
    assert.equal(normalizeString(''), '');
});

test('normalizeString: stripped punctuation set', () => {
    // Various CJK editorial marks all collapse to nothing.
    assert.equal(normalizeString('「無門」、《關》。'), '無門關');
});

// ---------- normalize (full record + index map) ----------

test('normalize: rawIndexByNormalizedIndex maps period skip correctly', () => {
    const nt = normalize('無門。關');
    // Normalized = "無門關"; raw indices for those three chars = 0, 1, 3
    // (period at raw index 2 is stripped).
    assert.equal(nt.normalized, '無門關');
    assert.deepEqual(Array.from(nt.rawIndexByNormalizedIndex), [0, 1, 3]);
});

test('normalize: returns Int32Array for index map', () => {
    const nt = normalize('abc');
    assert.ok(nt.rawIndexByNormalizedIndex instanceof Int32Array);
});

test('normalize: raw is the post-pre-pass string (U+3000 -> space)', () => {
    const nt = normalize('甲　乙');
    // Pre-pass replaces U+3000 with U+0020; the space then gets stripped on
    // iteration but the .raw field reflects post-replace.
    assert.equal(nt.raw, '甲 乙');
    assert.equal(nt.normalized, '甲乙');
});

// ---------- rawIndexFromNormalizedPos ----------

test('rawIndexFromNormalizedPos: clamps below zero to 0', () => {
    const nt = normalize('無門。關');
    assert.equal(rawIndexFromNormalizedPos(nt, -5), 0);
});

test('rawIndexFromNormalizedPos: above range returns raw.length', () => {
    const nt = normalize('無門。關');
    assert.equal(rawIndexFromNormalizedPos(nt, 999), nt.raw.length);
});

test('rawIndexFromNormalizedPos: in-range returns mapped raw index', () => {
    const nt = normalize('無門。關');
    assert.equal(rawIndexFromNormalizedPos(nt, 0), 0);
    assert.equal(rawIndexFromNormalizedPos(nt, 1), 1);
    assert.equal(rawIndexFromNormalizedPos(nt, 2), 3);
});

test('rawIndexFromNormalizedPos: null normalized text returns 0', () => {
    assert.equal(rawIndexFromNormalizedPos(null, 5), 0);
});

// ---------- isCjk ----------

test('isCjk: BMP CJK Unified range only', () => {
    assert.equal(isCjk(0x4E00), true);  // 一
    assert.equal(isCjk(0x9FFF), true);
    assert.equal(isCjk(0x4DFF), false); // just below
    assert.equal(isCjk(0xA000), false); // just above
    assert.equal(isCjk(0x3400), false); // Ext-A: NOT widened per spec
    assert.equal(isCjk(0x20000), false); // Ext-B
});

// ---------- containsCjk ----------

test('containsCjk: pure ASCII returns false', () => {
    assert.equal(containsCjk('hello'), false);
});

test('containsCjk: CJK char anywhere returns true', () => {
    assert.equal(containsCjk('無hello'), true);
    assert.equal(containsCjk('hello無'), true);
    assert.equal(containsCjk('hel無lo'), true);
});

test('containsCjk: empty/null/undefined return false', () => {
    assert.equal(containsCjk(''), false);
    assert.equal(containsCjk(null), false);
    assert.equal(containsCjk(undefined), false);
});

test('containsCjk: punctuation alone is not CJK', () => {
    assert.equal(containsCjk('。、「」'), false);
});

// ---------- Surrogate pair / Ext-B (latent C# parity bug) ----------

test('normalizeString: BMP emoji surrogate pair — high surrogate kept, low stripped (parity bug)', () => {
    // 😀 U+1F600 = high D83D + low DE00. Per the C# parity bug preserved in JS,
    // every code unit in 0xDB00..0xDFFF is in the strip set, so the LOW surrogate
    // (DE00) is dropped while the high surrogate (D83D) is kept (it's < 0xDB00).
    // This test documents the latent behavior so a future C# Ext-B fix can flip
    // the assertion intentionally.
    const result = normalizeString('😀');
    assert.equal(result.length, 1, 'one orphan high surrogate remains');
    assert.equal(result.charCodeAt(0), 0xD83D, 'high surrogate (D83D) preserved');
});

test('normalizeString: Ext-B ideograph U+20000 — high surrogate kept, low stripped (parity bug)', () => {
    // U+20000 = high D840 + low DC00. Same parity bug: low surrogate stripped.
    const extB = '𠀀';
    const result = normalizeString(extB);
    assert.equal(result.length, 1);
    assert.equal(result.charCodeAt(0), 0xD840);
});

test('normalizeString: lone low surrogate alone is fully stripped', () => {
    // A bare 0xDC00 (no preceding high surrogate) is in 0xDB00..0xDFFF so dropped.
    assert.equal(normalizeString('\uDC00'), '');
    // Mid-string lone low surrogate: surrounding chars survive.
    assert.equal(normalizeString('a\uDC00b'), 'ab');
});

test('isCjk: lone surrogate code units return false', () => {
    assert.equal(isCjk(0xD800), false);
    assert.equal(isCjk(0xDC00), false);
    assert.equal(isCjk(0xDFFF), false);
});

// ---------- Long string stress (>10K chars) ----------

test('normalize: 10K-char input takes the array-buffer fast path (no concat blowup)', () => {
    // Mix of CJK + spaces. Should be fast and produce the right length.
    const block = '無門。關門'; // 5 chars; 1 stripped (period) → 4 net chars per block
    const repeat = 2500;       // 12500 input chars, 10000 output chars
    const input = block.repeat(repeat);
    const t0 = Date.now();
    const out = normalize(input);
    const ms = Date.now() - t0;
    assert.equal(out.normalized.length, 4 * repeat, `expected ${4 * repeat} got ${out.normalized.length}`);
    assert.equal(out.rawIndexByNormalizedIndex.length, 4 * repeat);
    assert.ok(ms < 500, `normalize took ${ms}ms (>500ms; perf regression?)`);
});

test('normalize: rawIndexByNormalizedIndex is monotonically increasing on long input', () => {
    const input = '無門。關門'.repeat(100); // long enough to exercise array-join branch
    const out = normalize(input);
    const map = out.rawIndexByNormalizedIndex;
    for (let i = 1; i < map.length; i++) {
        assert.ok(map[i] > map[i - 1], `non-monotonic at ${i}: ${map[i - 1]} -> ${map[i]}`);
    }
});

// ---------- Concat-vs-array threshold (length===64 boundary) ----------

test('normalize: 64-char input (concat fast path) and 65-char (array-buffer path) match', () => {
    // Build a string of exactly 64 chars and 65 chars; both must produce
    // identical normalized output relative to the input.
    const s64 = '甲乙'.repeat(32);   // length 64, all CJK, no strip
    const s65 = s64 + '丙';          // length 65
    assert.equal(s64.length, 64);
    assert.equal(s65.length, 65);
    assert.equal(normalizeString(s64), s64);
    assert.equal(normalizeString(s65), s65);
});
