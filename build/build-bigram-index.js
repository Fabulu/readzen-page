#!/usr/bin/env node
// build/build-bigram-index.js
//
// Builds the SPA CJK bigram inverted index from the CBETA + OpenZen
// (+ translations + community) corpus. Replaces the Pagefind backend.
//
// Output layout:
//   data/search/bigram/manifest.json
//   data/search/bigram/docs.txt                   (line N = url for docId N)
//   data/search/bigram/shards/XX/YY-<hash6>.bin   (4096 hashed shards)
//   data/search/text/{XX}.bin                     (256 NDJSON text shards
//                                                  for verification step)
//
// Run with:
//   node --max-old-space-size=4096 --expose-gc build/build-bigram-index.js
// or `npm run build:search`
//
// Bump to --max-old-space-size=6144 only if rss > 3.8 GB.
//
// References:
//   runs/.../SYNTHESIS.md sections 1, 5
//   runs/.../IMPLEMENTATION_PLAN.md section 3 "W2.1"
//   build/build-pagefind-index.js  (env-var conventions, corpus walk)
//   lib/cjk-normalize.js           (normalizeString, isCjk)
//   lib/fnv.js                     (fnv1a32)
//   lib/bigram-codec.js            (encodePostingList, encodeShard)
//   lib/build/extract-text.js      (extractText)

import {
    readFileSync, readdirSync, existsSync,
    mkdirSync, writeFileSync, createWriteStream, rmSync,
} from 'fs';
import { join, relative, basename, dirname } from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';

import { normalizeString, isCjk } from '../lib/cjk-normalize.js';
import { fnv1a32 } from '../lib/fnv.js';
import { encodePostingList, encodeShard } from '../lib/bigram-codec.js';
import { extractText } from '../lib/build/extract-text.js';

// === Configuration (env-var conventions match build-pagefind-index.js) ===
const CBETA_XML_DIR = process.env.CBETA_XML_DIR || 'C:/Programmieren/CbetaZenTexts/xml-p5';
const OPENZEN_XML_DIR = process.env.OPENZEN_XML_DIR || 'C:/Programmieren/OpenZenTexts/xml-open';
const CBETA_TITLES = process.env.CBETA_TITLES || 'C:/Programmieren/CbetaZenTranslations/titles.jsonl';
const OPENZEN_TITLES = process.env.OPENZEN_TITLES || 'C:/Programmieren/OpenZenTranslations/titles.jsonl';
const CBETA_TRANSLATED_DIR = process.env.CBETA_TRANSLATED_DIR || 'C:/Programmieren/CbetaZenTranslations/xml-p5t';
const OPENZEN_TRANSLATED_DIR = process.env.OPENZEN_TRANSLATED_DIR || 'C:/Programmieren/OpenZenTranslations/xml-open-t';
const ZEN_TEXTS_PATH = process.env.ZEN_TEXTS_PATH || 'C:/Programmieren/CbetaZenTranslations/zen_texts.json';
const COMMUNITY_DIR = process.env.COMMUNITY_DIR || 'C:/Programmieren/CbetaZenTranslations/community/translations';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = dirname(dirname(__filename)); // .../ZenLinkPage
const OUTPUT_ROOT = join(REPO_ROOT, 'data', 'search');
const BIGRAM_DIR = join(OUTPUT_ROOT, 'bigram');
const SHARDS_DIR = join(BIGRAM_DIR, 'shards');
const TEXT_DIR = join(OUTPUT_ROOT, 'text');

const SHARD_COUNT = 4096;          // bigram shards (FNV-1a32 mod 4096)
const TEXT_SHARD_COUNT = 256;      // text shards (docId mod 256)
const MAX_DOC_COUNT = 65535;       // uint16 docId limit
const HASH_HEX_LEN = 6;            // first 6 hex of sha-256 of shard bytes

// === Helpers ===

function logMem(stage) {
    const mem = process.memoryUsage();
    const mb = (b) => (b / 1024 / 1024).toFixed(1);
    console.log(
        `  [mem] ${stage}: heapUsed=${mb(mem.heapUsed)}MB ` +
        `heapTotal=${mb(mem.heapTotal)}MB rss=${mb(mem.rss)}MB`
    );
}

