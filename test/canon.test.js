// test/canon.test.js
// Unit tests for the canon list inspector (views/canon.js), its route
// (lib/route.js `canon`/`texts`), and the time-travel URL helper
// (lib/github.js dataFileUrlAtRef).
//
// The render tests drive views/canon.js with a string-capturing `mount` stub
// (the real view only assigns innerHTML and queries one <select>), plus mocked
// global.fetch/sessionStorage — the same headless recipe as test/titles.test.js.
// This test is fully independent of the off-limits #/dict WIP modules.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoute } from '../lib/route.js';
import {
    DATA_REPO_BASE,
    OPEN_DATA_REPO_BASE,
    dataFileUrlAtRef
} from '../lib/github.js';
import { match, render } from '../views/canon.js';
import * as cache from '../lib/cache.js';

const SHA = 'abc1234def5678';
const COMMITS_API =
    'https://api.github.com/repos/Fabulu/CbetaZenTranslations/commits?path=zen_texts.json';

// ---------- Route matching ----------

test('route: #/canon parses to kind canon with empty asOf', () => {
    const r = parseRoute('canon');
    assert.equal(r.kind, 'canon');
    assert.equal(r.asOf, '');
});

test('route: #/canon?asOf=<sha> carries the SHA', () => {
    const r = parseRoute('canon?asOf=' + SHA);
    assert.equal(r.kind, 'canon');
    assert.equal(r.asOf, SHA);
});

test('route: #/texts is an alias for the canon view', () => {
    assert.equal(parseRoute('texts').kind, 'canon');
});

test('match(): true only for canon routes', () => {
    assert.equal(match({ kind: 'canon' }), true);
    assert.equal(match({ kind: 'passage' }), false);
    assert.equal(match(null), false);
});

// ---------- dataFileUrlAtRef (time-travel URL builder) ----------

test('dataFileUrlAtRef: empty ref returns the current main URL', () => {
    assert.equal(dataFileUrlAtRef('', 'zen_texts.json'), DATA_REPO_BASE + 'zen_texts.json');
});

test('dataFileUrlAtRef: a ref swaps main for the SHA in the raw URL', () => {
    assert.equal(
        dataFileUrlAtRef(SHA, 'zen_texts.json'),
        'https://raw.githubusercontent.com/Fabulu/CbetaZenTranslations/' + SHA + '/zen_texts.json'
    );
});

// ---------- Shared render harness ----------

const CBETA_TITLES =
    '{"path":"T/T48/T48n2005.xml","fileId":"T48n2005","en":"The Gateless Barrier","enShort":"Gateless Barrier"}\n' +
    '{"path":"B/B14/B14n0082.xml","fileId":"B14n0082","en":"Some Zen Record"}\n';

const CANON_CURRENT = {
    Version: 2,
    listVersion: 'v2',
    listVersionDate: '2026-07-15T09:00:00Z',
    UpdatedUtc: '2026-07-15T09:00:00Z',
    Note: 'Curated allowlist of genuinely-Zen CBETA texts.',
    Zen: ['T/T48/T48n2005.xml', 'B/B14/B14n0082.xml']
};

const CANON_PAST = {
    Version: 1,
    listVersion: 'v1',
    listVersionDate: '2026-07-01T00:00:00Z',
    Zen: ['T/T48/T48n2005.xml']
};

const COMMITS = [
    { sha: SHA, commit: { author: { date: '2026-07-13T09:55:46Z' }, message: 'Add more texts' } },
    { sha: '0000000fedcba', commit: { author: { date: '2026-07-01T00:00:00Z' }, message: 'Initial list' } }
];

const CHANGELOG = '# Changelog\n\n## v2\n- Added B14n0082\n';

function jsonResponse(obj) {
    const body = JSON.stringify(obj);
    return { ok: true, status: 200, text: async () => body, json: async () => obj };
}
function textResponse(body) {
    return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) };
}
function notFound() {
    return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
}

