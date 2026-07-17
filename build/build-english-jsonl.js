#!/usr/bin/env node
// build/build-english-jsonl.js
// Emits data/search/english.jsonl: one NDJSON record per English-side
// corpus file (CBETA translations + OpenZen translations + community
// translations). Wave 2 task W2.2 of the SPA bigram-index port.
//
// Per-record shape:
//   { fileId, translator?, side: 'translation', titleEn, text }
// where `text` is lowercased and whitespace-collapsed for case-insensitive
// substring scan at runtime (lib/search.js Latin path).
//
// Usage: node build/build-english-jsonl.js
// No new dependencies. ESM module. Node-only.
//
// WARN if output > 5 MB (current ~3.5 MB).
//
// === Environment variables ===
//   CBETA_TRANSLATED_DIR    CBETA translation XML root
//                           (default: C:/Programmieren/CbetaZenTranslations/xml-p5t)
//   OPENZEN_TRANSLATED_DIR  OpenZen translation XML root
//                           (default: C:/Programmieren/OpenZenTranslations/xml-open-t)
//   COMMUNITY_DIR           Per-translator community translations root
//                           (default: C:/Programmieren/CbetaZenTranslations/community/translations)
//   CBETA_TITLES            CBETA titles JSONL
//                           (default: C:/Programmieren/CbetaZenTranslations/titles.jsonl)
//   OPENZEN_TITLES          OpenZen titles JSONL
//                           (default: C:/Programmieren/OpenZenTranslations/titles.jsonl)

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, statSync } from 'fs';
import { join, relative, basename, dirname } from 'path';
import { fileURLToPath } from 'url';
import { extractText } from '../lib/build/extract-text.js';
import { englishNormalize } from '../lib/english-normalize.js';

// === Configuration (env-overridable, mirrors build-pagefind-index.js) ===
const CBETA_TRANSLATED_DIR = process.env.CBETA_TRANSLATED_DIR || 'C:/Programmieren/CbetaZenTranslations/xml-p5t';
const OPENZEN_TRANSLATED_DIR = process.env.OPENZEN_TRANSLATED_DIR || 'C:/Programmieren/OpenZenTranslations/xml-open-t';
const COMMUNITY_DIR = process.env.COMMUNITY_DIR || 'C:/Programmieren/CbetaZenTranslations/community/translations';
const CBETA_TITLES = process.env.CBETA_TITLES || 'C:/Programmieren/CbetaZenTranslations/titles.jsonl';
const OPENZEN_TITLES = process.env.OPENZEN_TITLES || 'C:/Programmieren/OpenZenTranslations/titles.jsonl';

// Output path is relative to repo root (one level up from build/).
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const OUTPUT_PATH = join(REPO_ROOT, 'data', 'search', 'english.jsonl');

const MAX_BYTES_WARN = 5 * 1024 * 1024; // 5 MB threshold

// Count of source files skipped (readdir/read failures, empty extractions).
// Every skip is logged loudly via console.error with the absolute path.
let skipped = 0;

// === Title loader (JSONL, keyed by `path`) ===
function loadTitles(path) {
    const titles = new Map();
    if (!existsSync(path)) return titles;
    const text = readFileSync(path, 'utf-8');
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            const obj = JSON.parse(trimmed);
            if (obj.path) titles.set(obj.path, obj);
        } catch {
            // Ignore malformed lines.
        }
    }
    return titles;
}

// === Recursive XML walker ===
function findXmlFiles(dir) {
    const results = [];
    if (!existsSync(dir)) return results;
    function walk(d) {
        let entries;
        try {
            entries = readdirSync(d, { withFileTypes: true });
        } catch (err) {
            console.error(`  SKIP (readdir error): ${d} :: ${err.message}`);
            skipped++;
            return;
        }
        // Deterministic order: plain default string sort (UTF-16 code-unit
        // order, locale-independent) so dirs and files are visited sorted.
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const entry of entries) {
            const full = join(d, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith('.xml')) results.push(full);
        }
    }
    walk(dir);
    return results;
}

// === Normalize body text for substring scan ===
// Lowercase, then collapse all whitespace runs to single spaces, then trim.
// Promoted to the shared lib/english-normalize.js module so the bigram index
// build emits English terms from the byte-identical normalization (one skew
// surface — see that module's header).
const normalizeForSearch = englishNormalize;

// === Per-record builder ===
function buildRecord(absPath, opts) {
    const { fileId, translator, titleEn } = opts;
    let xml;
    try {
        xml = readFileSync(absPath, 'utf-8');
    } catch (err) {
        console.error(`  SKIP (read error): ${absPath} :: ${err.message}`);
        skipped++;
        return null;
    }
    // captureLb: false for performance — anchors are not needed here.
    const { text } = extractText(xml, { captureLb: false });
    const norm = normalizeForSearch(text);
    if (!norm) {
        console.error(`  SKIP (empty extraction): ${absPath}`);
        skipped++;
        return null;
    }
    const rec = {
        fileId,
        side: 'translation',
        titleEn: titleEn || fileId,
        text: norm,
    };
    if (translator) rec.translator = translator;
    return rec;
}