function gcPause(label) {
    if (global.gc) {
        global.gc();
        if (label) console.log(`  [gc] after ${label}`);
    }
}

function ensureDir(dir) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function findXmlFiles(dir) {
    const results = [];
    if (!existsSync(dir)) return results;
    const stack = [dir];
    while (stack.length) {
        const d = stack.pop();
        let entries;
        try { entries = readdirSync(d, { withFileTypes: true }); }
        catch { continue; }
        for (const entry of entries) {
            const full = join(d, entry.name);
            if (entry.isDirectory()) stack.push(full);
            else if (entry.name.endsWith('.xml')) results.push(full);
        }
    }
    return results;
}

function loadTitles(path) {
    const titles = new Map();
    if (!existsSync(path)) return titles;
    const text = readFileSync(path, 'utf-8');
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
            const obj = JSON.parse(line);
            if (obj.path) titles.set(obj.path, obj);
        } catch { /* skip malformed line */ }
    }
    return titles;
}

function loadZenIds(path) {
    const ids = new Set();
    if (!existsSync(path)) return ids;
    try {
        const data = JSON.parse(readFileSync(path, 'utf-8'));
        for (const p of (data.Zen || [])) {
            ids.add(p.replace(/\.xml$/i, '').split('/').pop());
        }
    } catch { /* leave empty */ }
    return ids;
}

function hasTranslation(relPath, translatedDir) {
    return existsSync(join(translatedDir, relPath));
}

// === Document collection ===

/**
 * Collect documents from a single XML directory and append to docs[].
 * Returns the count appended.
 */
function walkAndIngest(docs, sourceDir, mapper) {
    const files = findXmlFiles(sourceDir);
    let appended = 0;
    for (const absPath of files) {
        const relPath = relative(sourceDir, absPath).replace(/\\/g, '/');
        let xml;
        try { xml = readFileSync(absPath, 'utf-8'); }
        catch { continue; }

        const { text } = extractText(xml);
        if (!text) continue;

        const meta = mapper(absPath, relPath);
        if (!meta) continue;

        // Normalize the extracted text once; all downstream consumers use the
        // normalized form (bigram emission, verification step at runtime).
        const normalized = normalizeString(text);

        docs.push({
            // docId assigned later (after collection complete).
            url: meta.url,
            fileId: meta.fileId,
            lang: meta.lang,
            title: meta.title,
            titleEn: meta.titleEn,
            translator: meta.translator || null,
            side: meta.side || null,
            normalized,
        });
        appended++;
        if (docs.length % 500 === 0) {
            console.log(`  collected ${docs.length} docs...`);
        }
    }
    return appended;
}

