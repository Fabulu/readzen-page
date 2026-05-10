// test/reading-list-share.test.js
// Unit tests for lib/reading-list-share.js — encode/decode round trip,
// URL safety, malformed-input rejection, and JSON export shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// localStorage shim (reading-list-share imports reading-lists which uses it).
const store = new Map();
globalThis.localStorage = {
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
    clear() { store.clear(); }
};

const {
    encodeListToHash,
    decodeListFromHash,
    exportListAsBlob,
    buildShareUrl,
    mergeIntoLocalList,
    URL_SAFE_MAX_ENTRIES
} = await import('../lib/reading-list-share.js');

const { getLists } = await import('../lib/reading-lists.js');

// ---------- encode / decode round trip ----------

test('encode -> decode round-trips a simple list', () => {
    const list = [
        { fileId: 'T48n2005', title: 'Gateless Barrier', route: 'T48n2005' },
        { fileId: 'T48n2010', title: 'Faith in Mind', route: 'T48n2010/0376b27-0376c14' }
    ];
    const encoded = encodeListToHash(list);
    assert.ok(encoded.length > 0);
    const decoded = decodeListFromHash(encoded);
    assert.equal(decoded.length, 2);
    assert.equal(decoded[0].fileId, 'T48n2005');
    assert.equal(decoded[0].title, 'Gateless Barrier');
    assert.equal(decoded[1].route, 'T48n2010/0376b27-0376c14');
});

test('encode preserves UTF-8 (Chinese) titles', () => {
    const list = [{ fileId: 'T48n2005', title: '無門關' }];
    const encoded = encodeListToHash(list);
    const decoded = decodeListFromHash(encoded);
    assert.equal(decoded.length, 1);
    assert.equal(decoded[0].title, '無門關');
});

test('encode result is URL-safe (no +, /, =, or whitespace)', () => {
    // Force a payload likely to produce + and / in standard base64 by
    // including a byte sequence that base64-encodes to those chars.
    const list = [
        { fileId: 'T48n2005', title: 'a'.repeat(63) },
        { fileId: 'T48n2010', title: 'ÿþýü' }
    ];
    const encoded = encodeListToHash(list);
    assert.ok(!/[+/=\s]/.test(encoded), `encoded payload contains unsafe char: ${encoded}`);
});

test('encode of empty list returns empty string', () => {
    assert.equal(encodeListToHash([]), '');
    assert.equal(encodeListToHash(null), '');
    assert.equal(encodeListToHash(undefined), '');
    assert.equal(encodeListToHash('not an array'), '');
});

test('encode skips entries missing fileId', () => {
    const list = [
        { fileId: 'T48n2005', title: 'Good' },
        { title: 'No fileId' },
        null,
        { fileId: '', title: 'Empty fileId' }
    ];
    const encoded = encodeListToHash(list);
    const decoded = decodeListFromHash(encoded);
    assert.equal(decoded.length, 1);
    assert.equal(decoded[0].fileId, 'T48n2005');
});

test('encode strips local-only fields (addedAt, junk)', () => {
    const list = [
        { fileId: 'T48n2005', title: 'X', route: 'T48n2005', addedAt: 1234567890, secret: 'hi' }
    ];
    const decoded = decodeListFromHash(encodeListToHash(list));
    assert.equal(decoded.length, 1);
    assert.equal(decoded[0].fileId, 'T48n2005');
    assert.equal(decoded[0].addedAt, undefined);
    assert.equal(decoded[0].secret, undefined);
});

test('decode rejects empty / null / non-string input', () => {
    assert.equal(decodeListFromHash(''), null);
    assert.equal(decodeListFromHash(null), null);
    assert.equal(decodeListFromHash(undefined), null);
    assert.equal(decodeListFromHash(42), null);
});

test('decode rejects non-base64 garbage', () => {
    assert.equal(decodeListFromHash('!!!@@@###'), null);
});

test('decode rejects valid base64 of non-JSON', () => {
    const b64 = Buffer.from('this is not json', 'utf-8').toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    assert.equal(decodeListFromHash(b64), null);
});

test('decode rejects JSON that is not a list shape', () => {
    const b64 = Buffer.from(JSON.stringify({ foo: 'bar' }), 'utf-8').toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    assert.equal(decodeListFromHash(b64), null);
});

test('decode rejects payload whose entries all lack fileId', () => {
    const payload = { v: 1, list: [{ title: 'no id' }, { title: 'also none' }] };
    const b64 = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    assert.equal(decodeListFromHash(b64), null);
});

test('decode accepts the legacy bare-array shape', () => {
    const list = [{ fileId: 'T48n2005', title: 'X', route: 'T48n2005' }];
    const b64 = Buffer.from(JSON.stringify(list), 'utf-8').toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const decoded = decodeListFromHash(b64);
    assert.equal(decoded.length, 1);
    assert.equal(decoded[0].fileId, 'T48n2005');
});

