import test from 'node:test';
import assert from 'node:assert/strict';

import {
    normalizeDictionaryQuery,
    rankDictionaryEntry,
    searchDictionaryEntries,
} from '../views/dict-browse.js';

const darkRoad = {
    sourceTerm: '玄路',
    senses: [{
        preferredTarget: 'the hidden road',
        alternateTargets: ['the dark road', 'the mysterious road'],
        searchAliases: [
            'dark path', 'dark way', 'dark route',
            'hidden path', 'hidden way', 'hidden route',
            'mysterious path', 'mysterious way', 'mysterious route',
        ],
        explanation: 'A named member of the three roads.',
        note: '',
        occurrences: [],
    }],
};

test('dictionary search aliases retrieve ordinary English road/path/way variants', () => {
    for (const query of ['dark path', 'dark way', 'hidden route', 'mysterious path']) {
        assert.deepEqual(searchDictionaryEntries([darkRoad], query), [darkRoad], query);
    }
});

test('dictionary search ranks preferred translations above aliases and prose mentions', () => {
    const preferred = {
        sourceTerm: '甲',
        senses: [{ preferredTarget: 'dark path', alternateTargets: [], searchAliases: [], explanation: '', note: '', occurrences: [] }],
    };
    const proseOnly = {
        sourceTerm: '乙',
        senses: [{ preferredTarget: 'something else', alternateTargets: [], searchAliases: [], explanation: 'This mentions a dark path.', note: '', occurrences: [] }],
    };
    const result = searchDictionaryEntries([darkRoad, proseOnly, preferred], 'dark path');
    assert.deepEqual(result, [preferred, darkRoad, proseOnly]);
    assert.ok(rankDictionaryEntry(preferred, 'dark path') > rankDictionaryEntry(darkRoad, 'dark path'));
});

test('dictionary query normalization handles punctuation, hyphens, spacing, and case', () => {
    assert.equal(normalizeDictionaryQuery('  Dark—Path!!  '), 'dark path');
    assert.equal(rankDictionaryEntry(darkRoad, 'DARK-PATH'), 700);
});

