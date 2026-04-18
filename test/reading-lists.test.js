// test/reading-lists.test.js
// Unit tests for lib/reading-lists.js — localStorage-backed reading lists
// and progress tracking.
//
// localStorage doesn't exist in Node, so we shim it with a plain Map.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Install a minimal localStorage shim before importing the module.
const store = new Map();
globalThis.localStorage = {
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
    clear() { store.clear(); }
};

const {
    addToList, removeFromList, getLists, isInList,
    setLastRead, getLastRead
} = await import('../lib/reading-lists.js');

test('addToList + getLists round-trips', () => {
    store.clear();
    addToList('Favorites', 'T48n2005', 'Gateless Barrier');
    const lists = getLists();
    assert.ok(lists['Favorites']);
    assert.equal(lists['Favorites'].length, 1);
    assert.equal(lists['Favorites'][0].fileId, 'T48n2005');
    assert.equal(lists['Favorites'][0].title, 'Gateless Barrier');
});

test('addToList deduplicates by fileId', () => {
    store.clear();
    addToList('Favorites', 'T48n2005', 'Gateless Barrier');
    addToList('Favorites', 'T48n2005', 'Gateless Barrier again');
    const lists = getLists();
    assert.equal(lists['Favorites'].length, 1);
});

test('removeFromList removes the entry', () => {
    store.clear();
    addToList('Favorites', 'T48n2005', 'Gateless Barrier');
    addToList('Favorites', 'T48n2010', 'Blue Cliff Record');
    removeFromList('Favorites', 'T48n2005');
    const lists = getLists();
    assert.equal(lists['Favorites'].length, 1);
    assert.equal(lists['Favorites'][0].fileId, 'T48n2010');
});

test('removeFromList deletes empty lists', () => {
    store.clear();
    addToList('Temp', 'T48n2005', 'X');
    removeFromList('Temp', 'T48n2005');
    const lists = getLists();
    assert.equal(lists['Temp'], undefined);
});

test('isInList returns true/false correctly', () => {
    store.clear();
    addToList('My Reading List', 'T48n2005', 'X');
    assert.equal(isInList('My Reading List', 'T48n2005'), true);
    assert.equal(isInList('My Reading List', 'T48n2010'), false);
    assert.equal(isInList('NonExistent', 'T48n2005'), false);
});

test('setLastRead + getLastRead round-trips', () => {
    store.clear();
    setLastRead('T48n2005', 'Gateless Barrier', 42);
    const lr = getLastRead();
    assert.equal(lr.fileId, 'T48n2005');
    assert.equal(lr.title, 'Gateless Barrier');
    assert.equal(lr.scrollPercent, 42);
    assert.ok(typeof lr.timestamp === 'number');
});

test('getLastRead returns null when nothing stored', () => {
    store.clear();
    assert.equal(getLastRead(), null);
});