function collectDocuments(cbetaTitles, openzenTitles, zenIds) {
    const docs = [];

    // 1) CBETA source corpus (zh)
    console.log(`\nCBETA source: ${CBETA_XML_DIR}`);
    const cbetaCount = walkAndIngest(docs, CBETA_XML_DIR, (absPath, relPath) => {
        const fileId = basename(absPath, '.xml');
        const titleEntry = cbetaTitles.get(relPath) || {};
        return {
            url: '/' + fileId,
            fileId,
            lang: 'zh',
            title: titleEntry.zh || fileId,
            titleEn: titleEntry.en || '',
        };
    });
    console.log(`  +${cbetaCount} CBETA source docs`);

    // 2) OpenZen source corpus (zh)
    console.log(`\nOpenZen source: ${OPENZEN_XML_DIR}`);
    const ozCount = walkAndIngest(docs, OPENZEN_XML_DIR, (absPath, relPath) => {
        // Canonical OpenZen fileId is `<topDir>.<basename>` (e.g.
        // `ws.gateless-barrier`, `pd.wumenguan-1632`) — matches
        // titles.jsonl `fileId` field and ZenUriParser convention.
        const relParts = relPath.split('/').filter(Boolean);
        const topDir = relParts[0];
        const fileId = topDir + '.' + basename(absPath, '.xml');
        const titleEntry = openzenTitles.get(relPath) || {};
        return {
            url: '/' + fileId,
            fileId,
            lang: 'zh',
            title: titleEntry.zh || fileId,
            titleEn: titleEntry.en || '',
        };
    });
    console.log(`  +${ozCount} OpenZen source docs`);

    // 3) CBETA translations (en)
    console.log(`\nCBETA translations: ${CBETA_TRANSLATED_DIR}`);
    const cbetaTransCount = walkAndIngest(docs, CBETA_TRANSLATED_DIR, (absPath, relPath) => {
        const fileId = basename(absPath, '.xml');
        const titleEntry = cbetaTitles.get(relPath) || {};
        return {
            url: '/' + fileId + '?side=en',
            fileId,
            lang: 'en',
            title: titleEntry.en || titleEntry.zh || fileId,
            titleEn: titleEntry.en || '',
            side: 'translation',
        };
    });
    console.log(`  +${cbetaTransCount} CBETA translation docs`);

    // 4) OpenZen translations (en)
    console.log(`\nOpenZen translations: ${OPENZEN_TRANSLATED_DIR}`);
    const ozTransCount = walkAndIngest(docs, OPENZEN_TRANSLATED_DIR, (absPath, relPath) => {
        // Canonical OpenZen fileId — see step 2 comment.
        const relParts = relPath.split('/').filter(Boolean);
        const topDir = relParts[0];
        const fileId = topDir + '.' + basename(absPath, '.xml');
        const titleEntry = openzenTitles.get(relPath) || {};
        return {
            url: '/' + fileId + '?side=en',
            fileId,
            lang: 'en',
            title: titleEntry.en || titleEntry.zh || fileId,
            titleEn: titleEntry.en || '',
            side: 'translation',
        };
    });
    console.log(`  +${ozTransCount} OpenZen translation docs`);

    // 5) Community translations (en) — per translator subdirectory
    console.log(`\nCommunity: ${COMMUNITY_DIR}`);
    if (existsSync(COMMUNITY_DIR)) {
        const users = readdirSync(COMMUNITY_DIR, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name);
        console.log(`  translators: ${users.join(', ') || '(none)'}`);
        for (const user of users) {
            const userDir = join(COMMUNITY_DIR, user);
            const before = docs.length;
            walkAndIngest(docs, userDir, (absPath, relPath) => {
                const fileId = basename(absPath, '.xml');
                const titleEntry = cbetaTitles.get(relPath) || {};
                return {
                    url: '/' + fileId + '?side=community&translator=' + user,
                    fileId,
                    lang: 'en',
                    title: titleEntry.en || titleEntry.zh || fileId,
                    titleEn: titleEntry.en || '',
                    side: 'community',
                    translator: user,
                };
            });
            console.log(`  +${docs.length - before} from ${user}`);
        }
    } else {
        console.log('  (community dir not present, skipping)');
    }

    // Assign uint16 docIds in collection order. Hard-fail above the limit.
    if (docs.length > MAX_DOC_COUNT) {
        throw new Error(
            `docCount ${docs.length} exceeds uint16 limit (${MAX_DOC_COUNT}). ` +
            `Bump posting-list element type before continuing.`
        );
    }
    for (let i = 0; i < docs.length; i++) docs[i].docId = i;

    // Annotate zen flag for completeness (consumed by future filter logic).
    // currently unused; kept for parity with desktop schema.
    // OpenZen fileIds use `<publisher>.<slug>` shape; strip the publisher
    // prefix for zen-id lookup since zen_texts.json keys by slug only.
    for (const d of docs) {
        const slug = d.fileId.includes('.')
            ? d.fileId.substring(d.fileId.indexOf('.') + 1)
            : d.fileId;
        d.isZen = zenIds.has(slug) || zenIds.has(d.fileId);
    }

    return docs;
}

// === Bigram index build ===

/**
 * Build the in-memory bigram index from zh docs.
 * Each bigram lists each doc once (per-doc Set dedupes).
 * Returns Map<bigram:string, Uint16Array (sorted ascending)>.
 */
