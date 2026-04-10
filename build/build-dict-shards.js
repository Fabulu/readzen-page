#!/usr/bin/env node
// build/build-dict-shards.js
//
// Reads the CC-CEDICT source file and writes one JSON shard per first
// traditional character into `../dict/{char}.json`, plus an index listing
// every shard character at `../dict/_index.json`.
//
// CC-CEDICT line format:
//   traditional simplified [pinyin] /definition 1/definition 2/.../
//
// Lines starting with `#` are comments and skipped. Blank lines skipped.
//
// Usage:
//   node build/build-dict-shards.js
//
// The source path defaults to the CBETA-Translator desktop app's bundled
// dictionary but can be overridden by setting the CEDICT_PATH env var.

import { createReadStream, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Default location: CEDICT bundled in this repo at build/cedict_ts.u8
const DEFAULT_SOURCE = resolve(__dirname, 'cedict_ts.u8');

const SOURCE_PATH = process.env.CEDICT_PATH || DEFAULT_SOURCE;
const OUT_DIR = resolve(__dirname, '..', 'dict');

// CEDICT entries are typically short; cap array length per shard defensively.
const MAX_ENTRIES_PER_SHARD = 20000;

/**
 * Parses one CC-CEDICT line into a shard entry, or returns `null` when the
 * line is a comment, blank, or malformed.
 */
function parseLine(line) {
    if (!line || line[0] === '#') return null;
    // Format: trad simp [pinyin] /def1/def2/.../
    // Split trad/simp as the first two space-separated tokens, then find the
    // bracketed pinyin and the slash-delimited definition tail.
    const firstSpace = line.indexOf(' ');
    if (firstSpace < 1) return null;
    const trad = line.substring(0, firstSpace);

    const secondSpace = line.indexOf(' ', firstSpace + 1);
    if (secondSpace < 0) return null;
    const simp = line.substring(firstSpace + 1, secondSpace);

    const openBracket = line.indexOf('[', secondSpace);
    const closeBracket = line.indexOf(']', openBracket + 1);
    if (openBracket < 0 || closeBracket < 0) return null;
    const pinyin = line.substring(openBracket + 1, closeBracket).trim();

    const slash = line.indexOf('/', closeBracket);
    if (slash < 0) return null;
    const tail = line.substring(slash + 1).replace(/\/\s*$/, '');
    const defs = tail
        .split('/')
        .map((s) => s.trim())
        .filter(Boolean);

    if (!trad || defs.length === 0) return null;
    return { trad, simp, pinyin, defs };
}

/**
 * Reads the CC-CEDICT file line by line and groups entries by the first
 * traditional character. Returns a `Map<char, entry[]>`.
 */
async function buildShards(sourcePath) {
    if (!existsSync(sourcePath)) {
        throw new Error(`CC-CEDICT source not found: ${sourcePath}`);
    }

    const shards = new Map();
    let totalLines = 0;
    let totalEntries = 0;

    const rl = createInterface({
        input: createReadStream(sourcePath, { encoding: 'utf8' }),
        crlfDelay: Infinity
    });

    for await (const rawLine of rl) {
        totalLines += 1;
        const entry = parseLine(rawLine);
        if (!entry) continue;
        totalEntries += 1;

        // Bucket by the first character of the traditional form. Uses the
        // full code-point iterator to handle surrogate pairs.
        const firstChar = [...entry.trad][0];
        if (!firstChar) continue;

        let bucket = shards.get(firstChar);
        if (!bucket) {
            bucket = [];
            shards.set(firstChar, bucket);
        }
        if (bucket.length < MAX_ENTRIES_PER_SHARD) {
            bucket.push(entry);
        }
    }

    return { shards, totalLines, totalEntries };
}

/** Clears any previous shard files so stale entries don't hang around. */
function clearShardDir() {
    if (!existsSync(OUT_DIR)) return;
    for (const name of readdirSync(OUT_DIR)) {
        if (name.endsWith('.json')) {
            try { rmSync(join(OUT_DIR, name)); } catch {}
        }
    }
}

/** Writes one JSON shard per bucket and the `_index.json` manifest. */
function writeShards(shards) {
    mkdirSync(OUT_DIR, { recursive: true });

    const indexChars = [];
    for (const [char, entries] of shards) {
        // Filename uses the raw character — all major filesystems support
        // Unicode filenames, and the front-end fetches `dict/{char}.json`.
        const filename = char + '.json';
        writeFileSync(
            join(OUT_DIR, filename),
            JSON.stringify(entries),
            'utf8'
        );
        indexChars.push(char);
    }

    indexChars.sort();
    writeFileSync(
        join(OUT_DIR, '_index.json'),
        JSON.stringify({
            source: 'CC-CEDICT',
            generatedAt: new Date().toISOString(),
            shardCount: indexChars.length,
            chars: indexChars
        }, null, 2),
        'utf8'
    );
}

async function main() {
    console.log(`Reading CC-CEDICT from: ${SOURCE_PATH}`);
    clearShardDir();

    const { shards, totalLines, totalEntries } = await buildShards(SOURCE_PATH);
    writeShards(shards);

    console.log(`Lines read       : ${totalLines}`);
    console.log(`Entries parsed   : ${totalEntries}`);
    console.log(`Shard files      : ${shards.size}`);
    console.log(`Output directory : ${OUT_DIR}`);
}

main().catch((error) => {
    console.error('build-dict-shards failed:', error);
    process.exitCode = 1;
});
