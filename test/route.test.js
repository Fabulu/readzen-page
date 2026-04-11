// test/route.test.js
// Unit tests for lib/route.js — parseRoute and buildZenUri.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoute, buildZenUri } from '../lib/route.js';

// ---------- Passage routes ----------

test('passage: workId only', () => {
    const r = parseRoute('T48n2005');
    assert.equal(r.kind, 'passage');
    assert.equal(r.workId, 'T48n2005');
    assert.equal(r.canon, 'T');
    assert.equal(r.volume, '48');
    assert.equal(r.workSuffix, '2005');
    assert.equal(r.hasExplicitRange, false);
    assert.equal(r.startLine, '');
    assert.equal(r.endLine, '');
    assert.equal(r.mode, 'zh');
    assert.equal(r.translator, '');
});

test('passage: workId with range', () => {
    const r = parseRoute('T48n2005/0292c23-0292c24');
    assert.equal(r.kind, 'passage');
    assert.equal(r.workId, 'T48n2005');
    assert.equal(r.startLine, '0292c23');
    assert.equal(r.endLine, '0292c24');
    assert.equal(r.hasExplicitRange, true);
    assert.equal(r.mode, 'zh');
});

test('passage: workId with range and side=en', () => {
    const r = parseRoute('T48n2005/0292c23-0292c24/en');
    assert.equal(r.kind, 'passage');
    assert.equal(r.mode, 'en');
    assert.equal(r.translator, '');
});

test('passage: workId with range, side, and translator', () => {
    const r = parseRoute('T48n2005/0292c23-0292c24/en/Fabulu');
    assert.equal(r.kind, 'passage');
    assert.equal(r.mode, 'en');
    assert.equal(r.translator, 'Fabulu');
});

test('passage: single line (start == end)', () => {
    const r = parseRoute('T48n2005/0292c23');
    assert.equal(r.kind, 'passage');
    assert.equal(r.startLine, '0292c23');
    assert.equal(r.endLine, '0292c23');
    assert.equal(r.hasExplicitRange, true);
});

test('passage: legacy passage/ prefix', () => {
    const r = parseRoute('passage/T48n2005/0292c23-0292c24/en/Fabulu');
    assert.equal(r.kind, 'passage');
    assert.equal(r.workId, 'T48n2005');
    assert.equal(r.startLine, '0292c23');
    assert.equal(r.mode, 'en');
    assert.equal(r.translator, 'Fabulu');
});

test('passage: implicit form with post-n letter', () => {
    // WORK_ID_PATTERN allows an optional [A-Za-z] after 'n'.
    const r = parseRoute('T85nA2774');
    assert.equal(r.kind, 'passage');
    assert.equal(r.workId, 'T85nA2774');
    assert.equal(r.canon, 'T');
    assert.equal(r.volume, '85');
    assert.equal(r.workSuffix, 'A2774');
});

test('passage: leading slash is tolerated by splitter', () => {
    // parseRoute is given the already-stripped raw route, but the parser's
    // own filter(Boolean) means a leading slash in the input is still OK.
    const r = parseRoute('/T48n2005/0292c23-0292c24');
    assert.equal(r.kind, 'passage');
    assert.equal(r.workId, 'T48n2005');
});

// ---------- Compare routes ----------

test('compare: full form with all fields', () => {
    const r = parseRoute('compare/T48n2005/orig/me/community');
    assert.equal(r.kind, 'compare');
    assert.equal(r.fileId, 'T48n2005');
    assert.equal(r.pane, 'orig');
    assert.equal(r.sourceA, 'me');
    assert.equal(r.sourceB, 'community');
});

test('compare: with query params from/to', () => {
    const r = parseRoute('compare/T48n2005/a/Fabulu/community?from=0292a26&to=0292a29');
    assert.equal(r.kind, 'compare');
    assert.equal(r.fileId, 'T48n2005');
    assert.equal(r.pane, 'a');
    assert.equal(r.sourceA, 'Fabulu');
    assert.equal(r.sourceB, 'community');
    assert.equal(r.from, '0292a26');
    assert.equal(r.to, '0292a29');
});

test('compare: pane is lowercased', () => {
    const r = parseRoute('compare/T48n2005/ORIG/me/community');
    assert.equal(r.pane, 'orig');
});

test('compare: incomplete returns { incomplete: true }', () => {
    const r = parseRoute('compare/T48n2005/orig');
    assert.equal(r.kind, 'compare');
    assert.equal(r.incomplete, true);
});

// ---------- Dictionary routes ----------

test('dictionary: plain term', () => {
    const r = parseRoute('dict/佛');
    assert.equal(r.kind, 'dictionary');
    assert.equal(r.term, '佛');
});

