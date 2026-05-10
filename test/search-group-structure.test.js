// test/search-group-structure.test.js
// Structural source-level checks for the search-result density v2 layout
// (commit 3772bc5: "style: search-result density v2") and the bilingual KWIC
// row added in commit a31fb4e. The relevant builders (buildSearchGroup,
// buildKwicRow) live inside views/search.js#render as closures and are not
// exported, so we cannot exercise them via DOM. Instead we lock in the
// structural invariants by asserting on the source string of views/search.js.
//
// These tests are intentionally lightweight — a refactor that preserves the
// 3-child summary contract and the bilingual layout will keep them green.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SEARCH_VIEW_SRC = readFileSync(
    fileURLToPath(new URL('../views/search.js', import.meta.url)),
    'utf8'
);

test('buildSearchGroup: <summary> contains exactly 3 grid children (idCell + title + meta)', () => {
    // Locate the `<summary>` block emitted by buildSearchGroup. It opens with
    // "'<summary>' +" and closes with "'</summary>' +". Count the top-level
    // children that the template appends inside it. The 3 expected children are:
    //   1. idCell (var holding row-id-cell <span>)
    //   2. '<span class="search-group-title">' ... '</span>'
    //   3. '<span class="search-group-meta">' ... '</span>'
    const summaryStart = SEARCH_VIEW_SRC.indexOf("'<summary>'");
    assert.ok(summaryStart > 0, 'buildSearchGroup must emit a <summary> open tag');
    const summaryEnd = SEARCH_VIEW_SRC.indexOf("'</summary>'", summaryStart);
    assert.ok(summaryEnd > summaryStart, 'buildSearchGroup must close </summary>');
    const summaryBlock = SEARCH_VIEW_SRC.slice(summaryStart, summaryEnd);

    // Count concatenated children. Child 1 is referenced by name (`idCell`),
    // children 2-3 are inline span literals — assert each is present exactly once.
    const idCellRefs = (summaryBlock.match(/\bidCell\b/g) || []).length;
    assert.equal(idCellRefs, 1, 'idCell concatenated exactly once inside <summary>');

    const titleSpans = (summaryBlock.match(/'<span class="search-group-title">'/g) || []).length;
    assert.equal(titleSpans, 1, 'exactly one search-group-title span');

    const metaSpans = (summaryBlock.match(/'<span class="search-group-meta">'/g) || []).length;
    assert.equal(metaSpans, 1, 'exactly one search-group-meta span');

    // Density v2 regression guard: the summary must NOT contain a search-row-badge
    // span as a direct sibling of idCell — the side badge was collapsed INTO idCell.
    // (Locate any standalone badge token outside the idCell var.)
    const sideBadgeAtTopLevel = summaryBlock.match(
        /'<span class="search-row-badge search-row-badge--side">/g
    );
    // Allowed: 0 occurrences inside the summary block proper. The one inside
    // `idCell`'s definition lives BEFORE summaryStart in the file, so it should
    // not appear here.
    if (sideBadgeAtTopLevel && sideBadgeAtTopLevel.length > 0) {
        assert.fail('density v2: side badge must live inside idCell, not as a top-level summary child');
    }
});

test('buildSearchGroup: idCell wraps row-id + side-badge into one cell', () => {
    // The collapse fix: row-id-cell must contain BOTH .search-row-id and
    // .search-row-badge--side. Look up the idCell definition.
    const idCellDef = SEARCH_VIEW_SRC.match(
        /var idCell =\s*\n\s*'<span class="search-row-id-cell">'\s*\+[\s\S]*?'<\/span>';/
    );
    assert.ok(idCellDef, 'idCell definition must use <span class="search-row-id-cell"> wrapper');
    const block = idCellDef[0];
    assert.ok(block.includes('search-row-id'), 'idCell wraps the file-id pill');
    assert.ok(block.includes('search-row-badge--side'), 'idCell wraps the side badge');
});

