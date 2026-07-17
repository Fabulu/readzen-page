#!/usr/bin/env node
// build/publish-index.js — publish the search index to a second destination, so the
// Devvit (Reddit) app can fetch it from raw.githubusercontent.com.
//
// ── Why this exists ────────────────────────────────────────────────────────
// The Devvit app may only fetch from domains Reddit has approved. `readzen.pages.dev`
// was REJECTED; `raw.githubusercontent.com` was APPROVED — and the app already fetches
// the TEI corpus from there (src/server/content/paths.ts). So the index goes to a
// GitHub repo and is served raw. No Cloudflare, no exception request.
//
// ── Build once, publish twice ──────────────────────────────────────────────
// `npm run build:search` writes data/search/ (~6 min, ~3.5 GB RAM). This script does
// NOT rebuild anything — it mirrors that existing output. Two publishers, one build:
//   make-dist.js    -> dist/ -> Cloudflare Pages (the SPA)
//   publish-index.js -> devvitindex/ -> GitHub raw (the Devvit app)
//
// ── What ships, and what does not ──────────────────────────────────────────
//   bigram/{manifest.json,docs.txt,shards/**,unigram/**}   ~269 MB   <- ships
//   english.jsonl                                          ~3.6 MB   <- ships (Latin queries)
//   text/**                                                ~649 MB   <- does NOT ship
// text/ exists only to phrase-verify displayed rows. The Devvit app already fetches the
// TEI for those documents from the corpus repo, so it can verify against that instead.
// Excluding it keeps this repo under GitHub's 1 GB soft warning and cuts push churn by
// two thirds — which matters because the corpus is going to grow.
//
// ── 🔴 NEVER put this repo on Git LFS ──────────────────────────────────────
// raw.githubusercontent.com does NOT resolve LFS pointers: it serves the ~130-byte
// pointer FILE instead of the shard. Every fetch would "succeed" with garbage and the
// failure would look like a corrupt index rather than a hosting mistake. LFS is the
// obvious answer for a 269 MB binary repo and it is exactly wrong here.
//
// ── 🔴 Publish on an ORPHAN branch, force-pushed ───────────────────────────
// The builder renumbers all docIds on every corpus walk (see _headers), so adding one
// text rewrites every shard. Git keeps every version: a handful of rebuilds with normal
// history would be gigabytes. Replacing history each publish keeps the repo ~272 MB
// forever. This script prints those commands; it does not run them.
//
// Usage:
//   node build/publish-index.js [--dest <path>]
//     default dest: C:\programmieren\devvitindex
//   Mirrors and reports. Does NOT commit or push — publishing is yours to run.

import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, linkSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEARCH = join(ROOT, 'data', 'search');
const argv = process.argv.slice(2);
const destArg = argv.indexOf('--dest');
const DEST = destArg >= 0 ? argv[destArg + 1] : 'C:\\programmieren\\devvitindex';

// Same-drive hardlink keeps 269 MB near-free; copy is the cross-device fallback.
function linkOrCopy(src, dst) {
    mkdirSync(dirname(dst), { recursive: true });
    try { linkSync(src, dst); } catch { copyFileSync(src, dst); }
}

function walk(dir, base = dir, out = []) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p, base, out);
        else out.push(relative(base, p).replace(/\\/g, '/'));
    }
    return out;
}

