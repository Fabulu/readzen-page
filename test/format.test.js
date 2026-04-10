// test/format.test.js
// Unit tests for lib/format.js helpers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    escapeHtml,
    normalizeText,
    sliceLines,
    sliceFirstN
} from '../lib/format.js';

// ---------- escapeHtml ----------

test('escapeHtml: all five special chars', () => {
    assert.equal(
        escapeHtml(`<tag attr="v" alt='x'>a & b</tag>`),
        '&lt;tag attr=&quot;v&quot; alt=&#39;x&#39;&gt;a &amp; b&lt;/tag&gt;'
    );
});

test('escapeHtml: ampersand is escaped first (no double-escape)', () => {
    // The order matters: if '&' is replaced after '<', then '&lt;' becomes
    // '&amp;lt;'. The implementation escapes '&' first, so '&' alone becomes
    // '&amp;' and existing '<' becomes '&lt;' (not '&amp;lt;').
    assert.equal(escapeHtml('&'), '&amp;');
    assert.equal(escapeHtml('<'), '&lt;');
    assert.equal(escapeHtml('a & b < c'), 'a &amp; b &lt; c');
});

test('escapeHtml: null returns empty string', () => {
    assert.equal(escapeHtml(null), '');
});

test('escapeHtml: undefined returns empty string', () => {
    assert.equal(escapeHtml(undefined), '');
});

test('escapeHtml: numbers are coerced to string', () => {
    assert.equal(escapeHtml(42), '42');
});

// ---------- normalizeText ----------

test('normalizeText: trims and collapses runs of spaces', () => {
    assert.equal(normalizeText('   a    b   c   '), 'a b c');
});

test('normalizeText: strips \\r characters', () => {
    assert.equal(normalizeText('a\r\nb'), 'a\nb');
});

test('normalizeText: trims spaces around newlines', () => {
    assert.equal(normalizeText('a   \n   b'), 'a\nb');
});

test('normalizeText: null/undefined → empty string', () => {
    assert.equal(normalizeText(null), '');
    assert.equal(normalizeText(undefined), '');
});

// ---------- sliceLines ----------

function makeLines(ids) {
    const linesById = new Map();
    for (const id of ids) {
        linesById.set(id, { id, text: `text-${id}` });
    }
    return { linesById, lineOrder: ids.slice() };
}

test('sliceLines: inclusive range between two IDs', () => {
    const { linesById, lineOrder } = makeLines([
        '0001a01', '0001a02', '0001a03', '0001a04', '0001a05'
    ]);
    const out = sliceLines(linesById, lineOrder, '0001a02', '0001a04');
    assert.equal(out.length, 3);
    assert.deepEqual(out.map(l => l.id), ['0001a02', '0001a03', '0001a04']);
});

test('sliceLines: empty start and end → full range', () => {
    const { linesById, lineOrder } = makeLines(['0001a01', '0001a02', '0001a03']);
    const out = sliceLines(linesById, lineOrder, '', '');
    assert.equal(out.length, 3);
});

test('sliceLines: start given, end empty → single line from start', () => {
    const { linesById, lineOrder } = makeLines(['0001a01', '0001a02', '0001a03']);
    const out = sliceLines(linesById, lineOrder, '0001a02', '');
    // The implementation sets endIdx = startIdx when startId is present and
    // endId is empty, so this returns just the single start line.
    assert.equal(out.length, 1);
    assert.equal(out[0].id, '0001a02');
});

test('sliceLines: non-existent start throws', () => {
    const { linesById, lineOrder } = makeLines(['0001a01', '0001a02']);
    assert.throws(() => sliceLines(linesById, lineOrder, 'nope', '0001a02'));
});

test('sliceLines: non-existent end throws', () => {
    const { linesById, lineOrder } = makeLines(['0001a01', '0001a02']);
    assert.throws(() => sliceLines(linesById, lineOrder, '0001a01', 'nope'));
});

test('sliceLines: end before start throws', () => {
    const { linesById, lineOrder } = makeLines(['0001a01', '0001a02', '0001a03']);
    assert.throws(() => sliceLines(linesById, lineOrder, '0001a03', '0001a01'));
});

// ---------- sliceFirstN ----------

test('sliceFirstN: returns first N non-empty lines', () => {
    const linesById = new Map([
        ['a', { id: 'a', text: 'one' }],
        ['b', { id: 'b', text: 'two' }],
        ['c', { id: 'c', text: 'three' }],
        ['d', { id: 'd', text: 'four' }],
        ['e', { id: 'e', text: 'five' }]
    ]);
    const out = sliceFirstN(linesById, ['a', 'b', 'c', 'd', 'e'], 3);
    assert.equal(out.length, 3);
    assert.deepEqual(out.map(l => l.id), ['a', 'b', 'c']);
});

test('sliceFirstN: skips empty/whitespace lines', () => {
    const linesById = new Map([
        ['a', { id: 'a', text: '' }],
        ['b', { id: 'b', text: '   ' }],
        ['c', { id: 'c', text: 'real' }],
        ['d', { id: 'd', text: 'also real' }]
    ]);
    const out = sliceFirstN(linesById, ['a', 'b', 'c', 'd'], 2);
    assert.equal(out.length, 2);
    assert.deepEqual(out.map(l => l.id), ['c', 'd']);
});

test('sliceFirstN: n larger than available → returns all non-empty', () => {
    const linesById = new Map([
        ['a', { id: 'a', text: 'one' }],
        ['b', { id: 'b', text: 'two' }]
    ]);
    const out = sliceFirstN(linesById, ['a', 'b'], 10);
    assert.equal(out.length, 2);
});

test('sliceFirstN: n=0 returns empty', () => {
    const linesById = new Map([['a', { id: 'a', text: 'one' }]]);
    assert.equal(sliceFirstN(linesById, ['a'], 0).length, 0);
});

test('sliceFirstN: missing bucket id is skipped', () => {
    const linesById = new Map([['a', { id: 'a', text: 'one' }]]);
    // 'missing' has no entry in the map.
    const out = sliceFirstN(linesById, ['missing', 'a'], 5);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'a');
});
