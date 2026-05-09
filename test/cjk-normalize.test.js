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