// ---------- exportListAsBlob ----------

test('exportListAsBlob produces a JSON payload + dated filename', () => {
    const list = [{ fileId: 'T48n2005', title: 'Gateless Barrier' }];
    const { blob, filename, json } = exportListAsBlob(list);
    assert.ok(blob);
    assert.match(filename, /^readzen-list-\d{4}-\d{2}-\d{2}\.json$/);
    const parsed = JSON.parse(json);
    assert.equal(parsed.version, 1);
    assert.equal(parsed.list.length, 1);
    assert.equal(parsed.list[0].fileId, 'T48n2005');
    assert.ok(parsed.exportedAt);
});

test('exportListAsBlob handles empty list (still produces valid JSON)', () => {
    const { json, filename } = exportListAsBlob([]);
    const parsed = JSON.parse(json);
    assert.equal(parsed.list.length, 0);
    assert.match(filename, /^readzen-list-/);
});

// ---------- buildShareUrl ----------

test('buildShareUrl returns "" for an empty list', () => {
    assert.equal(buildShareUrl([]), '');
});

test('buildShareUrl emits #/list?d=<encoded>', () => {
    // Provide a minimal location stub for Node.
    globalThis.location = { origin: 'https://readzen.pages.dev', pathname: '/' };
    const url = buildShareUrl([{ fileId: 'T48n2005', title: 'X' }]);
    assert.match(url, /^https:\/\/readzen\.pages\.dev\/#\/list\?d=/);
    // The encoded payload is the part after `d=` and must round-trip.
    const encoded = url.split('?d=')[1];
    const decoded = decodeListFromHash(encoded);
    assert.equal(decoded.length, 1);
    assert.equal(decoded[0].fileId, 'T48n2005');
});

// ---------- mergeIntoLocalList ----------

test('mergeIntoLocalList writes to localStorage via addToList', () => {
    store.clear();
    const list = [
        { fileId: 'T48n2005', title: 'Gateless Barrier', route: 'T48n2005' },
        { fileId: 'T48n2010', title: 'Faith in Mind', route: 'T48n2010' }
    ];
    const count = mergeIntoLocalList(list);
    assert.equal(count, 2);
    const lists = getLists();
    assert.equal(lists['My Reading List'].length, 2);
    const ids = lists['My Reading List'].map(i => i.fileId).sort();
    assert.deepEqual(ids, ['T48n2005', 'T48n2010']);
});

test('mergeIntoLocalList deduplicates against existing entries', () => {
    store.clear();
    mergeIntoLocalList([{ fileId: 'T48n2005', title: 'Gateless' }]);
    mergeIntoLocalList([{ fileId: 'T48n2005', title: 'Gateless v2' }]);
    const lists = getLists();
    assert.equal(lists['My Reading List'].length, 1);
    // addToList replaces existing entry, so the latest title wins.
    assert.equal(lists['My Reading List'][0].title, 'Gateless v2');
});

// ---------- threshold constant sanity ----------

test('URL_SAFE_MAX_ENTRIES is exported and reasonable', () => {
    assert.equal(typeof URL_SAFE_MAX_ENTRIES, 'number');
    assert.ok(URL_SAFE_MAX_ENTRIES >= 30);
    assert.ok(URL_SAFE_MAX_ENTRIES <= 500);
});

// ---------- end-to-end: encode large list, decode it, check size budget ----------

test('30-entry list fits within typical URL budget (~8 KB)', () => {
    const list = [];
    for (let i = 0; i < 30; i += 1) {
        list.push({
            fileId: `T48n${2000 + i}`,
            title: 'Sample title ' + i + ' 中文',
            route: `T48n${2000 + i}/0292c23-0292c25`
        });
    }
    const encoded = encodeListToHash(list);
    // 30 entries with CJK titles + ranges ≈ ~3.6 KB encoded — well under
    // the 8 KB practical URL limit on modern browsers, but above the
    // ~2 KB safe limit for very old IE/Edge. The warning in the UI kicks
    // in well before this point (URL_SAFE_MAX_ENTRIES=50).
    assert.ok(encoded.length < 8192, `encoded length ${encoded.length} exceeded 8192`);
    const decoded = decodeListFromHash(encoded);
    assert.equal(decoded.length, 30);
});

// ---------- Gap tests (Wave 2.3 review) ----------

// Helper: encode an arbitrary JS value as a URL-safe base64 hash payload.
function encodeRaw(value) {
    return Buffer.from(JSON.stringify(value), 'utf-8').toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

test('decode: rejects payload where list is not an array', () => {
    // {v:1, list: "oops"} — list field present but wrong type.
    assert.equal(decodeListFromHash(encodeRaw({ v: 1, list: 'oops' })), null);
    assert.equal(decodeListFromHash(encodeRaw({ v: 1, list: { fileId: 'x' } })), null);
    assert.equal(decodeListFromHash(encodeRaw({ v: 1, list: 42 })), null);
});

test('decode: accepts unknown future version when list is well-formed', () => {
    // The current implementation only branches on `list` being an array; it
    // does NOT enforce SCHEMA_VERSION. This test pins the actual behaviour so
    // future changes are deliberate. If we later want strict version checks,
    // flip this to assert null and bump SCHEMA_VERSION handling in the lib.
    const payload = { v: 99, list: [{ fileId: 'T48n2005', title: 'X' }] };
    const decoded = decodeListFromHash(encodeRaw(payload));
    assert.ok(Array.isArray(decoded));
    assert.equal(decoded.length, 1);
    assert.equal(decoded[0].fileId, 'T48n2005');
});

test('decode: rejects payload where every entry is missing fileId', () => {
    const payload = {
        v: 1,
        list: [
            { title: 'no id 1' },
            { fileId: '', title: 'empty id' },
            { route: 'foo', title: 'no id 3' }
        ]
    };
    assert.equal(decodeListFromHash(encodeRaw(payload)), null);
});

test('URL_SAFE_MAX_ENTRIES boundary: exactly 50 entries does NOT exceed; 51 does', () => {
    // The constant is the soft warning threshold, not a hard cap. The library
    // doesn't internally warn; the UI is expected to compare list.length vs
    // URL_SAFE_MAX_ENTRIES. This test documents that contract: 50 == safe,
    // 51 == warn-worthy.
    assert.equal(URL_SAFE_MAX_ENTRIES, 50);

    const make = (n) => Array.from({ length: n }, (_, i) => ({
        fileId: `T48n${2000 + i}`,
        title: `t${i}`
    }));

    const at = make(50);
    const over = make(51);

    // Encode succeeds in both cases; the decision to warn is callers'.
    const encAt = encodeListToHash(at);
    const encOver = encodeListToHash(over);
    assert.ok(encAt.length > 0);
    assert.ok(encOver.length > 0);

    // The boundary check used in the UI is `length > URL_SAFE_MAX_ENTRIES`.
    assert.equal(at.length > URL_SAFE_MAX_ENTRIES, false, '50 should not exceed soft cap');
    assert.equal(over.length > URL_SAFE_MAX_ENTRIES, true, '51 should exceed soft cap');
});

test('mergeIntoLocalList: encode -> decode -> merge twice does not double up', () => {
    store.clear();
    const original = [
        { fileId: 'T48n2005', title: 'Gateless Barrier', route: 'T48n2005' },
        { fileId: 'T48n2010', title: 'Faith in Mind', route: 'T48n2010' }
    ];
    // Round-trip through encode/decode just like the share flow does.
    const decodedA = decodeListFromHash(encodeListToHash(original));
    mergeIntoLocalList(decodedA);
    const decodedB = decodeListFromHash(encodeListToHash(original));
    mergeIntoLocalList(decodedB);

    const lists = getLists();
    assert.equal(lists['My Reading List'].length, 2,
        'two merges of the same list should still total 2 entries');
    const ids = lists['My Reading List'].map(i => i.fileId).sort();
    assert.deepEqual(ids, ['T48n2005', 'T48n2010']);
});

test('sanitizeEntry (via encode): strips addedAt and unknown future fields', () => {
    // sanitizeEntry isn't exported, but its behaviour is observable through
    // encodeListToHash -> decodeListFromHash.
    const list = [{
        fileId: 'T48n2005',
        title: 'X',
        route: 'T48n2005',
        addedAt: 1700000000000,
        // Imagine the v2 schema ships a `tags` field. Older clients must not
        // surface it on decode, otherwise they'd leak unknown state into UI.
        tags: ['favorite'],
        notes: 'private',
        sharedBy: 'someone'
    }];
    const decoded = decodeListFromHash(encodeListToHash(list));
    assert.equal(decoded.length, 1);
    const e = decoded[0];
    assert.equal(e.fileId, 'T48n2005');
    assert.equal(e.title, 'X');
    assert.equal(e.route, 'T48n2005');
    assert.equal(e.addedAt, undefined, 'addedAt must be stripped');
    assert.equal(e.tags, undefined, 'unknown future fields must be stripped');
    assert.equal(e.notes, undefined);
    assert.equal(e.sharedBy, undefined);
    // Decoded entry contains exactly the three known fields.
    assert.deepEqual(Object.keys(e).sort(), ['fileId', 'route', 'title']);
});
