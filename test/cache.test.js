// test/cache.test.js
// Unit tests for lib/cache.js — in-memory cache behaviour.
//
// Note: cache.js holds module-level state (a single shared Map), so we call
// `clear()` at the start of each test to get a clean slate. sessionStorage
// does not exist in Node, but every call to it in cache.js is wrapped in
// try/catch so it silently no-ops.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get, set, remove, clear } from '../lib/cache.js';

test('set then get returns the stored value', () => {
    clear();
    set('foo', { hello: 'world' });
    const v = get('foo');
    assert.deepEqual(v, { hello: 'world' });
});

test('get for a non-existent key returns undefined', () => {
    clear();
    assert.equal(get('does-not-exist'), undefined);
});

test('set overwrites an existing key', () => {
    clear();
    set('k', 'first');
    set('k', 'second');
    assert.equal(get('k'), 'second');
});

test('remove drops a key from the cache', () => {
    clear();
    set('k', 'v');
    assert.equal(get('k'), 'v');
    remove('k');
    assert.equal(get('k'), undefined);
});

test('clear empties the cache', () => {
    clear();
    set('a', 1);
    set('b', 2);
    set('c', 3);
    clear();
    assert.equal(get('a'), undefined);
    assert.equal(get('b'), undefined);
    assert.equal(get('c'), undefined);
});

test('TTL: value is returned before expiry', async (t) => {
    clear();
    t.mock.timers.enable({ apis: ['Date'] });
    set('k', 'v', 1000);
    t.mock.timers.tick(500);
    assert.equal(get('k'), 'v');
});

test('TTL: value is evicted after expiry', async (t) => {
    clear();
    t.mock.timers.enable({ apis: ['Date'] });
    set('k', 'v', 1000);
    // Tick past the TTL.
    t.mock.timers.tick(1500);
    assert.equal(get('k'), undefined);
});

test('TTL: zero/undefined ttl means no expiry', async (t) => {
    clear();
    t.mock.timers.enable({ apis: ['Date'] });
    set('k', 'v'); // no TTL arg
    t.mock.timers.tick(60 * 60 * 1000); // 1 hour
    assert.equal(get('k'), 'v');
});

test('LRU: capacity eviction drops the least-recently-used entry', () => {
    clear();
    // Store large strings so we can approach the 4 MB cap quickly.
    // Each 1 MB string is ~2 MB in the sizeOf estimate (chars * 2).
    const big = 'x'.repeat(1024 * 1024); // ~2 MB cost per entry
    set('a', big);
    set('b', big);
    // Both should still fit (~4 MB total).
    assert.ok(get('a'));
    assert.ok(get('b'));
    // Touch 'b' to make 'a' the LRU, then insert a third big value.
    // ensureCapacity should evict 'a' to make room.
    get('b');
    set('c', big);
    // 'a' should now be gone; 'b' and 'c' still present.
    assert.equal(get('a'), undefined);
    assert.ok(get('b'));
    assert.ok(get('c'));
});

test('LRU: get promotes the entry to most-recently-used', () => {
    clear();
    const big = 'y'.repeat(1024 * 1024); // ~2 MB
    set('a', big);
    set('b', big);
    // Access 'a' so it becomes MRU; 'b' becomes LRU.
    get('a');
    set('c', big);
    // 'b' should now be evicted, not 'a'.
    assert.ok(get('a'));
    assert.equal(get('b'), undefined);
    assert.ok(get('c'));
});

test('remove on missing key is a no-op', () => {
    clear();
    remove('nope'); // should not throw
    assert.equal(get('nope'), undefined);
});

test('set then get preserves primitive string values', () => {
    clear();
    set('s', 'hello');
    assert.equal(get('s'), 'hello');
});

test('set then get preserves number values', () => {
    clear();
    set('n', 42);
    assert.equal(get('n'), 42);
});
