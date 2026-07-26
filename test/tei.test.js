// test/tei.test.js
// Unit tests for lib/tei.js — parseTei.
//
// lib/tei.js uses the browser's DOMParser, which is not present in Node,
// so we install a minimal shim from test/_dom-shim.js BEFORE importing the
// module under test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDomShim } from './_dom-shim.js';

installDomShim();

// Import after the shim is installed.
const { parseTei, extractHeadings, dedupeAdjacentHeadings } = await import('../lib/tei.js');

const TEI_NS = 'http://www.tei-c.org/ns/1.0';

/** Wrap body content in a minimal but valid TEI envelope. */
function wrapTei(bodyInner, { titleZh = '', titleEn = '' } = {}) {
    const titles = [];
    if (titleZh) titles.push(`<title xml:lang="zh">${titleZh}</title>`);
    if (titleEn) titles.push(`<title xml:lang="en">${titleEn}</title>`);
    const titleStmt = titles.length
        ? `<titleStmt>${titles.join('')}</titleStmt>`
        : '';
    return `<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="${TEI_NS}" xmlns:xml="http://www.w3.org/XML/1998/namespace">
  <teiHeader><fileDesc>${titleStmt}</fileDesc></teiHeader>
  <text><body>${bodyInner}</body></text>
</TEI>`;
}

// ---------- Basic line parsing ----------

test('parseTei: single lb with text', () => {
    const xml = wrapTei('<p><lb n="0001a01"/>Hello world</p>');
    const parsed = parseTei(xml);
    assert.equal(parsed.lineOrder.length, 1);
    assert.equal(parsed.lineOrder[0], '0001a01');
    assert.equal(parsed.linesById.get('0001a01').text, 'Hello world');
});

test('parseTei: multiple lbs preserve order', () => {
    const xml = wrapTei(`
        <p>
            <lb n="0001a01"/>first line
            <lb n="0001a02"/>second line
            <lb n="0001a03"/>third line
        </p>
    `);
    const parsed = parseTei(xml);
    assert.deepEqual(parsed.lineOrder, ['0001a01', '0001a02', '0001a03']);
    assert.equal(parsed.linesById.get('0001a01').text, 'first line');
    assert.equal(parsed.linesById.get('0001a02').text, 'second line');
    assert.equal(parsed.linesById.get('0001a03').text, 'third line');
});

// ---------- Headings ----------

test('parseTei: <head> attaches heading with preceding lineId', () => {
    const xml = wrapTei(`
        <p>
            <lb n="0001a01"/><head>Chapter One</head>
            <lb n="0001a02"/>body text
        </p>
    `);
    const parsed = parseTei(xml);
    assert.equal(parsed.headings.length, 1);
    assert.equal(parsed.headings[0].text, 'Chapter One');
    assert.equal(parsed.headings[0].lineId, '0001a01');
});

test('extractHeadings: returns only headings array', () => {
    const xml = wrapTei(`
        <p>
            <lb n="0001a01"/><head>H1</head>
            <lb n="0001a02"/>body
            <lb n="0001a03"/><head>H2</head>
        </p>
    `);
    const headings = extractHeadings(xml);
    assert.equal(headings.length, 2);
    assert.equal(headings[0].text, 'H1');
    assert.equal(headings[1].text, 'H2');
});

// ---------- Adjacent-heading dedupe (T48n2005 duplicate preface heading) ----------

test('parseTei: collapses two consecutive identical <head> divisions', () => {
    // Mirrors T48n2005: two consecutive <cb:div type="xu"> prefaces, both headed 禪宗無門關.
    const xml = wrapTei(`
        <cb:div xmlns:cb="http://www.cbeta.org/ns/1.0" type="xu">
            <lb n="0292a25"/><cb:mulu level="1" type="序">禪宗無門關</cb:mulu><head>禪宗無門關</head>
            <lb n="0292a26"/>first preface
        </cb:div>
        <cb:div xmlns:cb="http://www.cbeta.org/ns/1.0" type="xu">
            <lb n="0292b11"/><cb:mulu level="1" type="序">禪宗無門關</cb:mulu><head>禪宗無門關</head>
            <lb n="0292b12"/>second preface
        </cb:div>
    `);
    const parsed = parseTei(xml);
    assert.equal(parsed.headings.length, 1, 'the redundant repeat is dropped');
    assert.equal(parsed.headings[0].text, '禪宗無門關');
    assert.equal(parsed.headings[0].lineId, '0292a25', 'the FIRST occurrence survives (its nav target)');
});

