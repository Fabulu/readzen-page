// test/bigram-codec.test.js
// Round-trip + wire-format tests for lib/bigram-codec.js (W1.3).
// JS->JS round-trip only; C# fixture cross-check deferred per architect note.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    encodePostingList,
    decodePostingList,
    encodeShard,
    readShardHeader,
} from '../lib/bigram-codec.js';

// --- encodePostingList / decodePostingList ---

test('encodePostingList: empty input encodes to zero bytes', () => {
    const enc = encodePostingList([]);
    assert.ok(enc instanceof Uint8Array);
    assert.equal(enc.length, 0);
    const dec = decodePostingList(enc, 0);
    assert.ok(dec instanceof Uint16Array);
    assert.equal(dec.length, 0);
});

test('encodePostingList: single-element [42] encodes to 1 byte', () => {
    const enc = encodePostingList([42]);
    assert.equal(enc.length, 1, 'delta=42 fits in one varint byte');
    assert.equal(enc[0], 42);
    const dec = decodePostingList(enc, 1);
    assert.equal(dec.length, 1);
    assert.equal(dec[0], 42);
});

test('encodePostingList: single-element [200] encodes to 2 bytes (varint boundary)', () => {
    const enc = encodePostingList([200]);
    assert.equal(enc.length, 2, 'delta=200 needs two varint bytes');
    const dec = decodePostingList(enc, 1);
    assert.equal(dec[0], 200);
});

test('encodePostingList: [1,2,3,1000] round-trips', () => {
    const input = [1, 2, 3, 1000];
    const enc = encodePostingList(input);
    const dec = decodePostingList(enc, input.length);
    assert.equal(dec.length, input.length);
    assert.ok(dec instanceof Uint16Array, 'decoder must preallocate Uint16Array');
    for (let i = 0; i < input.length; i++) {
        assert.equal(dec[i], input[i], `mismatch at index ${i}`);
    }
});

test('encodePostingList: large gaps encode correctly (sparse posting list)', () => {
    const input = [0, 1, 127, 128, 16383, 16384, 65535];
    const enc = encodePostingList(input);
    const dec = decodePostingList(enc, input.length);
    assert.equal(dec.length, input.length);
    for (let i = 0; i < input.length; i++) {
        assert.equal(dec[i], input[i]);
    }
});

test('encodePostingList: rejects non-ascending input', () => {
    assert.throws(() => encodePostingList([3, 2, 1]), /sorted ascending/);
});

test('encodePostingList: rejects duplicates', () => {
    assert.throws(() => encodePostingList([1, 1, 2]), /sorted ascending/);
});

test('decodePostingList: respects offset within larger buffer', () => {
    const padded = new Uint8Array(10);
    const enc = encodePostingList([5, 6, 7]);
    padded.set(enc, 3);
    const dec = decodePostingList(padded, 3, 3);
    assert.deepEqual(Array.from(dec), [5, 6, 7]);
});

// --- encodeShard / readShardHeader ---

test('encodeShard: writes IIDX magic + version 2 + correct counts', () => {
    const shard = encodeShard(
        [
            { term: '無門', postings: encodePostingList([1, 5, 9]), count: 3 },
            { term: '門關', postings: encodePostingList([2, 5]), count: 2 },
        ],
        100
    );

    // Magic bytes 'IIDX' = 0x49 0x49 0x44 0x58
    assert.equal(shard[0], 0x49);
    assert.equal(shard[1], 0x49);
    assert.equal(shard[2], 0x44);
    assert.equal(shard[3], 0x58);

    // version u32 LE
    const version = shard[4] | (shard[5] << 8) | (shard[6] << 16) | (shard[7] << 24);
    assert.equal(version, 2);
    // termCount u32 LE
    const termCount = shard[8] | (shard[9] << 8) | (shard[10] << 16) | (shard[11] << 24);
    assert.equal(termCount, 2);
    // docCount u32 LE
    const docCount = shard[12] | (shard[13] << 8) | (shard[14] << 16) | (shard[15] << 24);
    assert.equal(docCount, 100);
});

test('encodeShard + readShardHeader + decodePostingList: round-trip two terms', () => {
    const t1 = '無門'; // 'wú mén'
    const t2 = '門關'; // 'mén guān'
    const p1 = [1, 5, 9];
    const p2 = [2, 5];

    const shard = encodeShard(
        [
            { term: t1, postings: encodePostingList(p1), count: p1.length },
            { term: t2, postings: encodePostingList(p2), count: p2.length },
        ],
        100
    );

    const header = readShardHeader(shard);
    assert.equal(header.version, 2);
    assert.equal(header.docCount, 100);
    assert.equal(header.terms.size, 2);

    const e1 = header.terms.get(t1);
    const e2 = header.terms.get(t2);
    assert.ok(e1, 'term 1 present');
    assert.ok(e2, 'term 2 present');
    assert.equal(e1.count, p1.length);
    assert.equal(e2.count, p2.length);

    const dec1 = decodePostingList(shard, e1.count, e1.offset);
    const dec2 = decodePostingList(shard, e2.count, e2.offset);
    assert.deepEqual(Array.from(dec1), p1);
    assert.deepEqual(Array.from(dec2), p2);
});

