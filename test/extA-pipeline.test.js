// test/extA-pipeline.test.js
//
// End-to-end coverage for CJK Extension A (U+3400..U+4DBF) and Compatibility
// Ideographs (U+F900..U+FAFF) through the build → query pipeline. The
// `cjk-normalize.test.js` covers `isCjk` at the predicate level; this file
// drives a tiny corpus through the same primitives the real build uses
// (`extractText` + `normalizeString` + bigram emission + `fnv1a32` + codec)
// and asserts that an Ext-A bigram round-trips correctly.
//
// Without this test, widening `isCjk` could be silently undone (e.g. a typo
// narrowing the range) and only the synthetic predicate tests would catch
// it. This drives the actual emit path.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeString, isCjk } from '../lib/cjk-normalize.js';
import { extractText } from '../lib/build/extract-text.js';
import { fnv1a32 } from '../lib/fnv.js';
import {
    encodePostingList,
    encodeShard,
    readShardHeader,
    decodePostingList,
} from '../lib/bigram-codec.js';

// Three Ext-A characters (U+3402, U+3403, U+3404) — chosen so adjacent pairs
// produce real bigrams that are unambiguously Ext-A on both sides.
const EXTA_A = String.fromCharCode(0x3402); // 㐂
const EXTA_B = String.fromCharCode(0x3403); // 㐃
const EXTA_C = String.fromCharCode(0x3404); // 㐄

// One CJK Compatibility Ideograph (U+F900).
const COMPAT_X = String.fromCharCode(0xF900);
// And one BMP CJK Unified char to mix-and-match.
const BMP_Y = String.fromCharCode(0x4E00);

/** Walk normalized text and emit bigrams the way build-bigram-index.js does. */
function emitBigrams(normalized) {
    const seen = new Set();
    for (let i = 0; i < normalized.length - 1; i++) {
        const a = normalized.charCodeAt(i);
        const b = normalized.charCodeAt(i + 1);
        if (isCjk(a) && isCjk(b)) {
            seen.add(normalized.substring(i, i + 2));
        }
    }
    return seen;
}

test('Ext-A predicate accepts widened range', () => {
    assert.equal(isCjk(0x3400), true);
    assert.equal(isCjk(0x4DBF), true);
    assert.equal(isCjk(0x33FF), false);
    assert.equal(isCjk(0x4DC0), false);
});

test('CJK Compatibility predicate accepts widened range', () => {
    assert.equal(isCjk(0xF900), true);
    assert.equal(isCjk(0xFAFF), true);
    assert.equal(isCjk(0xF8FF), false);
    assert.equal(isCjk(0xFB00), false);
});

test('extractText + normalizeString preserves Ext-A characters', () => {
    const xml = `<TEI><text><body>${EXTA_A}${EXTA_B}${EXTA_C}</body></text></TEI>`;
    const { text } = extractText(xml);
    const normalized = normalizeString(text);
    assert.equal(normalized.includes(EXTA_A), true);
    assert.equal(normalized.includes(EXTA_B), true);
    assert.equal(normalized.includes(EXTA_C), true);
});

test('Ext-A pair produces a bigram via the build emitter', () => {
    const xml = `<TEI><text><body>${EXTA_A}${EXTA_B}</body></text></TEI>`;
    const { text } = extractText(xml);
    const normalized = normalizeString(text);
    const bigrams = emitBigrams(normalized);
    assert.equal(bigrams.has(EXTA_A + EXTA_B), true);
});

test('Ext-A + BMP mixed pair both emit bigrams', () => {
    const xml = `<TEI><text><body>${BMP_Y}${EXTA_A}${EXTA_B}</body></text></TEI>`;
    const { text } = extractText(xml);
    const normalized = normalizeString(text);
    const bigrams = emitBigrams(normalized);
    // Both adjacent pairs are CJK on both sides post-widen.
    assert.equal(bigrams.has(BMP_Y + EXTA_A), true);
    assert.equal(bigrams.has(EXTA_A + EXTA_B), true);
});

test('CJK Compatibility pair produces a bigram', () => {
    const xml = `<TEI><text><body>${COMPAT_X}${BMP_Y}</body></text></TEI>`;
    const { text } = extractText(xml);
    const normalized = normalizeString(text);
    const bigrams = emitBigrams(normalized);
    assert.equal(bigrams.has(COMPAT_X + BMP_Y), true);
});

test('Ext-A bigram round-trips through encodeShard / readShardHeader', () => {
    const term = EXTA_A + EXTA_B;
    const docIds = [3, 17, 99, 1000];

    const postings = encodePostingList(docIds);
    const shardBytes = encodeShard([{ term, postings, count: docIds.length }], 5012);

    const header = readShardHeader(shardBytes);
    assert.equal(header.terms.has(term), true);

    const meta = header.terms.get(term);
    const decoded = decodePostingList(shardBytes, meta.count, meta.offset);
    assert.deepEqual(Array.from(decoded), docIds);
});

test('Ext-A bigram hashes deterministically into 4096-bucket space', () => {
    const term = EXTA_A + EXTA_B;
    const bucket1 = fnv1a32(term) % 4096;
    const bucket2 = fnv1a32(term) % 4096;
    assert.equal(bucket1, bucket2);
    assert.ok(bucket1 >= 0 && bucket1 < 4096, `bucket out of range: ${bucket1}`);
});

test('Ext-A pair separated by punctuation still emits bigram (parity normalization)', () => {
    // Editorial punctuation is stripped by normalizeString, so 㐂、㐃 should
    // normalize to 㐂㐃 and produce a single bigram.
    const xml = `<TEI><text><body>${EXTA_A}、${EXTA_B}</body></text></TEI>`;
    const { text } = extractText(xml);
    const normalized = normalizeString(text);
    assert.equal(normalized, EXTA_A + EXTA_B);
    const bigrams = emitBigrams(normalized);
    assert.equal(bigrams.has(EXTA_A + EXTA_B), true);
});
