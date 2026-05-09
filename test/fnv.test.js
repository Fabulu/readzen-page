// test/fnv.test.js
// Unit tests for lib/fnv.js. Vectors are the canonical FNV-1a32 published
// reference values (offset basis 0x811c9dc5, prime 0x01000193).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fnv1a32 } from '../lib/fnv.js';

test('fnv1a32: empty string returns offset basis', () => {
    assert.equal(fnv1a32(''), 0x811c9dc5);
});

test('fnv1a32: single char "a"', () => {
    assert.equal(fnv1a32('a'), 0xe40c292c);
});

test('fnv1a32: "foobar"', () => {
    assert.equal(fnv1a32('foobar'), 0xbf9cf968);
});

test('fnv1a32: result is always an unsigned 32-bit integer', () => {
    const samples = ['', 'a', 'foobar', '中文', '￿￿'];
    for (const s of samples) {
        const h = fnv1a32(s);
        assert.ok(Number.isInteger(h), `non-integer for ${JSON.stringify(s)}`);
        assert.ok(h >= 0 && h <= 0xffffffff, `out of u32 range for ${JSON.stringify(s)}`);
    }
});

test('fnv1a32: deterministic (same input -> same output)', () => {
    assert.equal(fnv1a32('zen'), fnv1a32('zen'));
});
