import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBrowseSearch } from '../build/build-zen-browse-search.js';
import { searchDictionaryEntries } from '../views/dict-browse.js';

test('browse search preserves every existing searchable field without rich cards', async () => {
    const artifact = buildBrowseSearch({ Entries: [{ Id: 'example', SourceTerm: 'headword', Senses: [{
        PreferredTarget: 'preferred', AlternateTargets: ['alternate'], SearchAliases: ['alias'],
        Explanation: 'explanation', Note: 'note', Status: 'status', Occurrences: [{ Kwic: 'passage' }],
    }] }] });
    for (const query of ['headword', 'preferred', 'alternate', 'alias', 'explanation', 'note', 'status', 'passage']) {
        assert.equal(searchDictionaryEntries(artifact.Entries, query).length, 1, query);
    }
    assert.equal(artifact.Entries[0].senses[0].occurrences, undefined);
    const calls = [];
    const previous = globalThis.fetch;
    globalThis.fetch = async url => {
        calls.push(String(url));
        const file = String(url).endsWith('termbase.index.json') ? { Terms: [['headword', 'preferred']] }
            : String(url).endsWith('termbase.search.json') ? artifact
            : { Entries: [{ SourceTerm: 'headword', Senses: [{ PreferredTarget: 'preferred', Explanation: 'full card' }] }] };
        return { ok: true, text: async () => JSON.stringify(file) };
    };
    try {
        const { loadZenBrowseIndex, loadZenBrowseSearch, loadZenEntry } = await import('../lib/zen-dict.js');
        const entries = await loadZenBrowseIndex();
        assert.equal(entries.length, 1);
        assert.equal(calls.length, 1, 'initial browse fetches only headword index');
        assert.equal((await loadZenBrowseSearch()).Entries, undefined);
        assert.equal(searchDictionaryEntries(await loadZenBrowseSearch(), 'passage').length, 1);
        const full = await loadZenEntry('headword', { allowFullFallback: false });
        assert.equal(full.senses[0].explanation, 'full card');
        assert.equal(calls.length, 3, 'one index, one search sidecar, one lazy shard');
        assert.equal(await loadZenEntry('unavailable', { allowFullFallback: false }), null);
        assert.ok(calls.every(url => !url.endsWith('termbase.v2.json')));
    } finally { globalThis.fetch = previous; }
});
