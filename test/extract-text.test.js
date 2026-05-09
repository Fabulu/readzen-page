// test/extract-text.test.js
// Unit tests for lib/build/extract-text.js. Targets the five SYNTHESIS-§2
// bug fixes vs the previous SPA TEI extractor.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractText } from '../lib/build/extract-text.js';

function wrap(body) {
    return `<TEI><text><body>${body}</body></text></TEI>`;
}

// ---- Bug fix 1: skip whole <app>...</app> ----------------------------------

test('extractText: <app>...</app> excludes BOTH <lem> and <rdg> contents', () => {
    const xml = wrap('A<app><lem>foo</lem><rdg>bar</rdg></app>B');
    const { text } = extractText(xml);
    assert.ok(!text.includes('foo'), `expected no 'foo' in: ${JSON.stringify(text)}`);
    assert.ok(!text.includes('bar'), `expected no 'bar' in: ${JSON.stringify(text)}`);
    // The non-app content must still be present.
    assert.ok(text.includes('A'), `expected 'A' in: ${JSON.stringify(text)}`);
    assert.ok(text.includes('B'), `expected 'B' in: ${JSON.stringify(text)}`);
});

test('extractText: nested <app> handled via depth counter', () => {
    const xml = wrap('X<app>1<app>2</app>3</app>Y');
    const { text } = extractText(xml);
    assert.ok(!text.includes('1'));
    assert.ok(!text.includes('2'));
    assert.ok(!text.includes('3'));
    assert.ok(text.includes('X'));
    assert.ok(text.includes('Y'));
});

// ---- Bug fix 2: self-close depth fix ---------------------------------------

test('extractText: self-close <rdg type="x"/> does not leak depth', () => {
    const xml = wrap('before<rdg type="x"/>after');
    const { text } = extractText(xml);
    // Both 'before' and 'after' must be present — self-close must not enter
    // a "skip mode" that would swallow 'after'.
    assert.ok(text.includes('before'), `text=${JSON.stringify(text)}`);
    assert.ok(text.includes('after'), `text=${JSON.stringify(text)}`);
});

test('extractText: self-close <app type="x"/> is a no-op (does not skip following text)', () => {
    const xml = wrap('alpha<app type="x"/>beta');
    const { text } = extractText(xml);
    assert.ok(text.includes('alpha'));
    assert.ok(text.includes('beta'));
});

// ---- Bug fix 3: entity decode ----------------------------------------------

test('extractText: hex numeric entity &#x4E00; decodes to 一', () => {
    const xml = wrap('a&#x4E00;b');
    const { text } = extractText(xml);
    assert.ok(text.includes('一'), `text=${JSON.stringify(text)}`);
});

test('extractText: decimal numeric entity &#38; decodes to &', () => {
    const xml = wrap('x&#38;y');
    const { text } = extractText(xml);
    assert.ok(text.includes('&'), `text=${JSON.stringify(text)}`);
    assert.ok(text.includes('x'));
    assert.ok(text.includes('y'));
});

test('extractText: named entity &amp; decodes to &', () => {
    const xml = wrap('p&amp;q');
    const { text } = extractText(xml);
    // Single-pass decode: '&amp;' -> '&'.
    assert.ok(text.includes('&'));
    // Defensive: ensure no leftover 'amp;' after the ampersand.
    assert.ok(!/&amp;/.test(text), `text=${JSON.stringify(text)}`);
});

test('extractText: doubly-escaped &amp;amp; decodes to &amp; (single-pass parity with C# HtmlDecode)', () => {
    const xml = wrap('one&amp;amp;two');
    const { text } = extractText(xml);
    // Single-pass: '&amp;amp;' -> '&amp;'. (Iterating to fixed point would
    // give '&', but C# WebUtility.HtmlDecode is single-pass; we mirror that.)
    assert.ok(text.includes('&amp;'), `text=${JSON.stringify(text)}`);
});

test('extractText: skips decoding when decodeEntities=false', () => {
    const xml = wrap('p&amp;q');
    const { text } = extractText(xml, { decodeEntities: false });
    assert.ok(text.includes('&amp;'), `text=${JSON.stringify(text)}`);
});

test('extractText: skips decode pass entirely when no & present (sawAmp=false)', () => {
    // Smoke: text without any & should still come out clean and unchanged
    // (regex post-pass is short-circuited).
    const xml = wrap('plain text only');
    const { text } = extractText(xml);
    assert.equal(text, 'plain text only');
});

// ---- Bug fix 4: lb / pb anchor capture --------------------------------------