test('dictionary: URL-encoded term is decoded', () => {
    const r = parseRoute('dict/%E4%BD%9B');
    assert.equal(r.kind, 'dictionary');
    assert.equal(r.term, '佛');
});

// ---------- Termbase routes ----------

test('termbase: entry only', () => {
    const r = parseRoute('term/菩提');
    assert.equal(r.kind, 'termbase');
    assert.equal(r.entry, '菩提');
    assert.equal(r.user, '');
});

test('termbase: entry with user', () => {
    const r = parseRoute('term/菩提/Fabulu');
    assert.equal(r.kind, 'termbase');
    assert.equal(r.entry, '菩提');
    assert.equal(r.user, 'Fabulu');
});

// ---------- Master routes ----------

test('master: name with space (decoded)', () => {
    const r = parseRoute('master/Linji%20Yixuan');
    assert.equal(r.kind, 'master');
    assert.equal(r.name, 'Linji Yixuan');
    assert.equal(r.user, '');
});

test('master: name with user', () => {
    const r = parseRoute('master/Linji%20Yixuan/Fabulu');
    assert.equal(r.kind, 'master');
    assert.equal(r.name, 'Linji Yixuan');
    assert.equal(r.user, 'Fabulu');
});

// ---------- Scholar routes (bug fix) ----------

test('scholar: user as query param', () => {
    const r = parseRoute('scholar/myCollection?user=Fabulu');
    assert.equal(r.kind, 'scholar');
    assert.equal(r.collectionId, 'myCollection');
    assert.equal(r.passageId, '');
    assert.equal(r.user, 'Fabulu');
});

test('scholar: passageId and user as query param', () => {
    const r = parseRoute('scholar/myCollection/passageId?user=Fabulu');
    assert.equal(r.kind, 'scholar');
    assert.equal(r.collectionId, 'myCollection');
    assert.equal(r.passageId, 'passageId');
    assert.equal(r.user, 'Fabulu');
});

test('scholar: legacy empty-slot form preserves user position', () => {
    const r = parseRoute('scholar/myCollection//Fabulu');
    assert.equal(r.kind, 'scholar');
    assert.equal(r.collectionId, 'myCollection');
    assert.equal(r.passageId, '');
    assert.equal(r.user, 'Fabulu');
});

test('scholar: full positional form', () => {
    const r = parseRoute('scholar/myCollection/passageId/Fabulu');
    assert.equal(r.kind, 'scholar');
    assert.equal(r.collectionId, 'myCollection');
    assert.equal(r.passageId, 'passageId');
    assert.equal(r.user, 'Fabulu');
});

// ---------- Tags routes ----------

test('tags: all fields', () => {
    const r = parseRoute('tags/T48n2005/Fabulu/topic-1');
    assert.equal(r.kind, 'tags');
    assert.equal(r.fileId, 'T48n2005');
    assert.equal(r.user, 'Fabulu');
    assert.equal(r.tagId, 'topic-1');
});

test('tags: no tagId', () => {
    const r = parseRoute('tags/T48n2005/Fabulu');
    assert.equal(r.kind, 'tags');
    assert.equal(r.fileId, 'T48n2005');
    assert.equal(r.user, 'Fabulu');
    assert.equal(r.tagId, '');
});

test('tags: empty user slot collapses (filter(Boolean))', () => {
    // With filter(Boolean), the empty middle slot is removed, so the third
    // slot (tagId in a full positional form) shifts into the user position.
    // This documents the current behaviour for the tags route.
    const r = parseRoute('tags/T48n2005//topic-1');
    assert.equal(r.kind, 'tags');
    assert.equal(r.fileId, 'T48n2005');
    assert.equal(r.user, 'topic-1');
    assert.equal(r.tagId, '');
});

// ---------- Search routes ----------

test('search: query only', () => {
    const r = parseRoute('search?q=test');
    assert.equal(r.kind, 'search');
    assert.equal(r.q, 'test');
});

test('search: query with filters', () => {
    const r = parseRoute('search?q=test&corpus=T&orig=1&tran=0');
    assert.equal(r.kind, 'search');
    assert.equal(r.q, 'test');
    assert.equal(r.corpus, 'T');
    assert.equal(r.orig, '1');
    assert.equal(r.tran, '0');
});

// ---------- Edge cases ----------

test('empty route returns null', () => {
    assert.equal(parseRoute(''), null);
});

test('null route returns null', () => {
    assert.equal(parseRoute(null), null);
});

test('garbage route returns kind=unknown', () => {
    const r = parseRoute('garbage/foo');
    // 'garbage' does not match any workId pattern and isn't a known keyword,
    // so parsePassage returns null and we fall through to unknown.
    assert.equal(r.kind, 'unknown');
    assert.equal(r.rawRoute, 'garbage/foo');
});

