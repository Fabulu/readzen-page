// Build the browse full-text sidecar without changing the public data checkout.
// node build/build-zen-browse-search.js <termbase.v2.json> <output.json>
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { prepareDictionarySearchEntry } from '../views/dict-browse.js';

export function buildBrowseSearch(file) {
    const raw = file.Entries || file.entries || (Array.isArray(file) ? file : []);
    return { schemaVersion: 1, Entries: raw.map(entry => {
        const row = {
            id: entry.Id ?? entry.id,
            sourceTerm: entry.SourceTerm ?? entry.sourceTerm,
            senses: (entry.Senses || entry.senses || [entry]).map(sense => ({
                preferredTarget: sense.PreferredTarget ?? sense.preferredTarget ?? '',
                alternateTargets: sense.AlternateTargets ?? sense.alternateTargets ?? [],
                searchAliases: sense.SearchAliases ?? sense.searchAliases ?? [],
                explanation: sense.Explanation ?? sense.explanation ?? '',
                note: sense.Note ?? sense.note ?? '',
                status: sense.Status ?? sense.status ?? '',
                occurrences: sense.Occurrences ?? sense.occurrences ?? [],
            })),
        };
        prepareDictionarySearchEntry(row);
        return { id: row.id, sourceTerm: row.sourceTerm,
            senses: row.senses.map(sense => ({ preferredTarget: sense.preferredTarget })),
            _dictSearch: row._dictSearch };
    }).filter(row => row.sourceTerm) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [input, output] = process.argv.slice(2);
    if (!input || !output) throw new Error('Usage: build-zen-browse-search.js <input> <output>');
    const artifact = buildBrowseSearch(JSON.parse(await fs.readFile(input, 'utf8')));
    const text = JSON.stringify(artifact);
    await fs.writeFile(output, text + '\n');
    console.log(`${artifact.Entries.length} entries; ${Buffer.byteLength(text)} bytes; ${output}`);
}
