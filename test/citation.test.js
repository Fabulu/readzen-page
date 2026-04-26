// test/citation.test.js
// Unit tests for lib/citation.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CITE_STYLES, buildCitation } from '../lib/citation.js';

// ---------------------------------------------------------------------------
// CITE_STYLES
// ---------------------------------------------------------------------------

test('CITE_STYLES contains all expected style keys', () => {
    assert.deepEqual(CITE_STYLES, ['Chicago', 'APA', 'MLA', 'BibTeX', 'CBETA']);
});

// ---------------------------------------------------------------------------
// buildCitation – Chicago
// ---------------------------------------------------------------------------

test('buildCitation Chicago: wraps title in curly quotes and includes workId + URL', () => {
    const out = buildCitation('Chicago', 'Gateless Barrier', 'T48n2005', 'https://readzen.pages.dev/#/T48n2005');
    assert.ok(out.startsWith('\u201cGateless Barrier.\u201d'), 'should open with left double quotation mark');
    assert.ok(out.includes('CBETA T48n2005'), 'should include workId');
    assert.ok(out.includes('ReadZen'), 'should mention ReadZen');
    assert.ok(out.includes('https://readzen.pages.dev/#/T48n2005'), 'should include URL');
    assert.ok(out.endsWith('.'), 'should end with period');
});

// ---------------------------------------------------------------------------
// buildCitation – APA
// ---------------------------------------------------------------------------

test('buildCitation APA: title followed by (workId) and URL', () => {
    const out = buildCitation('APA', 'Gateless Barrier', 'T48n2005', 'https://readzen.pages.dev/#/T48n2005');
    assert.ok(out.startsWith('Gateless Barrier (T48n2005)'), 'should start with title and parenthesised workId');
    assert.ok(out.includes('Retrieved from'), 'should include "Retrieved from"');
    assert.ok(out.includes('https://readzen.pages.dev/#/T48n2005'), 'should include URL');
});

// ---------------------------------------------------------------------------
// buildCitation – MLA
// ---------------------------------------------------------------------------

test('buildCitation MLA: curly-quoted title, ReadZen, URL, and access date', () => {
    const out = buildCitation('MLA', 'Gateless Barrier', 'T48n2005', 'https://readzen.pages.dev/#/T48n2005');
    assert.ok(out.startsWith('\u201cGateless Barrier.\u201d'), 'should open with left double quotation mark');
    assert.ok(out.includes('ReadZen'), 'should mention ReadZen');
    assert.ok(out.includes('https://readzen.pages.dev/#/T48n2005'), 'should include URL');
    assert.ok(out.includes('Accessed'), 'should include access date label');
});

// ---------------------------------------------------------------------------
// buildCitation – BibTeX
// ---------------------------------------------------------------------------

test('buildCitation BibTeX: entry key, title field, howpublished field, note field', () => {
    const out = buildCitation('BibTeX', 'Gateless Barrier', 'T48n2005', 'https://readzen.pages.dev/#/T48n2005');
    assert.ok(out.startsWith('@misc{readzen:T48n2005,'), 'should start with @misc entry keyed by workId');
    assert.ok(out.includes('title        = {Gateless Barrier}'), 'should include title field');
    assert.ok(out.includes('howpublished = {https://readzen.pages.dev/#/T48n2005}'), 'should include URL field');
    assert.ok(out.includes('note         = {CBETA T48n2005}'), 'should include note field with workId');
    assert.ok(out.endsWith('}'), 'should close with }');
});

// ---------------------------------------------------------------------------
// buildCitation – CBETA
// ---------------------------------------------------------------------------

test('buildCitation CBETA: returns the workId verbatim', () => {
    const out = buildCitation('CBETA', 'Gateless Barrier', 'T48n2005', 'https://readzen.pages.dev/#/T48n2005');
    assert.equal(out, 'T48n2005');
});

// ---------------------------------------------------------------------------
// buildCitation – unknown style
// ---------------------------------------------------------------------------

test('buildCitation unknown style: returns empty string', () => {
    const out = buildCitation('Harvard', 'Any', 'X01n0001', 'https://example.com');
    assert.equal(out, '');
});

// ---------------------------------------------------------------------------
// buildCitation – special characters in title / workId
// ---------------------------------------------------------------------------

test('buildCitation Chicago: special chars in title are not HTML-escaped (plain text)', () => {
    const out = buildCitation('Chicago', 'A & B <test>', 'WS01n0001', 'https://readzen.pages.dev/#/WS01n0001');
    // buildCitation returns plain text — HTML escaping is the caller's responsibility.
    assert.ok(out.includes('A & B <test>'), 'should preserve raw special characters');
});
