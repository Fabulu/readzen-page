import test from 'node:test';
import assert from 'node:assert';

// localStorage shim before importing the module under test
const store = new Map();
globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
};

const { getRecentSearches, addRecentSearch, clearRecentSearches } =
    await import('../lib/search-history.js');

test('recent searches: record, dedupe, most-recent-first, cap at 10', () => {
    clearRecentSearches();
    for (let i = 1; i <= 12; i++) addRecentSearch('q' + i);
    addRecentSearch('q5'); // dedupe + bump to front
    const list = getRecentSearches();
    assert.strictEqual(list.length, 10);
    assert.strictEqual(list[0], 'q5');
    assert.ok(!list.includes('q1')); // oldest evicted
});

test('recent searches: whitespace ignored, values trimmed', () => {
    clearRecentSearches();
    addRecentSearch('   ');
    addRecentSearch('');
    addRecentSearch(null);
    addRecentSearch('  wumen  ');
    assert.deepStrictEqual(getRecentSearches(), ['wumen']);
});

test('recent searches: corrupt storage degrades to empty', () => {
    localStorage.setItem('zl:recent-searches', '{not json');
    assert.deepStrictEqual(getRecentSearches(), []);
    clearRecentSearches();
});