test('encodeShard: empty term list produces a valid header-only shard', () => {
    const shard = encodeShard([], 0);
    assert.equal(shard.length, 16, 'header is exactly 16 bytes');
    const header = readShardHeader(shard);
    assert.equal(header.version, 2);
    assert.equal(header.docCount, 0);
    assert.equal(header.terms.size, 0);
});

test('encodeShard: postingOffset is RELATIVE to postings section', () => {
    // Two terms with single-byte posting runs each (delta=1, delta=1).
    const shard = encodeShard(
        [
            { term: 'aa', postings: encodePostingList([1]), count: 1 },
            { term: 'bb', postings: encodePostingList([1]), count: 1 },
        ],
        10
    );
    const header = readShardHeader(shard);
    const a = header.terms.get('aa');
    const b = header.terms.get('bb');
    // a.offset === postingsStart + 0; b.offset === postingsStart + 1
    assert.equal(a.offset, header.postingsStart);
    assert.equal(b.offset, header.postingsStart + 1);
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
});

test('readShardHeader: rejects bad magic', () => {
    const bad = new Uint8Array(16); // all zeros
    assert.throws(() => readShardHeader(bad), /bad magic/);
});

test('readShardHeader: rejects buffer smaller than header', () => {
    const tiny = new Uint8Array(4);
    assert.throws(() => readShardHeader(tiny), /too small/);
});

test('readShardHeader: rejects unsupported version', () => {
    const shard = encodeShard([], 0);
    // Patch version u32 to 99
    shard[4] = 99; shard[5] = 0; shard[6] = 0; shard[7] = 0;
    assert.throws(() => readShardHeader(shard), /unsupported version/);
});

// --- Varint boundary tests (delta exactly at 127, 128, 16383, 16384) ---

test('encodePostingList: delta=127 fits in 1 byte (boundary)', () => {
    const enc = encodePostingList([127]);
    assert.equal(enc.length, 1, 'delta=127 still fits in single varint byte (high bit clear)');
    assert.equal(enc[0], 127);
    const dec = decodePostingList(enc, 1);
    assert.equal(dec[0], 127);
});

test('encodePostingList: delta=128 needs 2 bytes (boundary)', () => {
    const enc = encodePostingList([128]);
    assert.equal(enc.length, 2, 'delta=128 spills into a second varint byte');
    // First byte: 0x80 (low 7 bits = 0, continuation set)
    // Second byte: 0x01 (next 7 bits)
    assert.equal(enc[0], 0x80);
    assert.equal(enc[1], 0x01);
    const dec = decodePostingList(enc, 1);
    assert.equal(dec[0], 128);
});

test('encodePostingList: delta=16383 fits in 2 bytes (boundary)', () => {
    const enc = encodePostingList([16383]);
    assert.equal(enc.length, 2);
    const dec = decodePostingList(enc, 1);
    assert.equal(dec[0], 16383);
});

test('encodePostingList: delta=16384 needs 3 bytes (boundary)', () => {
    const enc = encodePostingList([16384]);
    assert.equal(enc.length, 3);
    const dec = decodePostingList(enc, 1);
    assert.equal(dec[0], 16384);
});

test('encodePostingList: cross-boundary deltas pack tightly', () => {
    // Test deltas spanning each varint boundary exactly: 127->128, 16383->16384.
    const cases = [
        { input: [0, 127], expectedBytes: 2 },           // delta 0 (1B) + delta 127 (1B)
        { input: [0, 128], expectedBytes: 3 },           // delta 0 (1B) + delta 128 (2B)
        { input: [0, 16383], expectedBytes: 3 },         // delta 0 + delta 16383
        { input: [0, 16384], expectedBytes: 4 },         // delta 0 + delta 16384
        { input: [100, 227], expectedBytes: 2 },         // delta 100 + delta 127
        { input: [100, 228], expectedBytes: 3 },         // delta 100 + delta 128
    ];
    for (const c of cases) {
        const enc = encodePostingList(c.input);
        assert.equal(enc.length, c.expectedBytes,
            `${JSON.stringify(c.input)}: expected ${c.expectedBytes}B, got ${enc.length}B`);
        const dec = decodePostingList(enc, c.input.length);
        assert.deepEqual(Array.from(dec), c.input);
    }
});

// --- Maximum corpus boundary (uint16 cap) ---

test('encodePostingList: max docId 65535 round-trips cleanly', () => {
    const enc = encodePostingList([0, 65535]);
    const dec = decodePostingList(enc, 2);
    assert.deepEqual(Array.from(dec), [0, 65535]);
});