test('extractText: 3 <lb xml:id="lN"/> tags produce 3 lbAnchorMap entries', () => {
    const xml = wrap('<lb xml:id="l1"/>aa<lb xml:id="l2"/>bb<lb xml:id="l3"/>cc');
    const { text, lbAnchorMap } = extractText(xml);
    assert.equal(lbAnchorMap.length, 3, `got ${lbAnchorMap.length} anchors`);
    assert.equal(lbAnchorMap[0].lbId, 'l1');
    assert.equal(lbAnchorMap[1].lbId, 'l2');
    assert.equal(lbAnchorMap[2].lbId, 'l3');
    assert.equal(lbAnchorMap[0].kind, 'lb');
    // Offsets must point at the start of each line's text.
    assert.equal(text.slice(lbAnchorMap[0].off, lbAnchorMap[0].off + 2), 'aa',
        `text=${JSON.stringify(text)}, off=${lbAnchorMap[0].off}`);
    assert.equal(text.slice(lbAnchorMap[1].off, lbAnchorMap[1].off + 2), 'bb');
    assert.equal(text.slice(lbAnchorMap[2].off, lbAnchorMap[2].off + 2), 'cc');
});

test('extractText: <lb n="3a"/> captures n attribute', () => {
    const xml = wrap('<lb n="3a"/>hello');
    const { lbAnchorMap } = extractText(xml);
    assert.equal(lbAnchorMap.length, 1);
    assert.equal(lbAnchorMap[0].n, '3a');
    assert.equal(lbAnchorMap[0].lbId, null); // no xml:id present
});

test('extractText: <pb/> captured as kind="pb"', () => {
    const xml = wrap('<pb n="2"/>page two');
    const { lbAnchorMap } = extractText(xml);
    assert.equal(lbAnchorMap.length, 1);
    assert.equal(lbAnchorMap[0].kind, 'pb');
    assert.equal(lbAnchorMap[0].n, '2');
});

test('extractText: lb inside <app> is NOT recorded', () => {
    const xml = wrap('A<app><lb xml:id="ignored"/>x</app>B');
    const { lbAnchorMap } = extractText(xml);
    assert.equal(lbAnchorMap.length, 0);
});

test('extractText: captureLb=false suppresses lbAnchorMap entries', () => {
    const xml = wrap('<lb xml:id="l1"/>aa<lb xml:id="l2"/>bb');
    const { lbAnchorMap } = extractText(xml, { captureLb: false });
    assert.equal(lbAnchorMap.length, 0);
});

// ---- Bug fix 5: hot-path tag-name parsing (<rdgGroup> regression) ----------

test('extractText: <rdgGroup>...</rdgGroup> does NOT trigger app/rdg skip (regression case)', () => {
    // Previous extractor used /^rdg[\s>\/]/ which matched 'rdgGroup>'.
    // We now strict-equal the tag name; rdgGroup is unrelated to <app> skip.
    const xml = wrap('lead<rdgGroup>kept</rdgGroup>tail');
    const { text } = extractText(xml);
    assert.ok(text.includes('kept'),
        `expected 'kept' (rdgGroup content) in: ${JSON.stringify(text)}`);
    assert.ok(text.includes('lead'));
    assert.ok(text.includes('tail'));
});

test('extractText: bare <rdg>...</rdg> outside <app> is NOT skipped (only <app> blocks skip)', () => {
    // The desktop port is <app>-scoped, not <rdg>-scoped. A loose <rdg>
    // (rare in practice) should still be emitted.
    const xml = wrap('p<rdg>kept</rdg>q');
    const { text } = extractText(xml);
    assert.ok(text.includes('kept'),
        `text=${JSON.stringify(text)}`);
});

// ---- General hygiene -------------------------------------------------------

test('extractText: returns empty for input without <body>', () => {
    const r = extractText('<TEI><teiHeader/></TEI>');
    assert.equal(r.text, '');
    assert.deepEqual(r.lbAnchorMap, []);
});

test('extractText: returns empty for null/empty input', () => {
    assert.deepEqual(extractText(''), { text: '', lbAnchorMap: [] });
    assert.deepEqual(extractText(null), { text: '', lbAnchorMap: [] });
    assert.deepEqual(extractText(undefined), { text: '', lbAnchorMap: [] });
});

test('extractText: collapses whitespace and trims trailing space', () => {
    const xml = wrap('  hello   world  ');
    const { text } = extractText(xml);
    assert.equal(text, 'hello world');
});

test('extractText: case-insensitive <BODY> tag matches', () => {
    const xml = '<TEI><text><BODY>upper</BODY></text></TEI>';
    const { text } = extractText(xml);
    assert.equal(text, 'upper');
});

test('extractText: drops \\r and treats \\n / \\t / \\f / \\v as whitespace', () => {
    const xml = wrap('a\r\nb\tc\fd\ve');
    const { text } = extractText(xml);
    assert.equal(text, 'a b c d e');
});
