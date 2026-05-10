// test/aligned-translation.test.js
// Coverage for the bilingual aligned-KWIC path added in commit a31fb4e
// ("search: bilingual aligned KWIC on group expand").
//
// Targets `loadAndSearchXml(fileId, term, opts)` in lib/search.js:
//   - opts.includeTranslation:false (default) -> result has NO translatedPassages.
//   - opts.includeTranslation:true           -> result has translatedPassages: Map<startLb,enText>.
// The internal helper `buildAlignedTranslation` walks lineOrder skipping
// synthetic IDs (`__lg_break_*` etc.) and joins matching real-line text.
//
// Strategy: install the DOM shim (parseTei needs DOMParser), mock globalThis.fetch
// to serve TEI XML for both source and authoritative-translation URLs, then call
// loadAndSearchXml with a 5-line CN source whose query hits line 3 and a 5-line
// EN translation aligned on the same lb IDs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDomShim } from './_dom-shim.js';

installDomShim();

import * as cache from '../lib/cache.js';
const { loadAndSearchXml } = await import('../lib/search.js');
const { sourceXmlUrl, authoritativeTranslationUrl } = await import('../lib/github.js');

const TEI_NS = 'http://www.tei-c.org/ns/1.0';

/** Build a TEI XML envelope from an array of {id, text} lines.
 *  Each line becomes a `<lb n="ID"/>TEXT` pair under a single <p>. */
function teiFromLines(lines, { titleZh = '', titleEn = '' } = {}) {
    const titles = [];
    if (titleZh) titles.push(`<title xml:lang="zh">${titleZh}</title>`);
    if (titleEn) titles.push(`<title xml:lang="en">${titleEn}</title>`);
    const titleStmt = `<titleStmt>${titles.join('')}</titleStmt>`;
    const inner = lines.map((l) => `<lb n="${l.id}"/>${l.text}`).join('');
    return `<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="${TEI_NS}" xmlns:xml="http://www.w3.org/XML/1998/namespace">
  <teiHeader><fileDesc>${titleStmt}</fileDesc></teiHeader>
  <text><body><p>${inner}</p></body></text>
</TEI>`;
}

/** Install a fetch mock keyed by URL. Returns {restore, calls}. */
function installUrlFetchMock(urlMap) {
    const calls = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url) => {
        calls.push(String(url));
        const u = String(url);
        if (Object.prototype.hasOwnProperty.call(urlMap, u)) {
            return new Response(urlMap[u], { status: 200 });
        }
        return new Response(null, { status: 404 });
    };
    return {
        calls,
        restore() { globalThis.fetch = original; }
    };
}

// Use a CBETA file ID so source/translation URL resolution succeeds.
const FILE_ID = 'T48n2005';

test('loadAndSearchXml: default opts return NO translatedPassages field', async () => {
    cache.clear();
    const sourceXml = teiFromLines([
        { id: '0001a01', text: '無門' },
        { id: '0001a02', text: '禪宗無門關' },
        { id: '0001a03', text: '尾段' }
    ]);
    const srcUrl = sourceXmlUrl(FILE_ID);
    const mock = installUrlFetchMock({ [srcUrl]: sourceXml });
    try {
        const result = await loadAndSearchXml(FILE_ID, '無門關');
        assert.ok(result.passages.length > 0, 'expected at least one passage');
        assert.ok(!('translatedPassages' in result),
            'default call must NOT include translatedPassages');
    } finally {
        mock.restore();
    }
});

test('loadAndSearchXml: opts.includeTranslation=true adds translatedPassages Map keyed by startLb', async () => {
    cache.clear();
    // 5-line source where the query hits line 3.
    const sourceXml = teiFromLines([
        { id: '0001a01', text: '甲' },
        { id: '0001a02', text: '乙' },
        { id: '0001a03', text: '無門關' },   // <- match line
        { id: '0001a04', text: '丁' },
        { id: '0001a05', text: '戊' }
    ]);
    // 5-line translation with the same lb IDs.
    const transXml = teiFromLines([
        { id: '0001a01', text: 'one' },
        { id: '0001a02', text: 'two' },
        { id: '0001a03', text: 'three' },
        { id: '0001a04', text: 'four' },
        { id: '0001a05', text: 'five' }
    ]);
    const srcUrl = sourceXmlUrl(FILE_ID);
    const trUrl  = authoritativeTranslationUrl(FILE_ID);
    const mock = installUrlFetchMock({ [srcUrl]: sourceXml, [trUrl]: transXml });
    try {
        const result = await loadAndSearchXml(FILE_ID, '無門關', { includeTranslation: true });
        assert.equal(result.passages.length, 1, 'one passage match for 無門關');
        assert.ok(result.translatedPassages instanceof Map, 'translatedPassages must be a Map');
        assert.equal(result.translatedPassages.size, 1);
        // findPassages walks 2 real lines back/forward from the match line, so
        // for a 5-line doc with the match at index 2 (0-based), the lb range
        // is 0001a01..0001a05 — the aligned EN should join all 5 EN lines.
        const passage = result.passages[0];
        const aligned = result.translatedPassages.get(passage.startLb);
        assert.ok(aligned, 'aligned text must exist for startLb');
        // Should include the EN line that aligns with the match line at minimum.
        assert.ok(aligned.includes('three'), `expected 'three' in aligned EN: ${JSON.stringify(aligned)}`);
    } finally {
        mock.restore();
    }
});