test('dedupeAdjacentHeadings: keeps first, drops adjacent identical, preserves distinct', () => {
    const input = [
        { lineId: 'a', text: '序', level: 1 },
        { lineId: 'b', text: '序', level: 1 },   // adjacent identical -> dropped
        { lineId: 'c', text: '正宗', level: 1 }, // distinct -> kept
        { lineId: 'd', text: '序', level: 1 },   // same text as 'a' but NOT adjacent -> kept
        { lineId: 'e', text: '序', level: 2 }    // same text, different level -> kept
    ];
    const out = dedupeAdjacentHeadings(input);
    assert.deepEqual(out.map((h) => h.lineId), ['a', 'c', 'd', 'e']);
});

test('dedupeAdjacentHeadings: whitespace-insensitive equality', () => {
    const out = dedupeAdjacentHeadings([
        { lineId: 'a', text: '禪宗 無門關', level: 1 },
        { lineId: 'b', text: '禪宗　無門關', level: 1 }
    ]);
    assert.equal(out.length, 1);
});

// ---------- Juan tracking ----------

test('parseTei: cb:juan marker sets currentJuan on subsequent headings', () => {
    const xml = wrapTei(`
        <p>
            <cb:juan xmlns:cb="http://cbeta.org/ns/1.0" n="1"/>
            <lb n="0001a01"/><head>First heading</head>
            <cb:juan xmlns:cb="http://cbeta.org/ns/1.0" n="2"/>
            <lb n="0002a01"/><head>Second heading</head>
        </p>
    `);
    const parsed = parseTei(xml);
    assert.equal(parsed.headings.length, 2);
    assert.equal(parsed.headings[0].juanNumber, 1);
    assert.equal(parsed.headings[1].juanNumber, 2);
});

test('parseTei: milestone unit="juan" tracks juan too', () => {
    const xml = wrapTei(`
        <p>
            <milestone unit="juan" n="3"/>
            <lb n="0003a01"/><head>Third</head>
        </p>
    `);
    const parsed = parseTei(xml);
    assert.equal(parsed.headings[0].juanNumber, 3);
});

// ---------- Notes ----------

test('parseTei: non-inline <note> is skipped', () => {
    const xml = wrapTei(`
        <p>
            <lb n="0001a01"/>before<note place="foot">FOOTNOTE</note>after
        </p>
    `);
    const parsed = parseTei(xml);
    const text = parsed.linesById.get('0001a01').text;
    assert.ok(!text.includes('FOOTNOTE'), `got: ${JSON.stringify(text)}`);
    assert.ok(text.includes('before'));
    assert.ok(text.includes('after'));
});

test('parseTei: inline <note> is also skipped (CBETA editorial commentary)', () => {
    const xml = wrapTei(`
        <p>
            <lb n="0001a01"/>start<note place="inline">INLINE_COMMENTARY</note>end
        </p>
    `);
    const parsed = parseTei(xml);
    const text = parsed.linesById.get('0001a01').text;
    // CBETA uses place="inline" for editorial annotations that should NOT
    // be inlined into the body text. The desktop app shows them as separate
    // annotations; the preview suppresses them entirely.
    assert.ok(!text.includes('INLINE_COMMENTARY'), `got: ${JSON.stringify(text)}`);
    assert.ok(text.includes('start'));
    assert.ok(text.includes('end'));
});

