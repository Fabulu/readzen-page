#!/usr/bin/env node
// build/build-bigram-index.js
//
// Builds the SPA CJK inverted index (v3: bigram + unigram, tf-carrying) from
// the CBETA + OpenZen (+ translations + community) corpus.
//
// Output layout:
//   data/search/bigram/manifest.json                     (version 3)
//   data/search/bigram/docs.txt                          (line N = url for docId N)
//   data/search/bigram/shards/XX/YY-<hash6>.bin          (4096 hashed bigram shards, v3)
//   data/search/bigram/unigram/XX/YY-<hash6>.bin         (4096 hashed unigram shards, v3)
//   data/search/text/{XXX}.bin                           (4096 NDJSON text shards
//                                                         for phrase verification)
//
// v3 shards (see lib/bigram-codec.js encodeShardV3) carry a per-doc term
// frequency after each docId gap, so ranking is index-only at runtime — text
// shards are only fetched to phrase-verify the rows actually displayed.
//
// Determinism: every directory listing is sorted before traversal, so docId
// assignment (and therefore every posting list and shard hash) is a pure
// function of corpus content. Every skipped source file/directory is logged
// loudly and counted in manifest.skippedFiles.
//
// Run with:
//   node --max-old-space-size=4096 --expose-gc build/build-bigram-index.js
//
// Bump to --max-old-space-size=6144 only if rss > 3.8 GB.
//
// References:
//   lib/cjk-normalize.js           (normalizeString, isCjk)
//   lib/fnv.js                     (fnv1a32)
//   lib/bigram-codec.js            (encodeShardV3, readShardHeader,
//                                   decodePostingListV3)
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
import { encodeShardV3, readShardHeader, decodePostingListV3 } from '../lib/bigram-codec.js';
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
// Output root is overridable for smoke tests against fixture corpora
// (default unchanged: <repo>/data/search, gitignored).
const OUTPUT_ROOT = process.env.SEARCH_OUTPUT_ROOT || join(REPO_ROOT, 'data', 'search');
const BIGRAM_DIR = join(OUTPUT_ROOT, 'bigram');
const SHARDS_DIR = join(BIGRAM_DIR, 'shards');
const UNIGRAM_DIR = join(BIGRAM_DIR, 'unigram');
const TEXT_DIR = join(OUTPUT_ROOT, 'text');

const SHARD_COUNT = 4096;          // bigram AND unigram shards (FNV-1a32 mod 4096)
const TEXT_SHARD_COUNT = 4096;     // text shards (docId mod 4096) — smaller per-shard fetches
const MAX_DOC_COUNT = 65535;       // uint16 docId limit
const HASH_HEX_LEN = 6;            // first 6 hex of sha-256 of shard bytes
const VALIDATION_SAMPLE = 16;      // min shards read back per set for round-trip check

// Count of source files/directories silently skipped during the build.
// Surfaced in the manifest (observability / determinism audit #7).
let skippedFiles = 0;

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

// Loud skip: log absolute path + reason, count it (manifest.skippedFiles).
function logSkip(absPath, reason) {
    skippedFiles++;
    console.error(`  [skip] ${absPath}: ${reason}`);
}

/**
 * Deterministic DFS over an XML tree. Every readdirSync listing is sorted
 * (plain code-unit string sort) so traversal order — and therefore docId
 * assignment — never depends on filesystem enumeration order (audit #7).
 * Within a directory, files come first (sorted), then subdirectories are
 * descended in sorted order.
 */