function main() {
    if (!existsSync(SEARCH)) {
        console.error('data/search/ not found. Run `npm run build:search` first.');
        process.exit(1);
    }
    const manifestPath = join(SEARCH, 'bigram', 'manifest.json');
    if (!existsSync(manifestPath)) {
        console.error('data/search/bigram/manifest.json missing — the index build did not complete.');
        process.exit(1);
    }

    // Wipe everything except .git, so a removed shard never lingers.
    if (existsSync(DEST)) {
        for (const e of readdirSync(DEST)) {
            if (e === '.git') continue;
            rmSync(join(DEST, e), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
    } else {
        mkdirSync(DEST, { recursive: true });
    }

    let files = 0, bytes = 0;
    for (const rel of walk(join(SEARCH, 'bigram'))) {
        const src = join(SEARCH, 'bigram', rel);
        linkOrCopy(src, join(DEST, 'bigram', rel));
        files++; bytes += statSync(src).size;
    }
    const eng = join(SEARCH, 'english.jsonl');
    if (existsSync(eng)) {
        linkOrCopy(eng, join(DEST, 'english.jsonl'));
        files++; bytes += statSync(eng).size;
    }

    // ── The version stamp ──────────────────────────────────────────────────
    // This file is the POINTER. Consumers fetch it from `main` (always current),
    // read `commit_sha`, and then fetch manifest.json / docs.txt / every shard
    // pinned to THAT COMMIT — which is immutable.
    //
    // Why that matters, proved by execution rather than argued:
    //   raw.githubusercontent serves every path from its own CDN node at
    //   max-age=300. Live skew was measured between these very files
    //   (INDEX_VERSION.json Source-Age: 50 vs docs.txt Source-Age: 0). So a
    //   consumer fetching manifest.json and docs.txt separately can get them
    //   from DIFFERENT publishes. docIds are reassigned on every corpus walk,
    //   so a manifest paired with a foreign docs.txt resolves every hit to the
    //   WRONG document — silently. Searching 無門關 returns the Blue Cliff
    //   Record. No error, no warning, and the wrong answers are plausible
    //   adjacent works, so nobody reports it as a bug.
    //
    // An earlier version of this stamp carried `index_id = sha256(manifest)` and
    // told consumers to "lock to index_id". That lock was BLIND to docs.txt —
    // the one file that maps docIds to documents. index_id is kept below for
    // observability, but commit_sha is the actual guarantee.
    //
    // `commit_sha` cannot be written by this script: a commit cannot contain its
    // own hash. It is stamped by the two-commit publish ritual printed below —
    // commit 1 carries the data, commit 2 carries a pointer to commit 1.
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const docs = readFileSync(join(SEARCH, 'bigram', 'docs.txt'), 'utf8');
    // Counts only. A previous version inlined manifest.shards here — the whole
    // 4096-entry map — which made this pointer file 180 KB, fetched serially on
    // every cold load to read twelve hex characters.
    const stamp = {
        index_id: createHash('sha256').update(readFileSync(manifestPath)).digest('hex').slice(0, 12),
        commit_sha: null,
        published: new Date().toISOString(),
        docs: docs.split('\n').filter(Boolean).length,
        shard_count: Array.isArray(manifest.shards) ? manifest.shards.length
            : (manifest.shards && typeof manifest.shards === 'object' ? Object.keys(manifest.shards).length : null),
        unigram_shard_count: Array.isArray(manifest.unigramShards) ? manifest.unigramShards.length
            : (manifest.unigramShards && typeof manifest.unigramShards === 'object' ? Object.keys(manifest.unigramShards).length : null),
        files, bytes,
        note: 'Fetch this from main, read commit_sha, then fetch manifest.json/docs.txt/shards pinned to that commit. docIds are reassigned on every corpus walk: a manifest paired with a docs.txt from a different publish resolves every hit to the wrong document, silently. commit_sha null = unpinned (pre-ritual); consumers should treat that as best-effort.',
    };
    writeFileSync(join(DEST, 'INDEX_VERSION.json'), JSON.stringify(stamp, null, 2) + '\n');

    writeFileSync(join(DEST, 'README.md'), `# readzen-search-index

Search index for [Read Zen](https://readzen.pages.dev), published here so the Reddit
(Devvit) app can fetch it from \`raw.githubusercontent.com\` — an approved domain.
Generated by \`build/publish-index.js\` in the ZenLinkPage repo. **Do not edit by hand.**

- \`bigram/manifest.json\` — shard map. Fetch first.
- \`bigram/docs.txt\` — line N = url for docId N.
- \`bigram/shards/XX/YY-<hash6>.bin\` — bigram postings (4096 buckets, FNV-1a32 mod 4096).
- \`bigram/unigram/XX/YY-<hash6>.bin\` — unigram postings.
- \`english.jsonl\` — English/Latin query corpus.
- \`INDEX_VERSION.json\` — version stamp; lock to \`index_id\`.

\`text/\` is deliberately **not** published: it only phrase-verifies displayed rows, and a
consumer can verify against the TEI it already fetches from the corpus repos.

## Two rules

**Never enable Git LFS here.** \`raw.githubusercontent.com\` does not resolve LFS pointers —
it would serve the pointer file instead of the shard, and every fetch would silently
return garbage.

**Publish on an orphan branch, force-pushed.** Every corpus walk renumbers docIds and so
rewrites every shard; keeping history would add ~272 MB per rebuild.
`);

    console.log(`Published to: ${DEST}`);
    console.log(`  files : ${files}`);
    console.log(`  size  : ${(bytes / 1048576).toFixed(1)} MB   (text/ excluded — 649 MB not shipped)`);
    console.log(`  index_id: ${stamp.index_id}   docs: ${stamp.docs}`);
    console.log('');
    console.log('Not committed. Publish with the TWO-COMMIT ritual — commit 1 is the data,');
    console.log('commit 2 points at it. A commit cannot contain its own hash, so the pointer');
    console.log('must live in a later commit than the data it pins:');
    console.log('');
    console.log(`  cd ${DEST}`);
    console.log('  git checkout --orphan publish && git add -A');
    console.log(`  git commit -m "index ${stamp.index_id} (data)"        # commit 1 = the data`);
    console.log('  SHA=$(git rev-parse HEAD)                            # <- what consumers pin to');
    console.log('  node -e "const f=\'INDEX_VERSION.json\',fs=require(\'fs\');' +
                'const j=JSON.parse(fs.readFileSync(f));j.commit_sha=process.argv[1];' +
                'fs.writeFileSync(f,JSON.stringify(j,null,2)+String.fromCharCode(10))" $SHA');
    console.log('  git add INDEX_VERSION.json && git commit -m "pin $SHA"   # commit 2 = the pointer');
    console.log('  git branch -M main && git push -f origin main');
    console.log('');
    console.log('Both commits are reachable from main, so raw.githubusercontent serves the');
    console.log('pinned SHA. Orphan branch each time = history never accumulates (every corpus');
    console.log('walk rewrites every shard; normal history would add ~272 MB per publish).');
}

main();