function buildBigramIndex(zhDocs) {
    // Two-stage: collect bigram -> Array<docId>; sort + uniq later.
    // Direct array push avoids per-doc per-bigram Set lookups outside the doc.
    const bigramToDocIds = new Map();

    let docCounter = 0;
    for (const doc of zhDocs) {
        const text = doc.normalized;
        if (!text || text.length < 2) { docCounter++; continue; }

        // Per-doc set: dedupe bigrams within a single doc.
        const seen = new Set();

        // Walk adjacent code-unit pairs. Both code units must satisfy
        // `isCjk()` (BMP CJK + Ext A).
        const len = text.length;
        let prevCu = text.charCodeAt(0);
        let prevIsCjk = isCjk(prevCu);
        for (let i = 1; i < len; i++) {
            const cu = text.charCodeAt(i);
            const cuIsCjk = isCjk(cu);
            if (prevIsCjk && cuIsCjk) {
                // Build the 2-char bigram. `substring` reuses interned 2-char
                // slices on V8.
                const bigram = text.substring(i - 1, i + 1);
                if (!seen.has(bigram)) {
                    seen.add(bigram);
                    let arr = bigramToDocIds.get(bigram);
                    if (arr === undefined) {
                        arr = [];
                        bigramToDocIds.set(bigram, arr);
                    }
                    arr.push(doc.docId);
                }
            }
            prevIsCjk = cuIsCjk;
        }

        docCounter++;
        if (docCounter % 500 === 0) {
            console.log(`  bigrams: processed ${docCounter}/${zhDocs.length} zh docs ` +
                `(${bigramToDocIds.size} distinct bigrams)`);
        }
    }

    // Convert each posting list to a sorted Uint16Array. Doc ids are already
    // appended in ascending order (we iterate docs by ascending docId), so
    // each list is already sorted ascending and unique. Verify in dev.
    const result = new Map();
    for (const [bigram, arr] of bigramToDocIds) {
        // Defensive sort + dedupe — cheap when already sorted.
        arr.sort((a, b) => a - b);
        // Dedupe (should be a no-op given the per-doc Set, but cheap insurance).
        let writeIdx = 0;
        for (let i = 0; i < arr.length; i++) {
            if (i === 0 || arr[i] !== arr[i - 1]) {
                arr[writeIdx++] = arr[i];
            }
        }
        const u16 = new Uint16Array(writeIdx);
        for (let i = 0; i < writeIdx; i++) u16[i] = arr[i];
        result.set(bigram, u16);
    }

    return result;
}

// === Sharding & writing ===

/**
 * Partition the bigram index into 4096 buckets via fnv1a32 mod 4096, encode
 * each non-empty bucket as a shard, write to disk, and return the per-bucket
 * manifest entries (a string: 6-hex content hash, or "0" for empty).
 */
function shardAndWrite(index, docCount) {
    // Pre-clear the shards directory so a rebuild with changed content (and
    // therefore changed content-hash filenames) doesn't leave stale orphan
    // files alongside the new ones — Cloudflare would happily upload both.
    if (existsSync(SHARDS_DIR)) {
        rmSync(SHARDS_DIR, { recursive: true, force: true });
    }

    // Group bigrams by bucket id.
    const buckets = new Array(SHARD_COUNT);
    for (let b = 0; b < SHARD_COUNT; b++) buckets[b] = null;

    for (const [bigram, postings] of index) {
        const bucket = fnv1a32(bigram) % SHARD_COUNT;
        let entry = buckets[bucket];
        if (entry === null) {
            entry = [];
            buckets[bucket] = entry;
        }
        entry.push({ term: bigram, postings });
    }

    const manifestShards = {};
    let written = 0;
    let totalShardBytes = 0;
    let totalPostings = 0;

    for (let b = 0; b < SHARD_COUNT; b++) {
        const xx = ((b >>> 8) & 0xff).toString(16).padStart(2, '0');
        const yy = (b & 0xff).toString(16).padStart(2, '0');
        const bucketKey = xx + yy; // 4-hex bucket id

        const entries = buckets[b];
        if (entries === null || entries.length === 0) {
            manifestShards[bucketKey] = '0';
            continue;
        }

        // Stable order within a shard: sort by term (deterministic builds).
        entries.sort((a, b) => (a.term < b.term ? -1 : a.term > b.term ? 1 : 0));

        // Encode each posting list as varint-delta bytes.
        const termList = entries.map(e => {
            const postBytes = encodePostingList(e.postings);
            totalPostings += e.postings.length;
            return { term: e.term, postings: postBytes, count: e.postings.length };
        });

        const shardBytes = encodeShard(termList, docCount);
        const hash6 = createHash('sha256')
            .update(shardBytes)
            .digest('hex')
            .slice(0, HASH_HEX_LEN);

        const subDir = join(SHARDS_DIR, xx);
        ensureDir(subDir);
        const fileName = `${yy}-${hash6}.bin`;
        const filePath = join(subDir, fileName);
        writeFileSync(filePath, shardBytes);

        manifestShards[bucketKey] = hash6;
        written++;
        totalShardBytes += shardBytes.length;

        // Free the bucket — these can be large.
        buckets[b] = null;

        if (written % 256 === 0) {
            gcPause(`shard ${written}`);
        }
        if (written % 512 === 0) {
            console.log(`  wrote ${written} shards (${totalShardBytes} bytes so far)`);
        }
    }

    return {
        manifestShards,
        nonEmptyCount: written,
        totalShardBytes,
        totalPostings,
    };
}