// ---------- buildZenUri ----------

test('buildZenUri: returns null for null route', () => {
    assert.equal(buildZenUri(null), null);
});

test('buildZenUri: returns null when no rawRoute', () => {
    assert.equal(buildZenUri({ kind: 'passage' }), null);
});

test('buildZenUri: produces zen:// prefix', () => {
    const r = parseRoute('T48n2005/0292c23-0292c24/en/Fabulu');
    const uri = buildZenUri(r);
    assert.equal(uri, 'zen://T48n2005/0292c23-0292c24/en/Fabulu');
});

test('buildZenUri: strips leading slashes from raw route', () => {
    const r = parseRoute('T48n2005');
    // Manually inject a leading slash to test the replace.
    r.rawRoute = '/T48n2005';
    assert.equal(buildZenUri(r), 'zen://T48n2005');
});

test('parse → build → parse round-trips for passage', () => {
    const raw = 'T48n2005/0292c23-0292c24/en/Fabulu';
    const r1 = parseRoute(raw);
    const uri = buildZenUri(r1);
    const stripped = uri.replace(/^zen:\/\//, '');
    const r2 = parseRoute(stripped);
    assert.equal(r2.kind, r1.kind);
    assert.equal(r2.workId, r1.workId);
    assert.equal(r2.startLine, r1.startLine);
    assert.equal(r2.endLine, r1.endLine);
    assert.equal(r2.mode, r1.mode);
    assert.equal(r2.translator, r1.translator);
});

test('parse → build → parse round-trips for scholar with query user', () => {
    const raw = 'scholar/myCollection/passageId?user=Fabulu';
    const r1 = parseRoute(raw);
    const uri = buildZenUri(r1);
    const stripped = uri.replace(/^zen:\/\//, '');
    const r2 = parseRoute(stripped);
    assert.equal(r2.kind, 'scholar');
    assert.equal(r2.collectionId, 'myCollection');
    assert.equal(r2.passageId, 'passageId');
    assert.equal(r2.user, 'Fabulu');
});

// ---------- OpenZen routes ----------

test('passage: OpenZen workId only', () => {
    const r = parseRoute('ws.gateless-barrier');
    assert.equal(r.kind, 'passage');
    assert.equal(r.workId, 'ws.gateless-barrier');
    assert.equal(r.corpus, 'openzen');
    assert.equal(r.canon, '');
    assert.equal(r.volume, '');
    assert.equal(r.workSuffix, '');
    assert.equal(r.mode, 'zh');
});

test('passage: OpenZen with side=en and translator', () => {
    const r = parseRoute('ws.gateless-barrier/en/Fabulu');
    assert.equal(r.kind, 'passage');
    assert.equal(r.mode, 'en');
    assert.equal(r.translator, 'Fabulu');
    assert.equal(r.corpus, 'openzen');
});

test('passage: CBETA route still has corpus=cbeta', () => {
    const r = parseRoute('T48n2005');
    assert.equal(r.kind, 'passage');
    assert.equal(r.corpus, 'cbeta');
});

test('compare: OpenZen fileId infers corpus=openzen', () => {
    const r = parseRoute('compare/ws.gateless-barrier/orig/me/community');
    assert.equal(r.kind, 'compare');
    assert.equal(r.fileId, 'ws.gateless-barrier');
    assert.equal(r.corpus, 'openzen');
});

test('tags: OpenZen fileId infers corpus=openzen', () => {
    const r = parseRoute('tags/ws.gateless-barrier/Fabulu');
    assert.equal(r.kind, 'tags');
    assert.equal(r.fileId, 'ws.gateless-barrier');
    assert.equal(r.corpus, 'openzen');
});

test('passage: OpenZen with each publisher prefix', () => {
    const publishers = ['ws', 'pd', 'ce', 'mit'];
    for (const prefix of publishers) {
        const r = parseRoute(`${prefix}.sample-text`);
        assert.equal(r.kind, 'passage');
        assert.equal(r.corpus, 'openzen');
    }
});

test('parse -> build -> parse round-trips for OpenZen passage', () => {
    const raw = 'ws.gateless-barrier/en/Fabulu';
    const r1 = parseRoute(raw);
    const uri = buildZenUri(r1);
    const stripped = uri.replace(/^zen:\/\//, '');
    const r2 = parseRoute(stripped);
    assert.equal(r2.kind, r1.kind);
    assert.equal(r2.workId, r1.workId);
    assert.equal(r2.mode, r1.mode);
    assert.equal(r2.translator, r1.translator);
});

test('unknown publisher does not match OpenZen pattern', () => {
    const r = parseRoute('xx.foo');
    assert.equal(r.kind, 'unknown');
});
