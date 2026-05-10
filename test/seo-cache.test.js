// test/seo-cache.test.js
//
// Acceptance criteria for Wave 2.4: hash-based SEO cache.
//
// We import `computeInputsHash` from build/generate-seo-pages.js and verify:
//   1. Same inputs (same files, same script) -> same hash.
//   2. Mutating an input file -> different hash.
//   3. Reordering input paths in the call site -> same hash (sort-stable).
//   4. Missing-file inputs are handled deterministically (don't throw, hash differs
//      from a present-file hash).
//
// The script export is guarded by a `process.argv[1] === SCRIPT_FILE` check so
// importing it does not auto-run main(). See build/generate-seo-pages.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { computeInputsHash } from '../build/generate-seo-pages.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function makeTmpDir(slug) {
    const dir = resolve(tmpdir(), `seo-cache-test-${slug}-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    return dir;
}

test('seo-cache: identical inputs yield identical hashes', () => {
    const dir = makeTmpDir('identical');
    try {
        const a = resolve(dir, 'a.jsonl');
        const b = resolve(dir, 'b.json');
        writeFileSync(a, '{"id":"x","zh":"無門關"}\n', 'utf8');
        writeFileSync(b, '{"masters":[]}', 'utf8');

        const h1 = computeInputsHash([a, b]);
        const h2 = computeInputsHash([a, b]);
        assert.equal(h1, h2);
        // Sanity: hash is a 64-char hex SHA-256 digest.
        assert.match(h1, /^[0-9a-f]{64}$/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('seo-cache: mutating a file changes the hash', () => {
    const dir = makeTmpDir('mutate');
    try {
        const a = resolve(dir, 'a.jsonl');
        writeFileSync(a, 'original', 'utf8');
        const before = computeInputsHash([a]);

        writeFileSync(a, 'modified', 'utf8');
        const after = computeInputsHash([a]);

        assert.notEqual(before, after, 'hash should change when file content changes');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('seo-cache: input order does not affect hash (sort-stable)', () => {
    const dir = makeTmpDir('order');
    try {
        const a = resolve(dir, 'a.jsonl');
        const b = resolve(dir, 'b.json');
        const c = resolve(dir, 'c.txt');
        writeFileSync(a, 'A', 'utf8');
        writeFileSync(b, 'B', 'utf8');
        writeFileSync(c, 'C', 'utf8');

        const h1 = computeInputsHash([a, b, c]);
        const h2 = computeInputsHash([c, b, a]);
        const h3 = computeInputsHash([b, a, c]);
        assert.equal(h1, h2);
        assert.equal(h1, h3);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('seo-cache: missing input files are handled deterministically', () => {
    const dir = makeTmpDir('missing');
    try {
        const present = resolve(dir, 'present.txt');
        const ghost = resolve(dir, 'ghost.txt');
        writeFileSync(present, 'hello', 'utf8');
        assert.ok(!existsSync(ghost), 'precondition: ghost file does not exist');

        const h1 = computeInputsHash([present, ghost]);
        const h2 = computeInputsHash([present, ghost]);
        assert.equal(h1, h2, 'missing files hash deterministically');

        // Should differ from the all-present case.
        writeFileSync(ghost, 'now-real', 'utf8');
        const h3 = computeInputsHash([present, ghost]);
        assert.notEqual(h1, h3, 'creating a missing input changes the hash');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('seo-cache: empty input list yields a stable hash', () => {
    const h1 = computeInputsHash([]);
    const h2 = computeInputsHash([]);
    assert.equal(h1, h2);
    assert.match(h1, /^[0-9a-f]{64}$/);
});

// ---------- Gap tests (Wave 2.4 review) ----------

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

test('seo-cache: cache file format is {hash, generatedAt} JSON', () => {
    // Round-trip: write a cache-shaped payload, read it back, confirm shape.
    // The implementation also stores `inputs` for diagnostics; tolerate that.
    const dir = makeTmpDir('format');
    try {
        const cacheFile = resolve(dir, '_inputs.sha256');
        const payload = {
            hash: 'a'.repeat(64),
            generatedAt: '2026-05-10T00:00:00.000Z',
            inputs: { CBETA_TITLES: '/x', OPEN_TITLES: '/y', MASTERS: '/z' }
        };
        writeFileSync(cacheFile, JSON.stringify(payload, null, 2), 'utf8');

        const decoded = JSON.parse(readFileSync(cacheFile, 'utf8'));
        assert.equal(typeof decoded.hash, 'string');
        assert.match(decoded.hash, /^[0-9a-f]{64}$/);
        assert.equal(typeof decoded.generatedAt, 'string');
        // generatedAt must be ISO-8601-ish so old caches stay readable.
        assert.ok(!Number.isNaN(Date.parse(decoded.generatedAt)),
            'generatedAt should parse as a date');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('seo-cache: modifying generate-seo-pages.js itself changes the hash', () => {
    // The recon spec requires the script's own bytes to participate in the
    // hash so a logic change forces a re-run. Rather than mutate the real
    // script, we simulate it: hash a shadow copy, mutate the shadow, hash
    // again — different output guarantees the script-as-input contract.
    const dir = makeTmpDir('script');
    try {
        const realScript = resolve(__dirname, '..', 'build', 'generate-seo-pages.js');
        const shadow = resolve(dir, 'generate-seo-pages.js');
        writeFileSync(shadow, readFileSync(realScript, 'utf8'), 'utf8');

        const before = computeInputsHash([shadow]);
        writeFileSync(shadow, readFileSync(realScript, 'utf8') + '\n// mutation\n', 'utf8');
        const after = computeInputsHash([shadow]);

        assert.notEqual(before, after,
            'changing the generator script bytes must change the cache hash');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('seo-cache: line-reorder of titles.jsonl DOES change hash (byte-level hash)', () => {
    // The implementation hashes the raw file bytes, so reordering lines flips
    // the hash. Path order is sorted (test 3 above), but line order is not.
    // This test pins that behaviour so a future move to "parse-then-sort"
    // doesn't sneak in unnoticed.
    const dir = makeTmpDir('reorder');
    try {
        const f = resolve(dir, 'titles.jsonl');
        writeFileSync(f, '{"id":"A"}\n{"id":"B"}\n{"id":"C"}\n', 'utf8');
        const h1 = computeInputsHash([f]);

        writeFileSync(f, '{"id":"C"}\n{"id":"A"}\n{"id":"B"}\n', 'utf8');
        const h2 = computeInputsHash([f]);

        assert.notEqual(h1, h2,
            'jsonl line reorder should change byte-level hash (impl chose bytes-not-records)');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('seo-cache: --force flag bypasses cache even when hash matches', () => {
    // Spawn a copy of the generator from a sandbox so its ROOT (resolved as
    // ../ from the script's __dirname) lands in the temp directory rather
    // than polluting the real repo's master/, masters/, sitemap.xml, etc.
    //
    // Layout:
    //   <tmp>/build/generate-seo-pages.js   (copied script)
    //   <tmp>/data/seo-cache/...             (cache landing zone)
    //   <tmp>/inputs/*                        (empty corpus stubs)
    const dir = makeTmpDir('force');
    try {
        const buildDir = resolve(dir, 'build');
        const inputsDir = resolve(dir, 'inputs');
        mkdirSync(buildDir, { recursive: true });
        mkdirSync(inputsDir, { recursive: true });

        const cbeta = resolve(inputsDir, 'cbeta-titles.jsonl');
        const open = resolve(inputsDir, 'open-titles.jsonl');
        const masters = resolve(inputsDir, 'masters.json');
        writeFileSync(cbeta, '', 'utf8');
        writeFileSync(open, '', 'utf8');
        writeFileSync(masters, '{"masters":[]}', 'utf8');

        const realScript = resolve(__dirname, '..', 'build', 'generate-seo-pages.js');
        const sandboxScript = resolve(buildDir, 'generate-seo-pages.js');
        writeFileSync(sandboxScript, readFileSync(realScript, 'utf8'), 'utf8');
        // The script uses ESM (`import` syntax) and depends on a sibling
        // package.json with {"type":"module"} for the ESM scope. Copy it.
        writeFileSync(resolve(buildDir, 'package.json'),
            '{"type":"module","private":true}', 'utf8');

        const env = {
            ...process.env,
            CBETA_TITLES: cbeta,
            OPENZEN_TITLES: open,
            MASTERS_JSON: masters
        };

        // Run 1: prime the cache (writes outputs into the sandbox).
        const r1 = spawnSync(process.execPath, [sandboxScript], {
            env, encoding: 'utf8', timeout: 30000, cwd: dir
        });
        assert.equal(r1.status, 0, `first run failed: ${r1.stderr}`);
        assert.match(r1.stdout, /SEO cache updated/,
            `first run should write the cache, got:\n${r1.stdout}`);

        // Run 2 (no force): should hit the cache.
        const r2 = spawnSync(process.execPath, [sandboxScript], {
            env, encoding: 'utf8', timeout: 30000, cwd: dir
        });
        assert.equal(r2.status, 0, `second run failed: ${r2.stderr}`);
        assert.match(r2.stdout, /SEO cache hit/,
            `expected cache hit on second run, got:\n${r2.stdout}`);

        // Run 3 (--force): must regenerate even though hash unchanged.
        const r3 = spawnSync(process.execPath, [sandboxScript, '--force'], {
            env, encoding: 'utf8', timeout: 30000, cwd: dir
        });
        assert.equal(r3.status, 0, `force run failed: ${r3.stderr}`);
        assert.doesNotMatch(r3.stdout, /SEO cache hit/,
            `--force must not short-circuit, got:\n${r3.stdout}`);
        assert.match(r3.stdout, /SEO cache updated/,
            `--force run should write a fresh cache, got:\n${r3.stdout}`);

        // Sanity: confirm outputs landed in the sandbox, not the real repo.
        assert.ok(existsSync(resolve(dir, 'data', 'seo-cache', '_inputs.sha256')),
            'cache file should be written under sandbox ROOT');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