test('loadAndSearchXml: includeTranslation=true with no match returns empty Map (no translation fetch)', async () => {
    cache.clear();
    const sourceXml = teiFromLines([
        { id: '0001a01', text: '甲' },
        { id: '0001a02', text: '乙' }
    ]);
    const srcUrl = sourceXmlUrl(FILE_ID);
    const trUrl  = authoritativeTranslationUrl(FILE_ID);
    const mock = installUrlFetchMock({ [srcUrl]: sourceXml });
    try {
        const result = await loadAndSearchXml(FILE_ID, '無門關', { includeTranslation: true });
        assert.equal(result.passages.length, 0);
        // When passages.length === 0, buildAlignedTranslation is not called,
        // so translatedPassages stays absent on the result object.
        assert.ok(!('translatedPassages' in result),
            'no translation fetch when there are no passages to align');
        const trCalls = mock.calls.filter((u) => u === trUrl);
        assert.equal(trCalls.length, 0, 'no fetch to translation URL when no passages');
    } finally {
        mock.restore();
    }
});

test('loadAndSearchXml: translation 404 returns empty Map (graceful fallback)', async () => {
    cache.clear();
    const sourceXml = teiFromLines([
        { id: '0001a01', text: '甲' },
        { id: '0001a02', text: '無門關' },
        { id: '0001a03', text: '丙' }
    ]);
    const srcUrl = sourceXmlUrl(FILE_ID);
    // Only mock the source, not the translation — translation URL will 404.
    const mock = installUrlFetchMock({ [srcUrl]: sourceXml });
    try {
        const result = await loadAndSearchXml(FILE_ID, '無門關', { includeTranslation: true });
        assert.ok(result.passages.length > 0);
        assert.ok(result.translatedPassages instanceof Map);
        assert.equal(result.translatedPassages.size, 0,
            'translation 404 yields empty Map, not a thrown error');
    } finally {
        mock.restore();
    }
});

test('loadAndSearchXml: translation lb IDs that do not match source range are skipped', async () => {
    cache.clear();
    // Source has lb IDs a01..a05; translation has different IDs that don't overlap.
    const sourceXml = teiFromLines([
        { id: '0001a01', text: '甲' },
        { id: '0001a02', text: '乙' },
        { id: '0001a03', text: '無門關' },
        { id: '0001a04', text: '丁' },
        { id: '0001a05', text: '戊' }
    ]);
    const transXml = teiFromLines([
        { id: '9999z99', text: 'unrelated' }
    ]);
    const srcUrl = sourceXmlUrl(FILE_ID);
    const trUrl  = authoritativeTranslationUrl(FILE_ID);
    const mock = installUrlFetchMock({ [srcUrl]: sourceXml, [trUrl]: transXml });
    try {
        const result = await loadAndSearchXml(FILE_ID, '無門關', { includeTranslation: true });
        assert.equal(result.passages.length, 1);
        assert.ok(result.translatedPassages instanceof Map);
        // No source-side lb matches a translation lb — Map is empty.
        assert.equal(result.translatedPassages.size, 0,
            'no overlapping lb IDs -> empty alignment Map');
    } finally {
        mock.restore();
    }
});

test('loadAndSearchXml: synthetic translation IDs (__lg_break_*) are skipped during alignment walk', async () => {
    cache.clear();
    // Source lines a01..a05 with match on a03.
    const sourceXml = teiFromLines([
        { id: '0001a01', text: '甲' },
        { id: '0001a02', text: '乙' },
        { id: '0001a03', text: '無門關' },
        { id: '0001a04', text: '丁' },
        { id: '0001a05', text: '戊' }
    ]);
    // Translation TEI with an <lg> verse group between a02 and a04 — that
    // injects __lg_break_N synthetic IDs into the translation lineOrder.
    // The alignment walk must skip them silently while still picking up the
    // real "three" text bucket for a03.
    const transXml = `<?xml version="1.0"?>
<TEI xmlns="${TEI_NS}" xmlns:xml="http://www.w3.org/XML/1998/namespace">
  <teiHeader><fileDesc><titleStmt><title>x</title></titleStmt></fileDesc></teiHeader>
  <text><body><p>
    <lb n="0001a01"/>one
    <lb n="0001a02"/>two
    <lg><lb n="0001a03"/>three</lg>
    <lb n="0001a04"/>four
    <lb n="0001a05"/>five
  </p></body></text>
</TEI>`;
    const srcUrl = sourceXmlUrl(FILE_ID);
    const trUrl  = authoritativeTranslationUrl(FILE_ID);
    const mock = installUrlFetchMock({ [srcUrl]: sourceXml, [trUrl]: transXml });
    try {
        const result = await loadAndSearchXml(FILE_ID, '無門關', { includeTranslation: true });
        assert.equal(result.passages.length, 1);
        const passage = result.passages[0];
        const aligned = result.translatedPassages.get(passage.startLb);
        assert.ok(aligned, 'aligned text must exist');
        // The synthetic __lg_break_* IDs must NOT appear in the joined text.
        assert.ok(!aligned.includes('__lg_break'),
            `synthetic IDs leaked: ${JSON.stringify(aligned)}`);
        assert.ok(aligned.includes('three'),
            `expected 'three' in aligned EN: ${JSON.stringify(aligned)}`);
    } finally {
        mock.restore();
    }
});
