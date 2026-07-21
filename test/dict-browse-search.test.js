import test from 'node:test';
import assert from 'node:assert/strict';

import {
    dictionaryGlossLabel,
    dictionaryGlossSortKey,
    normalizeDictionaryQuery,
    pageRangeLabels,
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

const mk = (sourceTerm, gloss) => ({ sourceTerm, senses: [{ preferredTarget: gloss }] });

test('gloss sort key lowercases and strips leading punctuation and articles', () => {
    assert.equal(dictionaryGlossSortKey(mk('玄路', 'The Hidden Road')), 'hidden road');
    assert.equal(dictionaryGlossSortKey(mk('一', '“cutting off”')), 'cutting off”');
    assert.equal(dictionaryGlossSortKey(mk('甲', 'a decisive cut')), 'decisive cut');
    assert.equal(dictionaryGlossSortKey(mk('乙', 'an abbot')), 'abbot');
});

test('gloss sort key falls back to a later sense and is empty when no gloss exists', () => {
    const later = { sourceTerm: '丙', senses: [{ preferredTarget: '' }, { preferredTarget: 'staff' }] };
    assert.equal(dictionaryGlossSortKey(later), 'staff');
    assert.equal(dictionaryGlossSortKey({ sourceTerm: '丁', senses: [] }), '');
    assert.equal(dictionaryGlossSortKey({ sourceTerm: '戊' }), '');
});

test('gloss thumb label keeps compound first words and never renders empty', () => {
    assert.equal(dictionaryGlossLabel(mk('一刀兩段', 'the one-cut-two-pieces verdict')), 'one-cut-two-pieces');
    assert.equal(dictionaryGlossLabel(mk('甲', "one's original face")), "one's");
    assert.equal(dictionaryGlossLabel({ sourceTerm: '丁', senses: [] }), '—');
});

test('page range labels follow the active browse order', () => {
    const list = [mk('上', 'abbot'), mk('佛', 'the Buddha'), mk('心', 'emptiness'), mk('道', 'mind')];
    assert.deepEqual(pageRangeLabels(list, 2, 'en'), ['abbot – Buddha', 'emptiness – mind']);
    assert.deepEqual(pageRangeLabels(list, 2, 'zh'), ['上–佛', '心–道']);
    assert.deepEqual(pageRangeLabels([mk('上', 'abbot')], 2, 'en'), ['abbot']);
});