/** Install mocked fetch + sessionStorage; returns the recorded fetch URLs. */
function installMocks(t) {
    const fetchCalls = [];
    const originalFetch = global.fetch;
    const originalSessionStorage = global.sessionStorage;
    const storage = new Map();
    global.sessionStorage = {
        getItem: (k) => (storage.has(k) ? storage.get(k) : null),
        setItem: (k, v) => { storage.set(k, String(v)); },
        removeItem: (k) => { storage.delete(k); },
        key: (i) => Array.from(storage.keys())[i] || null,
        get length() { return storage.size; }
    };

    global.fetch = async (url) => {
        fetchCalls.push(url);
        if (url === COMMITS_API) return jsonResponse(COMMITS);
        if (url.endsWith('CHANGELOG-zen-texts.md')) return textResponse(CHANGELOG);
        if (url.endsWith('titles.jsonl')) {
            return textResponse(url.startsWith(OPEN_DATA_REPO_BASE) ? '' : CBETA_TITLES);
        }
        if (url === dataFileUrlAtRef(SHA, 'zen_texts.json')) return jsonResponse(CANON_PAST);
        if (url === DATA_REPO_BASE + 'zen_texts.json') return jsonResponse(CANON_CURRENT);
        return notFound();
    };

    t.after(() => {
        global.fetch = originalFetch;
        global.sessionStorage = originalSessionStorage;
    });
    cache.clear();
    return fetchCalls;
}

function makeMount() {
    return { innerHTML: '', querySelector: () => null };
}
function makeShell() {
    return { setTitle() {}, setContext() {}, hideStatus() {} };
}

// ---------- Render: happy path (current version) ----------

test('render: current version lists texts with titles, versions, and changelog', async (t) => {
    const fetchCalls = installMocks(t);
    const mount = makeMount();

    await render({ kind: 'canon', asOf: '' }, mount, makeShell());
    const html = mount.innerHTML;

    // Fetched the current (main) canon file.
    assert.ok(fetchCalls.includes(DATA_REPO_BASE + 'zen_texts.json'),
        'should fetch the current zen_texts.json');

    // Card + version metadata.
    assert.match(html, /Zen Canon/);
    assert.match(html, /2 texts/);
    assert.match(html, /Current \(v2\)/);
    assert.match(html, /Viewing the current version/);

    // Titles resolved from titles.jsonl, linked to the passage route.
    assert.match(html, /Gateless Barrier/);
    assert.match(html, /href="#\/T48n2005"/);
    assert.match(html, /Some Zen Record/);
    assert.match(html, /href="#\/B14n0082"/);

    // Grouped by canon section (T and B present as group heads).
    assert.match(html, /canon-group-head/);

    // Time-travel picker offers the commit history.
    assert.match(html, /id="canon-version"/);
    assert.match(html, new RegExp(SHA));

    // Changelog embedded.
    assert.match(html, /Show changelog/);
    assert.match(html, /Added B14n0082/);
});

// ---------- Render: time-travel (as-of a past SHA) ----------

test('render: asOf fetches the pinned SHA and shows the past-version banner', async (t) => {
    const fetchCalls = installMocks(t);
    const mount = makeMount();

    await render({ kind: 'canon', asOf: SHA }, mount, makeShell());
    const html = mount.innerHTML;

    // Fetched zen_texts.json pinned to the SHA — NOT the current main URL.
    assert.ok(fetchCalls.includes(dataFileUrlAtRef(SHA, 'zen_texts.json')),
        'should fetch the SHA-pinned zen_texts.json');
    assert.ok(!fetchCalls.includes(DATA_REPO_BASE + 'zen_texts.json'),
        'should not fetch the current version when time-travelling');

    // Past list has a single text.
    assert.match(html, /1 text/);
    assert.match(html, /href="#\/T48n2005"/);
    assert.doesNotMatch(html, /href="#\/B14n0082"/);

    // Banner states we are viewing a past version + offers a way back.
    assert.match(html, /Viewing the list as of/);
    assert.match(html, /View current version/);
    assert.match(html, /href="#\/canon"/);
});

// ---------- Render: canon fetch failure degrades cleanly ----------

test('render: a failed canon fetch shows an empty-state card, not a crash', async (t) => {
    const originalFetch = global.fetch;
    const originalSessionStorage = global.sessionStorage;
    global.sessionStorage = {
        getItem: () => null, setItem: () => {}, removeItem: () => {},
        key: () => null, get length() { return 0; }
    };
    global.fetch = async () => notFound();
    t.after(() => {
        global.fetch = originalFetch;
        global.sessionStorage = originalSessionStorage;
    });
    cache.clear();

    const mount = makeMount();
    await render({ kind: 'canon', asOf: '' }, mount, makeShell());
    assert.match(mount.innerHTML, /Canon unavailable/);
});
