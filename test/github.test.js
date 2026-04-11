// test/github.test.js
// Unit tests for lib/github.js URL builders.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    TEXT_REPO_BASE,
    TRANSLATION_REPO_BASE,
    COMMUNITY_TRANSLATIONS_BASE,
    OPEN_TEXT_REPO_BASE,
    OPEN_TRANSLATION_REPO_BASE,
    OPEN_COMMUNITY_TRANSLATIONS_BASE,
    xmlUrlForFileId,
    sourceXmlUrl,
    authoritativeTranslationUrl,
    communityTranslationUrl
} from '../lib/github.js';
import { Corpus, inferCorpusForRelPath } from '../lib/corpus.js';

test('xmlUrlForFileId: CBETA T48n2005', () => {
    assert.equal(xmlUrlForFileId('T48n2005'), 'T/T48/T48n2005.xml');
});

test('xmlUrlForFileId: CBETA T85nA2774', () => {
    assert.equal(xmlUrlForFileId('T85nA2774'), 'T/T85/T85nA2774.xml');
});

test('xmlUrlForFileId: OpenZen ws.gateless-barrier', () => {
    assert.equal(
        xmlUrlForFileId('ws.gateless-barrier'),
        'ws/gateless-barrier/gateless-barrier.xml'
    );
});

test('xmlUrlForFileId: OpenZen publishers pd/ce/mit', () => {
    assert.equal(
        xmlUrlForFileId('pd.linji-record'),
        'pd/linji-record/linji-record.xml'
    );
    assert.equal(
        xmlUrlForFileId('ce.blue-cliff-record'),
        'ce/blue-cliff-record/blue-cliff-record.xml'
    );
    assert.equal(
        xmlUrlForFileId('mit.platform-sutra'),
        'mit/platform-sutra/platform-sutra.xml'
    );
});

test('xmlUrlForFileId: explicit corpus overrides inference', () => {
    assert.equal(xmlUrlForFileId('ws.gateless-barrier', Corpus.Cbeta), null);
});

test('xmlUrlForFileId: returns null for empty or unknown', () => {
    assert.equal(xmlUrlForFileId(''), null);
    assert.equal(xmlUrlForFileId('garbage'), null);
});

test('sourceXmlUrl: CBETA prepends TEXT_REPO_BASE', () => {
    assert.equal(
        sourceXmlUrl('T48n2005'),
        TEXT_REPO_BASE + 'T/T48/T48n2005.xml'
    );
});

test('sourceXmlUrl: OpenZen prepends OPEN_TEXT_REPO_BASE', () => {
    assert.equal(
        sourceXmlUrl('ws.gateless-barrier'),
        OPEN_TEXT_REPO_BASE + 'ws/gateless-barrier/gateless-barrier.xml'
    );
});

test('authoritativeTranslationUrl: CBETA and OpenZen branches', () => {
    assert.equal(
        authoritativeTranslationUrl('T48n2005'),
        TRANSLATION_REPO_BASE + 'T/T48/T48n2005.xml'
    );
    assert.equal(
        authoritativeTranslationUrl('ws.gateless-barrier'),
        OPEN_TRANSLATION_REPO_BASE + 'ws/gateless-barrier/gateless-barrier.xml'
    );
});

test('communityTranslationUrl: CBETA and OpenZen branches', () => {
    assert.equal(
        communityTranslationUrl('T48n2005', 'Fabulu'),
        COMMUNITY_TRANSLATIONS_BASE + 'Fabulu/T/T48/T48n2005.xml'
    );
    assert.equal(
        communityTranslationUrl('ws.gateless-barrier', 'Fabulu'),
        OPEN_COMMUNITY_TRANSLATIONS_BASE + 'Fabulu/ws/gateless-barrier/gateless-barrier.xml'
    );
});

test('round-trip: OpenZen fileId → relPath → fileId', () => {
    const relPath = xmlUrlForFileId('ws.gateless-barrier');
    assert.equal(inferCorpusForRelPath(relPath), Corpus.OpenZen);
    const parts = relPath.split('/');
    const roundTrip = `${parts[0]}.${parts[1]}`;
    assert.equal(roundTrip, 'ws.gateless-barrier');
});
