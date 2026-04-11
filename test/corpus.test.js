// test/corpus.test.js
// Unit tests for lib/corpus.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    isOpenZenFileId,
    inferCorpus,
    inferCorpusForRelPath,
    Corpus
} from '../lib/corpus.js';

test('isOpenZenFileId returns true for known publisher prefixes', () => {
    assert.equal(isOpenZenFileId('ws.gateless-barrier'), true);
    assert.equal(isOpenZenFileId('pd.linji-record'), true);
    assert.equal(isOpenZenFileId('ce.blue-cliff-record'), true);
    assert.equal(isOpenZenFileId('mit.platform-sutra'), true);
});

test('isOpenZenFileId returns false for empty slug', () => {
    assert.equal(isOpenZenFileId('ws.'), false);
});

test('isOpenZenFileId returns false for unknown publisher', () => {
    assert.equal(isOpenZenFileId('xx.foo'), false);
});

test('isOpenZenFileId returns false for CBETA fileId', () => {
    assert.equal(isOpenZenFileId('T48n2005'), false);
});

test('inferCorpus identifies CBETA file IDs', () => {
    assert.equal(inferCorpus('T48n2005'), Corpus.Cbeta);
    assert.equal(inferCorpus('X12n0123b'), Corpus.Cbeta);
    assert.equal(inferCorpus('T85nA2774'), Corpus.Cbeta);
});

test('inferCorpus identifies OpenZen file IDs', () => {
    assert.equal(inferCorpus('ws.gateless-barrier'), Corpus.OpenZen);
    assert.equal(inferCorpus('pd.linji-record'), Corpus.OpenZen);
    assert.equal(inferCorpus('ce.blue-cliff-record'), Corpus.OpenZen);
    assert.equal(inferCorpus('mit.platform-sutra'), Corpus.OpenZen);
});

test('inferCorpus returns Unknown for garbage or empty input', () => {
    assert.equal(inferCorpus('garbage'), Corpus.Unknown);
    assert.equal(inferCorpus(''), Corpus.Unknown);
    assert.equal(inferCorpus(null), Corpus.Unknown);
});

test('inferCorpusForRelPath identifies CBETA paths', () => {
    assert.equal(inferCorpusForRelPath('T/T48/T48n2005.xml'), Corpus.Cbeta);
});

test('inferCorpusForRelPath identifies OpenZen paths', () => {
    assert.equal(inferCorpusForRelPath('ws/gateless-barrier/gateless-barrier.xml'), Corpus.OpenZen);
});

test('inferCorpusForRelPath returns Unknown for unparseable input', () => {
    assert.equal(inferCorpusForRelPath('notes/readme.txt'), Corpus.Unknown);
    assert.equal(inferCorpusForRelPath(''), Corpus.Unknown);
});