test('encodePostingList: full posting [0..65535] round-trips (worst case)', () => {
    // Worst case: every doc in the corpus contains this bigram.
    const all = new Array(65536);
    for (let i = 0; i < 65536; i++) all[i] = i;
    const enc = encodePostingList(all);
    // Each delta is 1, encodes to 1 byte → exactly 65536 bytes.
    assert.equal(enc.length, 65536);
    const dec = decodePostingList(enc, 65536);
    // Spot-check first/last/middle.
    assert.equal(dec[0], 0);
    assert.equal(dec[1], 1);
    assert.equal(dec[32768], 32768);
    assert.equal(dec[65535], 65535);
});

// --- Invalid / truncated bytes (decoder throws cleanly after bounds-check fix) ---

test('decodePostingList: truncated varint throws', () => {
    const truncated = new Uint8Array([0x80, 0x80]); // continuation bytes, no terminator
    assert.throws(() => decodePostingList(truncated, 1), /truncated/i);
});

test('decodePostingList: count exceeds available varints throws', () => {
    const oneOnly = new Uint8Array([5]); // one varint, asking for two
    assert.throws(() => decodePostingList(oneOnly, 2), /truncated/i);
});

test('readShardHeader: truncated dictionary throws', () => {
    const shard = new Uint8Array(16);
    shard[0] = 0x49; shard[1] = 0x49; shard[2] = 0x44; shard[3] = 0x58; // IIDX
    shard[4] = 2; // version
    shard[8] = 1; // termCount = 1, but no dictionary entry follows
    assert.throws(() => readShardHeader(shard), /truncated/i);
});

test('readShardHeader: too-long termLen (exceeds buffer remainder) throws', () => {
    const shard = new Uint8Array(20);
    shard[0] = 0x49; shard[1] = 0x49; shard[2] = 0x44; shard[3] = 0x58;
    shard[4] = 2;
    shard[8] = 1;
    shard[16] = 0xE7; shard[17] = 0x03; // termLen = 999, no follow-on bytes
    assert.throws(() => readShardHeader(shard), /truncated/i);
});

test('encodeShard: term count 1000 (stress) round-trips through readShardHeader', () => {
    // Build a shard with many distinct terms — stress the dictionary
    // (no documented max, but a sane upper bound is ~tens of thousands per shard).
    const N = 1000;
    const termList = [];
    for (let i = 0; i < N; i++) {
        // Build distinct CJK 2-char terms.
        const a = String.fromCharCode(0x4E00 + (i % 4096));
        const b = String.fromCharCode(0x4E00 + ((i + 1) % 4096));
        const term = a + b;
        termList.push({ term, postings: encodePostingList([i % 100]), count: 1 });
    }
    // Sort by term for determinism (deduping any that collide).
    termList.sort((a, b) => a.term < b.term ? -1 : a.term > b.term ? 1 : 0);
    const dedup = [];
    for (const t of termList) {
        if (dedup.length === 0 || dedup[dedup.length - 1].term !== t.term) dedup.push(t);
    }
    const shard = encodeShard(dedup, 100);
    const header = readShardHeader(shard);
    assert.equal(header.terms.size, dedup.length);
    // Spot-check first and last term.
    assert.ok(header.terms.has(dedup[0].term));
    assert.ok(header.terms.has(dedup[dedup.length - 1].term));
});

test('encodeShard determinism: two consecutive runs produce byte-identical output', () => {
    // Acceptance criterion #6: builds must be reproducible.
    const build = () => encodeShard(
        [
            { term: '無門', postings: encodePostingList([1, 5, 9]), count: 3 },
            { term: '門關', postings: encodePostingList([2, 5]), count: 2 },
            { term: '關卡', postings: encodePostingList([3, 7]), count: 2 },
        ],
        100
    );
    const a = build();
    const b = build();
    assert.equal(a.length, b.length);
    for (let i = 0; i < a.length; i++) {
        assert.equal(a[i], b[i], `byte ${i} mismatch`);
    }
});

test('end-to-end: many bigrams with realistic posting density', () => {
    const terms = [];
    for (let i = 0; i < 50; i++) {
        // Term: two characters from CJK Unified Ideographs.
        const term = String.fromCharCode(0x4e00 + i) + String.fromCharCode(0x4e00 + i + 1);
        // Posting list: every (i+2)-th doc up to 1000.
        const postings = [];
        for (let d = 0; d < 1000; d += (i + 2)) postings.push(d);
        terms.push({
            term,
            postings: encodePostingList(postings),
            count: postings.length,
            _expected: postings,
        });
    }

    const shard = encodeShard(
        terms.map(t => ({ term: t.term, postings: t.postings, count: t.count })),
        2000
    );
    const header = readShardHeader(shard);
    assert.equal(header.terms.size, 50);
    assert.equal(header.docCount, 2000);

    for (const t of terms) {
        const meta = header.terms.get(t.term);
        assert.ok(meta, `term ${t.term} present`);
        assert.equal(meta.count, t._expected.length);
        const dec = decodePostingList(shard, meta.count, meta.offset);
        assert.deepEqual(Array.from(dec), t._expected, `posting mismatch for ${t.term}`);
    }
});