// === Title resolution helpers ===
function pickTitleEn(titleEntry) {
    if (!titleEntry) return '';
    return titleEntry.en || titleEntry.enShort || titleEntry.zh || '';
}

// === Main ===
function main() {
    const t0 = Date.now();
    console.log('Building data/search/english.jsonl ...');

    const cbetaTitles = loadTitles(CBETA_TITLES);
    const openzenTitles = loadTitles(OPENZEN_TITLES);
    console.log(`  loaded ${cbetaTitles.size} CBETA titles, ${openzenTitles.size} OpenZen titles`);

    const records = [];

    // --- CBETA translations: xml-p5t/<canon>/<vol>/<file>.xml ---
    const cbetaFiles = findXmlFiles(CBETA_TRANSLATED_DIR);
    console.log(`  CBETA translations: ${cbetaFiles.length} files`);
    for (const absPath of cbetaFiles) {
        const relPath = relative(CBETA_TRANSLATED_DIR, absPath).replace(/\\/g, '/');
        const fileId = basename(absPath, '.xml');
        const titleEntry = cbetaTitles.get(relPath);
        const titleEn = pickTitleEn(titleEntry);
        const rec = buildRecord(absPath, { fileId, translator: undefined, titleEn });
        if (rec) records.push(rec);
    }

    // --- OpenZen translations: xml-open-t/<rel>.xml (may be empty pre-launch) ---
    const openzenFiles = findXmlFiles(OPENZEN_TRANSLATED_DIR);
    console.log(`  OpenZen translations: ${openzenFiles.length} files`);
    for (const absPath of openzenFiles) {
        const relPath = relative(OPENZEN_TRANSLATED_DIR, absPath).replace(/\\/g, '/');
        // OpenZen titles file has fileId baked in; prefer that, else derive
        // canonical `<topDir>.<basename>` (e.g. `ws.gateless-barrier`).
        const titleEntry = openzenTitles.get(relPath);
        const relParts = relPath.split('/').filter(Boolean);
        const derivedFileId = relParts.length >= 2
            ? relParts[0] + '.' + basename(absPath, '.xml')
            : basename(absPath, '.xml');
        const fileId = (titleEntry && titleEntry.fileId) || derivedFileId;
        const titleEn = pickTitleEn(titleEntry);
        const rec = buildRecord(absPath, { fileId, translator: undefined, titleEn });
        if (rec) records.push(rec);
    }

    // --- Community translations: community/translations/<user>/<canon>/<vol>/<file>.xml ---
    if (existsSync(COMMUNITY_DIR)) {
        let users;
        try {
            users = readdirSync(COMMUNITY_DIR, { withFileTypes: true })
                .filter(d => d.isDirectory())
                .map(d => d.name)
                .sort(); // deterministic UTF-16 code-unit order
        } catch (err) {
            console.error(`  SKIP (readdir error): ${COMMUNITY_DIR} :: ${err.message}`);
            skipped++;
            users = [];
        }
        console.log(`  Community translators: ${users.length} (${users.join(', ')})`);
        for (const user of users) {
            const userDir = join(COMMUNITY_DIR, user);
            const userFiles = findXmlFiles(userDir);
            for (const absPath of userFiles) {
                const relPath = relative(userDir, absPath).replace(/\\/g, '/');
                const fileId = basename(absPath, '.xml');
                // Community files reuse the CBETA title map (they translate
                // CBETA originals).
                const titleEntry = cbetaTitles.get(relPath);
                const titleEn = pickTitleEn(titleEntry);
                const rec = buildRecord(absPath, { fileId, translator: user, titleEn });
                if (rec) records.push(rec);
            }
            console.log(`    ${user}: ${userFiles.length} files`);
        }
    } else {
        console.log(`  Community dir not present: ${COMMUNITY_DIR}`);
    }

    // --- Authoritative determinism pin: sort records regardless of walk
    // order, by (fileId, translator, side) using plain string comparison
    // (UTF-16 code-unit order, locale-independent). ---
    const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    records.sort((a, b) =>
        cmp(a.fileId, b.fileId) ||
        cmp(a.translator || '', b.translator || '') ||
        cmp(a.side || '', b.side || ''));

    // --- Emit NDJSON ---
    mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
    const ndjson = records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
    writeFileSync(OUTPUT_PATH, ndjson, 'utf-8');

    const stat = statSync(OUTPUT_PATH);
    const sizeMB = stat.size / (1024 * 1024);
    if (stat.size > MAX_BYTES_WARN) {
        console.warn(`  WARNING: output size ${sizeMB.toFixed(2)} MB exceeds 5 MB threshold`);
    }

    const elapsed = Date.now() - t0;
    console.log(`english.jsonl: ${records.length} records, ${skipped} skipped`);
    console.log(`Done. ${records.length} records, ${stat.size} bytes (${sizeMB.toFixed(3)} MB), ${elapsed} ms.`);
    console.log(`Output: ${OUTPUT_PATH}`);
}

main();