test('parseTei: <cb:mulu> is skipped (CBETA TOC marker that duplicates <head>)', () => {
    // Real CBETA structure observed in T48n2005 (Wumenguan):
    //   <lb n="0292a25"/><cb:div type="xu"><cb:mulu>禪宗無門關</cb:mulu><head>禪宗無門關</head>
    // Recursing into <cb:mulu> would double the heading text in the line.
    const xml = `<?xml version="1.0"?>
<TEI xmlns="${TEI_NS}" xmlns:cb="http://www.cbeta.org/ns/1.0">
  <teiHeader><fileDesc><titleStmt><title>x</title></titleStmt><publicationStmt/><sourceDesc><p>x</p></sourceDesc></fileDesc></teiHeader>
  <text><body>
    <p><lb n="0292a25"/><cb:div type="xu"><cb:mulu level="1" type="序">禪宗無門關</cb:mulu><head>禪宗無門關</head></cb:div></p>
  </body></text>
</TEI>`;
    const parsed = parseTei(xml);
    const text = parsed.linesById.get('0292a25').text;
    // Should appear ONCE, not twice.
    assert.equal(text, '禪宗無門關', `got: ${JSON.stringify(text)}`);
});

// ---------- Titles ----------

test('parseTei: extracts zh and en titles from titleStmt', () => {
    const xml = wrapTei(
        '<p><lb n="0001a01"/>text</p>',
        { titleZh: '佛說阿彌陀經', titleEn: 'Amitabha Sutra' }
    );
    const parsed = parseTei(xml);
    assert.equal(parsed.titleZh, '佛說阿彌陀經');
    assert.equal(parsed.titleEn, 'Amitabha Sutra');
});

test('parseTei: no titleStmt → empty titles', () => {
    // Skip the wrapper so we can build without a titleStmt at all.
    const xml = `<?xml version="1.0"?>
<TEI xmlns="${TEI_NS}">
  <text><body><p><lb n="0001a01"/>only text</p></body></text>
</TEI>`;
    const parsed = parseTei(xml);
    assert.equal(parsed.titleZh, '');
    assert.equal(parsed.titleEn, '');
});

// ---------- Error handling ----------

test('parseTei: missing <body> throws', () => {
    const xml = `<?xml version="1.0"?>
<TEI xmlns="${TEI_NS}">
  <teiHeader><fileDesc><titleStmt><title>x</title></titleStmt></fileDesc></teiHeader>
</TEI>`;
    assert.throws(() => parseTei(xml), /missing a <body>/);
});

test('parseTei: pb elements emit a spacer line and do not error', () => {
    // <pb> (page break) creates a synthetic `__pb_break_*` spacer entry in
    // lineOrder so the renderer can show a visual page break. Real CBETA
    // line-id entries are unchanged, so consumers that only care about
    // citable lines should filter spacers via the `__` prefix.
    const xml = wrapTei(`
        <p>
            <lb n="0001a01"/>text<pb n="2"/>
            <lb n="0001a02"/>more
        </p>
    `);
    const parsed = parseTei(xml);
    const realLines = parsed.lineOrder.filter(id => !id.startsWith('__'));
    assert.equal(realLines.length, 2, 'pb does not consume real lb entries');
    assert.ok(parsed.lineOrder.some(id => id.startsWith('__pb_break_')),
        'pb produces a spacer entry for the renderer');
});

test('parseTei: <g> elements contribute their text content', () => {
    const xml = wrapTei(`
        <p>
            <lb n="0001a01"/>pre<g ref="x">GLYPH</g>post
        </p>
    `);
    const parsed = parseTei(xml);
    const text = parsed.linesById.get('0001a01').text;
    assert.ok(text.includes('GLYPH'));
    assert.ok(text.includes('pre'));
    assert.ok(text.includes('post'));
});

test('parseTei: cb:jhead becomes a heading; byline collected separately', () => {
    const xml = `<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0" xmlns:cb="http://www.cbeta.org/ns/1.0">
<teiHeader><fileDesc><titleStmt><title>t</title></titleStmt></fileDesc></teiHeader>
<text><body>
<cb:jhead>無門關</cb:jhead>
<lb n="0001a01" ed="T"/><byline cb:type="Editor">宗紹編</byline>
<p><lb n="0001a02" ed="T"/>正文</p>
</body></text></TEI>`;
    const parsed = parseTei(xml);
    assert.ok(parsed.headings.some((h) => h.text.includes('無門關')), 'jhead in headings[]');
    assert.ok(Array.isArray(parsed.bylines), 'bylines array exists');
    assert.ok(parsed.bylines.some((b) => b.text.includes('宗紹編')), 'byline collected');
});
