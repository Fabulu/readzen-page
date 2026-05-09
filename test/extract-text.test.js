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

// ---- Additional gap-coverage tests --------------------------------------------

test('extractText: empty <body></body> returns empty text and lbAnchorMap', () => {
    const r = extractText('<TEI><text><body></body></text></TEI>');
    assert.equal(r.text, '');
    assert.deepEqual(r.lbAnchorMap, []);
});

test('extractText: whitespace-only <body> returns empty text', () => {
    const r = extractText('<TEI><text><body>   \n\t  </body></text></TEI>');
    assert.equal(r.text, '');
});

test('extractText: <lb/> with no attributes captures null lbId and null n', () => {
    const xml = wrap('a<lb/>b');
    const { text, lbAnchorMap } = extractText(xml);
    // Whitespace inserted at tag boundary; offset points after the inserted space
    assert.equal(lbAnchorMap.length, 1);
    assert.equal(lbAnchorMap[0].kind, 'lb');
    assert.equal(lbAnchorMap[0].lbId, null);
    assert.equal(lbAnchorMap[0].n, null);
    assert.equal(text.charAt(lbAnchorMap[0].off), 'b',
        `expected 'b' at offset ${lbAnchorMap[0].off} of ${JSON.stringify(text)}`);
});

test('extractText: <lb /> with internal whitespace before slash also captured', () => {
    const xml = wrap('x<lb />y');
    const { lbAnchorMap } = extractText(xml);
    assert.equal(lbAnchorMap.length, 1);
    assert.equal(lbAnchorMap[0].kind, 'lb');
});

test('extractText: nested <app> at depth 3+ all skipped (deeply nested critical apparatus)', () => {
    const xml = wrap('A<app>1<app>2<app>3<app>4</app>5</app>6</app>7</app>B');
    const { text } = extractText(xml);
    // None of the digits inside any depth of <app> should appear.
    for (const d of '1234567') {
        assert.ok(!text.includes(d), `unexpected '${d}' in: ${JSON.stringify(text)}`);
    }
    assert.ok(text.includes('A'));
    assert.ok(text.includes('B'));
});

test('extractText: 4-byte UTF-8 entity &#x1F600; decodes to emoji', () => {
    // 4-byte UTF-8 / supplementary code point. Single hex entity decodes via
    // String.fromCodePoint, producing a surrogate pair in JS.
    const xml = wrap('a&#x1F600;b');
    const { text } = extractText(xml);
    assert.ok(text.includes('😀'),
        `expected emoji surrogate pair, got ${JSON.stringify(text)}`);
});

test('extractText: 4-byte decimal entity &#128512; decodes to emoji', () => {
    const xml = wrap('a&#128512;b');
    const { text } = extractText(xml);
    assert.ok(text.includes('😀'));
});

test('extractText: out-of-range numeric entity is left intact', () => {
    // 0x110000 is one past the Unicode max; String.fromCodePoint would throw.
    // The extractor catches the error and returns the raw match unchanged.
    const xml = wrap('a&#x110000;b');
    const { text } = extractText(xml);
    assert.ok(text.includes('&#x110000;'),
        `expected raw entity preserved, got ${JSON.stringify(text)}`);
});

test('extractText: missing <body> returns empty result', () => {
    const r = extractText('<root>nope</root>');
    assert.equal(r.text, '');
    assert.deepEqual(r.lbAnchorMap, []);
});

test('extractText: unmatched <body> open without close returns empty result', () => {
    const r = extractText('<TEI><text><body>hello world');
    assert.equal(r.text, '');
});

test('extractText: deeply nested <app> with mixed lb tags inside (lb suppressed)', () => {
    // lb inside any depth of <app> must NOT be captured.
    const xml = wrap('<lb xml:id="l1"/>A<app><lb xml:id="x1"/><app><lb xml:id="x2"/></app></app>B<lb xml:id="l2"/>C');
    const { lbAnchorMap, text } = extractText(xml);
    assert.equal(lbAnchorMap.length, 2, `expected 2 anchors, got ${lbAnchorMap.length}`);
    const ids = lbAnchorMap.map(a => a.lbId);
    assert.deepEqual(ids, ['l1', 'l2']);
    assert.ok(text.includes('A'));
    assert.ok(text.includes('B'));
    assert.ok(text.includes('C'));
});

test('extractText: <pb/> and <lb/> mixed in correct order', () => {
    const xml = wrap('<pb n="1"/>X<lb n="1.1"/>Y<pb n="2"/>Z');
    const { lbAnchorMap, text } = extractText(xml);
    assert.equal(lbAnchorMap.length, 3);
    assert.equal(lbAnchorMap[0].kind, 'pb');
    assert.equal(lbAnchorMap[0].n, '1');
    assert.equal(lbAnchorMap[1].kind, 'lb');
    assert.equal(lbAnchorMap[1].n, '1.1');
    assert.equal(lbAnchorMap[2].kind, 'pb');
    assert.equal(lbAnchorMap[2].n, '2');
    // Offsets must be in ascending order.
    assert.ok(lbAnchorMap[0].off <= lbAnchorMap[1].off);
    assert.ok(lbAnchorMap[1].off <= lbAnchorMap[2].off);
});

test('extractText: <rdgGroup><app>...</app></rdgGroup> still skips <app> contents', () => {
    // rdgGroup is preserved (rdgGroup != app), but a nested <app> inside it
    // should still be skipped.
    const xml = wrap('lead<rdgGroup>kept<app>skip</app>more</rdgGroup>tail');
    const { text } = extractText(xml);
    assert.ok(text.includes('kept'));
    assert.ok(text.includes('more'));
    assert.ok(!text.includes('skip'), `text=${JSON.stringify(text)}`);
    assert.ok(text.includes('lead'));
    assert.ok(text.includes('tail'));
});

test('extractText: doubly-escaped &amp;#x4E00; decodes to literal "&#x4E00;" not 一 (single-pass)', () => {
    // Single-pass decode: '&amp;#x4E00;' -> '&#x4E00;', not '一'.
    const xml = wrap('a&amp;#x4E00;b');
    const { text } = extractText(xml);
    assert.ok(text.includes('&#x4E00;'),
        `expected literal entity after single decode pass, got ${JSON.stringify(text)}`);
    assert.ok(!text.includes('一'),
        'the hex character should NOT be resolved in a second pass');
});

test('extractText: long body with many lb tags returns sequential offsets', () => {
    // Build a synthetic body with 20 lines, verify all 20 anchors captured.
    let body = '';
    for (let i = 0; i < 20; i++) body += `<lb xml:id="l${i}"/>line${i}`;
    const xml = wrap(body);
    const { lbAnchorMap } = extractText(xml);
    assert.equal(lbAnchorMap.length, 20);
    for (let i = 0; i < 20; i++) {
        assert.equal(lbAnchorMap[i].lbId, `l${i}`);
    }
    // Strict monotonic ordering.
    for (let i = 1; i < 20; i++) {
        assert.ok(lbAnchorMap[i].off >= lbAnchorMap[i - 1].off);
    }
});
