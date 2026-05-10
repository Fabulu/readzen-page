// test/tei-license.test.js
// Coverage for the license-extraction path added in commit a861a31
// ("views: license chip in passage toolbar"). The new fields `license` and
// `licenseUrl` come out of parseTei() — extractLicense itself is private but
// exercised indirectly through the parseTei return shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDomShim } from './_dom-shim.js';

installDomShim();

const { parseTei } = await import('../lib/tei.js');

const TEI_NS = 'http://www.tei-c.org/ns/1.0';

/** Build a TEI envelope with a custom <fileDesc> body so we can drop in
 *  arbitrary <publicationStmt>/<availability> structures per test. */
function teiWithFileDesc(fileDescInner, bodyInner = '<p><lb n="0001a01"/>x</p>') {
    return `<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="${TEI_NS}" xmlns:xml="http://www.w3.org/XML/1998/namespace">
  <teiHeader><fileDesc>${fileDescInner}</fileDesc></teiHeader>
  <text><body>${bodyInner}</body></text>
</TEI>`;
}

test('parseTei: TEI without <availability> returns empty license fields', () => {
    const xml = teiWithFileDesc('<titleStmt><title xml:lang="zh">x</title></titleStmt>');
    const parsed = parseTei(xml);
    assert.equal(parsed.license, '');
    assert.equal(parsed.licenseUrl, '');
});

test('parseTei: <availability>/<licence target=""> populates label + url', () => {
    const xml = teiWithFileDesc(
        '<titleStmt><title xml:lang="zh">x</title></titleStmt>' +
        '<publicationStmt>' +
        '<availability>' +
        '<licence target="https://creativecommons.org/licenses/by-sa/4.0/">CC BY-SA 4.0</licence>' +
        '</availability>' +
        '</publicationStmt>'
    );
    const parsed = parseTei(xml);
    assert.equal(parsed.license, 'CC BY-SA 4.0');
    assert.equal(parsed.licenseUrl, 'https://creativecommons.org/licenses/by-sa/4.0/');
});

test('parseTei: <licence href=""> fallback also supported', () => {
    const xml = teiWithFileDesc(
        '<titleStmt><title xml:lang="zh">x</title></titleStmt>' +
        '<publicationStmt>' +
        '<availability>' +
        '<licence href="https://example.org/lic">Some Licence</licence>' +
        '</availability>' +
        '</publicationStmt>'
    );
    const parsed = parseTei(xml);
    assert.equal(parsed.license, 'Some Licence');
    assert.equal(parsed.licenseUrl, 'https://example.org/lic');
});

test('parseTei: bare <availability> text fallback extracts URL via regex', () => {
    // No <licence> child — just text. extractLicense's fallback path joins
    // text content and tries to mine an obvious http(s) URL.
    const xml = teiWithFileDesc(
        '<titleStmt><title xml:lang="zh">x</title></titleStmt>' +
        '<publicationStmt>' +
        '<availability status="restricted">See https://example.org/terms for details.</availability>' +
        '</publicationStmt>'
    );
    const parsed = parseTei(xml);
    assert.ok(parsed.license.includes('See'), `got: ${JSON.stringify(parsed.license)}`);
    assert.equal(parsed.licenseUrl, 'https://example.org/terms');
});

test('parseTei: empty <availability/> returns empty fields (no false positive)', () => {
    const xml = teiWithFileDesc(
        '<titleStmt><title xml:lang="zh">x</title></titleStmt>' +
        '<publicationStmt><availability/></publicationStmt>'
    );
    const parsed = parseTei(xml);
    assert.equal(parsed.license, '');
    assert.equal(parsed.licenseUrl, '');
});

test('parseTei: <licence> with text but no target returns label + empty url', () => {
    const xml = teiWithFileDesc(
        '<titleStmt><title xml:lang="zh">x</title></titleStmt>' +
        '<publicationStmt>' +
        '<availability><licence>Public Domain</licence></availability>' +
        '</publicationStmt>'
    );
    const parsed = parseTei(xml);
    assert.equal(parsed.license, 'Public Domain');
    assert.equal(parsed.licenseUrl, '');
});

test('parseTei: <licence target> with empty text returns empty label + url', () => {
    // Parser prefers an explicit <licence> child; both label and url empty
    // would mean we skip and fall through to the availability-text fallback,
    // which is also empty here, so both fields end up empty.
    const xml = teiWithFileDesc(
        '<titleStmt><title xml:lang="zh">x</title></titleStmt>' +
        '<publicationStmt>' +
        '<availability><licence target="https://example.org/lic"></licence></availability>' +
        '</publicationStmt>'
    );
    const parsed = parseTei(xml);
    // The licence child has a target but empty text — the implementation
    // returns whatever is set (label='', url='https://...'), which is fine.
    assert.equal(parsed.license, '');
    assert.equal(parsed.licenseUrl, 'https://example.org/lic');
});
