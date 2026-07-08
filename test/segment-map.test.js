import test from 'node:test';
import assert from 'node:assert';
import { loadSegmentMap, clearSegmentCache } from '../lib/segment-map.js';
import { renderLinesHtml } from '../lib/format.js';

// ── loadSegmentMap tests ──

test('loadSegmentMap returns empty Map for null/undefined workId', async () => {
    const map = await loadSegmentMap(null);
    assert.ok(map instanceof Map);
    assert.equal(map.size, 0);
});

test('loadSegmentMap returns empty Map for non-CBETA workId', async () => {
    const map = await loadSegmentMap('not-a-cbeta-id');
    assert.ok(map instanceof Map);
    assert.equal(map.size, 0);
});

test('clearSegmentCache clears the cache', async () => {
    // Load something (will be empty/404 but gets cached)
    await loadSegmentMap('T99n9999');
    clearSegmentCache();
    // No error = success
});

// ── renderLinesHtml with segmentMap tests ──

test('renderLinesHtml without segmentMap produces plain line-rows', () => {
    const lines = [
        { id: '0001a01', text: 'hello' },
        { id: '0001a02', text: 'world' }
    ];
    const html = renderLinesHtml(lines);
    assert.ok(html.includes('class="line-row"'));
    assert.ok(html.includes('data-line-id="0001a01"'));
    assert.ok(!html.includes('data-segment-type'));
    assert.ok(!html.includes('line-row--'));
});

test('renderLinesHtml with segmentMap adds CSS classes and data attributes', () => {
    const lines = [
        { id: '0001a01', text: 'verse text' },
        { id: '0001a02', text: 'prose text' },
        { id: '0001a03', text: 'no segment' }
    ];
    const segMap = new Map([
        ['0001a01', { type: 'verse', speaker: null }],
        ['0001a02', { type: 'dialogue', speaker: '趙州' }]
    ]);
    const html = renderLinesHtml(lines, segMap);

    // Verse line has CSS class + data attribute
    assert.ok(html.includes('line-row line-row--verse'));
    assert.ok(html.includes('data-segment-type="verse"'));

    // Dialogue line has speaker data attribute
    assert.ok(html.includes('line-row--dialogue'));
    assert.ok(html.includes('data-speaker="趙州"'));

    // Unsegmented line (0001a03) has no segment class — check its specific div
    const lines0003 = html.match(/data-line-id="0001a03"[^>]*/);
    assert.ok(lines0003, 'should find the 0001a03 line');
    assert.ok(!lines0003[0].includes('line-row--'), 'unsegmented line should not have segment class');
});

test('renderLinesHtml with empty segmentMap renders plain', () => {
    const lines = [{ id: '0001a01', text: 'test' }];
    const html = renderLinesHtml(lines, new Map());
    assert.ok(html.includes('class="line-row"'));
    assert.ok(!html.includes('line-row--'));
});

test('renderLinesHtml still handles spacer rows with segmentMap', () => {
    const lines = [
        { id: '__lg_break_1', text: '' },
        { id: '0001a01', text: 'after spacer' }
    ];
    const segMap = new Map([['0001a01', { type: 'verse' }]]);
    const html = renderLinesHtml(lines, segMap);
    assert.ok(html.includes('spacer-row'));
    assert.ok(html.includes('line-row--verse'));
});

test('segment type with special characters is escaped in HTML', () => {
    const lines = [{ id: '0001a01', text: 'test' }];
    const segMap = new Map([['0001a01', { type: 'a"<script>', speaker: 'b"<>' }]]);
    const html = renderLinesHtml(lines, segMap);
    // Should not contain raw angle brackets from type/speaker
    assert.ok(!html.includes('<script>'));
});

// -- fetch-level parse tests (stubbed fetch) --

test('loadSegmentMap skips the seg-v1 header line and expands lb_range', async () => {
    clearSegmentCache();
    const jsonl = [
        '{"source_sha256":"abc123","schema":"seg-v1"}',
        '{"unit_id":"T99n9901_001","lb_range":["0001a01","0001a02"],"text_zh":"x","text_en":"y","type":"verse","confidence":1}',
        'not json at all',
        ''
    ].join('\n');
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, text: async () => jsonl });
    try {
        const map = await loadSegmentMap('T99n9901');
        assert.strictEqual(map.size, 2); // header contributed nothing, bad line skipped
        assert.strictEqual(map.get('0001a01').type, 'verse');
        assert.strictEqual(map.get('0001a02').unitId, 'T99n9901_001');
    } finally {
        globalThis.fetch = realFetch;
        clearSegmentCache();
    }
});

// -- passage.js contract (regression) --
// passage.js is not headless-importable (DOM-heavy), so pin the contract that
// broke: the rangeless/first-N render helpers are top-level functions and MUST
// receive segmentMap as a parameter - a `var segmentMap` inside render() is
// invisible to them (strict-mode ReferenceError took down both paths).

test('passage.js render helpers take segmentMap as an explicit parameter', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('../views/passage.js', import.meta.url), 'utf8');
    assert.match(src, /function renderRangelessBilingual\([^)]*segmentMap[^)]*\)/);
    assert.match(src, /function renderFirstNLines\([^)]*segmentMap[^)]*\)/);
    assert.doesNotMatch(src, /var segmentMap/);
});
