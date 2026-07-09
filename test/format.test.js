// test/format.test.js
// Unit tests for lib/format.js helpers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    escapeHtml,
    normalizeText,
    sliceLines,
    sliceFirstN,
    renderLinesHtml,
    renderMergedHtml
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

test('sliceFirstN: preserves empty/whitespace lines', () => {
    const linesById = new Map([
        ['a', { id: 'a', text: '' }],
        ['b', { id: 'b', text: '   ' }],
        ['c', { id: 'c', text: 'real' }],
        ['d', { id: 'd', text: 'also real' }]
    ]);
    const out = sliceFirstN(linesById, ['a', 'b', 'c', 'd'], 4);
    assert.equal(out.length, 4);
    assert.deepEqual(out.map(l => l.id), ['a', 'b', 'c', 'd']);
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

// -- per-line copy-link markup (reading-flow feature) --

test('renderLinesHtml without opts emits no line-link button (legacy markup)', () => {
    const html = renderLinesHtml([{ id: '0001a01', text: 'x' }]);
    assert.ok(!html.includes('line-link'));
});

test('renderLinesHtml with lineLinks emits a copy button per real line', () => {
    const html = renderLinesHtml(
        [{ id: '0001a01', text: 'x' }, { id: '__lg_break_1', text: '' }],
        undefined,
        { lineLinks: true }
    );
    assert.ok(html.includes('class="line-link"'));
    assert.ok(html.includes('data-link-id="0001a01"'));
    // spacer rows get no button
    assert.strictEqual((html.match(/line-link/g) || []).length, 1);
});

// -- renderMergedHtml (merged reading layouts) --

const M_LINES = [
    { id: 'a1', text: '甲甲' }, { id: 'a2', text: '乙乙' },   // segment U1 (dialogue)
    { id: '__pb_break_1', text: '' },                          // spacer - skipped
    { id: 'b1', text: '丙丙' },                                // segment U2 (verse)
];
const M_TRN = [
    { id: 'a1', text: 'first line' }, { id: 'a2', text: 'second line' },
    { id: '__pb_break_1', text: '' },
    { id: 'b1', text: '' },                                    // untranslated
];
const M_MAP = new Map([
    ['a1', { unitId: 'U1', type: 'dialogue' }],
    ['a2', { unitId: 'U1', type: 'dialogue' }],
    ['b1', { unitId: 'U2', type: 'verse' }],
]);

test('renderMergedHtml groups consecutive lines by segment unit', () => {
    const html = renderMergedHtml(M_LINES, M_MAP, null, { side: 'zh' });
    assert.strictEqual((html.match(/class="merged-seg/g) || []).length, 2);
    assert.ok(html.includes('merged-seg--dialogue'));
    assert.ok(html.includes('merged-seg--verse'));
    // both lines of U1 live in ONE paragraph, healed across the woodblock cut
    const firstPara = html.split('</p>')[0];
    assert.ok(firstPara.includes('甲甲') && firstPara.includes('乙乙'));
});

test('renderMergedHtml keeps per-line anchors as inline line-text spans', () => {
    const html = renderMergedHtml(M_LINES, M_MAP, null, { side: 'zh' });
    for (const id of ['a1', 'a2', 'b1']) {
        assert.ok(html.includes('data-line-id="' + id + '"'), id);
    }
    assert.ok(html.includes('<span class="line-text"')); // highlight machinery target
    assert.ok(!html.includes('__pb_break'));             // spacers dropped
});

test('renderMergedHtml stacked emits ZH then EN paragraphs per segment', () => {
    const html = renderMergedHtml(M_LINES, M_MAP, M_TRN, { stacked: true });
    assert.ok(html.indexOf('merged-text--zh') < html.indexOf('merged-text--en'));
    assert.ok(html.includes('first line second line') || (html.includes('first line') && html.includes('second line')));
});

test('renderMergedHtml en side marks untranslated segments', () => {
    const html = renderMergedHtml(M_LINES, M_MAP, M_TRN, { side: 'en' });
    assert.ok(html.includes('merged-text--missing')); // U2 has no EN
});

test('renderMergedHtml escapes text and sanitizes type classes', () => {
    const lines = [{ id: 'x1', text: '<b>evil</b>' }];
    const map = new Map([['x1', { unitId: 'U9', type: 'bad"type<' }]]);
    const html = renderMergedHtml(lines, map, null, { side: 'zh' });
    assert.ok(!html.includes('<b>evil</b>'));
    assert.ok(html.includes('merged-seg--badtype'));
});
