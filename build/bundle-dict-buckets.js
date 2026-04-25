#!/usr/bin/env node
// build/bundle-dict-buckets.js
//
// Reads per-character dict shards from dict/{char}.json and bundles them
// into numbered bucket files dict/{N}.json plus a manifest dict/_manifest.json.
//
// Usage: node build/bundle-dict-buckets.js

import { readdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DICT_DIR = resolve(__dirname, '..', 'dict');
const NUM_BUCKETS = 201;

// Read all per-character shards
const files = readdirSync(DICT_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'));
console.log(`Found ${files.length} shard files`);

const manifest = {};   // char -> bucket number
const buckets = {};     // bucket number -> { char: entries[] }

for (const file of files) {
    const char = file.replace('.json', '');
    if (!char) continue;

    const codePoint = char.codePointAt(0);
    const bucketId = codePoint % NUM_BUCKETS;

    manifest[char] = bucketId;

    if (!buckets[bucketId]) buckets[bucketId] = {};
    try {
        const entries = JSON.parse(readFileSync(join(DICT_DIR, file), 'utf8'));
        buckets[bucketId][char] = entries;
    } catch (e) {
        console.warn(`  Skipping ${file}: ${e.message}`);
    }
}

// Remove old per-character shards
for (const file of files) {
    const char = file.replace('.json', '');
    // Don't remove numbered bucket files we're about to write
    if (/^\d+$/.test(char)) continue;
    try { rmSync(join(DICT_DIR, file)); } catch {}
}

// Also remove old _index.json
try { rmSync(join(DICT_DIR, '_index.json')); } catch {}

// Write bucket files
let bucketCount = 0;
for (const [id, data] of Object.entries(buckets)) {
    writeFileSync(join(DICT_DIR, id + '.json'), JSON.stringify(data), 'utf8');
    bucketCount++;
}

// Write manifest
writeFileSync(join(DICT_DIR, '_manifest.json'), JSON.stringify(manifest), 'utf8');

console.log(`Wrote ${bucketCount} bucket files + _manifest.json`);
console.log(`Characters mapped: ${Object.keys(manifest).length}`);
