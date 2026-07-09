import test from 'node:test';
import assert from 'node:assert';

const store = new Map();
globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
};

const { getPageSize, setPageSize, PAGE_SIZE_OPTIONS, DEFAULT_PAGE_SIZE,
    getBilingualMode, setBilingualMode, BILINGUAL_MODES, DEFAULT_BILINGUAL_MODE } =
    await import('../lib/reader-prefs.js');

test('page size: defaults, persists, whitelists', () => {
    assert.strictEqual(getPageSize(), DEFAULT_PAGE_SIZE);
    setPageSize(3000);
    assert.strictEqual(getPageSize(), 3000);
    setPageSize('all');
    assert.strictEqual(getPageSize(), 'all');
    setPageSize(9999);            // not whitelisted - ignored
    assert.strictEqual(getPageSize(), 'all');
    setPageSize('10000');         // string form of a whitelisted number
    assert.strictEqual(getPageSize(), 10000);
});

test('page size: corrupt storage falls back to default', () => {
    localStorage.setItem('zl:page-size', 'banana');
    assert.strictEqual(getPageSize(), DEFAULT_PAGE_SIZE);
});

test('option list shape', () => {
    assert.ok(PAGE_SIZE_OPTIONS.includes(DEFAULT_PAGE_SIZE));
    assert.strictEqual(PAGE_SIZE_OPTIONS[PAGE_SIZE_OPTIONS.length - 1], 'all');
});

test('bilingual mode: defaults to flow, persists, whitelists', () => {
    assert.strictEqual(DEFAULT_BILINGUAL_MODE, 'flow');
    assert.strictEqual(getBilingualMode(), 'flow');
    setBilingualMode('interleaved');
    assert.strictEqual(getBilingualMode(), 'interleaved');
    setBilingualMode('nonsense');
    assert.strictEqual(getBilingualMode(), 'interleaved');
    for (const m of BILINGUAL_MODES) { setBilingualMode(m); assert.strictEqual(getBilingualMode(), m); }
});

test('bilingual mode: corrupt storage falls back to flow', () => {
    localStorage.setItem('zl:bilingual-mode', '42');
    assert.strictEqual(getBilingualMode(), 'flow');
});