// === Manifest + docs.txt ===

function writeManifest(meta) {
    const manifest = {
        version: 1,
        builtAt: new Date().toISOString(),
        docCount: meta.docCount,
        shardCount: SHARD_COUNT,
        hashAlgo: 'fnv1a32',
        bigramCount: meta.bigramCount,
        nonEmptyShardCount: meta.nonEmptyShardCount,
        textShards: { count: TEXT_SHARD_COUNT, path: 'data/search/text/{XX}.bin' },
        shards: meta.manifestShards,
    };
    const path = join(BIGRAM_DIR, 'manifest.json');
    // Pretty-print for human readability; manifest is ~2 KB so cost is irrelevant.
    writeFileSync(path, JSON.stringify(manifest, null, 2));
    return path;
}

function writeDocList(docs) {
    // One URL per line. Line N (0-indexed) is the URL for docId N.
    const lines = new Array(docs.length);
    for (const d of docs) lines[d.docId] = d.url;
    const path = join(BIGRAM_DIR, 'docs.txt');
    writeFileSync(path, lines.join('\n') + '\n');
    return path;
}

// === Per-doc text shards ===
//
// Each shard at data/search/text/{XX}.bin is a UTF-8 NDJSON file with one
// {docId, text} record per line. text is the *normalized* text (the same
// form used for bigram emission). Bucket by docId mod 256.
//
// The verification step in lib/bigram-search.js fetches the shard for each
// candidate docId and runs text.indexOf(normalizedQuery) to enumerate true
// hit positions (bigrams are necessary, not sufficient).

function writeTextShards(docs) {
    ensureDir(TEXT_DIR);

    // Group docs by docId % 256. Use streams to avoid building 256 huge
    // strings in memory simultaneously.
    const streams = new Array(TEXT_SHARD_COUNT);
    for (let i = 0; i < TEXT_SHARD_COUNT; i++) {
        const xx = i.toString(16).padStart(2, '0');
        streams[i] = createWriteStream(join(TEXT_DIR, `${xx}.bin`), { encoding: 'utf-8' });
    }

    let totalBytes = 0;
    for (const d of docs) {
        const bucket = d.docId % TEXT_SHARD_COUNT;
        const line = JSON.stringify({ docId: d.docId, text: d.normalized }) + '\n';
        streams[bucket].write(line);
        totalBytes += Buffer.byteLength(line, 'utf-8');
    }

    return Promise.all(streams.map((s, i) => new Promise((resolve, reject) => {
        s.end(err => err ? reject(err) : resolve(i));
    }))).then(() => totalBytes);
}

// === Main ===