test('buildKwicRow: bilingual row renders two grid rows (CN label + EN label)', () => {
    // Lock in the bilingual two-row layout from commit a31fb4e. The bilingual
    // branch must emit BOTH a kwic-side-label--cn span AND a kwic-side-label--en span
    // inside the same .kwic-row link. Multiple occurrences are allowed (one
    // bilingual branch per state: aligned EN, missing-EN hint).
    const cnLabels = SEARCH_VIEW_SRC.match(/kwic-side-label--cn/g) || [];
    const enLabels = SEARCH_VIEW_SRC.match(/kwic-side-label--en/g) || [];
    assert.ok(cnLabels.length >= 1, 'at least one kwic-side-label--cn template');
    assert.ok(enLabels.length >= 1, 'at least one kwic-side-label--en template');
    assert.equal(cnLabels.length, enLabels.length,
        'CN and EN labels balanced across all bilingual branches');

    // The bilingual <a> wrapper should declare both .kwic-row and .kwic-row--bilingual.
    assert.ok(
        SEARCH_VIEW_SRC.includes('class="kwic-row kwic-row--bilingual"'),
        'bilingual row uses combined class names so monolingual styling still applies'
    );
});

test('wireGroupExpanders: bilingual gated by side==="" AND translatedIds.has(fileId)', () => {
    // The gate logic was specified in commit a31fb4e; assert both halves are present.
    assert.ok(
        SEARCH_VIEW_SRC.includes('var bilingual = !sideAttr && translatedIds && translatedIds.has(fileId);'),
        'bilingual gating must check sideAttr empty AND translatedIds.has(fileId)'
    );
    assert.ok(
        SEARCH_VIEW_SRC.includes('includeTranslation: bilingual'),
        'loadAndSearchXml call must pass includeTranslation flag'
    );
});

test('"(no translation aligned)" hint emitted when bilingual requested but Map is empty', () => {
    // The fallback hint from commit a31fb4e — used when the user is on a
    // source-side hit, the file is in translatedIds, but no lb in the source
    // range matched a translation line.
    assert.ok(
        SEARCH_VIEW_SRC.includes('(no translation aligned)'),
        'bilingual fallback hint string must be present'
    );
    assert.ok(
        SEARCH_VIEW_SRC.includes('kwic-no-alignment'),
        'fallback hint uses .kwic-no-alignment class'
    );
});

test('auto-expand: doSearch resets _autoExpandedThisQuery flag at top of every call', () => {
    // Commit 79a4489: re-streaming during incremental updates must NOT reopen
    // what the user just manually closed. The reset must happen before the
    // empty-query early return so a new search always re-arms the flag.
    const doSearchBlock = SEARCH_VIEW_SRC.match(
        /async function doSearch\([^)]*\)\s*\{[\s\S]*?\}\s*\n\s*\n/
    );
    assert.ok(doSearchBlock, 'doSearch function body must be locatable');
    const body = doSearchBlock[0];
    assert.ok(body.includes('_autoExpandedThisQuery = false'),
        'doSearch must reset _autoExpandedThisQuery');
    // The reset must come before the empty-query early return.
    const resetIdx = body.indexOf('_autoExpandedThisQuery = false');
    const earlyReturnIdx = body.indexOf('doBrowseAll(page);');
    assert.ok(resetIdx < earlyReturnIdx,
        'flag must reset BEFORE the empty-query early return');
});

test('maybeAutoExpandFirstGroup: gates on _autoExpandedThisQuery and sets attribute (not property)', () => {
    // Commit 79a4489: setting `open` via setAttribute is what fires the native
    // toggle event, which the existing wireGroupExpanders handler picks up.
    // Setting it as a JS property would NOT fire the toggle, so the
    // setAttribute call is load-bearing.
    assert.ok(
        SEARCH_VIEW_SRC.includes("first.setAttribute('open', '')"),
        'must use setAttribute to trigger the native toggle event'
    );
    assert.ok(
        SEARCH_VIEW_SRC.includes('if (_autoExpandedThisQuery) return;'),
        'auto-expand must early-return when flag is already set'
    );
    assert.ok(
        SEARCH_VIEW_SRC.includes('_autoExpandedThisQuery = true;'),
        'flag must flip to true on first auto-expand of the query'
    );
});
