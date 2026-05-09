// test/kwic.test.js
// Unit tests for lib/kwic.js — findPassages.
//
// W3.4 parity: CJK queries must match across stripped editorial punctuation
// (e.g. query 無門關 against raw line 無門。關門) and the displayed
// `match` must preserve the raw punctuation (so highlighting visually shows
// "無門。關" with the period).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPassages } from '../lib/kwic.js';

/** Helper: build a linesById Map from a plain object of {id: text}. */
function makeLines(obj) {
    const m = new Map();
    for (const [id, text] of Object.entries(obj)) {
        m.set(id, { text });
    }
    return m;
}

// ---------- W3.4 core parity case ----------

test('findPassages: CJK query matches across editorial period (W3.4 parity)', () => {
    const lines = makeLines({ l1: '無門。關門' });
    const hits = findPassages(lines, ['l1'], '無門關');
    assert.equal(hits.length, 1, 'expected exactly one hit across the period');
    assert.equal(hits[0].lineId, 'l1');
});

test('findPassages: CJK match preserves raw punctuation in displayed match', () => {
    const lines = makeLines({ l1: '無門。關門' });
    const hits = findPassages(lines, ['l1'], '無門關');
    assert.equal(hits.length, 1);
    // Raw match span covers raw indices 0..4 (無=0, 門=1, 。=2, 關=3 → end exclusive 4)
    // so the displayed match is '無門。關', period intact.
    assert.equal(hits[0].match, '無門。關');
});

test('findPassages: CJK match left/right context come from raw text', () => {
    const lines = makeLines({ l1: '前文無門。關門後文' });
    const hits = findPassages(lines, ['l1'], '無門關');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].match, '無門。關');
    // Left = everything before the match in raw text
    assert.equal(hits[0].left, '前文');
    // Right = everything after the raw match end
    assert.equal(hits[0].right, '門後文');
});

// ---------- CJK basic exact match (no punctuation) ----------

test('findPassages: CJK exact contiguous match still works', () => {
    const lines = makeLines({ l1: '無門關' });
    const hits = findPassages(lines, ['l1'], '無門關');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].match, '無門關');
});

test('findPassages: CJK multiple occurrences in one line', () => {
    const lines = makeLines({ l1: '無門。關前後無門關末' });
    const hits = findPassages(lines, ['l1'], '無門關');
    assert.equal(hits.length, 2);
    // First crosses the period
    assert.equal(hits[0].match, '無門。關');
    // Second is contiguous
    assert.equal(hits[1].match, '無門關');
});

// ---------- Negative cases ----------

test('findPassages: empty linesById returns empty array', () => {
    const hits = findPassages(new Map(), [], '無門關');
    assert.deepEqual(hits, []);
});

test('findPassages: doc without query returns empty array', () => {
    const lines = makeLines({ l1: '別的文字沒有匹配' });
    const hits = findPassages(lines, ['l1'], '無門關');
    assert.deepEqual(hits, []);
});

test('findPassages: empty query returns empty array', () => {
    const lines = makeLines({ l1: '無門。關門' });
    const hits = findPassages(lines, ['l1'], '');
    assert.deepEqual(hits, []);
});

test('findPassages: punctuation-only CJK query (normalizes to empty) returns empty array', () => {
    const lines = makeLines({ l1: '無門。關門' });
    // 。 is in the strip set; this is technically not isCjk() per the kwic regex
    // (CJK detection looks at punctuation in the U+3000+ block), but the
    // important contract is "no infinite loop, no spurious hits".
    const hits = findPassages(lines, ['l1'], '。');
    // The kwic.js isCjk regex returns true for 。 (it's in U+3000-U+9FFF), so
    // CJK branch is taken; normTerm becomes '' and we short-circuit to [].
    assert.deepEqual(hits, []);
});

// ---------- Latin (non-CJK) branch unchanged ----------

test('findPassages: Latin case-insensitive match still works (non-CJK branch)', () => {
    const lines = makeLines({ l1: 'The Gateless Gate is famous.' });
    const hits = findPassages(lines, ['l1'], 'gateless');
    assert.equal(hits.length, 1);
    // Original casing preserved in match
    assert.equal(hits[0].match, 'Gateless');
});

test('findPassages: Latin query with no match returns empty array', () => {
    const lines = makeLines({ l1: 'The Gateless Gate' });
    const hits = findPassages(lines, ['l1'], 'koan');
    assert.deepEqual(hits, []);
});

test('findPassages: Latin query — multiple case-insensitive hits in one line', () => {
    const lines = makeLines({ l1: 'gate Gate GATE' });
    const hits = findPassages(lines, ['l1'], 'gate');
    assert.equal(hits.length, 3);
    assert.equal(hits[0].match, 'gate');
    assert.equal(hits[1].match, 'Gate');
    assert.equal(hits[2].match, 'GATE');
});

// ---------- lb range walk-back/forward (regression guard) ----------

test('findPassages: startLb/endLb walk 2 real lines back/forward', () => {
    const lines = makeLines({
        a: '前一',
        b: '前二',
        c: '無門。關門',
        d: '後一',
        e: '後二',
    });
    const hits = findPassages(lines, ['a', 'b', 'c', 'd', 'e'], '無門關');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].lineId, 'c');
    assert.equal(hits[0].startLb, 'a'); // 2 real lines back
    assert.equal(hits[0].endLb, 'e');   // 2 real lines forward
});