async function main() {
    const t0 = Date.now();
    console.log('=== build-bigram-index ===');
    console.log(`output root: ${OUTPUT_ROOT}`);

    // Prepare output dirs.
    ensureDir(BIGRAM_DIR);
    ensureDir(SHARDS_DIR);
    ensureDir(TEXT_DIR);

    // ---- 1. Load titles ----
    const cbetaTitles = loadTitles(CBETA_TITLES);
    const openzenTitles = loadTitles(OPENZEN_TITLES);
    console.log(`titles: ${cbetaTitles.size} CBETA, ${openzenTitles.size} OpenZen`);

    // ---- 2. Load zen ids ----
    const zenIds = loadZenIds(ZEN_TEXTS_PATH);
    console.log(`zen ids: ${zenIds.size}`);

    // ---- 3. Collect documents ----
    console.log('\n--- collectDocuments ---');
    const docs = collectDocuments(cbetaTitles, openzenTitles, zenIds);
    const docCount = docs.length;
    const zhDocs = docs.filter(d => d.lang === 'zh');
    console.log(`\nTotal: ${docCount} docs (${zhDocs.length} zh, ${docCount - zhDocs.length} en)`);
    logMem('after collectDocuments');
    gcPause('collectDocuments');

    // ---- 4. Build bigram index ----
    // Pass ALL docs (not just zh): the inner CJK-pair gate
    // (`prevIsCjk && cuIsCjk`) ensures English-side docs contribute ~zero
    // bigrams, but stray CJK in English glosses (e.g. inline names) is
    // correctly indexed. This unifies the docId space so translations and
    // community docs participate in CJK fulltext queries.
    console.log('\n--- buildBigramIndex ---');
    const index = buildBigramIndex(docs);
    const bigramCount = index.size;
    let totalPostings = 0;
    for (const arr of index.values()) totalPostings += arr.length;
    console.log(`distinct bigrams: ${bigramCount}`);
    console.log(`total postings:   ${totalPostings}`);
    logMem('after buildBigramIndex');

    // We can drop normalized text from non-zh docs once bigram index is built,
    // but we still need normalized text for the per-doc text shards (used by
    // runtime verification). Keep `docs[].normalized` until writeTextShards.
    gcPause('buildBigramIndex');

    // ---- 5. Shard and write ----
    console.log('\n--- shardAndWrite ---');
    const shardResult = shardAndWrite(index, docCount);
    console.log(`wrote ${shardResult.nonEmptyCount} non-empty shards ` +
        `(${SHARD_COUNT - shardResult.nonEmptyCount} empty), ` +
        `${shardResult.totalShardBytes} bytes total`);
    logMem('after shardAndWrite');

    // Drop the index now that it's been written.
    index.clear();
    gcPause('shardAndWrite');

    // ---- 6. Manifest + docs.txt ----
    console.log('\n--- writeManifest + writeDocList ---');
    const manifestPath = writeManifest({
        docCount,
        bigramCount,
        nonEmptyShardCount: shardResult.nonEmptyCount,
        manifestShards: shardResult.manifestShards,
    });
    const docsPath = writeDocList(docs);
    console.log(`manifest: ${manifestPath}`);
    console.log(`docs.txt: ${docsPath}`);

    // ---- 7. Per-doc text shards ----
    console.log('\n--- writeTextShards ---');
    const textBytes = await writeTextShards(docs);
    console.log(`wrote ${TEXT_SHARD_COUNT} text shards, ${textBytes} bytes total`);
    logMem('after writeTextShards');

    // ---- 8. Summary ----
    const t1 = Date.now();
    const wallSec = ((t1 - t0) / 1000).toFixed(1);
    console.log('\n=== summary ===');
    console.log(`docCount:           ${docCount}`);
    console.log(`bigramCount:        ${bigramCount}`);
    console.log(`nonEmptyShards:     ${shardResult.nonEmptyCount} / ${SHARD_COUNT}`);
    console.log(`totalShardBytes:    ${shardResult.totalShardBytes}`);
    console.log(`textShardBytes:     ${textBytes}`);
    console.log(`totalPostings:      ${totalPostings}`);
    console.log(`wall time:          ${wallSec}s`);
    logMem('final');
}

main().catch(err => {
    console.error('FATAL:', err);
    process.exit(1);
});