function findXmlFiles(dir) {
    const results = [];
    if (!existsSync(dir)) return results;
    const stack = [dir];
    while (stack.length) {
        const d = stack.pop();
        let entries;
        try { entries = readdirSync(d, { withFileTypes: true }); }
        catch (err) {
            logSkip(d, `unreadable directory (${err.message})`);
            continue;
        }
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        const subdirs = [];
        for (const entry of entries) {
            const full = join(d, entry.name);
            if (entry.isDirectory()) subdirs.push(full);
            else if (entry.name.endsWith('.xml')) results.push(full);
        }
        // Push in reverse so the LIFO stack pops subdirectories in
        // ascending sorted order.
        for (let i = subdirs.length - 1; i >= 0; i--) stack.push(subdirs[i]);
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
        catch (err) {
            logSkip(absPath, `unreadable file (${err.message})`);
            continue;
        }

        const { text } = extractText(xml);
        if (!text) {
            logSkip(absPath, 'extracted text is empty');
            continue;
        }

        const meta = mapper(absPath, relPath);
        if (!meta) continue;

        // Normalize the extracted text once; all downstream consumers use the
        // normalized form (term emission, verification step at runtime).
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
        // Sorted for deterministic docId assignment (audit #7).
        const users = readdirSync(COMMUNITY_DIR, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name)
            .sort();
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

// === Term index build (bigram + unigram, with term frequency) ===

/**
 * Flush a per-doc Map<term, tf> into the global interleaved index
 * Map<term, number[]> where each array is [docId, tf, docId, tf, ...] with
 * docIds strictly ascending (guaranteed by iterating docs in docId order —
 * asserted, never re-sorted).
 */
function flushDocTerms(globalIndex, docTfs, docId) {
    for (const [term, tf] of docTfs) {
        let arr = globalIndex.get(term);
        if (arr === undefined) {
            arr = [];
            globalIndex.set(term, arr);
        } else if (arr[arr.length - 2] >= docId) {
            // Postings are appended in ascending doc order by construction;
            // a violation means docId assignment broke — hard-fail.
            throw new Error(
                `flushDocTerms: docId ${docId} for term "${term}" not ascending ` +
                `(last was ${arr[arr.length - 2]})`
            );
        }
        arr.push(docId, tf);
    }
}

/**
 * Build the in-memory term indexes from all docs in one pass:
 *   - bigram: every adjacent CJK code-unit pair, counted per occurrence (tf)
 *   - unigram: every CJK code unit, counted per occurrence (tf)
 * Returns { bigramIndex, unigramIndex }, each Map<term, number[]> with
 * interleaved [docId, tf, ...] postings (docIds ascending unique).
 */
function buildTermIndexes(docs) {
    const bigramIndex = new Map();
    const unigramIndex = new Map();

    let docCounter = 0;
    for (const doc of docs) {
        const text = doc.normalized;
        if (!text) { docCounter++; continue; }

        // Per-doc tf accumulators (audit #1: count occurrences, not a dedupe
        // Set; audit #4: unigrams captured in the same char walk).
        //
        // Counting convention: NON-OVERLAPPING occurrences, matching the
        // runtime's countSubstringHits greedy walk (pos = idx + len), the v2
        // text-verification pipeline, and the KWIC expansion — so the tf a
        // v3 shard reports for a self-overlapping bigram (e.g. 無無 in a run
        // 無無無) equals the count every display path computes (1, not 2).
        // Only a bigram of two IDENTICAL code units can self-overlap, and
        // only at consecutive start positions, i.e. inside a run of the same
        // char: greedily count it at every other position of that run.
        const bigramTfs = new Map();
        const unigramTfs = new Map();

        const len = text.length;
        let prevIsCjk = isCjk(text.charCodeAt(0));
        if (prevIsCjk) {
            unigramTfs.set(text[0], 1);
        }
        let eqRunStart = 0; // start index of the current run of identical code units
        for (let i = 1; i < len; i++) {
            const cu = text.charCodeAt(i);
            const cuIsCjk = isCjk(cu);
            if (cu !== text.charCodeAt(i - 1)) eqRunStart = i;
            if (cuIsCjk) {
                // Unigram: single UTF-16 code unit (corpus is BMP-dominated;
                // matches what the pair loop indexes). Length-1 needles can't
                // overlap, so every occurrence counts.
                const ch = text[i];
                unigramTfs.set(ch, (unigramTfs.get(ch) || 0) + 1);
                if (prevIsCjk) {
                    // Bigram: both code units CJK per cjk-normalize.isCjk.
                    // Self-pair (XX): count only at even offsets within the
                    // identical-char run (greedy non-overlapping).
                    if (cu !== text.charCodeAt(i - 1) || (i - 1 - eqRunStart) % 2 === 0) {
                        const bigram = text.substring(i - 1, i + 1);
                        bigramTfs.set(bigram, (bigramTfs.get(bigram) || 0) + 1);
                    }
                }
            }
            prevIsCjk = cuIsCjk;
        }

        // Flush once per doc: appends (docId, tf) pairs in ascending doc order.
        flushDocTerms(bigramIndex, bigramTfs, doc.docId);
        flushDocTerms(unigramIndex, unigramTfs, doc.docId);

        docCounter++;
        if (docCounter % 500 === 0) {
            console.log(`  terms: processed ${docCounter}/${docs.length} docs ` +
                `(${bigramIndex.size} bigrams, ${unigramIndex.size} unigrams)`);
        }
    }

    return { bigramIndex, unigramIndex };
}

/** Total postings (docId,tf pairs) across an interleaved index. */
function countPostings(index) {
    let total = 0;
    for (const arr of index.values()) total += arr.length >>> 1;
    return total;
}

// === Sharding & writing ===

/**
 * Partition an interleaved term index into 4096 buckets via fnv1a32 mod 4096,
 * encode each non-empty bucket as a v3 shard, write to disk under shardsDir
 * ({XX}/{YY}-{hash6}.bin, hash6 = first 6 hex of sha-256 of shard bytes),
 * and return the per-bucket manifest entries ("0" sentinel for empty).
 *
 * Memory: the source index is CLEARED as soon as bucketing completes (posting
 * arrays stay referenced only by their bucket and are freed bucket-by-bucket
 * after encoding) — no double-hold of raw + converted copies.
 *
 * Validation: a random sample of >= VALIDATION_SAMPLE written shards is read
 * back via readShardHeader + decodePostingListV3 and one full posting list per
 * sampled shard is compared against the in-memory data. Throws on mismatch.
 */
function shardAndWrite(index, docCount, shardsDir, label) {
    // Pre-clear the shards directory so a rebuild with changed content (and
    // therefore changed content-hash filenames) doesn't leave stale orphan
    // files alongside the new ones — Cloudflare would happily upload both.
    if (existsSync(shardsDir)) {
        rmSync(shardsDir, { recursive: true, force: true });
    }

    // Group terms by bucket id.
    const buckets = new Array(SHARD_COUNT);
    for (let b = 0; b < SHARD_COUNT; b++) buckets[b] = null;

    for (const [term, interleaved] of index) {
        const bucket = fnv1a32(term) % SHARD_COUNT;
        let entry = buckets[bucket];
        if (entry === null) {
            entry = [];
            buckets[bucket] = entry;
        }
        entry.push({ term, interleaved });
    }

    // The buckets now hold the only needed references to the posting arrays;
    // drop the map entries so each array is freed with its bucket.
    index.clear();

    // Pick the read-back validation sample among non-empty buckets.
    const nonEmptyBuckets = [];
    for (let b = 0; b < SHARD_COUNT; b++) {
        if (buckets[b] !== null && buckets[b].length > 0) nonEmptyBuckets.push(b);
    }
    const sampleSize = Math.min(VALIDATION_SAMPLE, nonEmptyBuckets.length);
    for (let i = 0; i < sampleSize; i++) {
        const j = i + Math.floor(Math.random() * (nonEmptyBuckets.length - i));
        const tmp = nonEmptyBuckets[i];
        nonEmptyBuckets[i] = nonEmptyBuckets[j];
        nonEmptyBuckets[j] = tmp;
    }
    const sampleBuckets = new Set(nonEmptyBuckets.slice(0, sampleSize));
    const validationRecords = [];

    const manifestShards = {};
    let written = 0;
    let totalShardBytes = 0;
    let totalPostings = 0;
    let termCount = 0;

    for (let b = 0; b < SHARD_COUNT; b++) {
        const xx = ((b >>> 8) & 0xff).toString(16).padStart(2, '0');
        const yy = (b & 0xff).toString(16).padStart(2, '0');
        const bucketKey = xx + yy; // 4-hex bucket id

        const entries = buckets[b];
        if (entries === null || entries.length === 0) {
            manifestShards[bucketKey] = '0';
            continue;
        }

        // Split each interleaved [docId, tf, ...] run into the typed pair
        // arrays encodeShardV3 expects. (encodeShardV3 sorts terms internally
        // in UTF-16 code-unit order, so shard bytes are deterministic.)
        const termList = entries.map(e => {
            const arr = e.interleaved;
            const n = arr.length >>> 1;
            const docIds = new Uint16Array(n);
            const tfs = new Uint32Array(n);
            for (let i = 0; i < n; i++) {
                docIds[i] = arr[2 * i];
                tfs[i] = arr[2 * i + 1];
            }
            totalPostings += n;
            return { term: e.term, docIds, tfs };
        });
        termCount += termList.length;

        const shardBytes = encodeShardV3(termList, docCount);
        const hash6 = createHash('sha256')
            .update(shardBytes)
            .digest('hex')
            .slice(0, HASH_HEX_LEN);

        const subDir = join(shardsDir, xx);
        ensureDir(subDir);
        const fileName = `${yy}-${hash6}.bin`;
        const filePath = join(subDir, fileName);
        writeFileSync(filePath, shardBytes);

        manifestShards[bucketKey] = hash6;
        written++;
        totalShardBytes += shardBytes.length;

        // Stash a validation record for sampled buckets: term count plus one
        // full posting list (references to the freshly built typed arrays —
        // nothing mutates them after this point).
        if (sampleBuckets.has(b)) {
            const pick = termList[Math.floor(Math.random() * termList.length)];
            validationRecords.push({
                filePath,
                termCount: termList.length,
                term: pick.term,
                docIds: pick.docIds,
                tfs: pick.tfs,
            });
        }

        // Free the bucket — these can be large.
        buckets[b] = null;

        if (written % 256 === 0) {
            gcPause(`${label} shard ${written}`);
        }
        if (written % 512 === 0) {
            console.log(`  wrote ${written} ${label} shards (${totalShardBytes} bytes so far)`);
        }
    }

    validateShardSample(validationRecords, label);

    return {
        manifestShards,
        nonEmptyCount: written,
        totalShardBytes,
        totalPostings,
        termCount,
    };
}

/**
 * Read back sampled shard files and assert (a) version 3, (b) dictionary term
 * count matches, (c) one full posting-list round-trip (docIds + tfs) matches
 * the in-memory data exactly. Throws on any mismatch.
 */
function validateShardSample(records, label) {
    for (const rec of records) {
        const bytes = readFileSync(rec.filePath); // Buffer IS a Uint8Array
        const header = readShardHeader(bytes);
        if (header.version !== 3) {
            throw new Error(`validate(${label}): ${rec.filePath} has version ${header.version}, expected 3`);
        }
        if (header.terms.size !== rec.termCount) {
            throw new Error(
                `validate(${label}): ${rec.filePath} termCount ${header.terms.size} != expected ${rec.termCount}`
            );
        }
        const meta = header.terms.get(rec.term);
        if (!meta) {
            throw new Error(`validate(${label}): ${rec.filePath} missing term "${rec.term}"`);
        }
        if (meta.count !== rec.docIds.length) {
            throw new Error(
                `validate(${label}): ${rec.filePath} term "${rec.term}" posting count ` +
                `${meta.count} != expected ${rec.docIds.length}`
            );
        }
        const { docIds, tfs } = decodePostingListV3(bytes, meta.count, meta.offset);
        for (let i = 0; i < meta.count; i++) {
            if (docIds[i] !== rec.docIds[i] || tfs[i] !== rec.tfs[i]) {
                throw new Error(
                    `validate(${label}): ${rec.filePath} term "${rec.term}" posting ${i} ` +
                    `round-trip mismatch: got (${docIds[i]}, ${tfs[i]}), ` +
                    `expected (${rec.docIds[i]}, ${rec.tfs[i]})`
                );
            }
        }
    }
    console.log(`  [validate] ${label}: ${records.length} sampled shards round-tripped OK`);
}

// === Manifest + docs.txt ===

function writeManifest(meta) {
    const manifest = {
        version: 3,
        builtAt: new Date().toISOString(),
        docCount: meta.docCount,
        shardCount: SHARD_COUNT,
        hashAlgo: 'fnv1a32',
        bigramCount: meta.bigramCount,
        nonEmptyShardCount: meta.nonEmptyShardCount,
        textShards: { count: TEXT_SHARD_COUNT, path: 'data/search/text/{XX}.bin' },
        shards: meta.manifestShards,
        // v3 additions: parallel unigram shard set + build observability.
        unigramShards: meta.unigramShards,
        unigramCount: meta.unigramCount,
        skippedFiles: meta.skippedFiles,
    };
    const path = join(BIGRAM_DIR, 'manifest.json');
    // Pretty-print for human readability; manifest is small so cost is irrelevant.
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

/** Read docs.txt back and assert line count === docCount, all lines non-empty. */
function validateDocList(path, docCount) {
    const content = readFileSync(path, 'utf-8');
    const lines = content.split('\n');
    // writeDocList appends a trailing newline → one trailing empty element.
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    if (lines.length !== docCount) {
        throw new Error(`validate(docs.txt): ${lines.length} lines != docCount ${docCount}`);
    }
    for (let i = 0; i < lines.length; i++) {
        if (!lines[i]) {
            throw new Error(`validate(docs.txt): line ${i} (docId ${i}) is empty`);
        }
    }
    console.log(`  [validate] docs.txt: ${lines.length} non-empty lines OK`);
}

// === Per-doc text shards ===
//
// Each shard at data/search/text/{XXX}.bin is a UTF-8 NDJSON file with one
// {docId, text} record per line. text is the *normalized* text (the same
// form used for term emission). Bucket by docId mod 4096 (3-hex name).
//
// The verification step in lib/bigram-search.js fetches the shard for a
// candidate docId and runs text.indexOf(normalizedQuery) to enumerate true
// hit positions (bigrams are necessary, not sufficient). Under v3 this only
// happens for displayed rows / KWIC, not for ranking.
//
// 4096 buckets keeps each shard small (~50-200 KB) so verification fetches
// are cheap over HTTP/2 and stream as they arrive.

function writeTextShards(docs) {
    // Pre-clear the text shard directory so a rebuild with a different bucket
    // count doesn't leave stale files behind (Cloudflare would upload them).
    if (existsSync(TEXT_DIR)) {
        rmSync(TEXT_DIR, { recursive: true, force: true });
    }
    ensureDir(TEXT_DIR);

    // Group docs by docId % TEXT_SHARD_COUNT. Use streams to avoid building
    // many huge strings in memory simultaneously.
    const streams = new Array(TEXT_SHARD_COUNT);
    for (let i = 0; i < TEXT_SHARD_COUNT; i++) {
        const xx = i.toString(16).padStart(3, '0');
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
    console.log('=== build-bigram-index (v3) ===');
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

    // ---- 4. Build term indexes (bigram + unigram, tf-carrying) ----
    // Pass ALL docs (not just zh): the inner CJK gate ensures English-side
    // docs contribute ~zero terms, but stray CJK in English glosses (e.g.
    // inline names) is correctly indexed. This unifies the docId space so
    // translations and community docs participate in CJK fulltext queries.
    console.log('\n--- buildTermIndexes ---');
    const { bigramIndex, unigramIndex } = buildTermIndexes(docs);
    const bigramCount = bigramIndex.size;
    const unigramCount = unigramIndex.size;
    const expectedBigramPostings = countPostings(bigramIndex);
    const expectedUnigramPostings = countPostings(unigramIndex);
    console.log(`distinct bigrams:  ${bigramCount}`);
    console.log(`distinct unigrams: ${unigramCount}`);
    console.log(`bigram postings:   ${expectedBigramPostings}`);
    console.log(`unigram postings:  ${expectedUnigramPostings}`);
    logMem('after buildTermIndexes');
    gcPause('buildTermIndexes');

    // ---- 5. Shard and write (bigram, then unigram) ----
    // shardAndWrite clears its source index once bucketing completes and
    // frees each bucket after encoding — peak rss stays bounded.
    console.log('\n--- shardAndWrite (bigram) ---');
    const bigramResult = shardAndWrite(bigramIndex, docCount, SHARDS_DIR, 'bigram');
    console.log(`wrote ${bigramResult.nonEmptyCount} non-empty bigram shards ` +
        `(${SHARD_COUNT - bigramResult.nonEmptyCount} empty), ` +
        `${bigramResult.totalShardBytes} bytes total`);
    if (bigramResult.totalPostings !== expectedBigramPostings) {
        throw new Error(
            `bigram postings mismatch: shardAndWrite wrote ${bigramResult.totalPostings}, ` +
            `index recount was ${expectedBigramPostings}`
        );
    }
    if (bigramResult.termCount !== bigramCount) {
        throw new Error(
            `bigram term count mismatch: shardAndWrite wrote ${bigramResult.termCount}, ` +
            `index had ${bigramCount}`
        );
    }
    logMem('after shardAndWrite (bigram)');
    gcPause('shardAndWrite bigram');

    console.log('\n--- shardAndWrite (unigram) ---');
    const unigramResult = shardAndWrite(unigramIndex, docCount, UNIGRAM_DIR, 'unigram');
    console.log(`wrote ${unigramResult.nonEmptyCount} non-empty unigram shards ` +
        `(${SHARD_COUNT - unigramResult.nonEmptyCount} empty), ` +
        `${unigramResult.totalShardBytes} bytes total`);
    if (unigramResult.totalPostings !== expectedUnigramPostings) {
        throw new Error(
            `unigram postings mismatch: shardAndWrite wrote ${unigramResult.totalPostings}, ` +
            `index recount was ${expectedUnigramPostings}`
        );
    }
    if (unigramResult.termCount !== unigramCount) {
        throw new Error(
            `unigram term count mismatch: shardAndWrite wrote ${unigramResult.termCount}, ` +
            `index had ${unigramCount}`
        );
    }
    logMem('after shardAndWrite (unigram)');
    gcPause('shardAndWrite unigram');

    // ---- 6. Manifest + docs.txt ----
    console.log('\n--- writeManifest + writeDocList ---');
    const manifestPath = writeManifest({
        docCount,
        bigramCount,
        nonEmptyShardCount: bigramResult.nonEmptyCount,
        manifestShards: bigramResult.manifestShards,
        unigramShards: unigramResult.manifestShards,
        unigramCount,
        skippedFiles,
    });
    const docsPath = writeDocList(docs);
    validateDocList(docsPath, docCount);
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
    console.log(`docCount:            ${docCount}`);
    console.log(`bigramCount:         ${bigramCount}`);
    console.log(`unigramCount:        ${unigramCount}`);
    console.log(`nonEmptyShards:      ${bigramResult.nonEmptyCount} / ${SHARD_COUNT} bigram, ` +
        `${unigramResult.nonEmptyCount} / ${SHARD_COUNT} unigram`);
    console.log(`bigramShardBytes:    ${bigramResult.totalShardBytes}`);
    console.log(`unigramShardBytes:   ${unigramResult.totalShardBytes}`);
    console.log(`textShardBytes:      ${textBytes}`);
    console.log(`bigramPostings:      ${bigramResult.totalPostings}`);
    console.log(`unigramPostings:     ${unigramResult.totalPostings}`);
    console.log(`skippedFiles:        ${skippedFiles}`);
    console.log(`wall time:           ${wallSec}s`);
    logMem('final');
}

main().catch(err => {
    console.error('FATAL:', err);
    process.exit(1);
});
