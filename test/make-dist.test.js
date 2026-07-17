// test/make-dist.test.js
//
// Tests for build/make-dist.js — the deploy-time staging script (PLAN_v1.md
// §4, run RUN-20260716-2154) that:
//   1. copies the whole repo into a throwaway dist/ tree,
//   2. stamps `?v=<BUILD_ID>` onto every relative shell-to-shell reference
//      (BUILD_ID = sha256 of the canonical shell contents, slice(0,8)),
//   3. edits a COPY of _headers so the four shell rules become `immutable`
//      (the repo's own _headers stays `no-cache` forever — see
//      test/import-discipline.test.js for that sentinel),
//   4. greps the ENTIRE staged tree it just wrote for any bare (unversioned,
//      or versioned with anything other than THIS run's own BUILD_ID) shell
//      reference, and — on a single hit, or on any crash after _headers is
//      rewritten — deletes the dist/ it just wrote and exits non-zero. A
//      guard failure never leaves a complete-looking dist/ sitting on disk;
//      nothing survives to be deployed by accident (finding 2).
//
// Why this file exists (RECON_CONSOLIDATED.md §4): readzen.pages.dev served
// a real user a months-stale build for months, and 519 pre-existing tests
// never caught it — every service-worker test was a single-point-in-time
// content check against one commit; none modeled "build N vs N+1". Recon 5's
// adversarial pass found the one catastrophic failure mode of the `?v=` +
// `immutable` scheme: an `immutable` header on a BARE unversioned URL pins it
// for a year, unrecoverable by reload, unfixable by rollback. The guard
// (step 4 above / `findBareShellRefs`) is the only thing standing between
// "safe" and that failure mode — proving it fails closed, AND proving a
// failed guard leaves no deployable dist/ behind, is this file's single most
// important job (see "THE GUARD TEST" sections below).
//
// Structure:
//   §6.1  unit tests on the pure exports (no fs side effects)
//   §6.2  sandbox integration test (spawnSync pattern, test/seo-cache.test.js:187-257)
//   §6.3  a from-scratch `_headers` parser + Cache-Control policy assertions
//
// If build/make-dist.js has not landed yet, every test below fails at
// import time with a single "Cannot find module" error for the whole file —
// that is expected and not a bug in these tests; see the run's task notes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    writeFileSync,
    mkdirSync,
    rmSync,
    readFileSync,
    existsSync,
} from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import {
    computeBuildId,
    stampJs,
    stampHtml,
    stampSw,
    transformHeaders,
    findBareShellRefs,
} from '../build/make-dist.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

function makeTmpDir(slug) {
    const dir = resolve(tmpdir(), `make-dist-test-${slug}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    return dir;
}

// =============================================================================
// §6.1 — unit tests on the pure exports (no fs side effects)
// =============================================================================

// ---- stampJs ----------------------------------------------------------------

test('stampJs: stamps a static relative specifier (single-quoted, from-form)', () => {
    const out = stampJs("import { foo } from './lib/foo.js';\n", 'abc12345');
    assert.match(out, /from '\.\/lib\/foo\.js\?v=abc12345'/);
});

test('stampJs: stamps a parent-relative (../) specifier', () => {
    const out = stampJs("import { attachInlineDict } from '../lib/inline-dict.js';\n", 'abc12345');
    assert.match(out, /from '\.\.\/lib\/inline-dict\.js\?v=abc12345'/);
});

test('stampJs: stamps all 4 real dynamic-import call sites verbatim (recon 3 catalogue)', () => {
    // Exact lines from views/compare.js:150, views/dictionary.js:35,
    // views/landing.js:477, views/passage.js:1611 — recon 3's "4 dynamic,
    // all plain string literals" finding, pinned so a future refactor to a
    // computed specifier is caught here first.
    const fixtures = [
        ["import('../lib/inline-dict.js').then(m => m.attachInlineDict(origBody));",
            /import\('\.\.\/lib\/inline-dict\.js\?v=deadbeef'\)/],
        ["const { loadZenEntry, renderZenCard } = await import('../lib/zen-dict.js');",
            /await import\('\.\.\/lib\/zen-dict\.js\?v=deadbeef'\)/],
        ["import('../lib/zen-dict.js')",
            /import\('\.\.\/lib\/zen-dict\.js\?v=deadbeef'\)/],
        ["import('../lib/reader-prefs.js').then(({ setPageSize }) => {",
            /import\('\.\.\/lib\/reader-prefs\.js\?v=deadbeef'\)/],
    ];
    for (const [line, expected] of fixtures) {
        const out = stampJs(line + '\n', 'deadbeef');
        assert.match(out, expected, `expected ${expected} in stamped output: ${out}`);
    }
});

test('stampJs: leaves every recon-3 false positive untouched (the anchor discipline)', () => {
    // Fixture strings lifted verbatim from the real files (RECON_CONSOLIDATED.md
    // recon 3). None of these are import specifiers. A looser `from\s*['"]`
    // (or similar) regex corrupts every single one of them — this is the
    // regression this test exists to catch.
    const falsePositives = [
        "throw new Error('Invalid JSON from ' + url + ': ' + error.message);", // lib/github.js:127
        "return title + ' (' + workId + '). ReadZen. Retrieved from ' + url;", // lib/citation.js:55
        "tagIdFilter ? `Filtered to tag \"${tagIdFilter}\"` : 'Community tags from the Read Zen corpus'", // views/tags.js:65
        "const from = (appNode.getAttribute('from') || '').replace(/^#/, '');", // lib/tei.js:362
        "    'received-from':       '#C854D9',", // views/scholar-graph.js
        "    'excerpted-from':      '#AB47BC',",
        "    'absent-from':         '#FFB347',",
        "    'inherited-from':      '#C854D9',",
        "    'derived-from':        '#51D996',",
        "    'draws-from':          '#D4A574',",
    ];
    const violations = [];
    for (const line of falsePositives) {
        const out = stampJs(line + '\n', 'deadbeef');
        if (out !== line + '\n') violations.push(`corrupted: ${JSON.stringify(line)} -> ${JSON.stringify(out)}`);
    }
    assert.deepEqual(violations, [], violations.join('\n'));
});

test('stampJs: never stamps serviceWorker.register(\'/sw.js\')', () => {
    // A changed scriptURL registers a PARALLEL service worker (recon 3);
    // this call must never gain a query string.
    const line = "navigator.serviceWorker.register('/sw.js').catch(() => { /* non-fatal */ });\n";
    const out = stampJs(line, 'deadbeef');
    assert.equal(out, line, 'register(\'/sw.js\') must never be stamped');
});

test('stampJs: idempotent (stamp twice = stamp once)', () => {
    const once = stampJs("import { foo } from './lib/foo.js';\nimport('../views/bar.js');\n", 'abc12345');
    const twice = stampJs(once, 'abc12345');
    assert.equal(twice, once, 'stamping already-stamped text must be a no-op');
});

// ---- stampHtml ---------------------------------------------------------------

test('stampHtml: stamps both index.html shell refs (href + src)', () => {
    const html = '<link rel="stylesheet" href="/style.css">\n<script type="module" src="/app.js"></script>\n';
    const out = stampHtml(html, 'abc12345');
    assert.match(out, /href="\/style\.css\?v=abc12345"/);
    assert.match(out, /src="\/app\.js\?v=abc12345"/);
});

test('stampHtml: idempotent (stamp twice = stamp once)', () => {
    const html = '<link rel="stylesheet" href="/style.css">\n<script type="module" src="/app.js"></script>\n';
    const once = stampHtml(html, 'abc12345');
    const twice = stampHtml(once, 'abc12345');
    assert.equal(twice, once);
});

// ---- stampSw -------------------------------------------------------------

test('stampSw: replaces BUILD and rewrites PRECACHE to exactly the given list', () => {
    const sw = "const BUILD = 'dev';\nconst CACHE = `zl-${BUILD}`;\nconst PRECACHE = [\n    '/',\n    '/index.html',\n];\n";
    const list = ['/', '/index.html', '/manifest.json', '/assets/icon.svg', '/app.js?v=abc12345', '/style.css?v=abc12345'];
    const out = stampSw(sw, 'abc12345', list);

    assert.match(out, /const BUILD = 'abc12345'/, 'BUILD constant must be replaced with the id');

    const m = out.match(/const PRECACHE = \[([\s\S]*?)\]/);
    assert.ok(m, 'PRECACHE array not found in stamped output');
    const entries = [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
    assert.deepEqual(entries, list, 'PRECACHE entries must equal exactly the given list, in order');
    assert.ok(!m[1].includes('`'), 'PRECACHE block must contain no template-literal entries');
});

// ---- computeBuildId -------------------------------------------------------
// NOTE: computeBuildId's exact signature is inferred from the PLAN's
// "computeBuildId(map)" naming and the pre-existing build/stamp-build-id.js
// design it evolves (per-file canonical-content hashing keyed by relative
// path). These tests exercise it as a Map<relPath, content>. If lane A's
// landed implementation takes a different shape, this is the first place to
// reconcile — see the report for this run.

test('computeBuildId: deterministic (same shell contents -> same id, 8 hex chars)', () => {
    const shell = new Map([
        ['app.js', "import { a } from './views/a.js';\n"],
        ['views/a.js', "export const a = 1;\n"],
        ['index.html', '<script src="/app.js"></script>\n'],
    ]);
    const id1 = computeBuildId(shell);
    const id2 = computeBuildId(new Map(shell));
    assert.equal(id1, id2, 'identical shell contents must yield identical BUILD_ID');
    assert.match(id1, /^[0-9a-f]{8}$/, 'BUILD_ID must be an 8-char lowercase hex string');
});

test('computeBuildId: the cross-build invariant — flip one byte in one shell file -> id changes', () => {
    // This is the invariant recon 4 identified that 519 pre-existing tests
    // never covered ("whenever any shell file changes, the version
    // identifier must also change"). A stale sw.js for 27 deploys is exactly
    // what happens when this invariant silently breaks.
    const base = new Map([
        ['app.js', "import { a } from './views/a.js';\n"],
        ['views/a.js', "export const a = 1;\n"],
    ]);
    const before = computeBuildId(base);

    const mutated = new Map(base);
    mutated.set('views/a.js', "export const a = 2;\n"); // one byte flipped
    const after = computeBuildId(mutated);

    assert.notEqual(before, after, 'a one-byte shell content change must change BUILD_ID');
});

// ---- transformHeaders ------------------------------------------------------
// See §6.3 below for the fuller policy assertions against the real repo
// _headers file; these two are the pure-function unit-level checks.

const REPO_HEADERS = readFileSync(resolve(REPO_ROOT, '_headers'), 'utf8');

test('transformHeaders: exactly 4 Cache-Control values change (the four shell rules)', () => {
    const before = parseHeadersFile(REPO_HEADERS);
    const after = parseHeadersFile(transformHeaders(REPO_HEADERS));
    let changed = 0;
    for (const b of before) {
        const a = after.find((x) => x.path === b.path);
        assert.ok(a, `block for ${b.path} disappeared after transformHeaders`);
        if (cacheControlValue(b) !== cacheControlValue(a)) changed++;
    }
    assert.equal(changed, 4, `expected exactly 4 changed Cache-Control values, got ${changed}`);
});

test('transformHeaders: throws if a required shell rule block is missing', () => {
    // Simulates someone renaming/removing one of the four rule blocks.
    // make-dist must abort the build rather than silently ship 3/4
    // transformed (an untransformed 4th rule paired with the OTHER three
    // going immutable is exactly the half-transformed state PLAN §4 step 5
    // says must never ship).
    const withoutStyleBlock = REPO_HEADERS.replace(/\/style\.css\r?\n\s*Cache-Control: no-cache\r?\n\r?\n/, '');
    assert.notEqual(withoutStyleBlock, REPO_HEADERS, 'precondition: /style.css block must actually be removed from the copy');
    assert.throws(() => transformHeaders(withoutStyleBlock));
});

test('transformHeaders: idempotent (twice-applied = same output)', () => {
    const once = transformHeaders(REPO_HEADERS);
    const twice = transformHeaders(once);
    assert.equal(twice, once, 'transformHeaders applied to its own output must be a no-op');
});

// ---- findBareShellRefs ------------------------------------------------------

test('findBareShellRefs: allowlists register(\'/sw.js\'), \'/\', and \'/index.html\'', () => {
    const clean = "navigator.serviceWorker.register('/sw.js').catch(() => {});\n" +
        "const a = '/';\nconst b = '/index.html';\n";
    const hits = findBareShellRefs(clean, 'app.js');
    assert.deepEqual(hits, [], `expected no hits on allowlisted forms, got: ${JSON.stringify(hits)}`);
});

test('findBareShellRefs: clean on fully stamped input (only when the stamp IS the current build id)', () => {
    const stamped = "import { a } from './views/foo.js?v=deadbeef';\n" +
        "fetch('/app.js?v=deadbeef');\n" +
        "navigator.serviceWorker.register('/sw.js').catch(() => {});\n";
    const hits = findBareShellRefs(stamped, 'app.js', 'deadbeef');
    assert.deepEqual(hits, [], `expected clean stamped input to pass, got: ${JSON.stringify(hits)}`);
});

// ---- findBareShellRefs — finding 1b: query-string evasion ------------------
// A query used to defeat the guard entirely, stamped or not: the old anchor
// required the closing quote to sit immediately after `.js`/`.css`, so ANY
// suffix broke the match. Cloudflare Pages serves the same file content
// regardless of query string, so a query that isn't THIS run's own BUILD_ID
// is just a bare reference in disguise — including a well-formed but stale
// hardcoded `?v=deadbeef` that never gets refreshed by any build process.

test('findBareShellRefs (1b): a hardcoded stale ?v= stamp is flagged when it does not match the current build id', () => {
    const hits = findBareShellRefs("fetch('/lib/data.js?v=deadbeef');\n", 'seo/page.html', '11112222');
    assert.equal(hits.length, 1, `expected the stale ?v=deadbeef stamp to be flagged (current build is 11112222), got: ${JSON.stringify(hits)}`);
});

test('findBareShellRefs (1b): an unrelated query on a shell literal is flagged', () => {
    const hits = findBareShellRefs("fetch('/app.js?raw=1');\n", 'seo/page.html', 'abc12345');
    assert.equal(hits.length, 1, `expected '/app.js?raw=1' to be flagged even with a valid current build id, got: ${JSON.stringify(hits)}`);
});

test('findBareShellRefs (1b): any query is flagged when no current build id is known (strictest default)', () => {
    const hits = findBareShellRefs("fetch('/app.js?v=abc12345');\n", 'seo/page.html');
    assert.equal(hits.length, 1, `expected a stamp to be flagged when currentBuildId is omitted, got: ${JSON.stringify(hits)}`);
});

// ---- findBareShellRefs — finding 1a: unquoted HTML attributes --------------
// `<script src=/app.js>` / `<link href=/style.css>` are valid HTML5 and were
// invisible to both quote-anchored patterns above.

test('findBareShellRefs (1a): flags unquoted href/src attributes referencing the shell, in .html files', () => {
    const html = '<script src=/app.js></script>\n<link rel=stylesheet href=/style.css>\n';
    const hits = findBareShellRefs(html, 'index.html');
    assert.equal(hits.length, 2, `expected both unquoted shell attributes to be flagged, got: ${JSON.stringify(hits)}`);
});

test('findBareShellRefs (1a): an unquoted attribute stamped with the current build id is clean', () => {
    const html = '<script src=/app.js?v=abc12345></script>\n';
    const hits = findBareShellRefs(html, 'index.html', 'abc12345');
    assert.deepEqual(hits, [], `expected the correctly-stamped unquoted attribute to be clean, got: ${JSON.stringify(hits)}`);
});

test('findBareShellRefs (1a): the unquoted-attribute pattern is scoped to .html files only', () => {
    // Same literal inside a .js file is left to the quoted/relative patterns;
    // this just confirms the new pattern doesn't fire outside .html.
    const hits = findBareShellRefs('const s = "src=/app.js";\n', 'app.js');
    assert.deepEqual(hits, [], `unquoted-attribute pattern must not run against non-.html files, got: ${JSON.stringify(hits)}`);
});

test('THE GUARD TEST — findBareShellRefs finds every planted bare shell reference (fails closed)', () => {
    // This is the single most important assertion in this file (see the
    // header comment / PLAN §4 step 6 / recon 5). An `immutable` header
    // beside a bare unversioned shell URL pins that URL for a year,
    // unrecoverable by reload, unfixable by rollback — strictly worse than
    // the original incident. The guard existing and firing on every one of
    // these forms is what makes that failure mode structurally unreachable.
    const planted = [
        ["fetch('/app.js')", 'a bare /app.js fetch() call'],
        ['<script src="/app.js"></script>', 'a bare /app.js src attribute'],
        ['<link href="/style.css">', 'a bare /style.css href attribute'],
        ["import x from './views/x.js';", 'an unversioned relative import of a views/ module'],
        ["const p = '/lib/x.js';", 'a bare /lib/x.js string literal'],
    ];
    const misses = [];
    for (const [snippet, why] of planted) {
        const hits = findBareShellRefs(snippet + '\n', 'seo/planted.html');
        if (!hits || hits.length === 0) misses.push(`guard MISSED ${why}: ${JSON.stringify(snippet)}`);
    }
    assert.deepEqual(misses, [], 'guard failed to fail closed:\n' + misses.join('\n'));
});

// =============================================================================
// §6.3 — a from-scratch `_headers` parser + Cache-Control policy assertions
//
// Cloudflare Pages `_headers` format: blank-line-separated blocks; the first
// non-blank, non-comment line of a block is a path glob; subsequent
// whitespace-indented lines are `Key: Value` pairs. No parser existed before
// this file (~20 lines below).
// =============================================================================

function parseHeadersFile(text) {
    const blocks = [];
    let current = null;
    for (const raw of text.split('\n')) {
        const line = raw.replace(/\r$/, '');
        const trimmed = line.trim();
        if (trimmed === '') { current = null; continue; }
        if (trimmed.startsWith('#')) continue;
        if (/^\s/.test(line)) {
            if (!current) continue; // stray indented line with no active block
            const i = line.indexOf(':');
            if (i === -1) continue;
            current.headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
        } else {
            current = { path: trimmed, headers: [] };
            blocks.push(current);
        }
    }
    return blocks;
}

function cacheControlValue(block) {
    const values = block.headers.filter(([k]) => k.toLowerCase() === 'cache-control').map(([, v]) => v);
    return values[0];
}

const SHELL_PATHS = ['/app.js', '/style.css', '/views/*', '/lib/*'];

test('_headers parser: repo file has no duplicate path blocks', () => {
    const blocks = parseHeadersFile(REPO_HEADERS);
    const paths = blocks.map((b) => b.path);
    assert.equal(new Set(paths).size, paths.length, `duplicate path blocks found: ${paths.join(', ')}`);
});

test('_headers parser: at most one Cache-Control header per block in the repo file', () => {
    const blocks = parseHeadersFile(REPO_HEADERS);
    for (const b of blocks) {
        const count = b.headers.filter(([k]) => k.toLowerCase() === 'cache-control').length;
        assert.ok(count <= 1, `${b.path} has ${count} Cache-Control headers (comma-join risk within one block)`);
    }
});

test('_headers policy: repo shell rules + /sw.js are no-cache (phase-1 state, permanent)', () => {
    const blocks = parseHeadersFile(REPO_HEADERS);
    for (const p of [...SHELL_PATHS, '/sw.js', '/', '/index.html']) {
        const block = blocks.find((b) => b.path === p);
        assert.ok(block, `no _headers block found for ${p}`);
        assert.equal(cacheControlValue(block), 'no-cache', `${p} must be no-cache in the checked-in _headers`);
    }
});

test('_headers policy: transformHeaders output — shell immutable, navigation entries still no-cache, no new duplicates', () => {
    const out = transformHeaders(REPO_HEADERS);
    const before = parseHeadersFile(REPO_HEADERS);
    const after = parseHeadersFile(out);

    assert.equal(after.length, before.length, 'transformHeaders must not add or remove _headers blocks');
    const afterPaths = after.map((b) => b.path);
    assert.equal(new Set(afterPaths).size, afterPaths.length,
        'transformed output must not contain duplicate path blocks (this is what makes the comma-join hazard structurally impossible)');

    for (const p of SHELL_PATHS) {
        const block = after.find((b) => b.path === p);
        assert.ok(block, `${p} block missing from transformed output`);
        assert.match(cacheControlValue(block) || '', /immutable/, `${p} should be immutable in the dist copy`);
    }
    for (const p of ['/', '/index.html', '/sw.js']) {
        const block = after.find((b) => b.path === p);
        assert.ok(block, `${p} block missing from transformed output`);
        assert.equal(cacheControlValue(block), 'no-cache', `${p} must stay no-cache even in the dist copy`);
    }
});

// =============================================================================
// §6.2 — sandbox integration test
//
// Pattern: test/seo-cache.test.js:187-257 ("--force flag bypasses cache"
// test) — copy the real script plus a miniature fixture tree into a fresh
// temp dir, give it its own ESM package scope, and spawnSync it with cwd set
// there. NEVER run the real script against the real repo: it deletes and
// recreates dist/ and would read/hash the user's actual WIP shell.
// =============================================================================

// build/make-dist.js is expected to resolve its ROOT the same way
// build/stamp-build-id.js and build/generate-seo-pages.js do:
// `dirname(fileURLToPath(import.meta.url))/..` — i.e. relative to the
// script's OWN location, not cwd. So the sandbox must place the copied
// script at <tmp>/build/make-dist.js for ROOT to resolve to <tmp>/.
function makeSandbox(slug) {
    const dir = makeTmpDir(slug);
    const buildDir = resolve(dir, 'build');
    mkdirSync(buildDir, { recursive: true });

    const realScript = resolve(REPO_ROOT, 'build', 'make-dist.js');
    writeFileSync(resolve(buildDir, 'make-dist.js'), readFileSync(realScript, 'utf8'), 'utf8');
    // ESM package scope for the copied script (mirrors seo-cache.test.js's
    // --force sandbox, test/seo-cache.test.js:214-216).
    writeFileSync(resolve(buildDir, 'package.json'), '{"type":"module","private":true}\n', 'utf8');

    // A tiny, controlled-LF-endings fixture shell (recon 4's CRLF note).
    // Every write below uses an explicit '\n' string, never a template
    // literal that could pick up the OS's line ending.
    writeFileSync(
        resolve(dir, 'app.js'),
        "import { mount } from './views/foo.js';\n" +
        "import('./lib/bar.js').then(() => {});\n" +
        "navigator.serviceWorker.register('/sw.js').catch(() => {});\n",
        'utf8'
    );
    writeFileSync(resolve(dir, 'style.css'), 'body { color: #111; }\n', 'utf8');

    mkdirSync(resolve(dir, 'views'), { recursive: true });
    writeFileSync(resolve(dir, 'views', 'foo.js'), 'export function mount() {}\n', 'utf8');

    mkdirSync(resolve(dir, 'lib'), { recursive: true });
    writeFileSync(resolve(dir, 'lib', 'bar.js'), 'export const bar = 1;\n', 'utf8');

    writeFileSync(
        resolve(dir, 'index.html'),
        '<!doctype html>\n<html><head><link rel="stylesheet" href="/style.css"></head>' +
        '<body><script type="module" src="/app.js"></script></body></html>\n',
        'utf8'
    );

    writeFileSync(
        resolve(dir, 'sw.js'),
        "const BUILD = 'dev';\n" +
        "const CACHE = `zl-${BUILD}`;\n" +
        "const PRECACHE = [\n    '/',\n    '/index.html',\n    '/style.css',\n    '/app.js',\n];\n",
        'utf8'
    );

    writeFileSync(
        resolve(dir, '_headers'),
        '/\n  Cache-Control: no-cache\n\n' +
        '/index.html\n  Cache-Control: no-cache\n\n' +
        '/sw.js\n  Cache-Control: no-cache\n\n' +
        '/app.js\n  Cache-Control: no-cache\n\n' +
        '/style.css\n  Cache-Control: no-cache\n\n' +
        '/views/*\n  Cache-Control: no-cache\n\n' +
        '/lib/*\n  Cache-Control: no-cache\n',
        'utf8'
    );

    mkdirSync(resolve(dir, 'data'), { recursive: true });
    writeFileSync(resolve(dir, 'data', 'sample.json'), '{"ok":true}\n', 'utf8');

    // make-dist's generated PRECACHE list always includes these two fixed
    // entries (see build/make-dist.js main(): '/manifest.json',
    // '/assets/icon.svg'), independent of the input sw.js's own PRECACHE —
    // they must exist on disk for the "entries resolve in dist/" assertion.
    writeFileSync(resolve(dir, 'manifest.json'), '{"name":"fixture"}\n', 'utf8');
    mkdirSync(resolve(dir, 'assets'), { recursive: true });
    writeFileSync(resolve(dir, 'assets', 'icon.svg'), '<svg></svg>\n', 'utf8');

    return dir;
}

function snapshotFixtureSources(dir) {
    const files = ['app.js', 'style.css', 'index.html', 'sw.js', '_headers',
        join('views', 'foo.js'), join('lib', 'bar.js'), join('data', 'sample.json')];
    const snap = new Map();
    for (const f of files) snap.set(f, readFileSync(resolve(dir, f), 'utf8'));
    return snap;
}

function runMakeDist(dir) {
    return spawnSync(process.execPath, [resolve(dir, 'build', 'make-dist.js')], {
        cwd: dir, encoding: 'utf8', timeout: 30000,
    });
}

test('sandbox: make-dist stages dist/, stamps the shell, transforms _headers, and leaves the source tree untouched', () => {
    const dir = makeSandbox('happy');
    try {
        const before = snapshotFixtureSources(dir);

        const result = runMakeDist(dir);
        assert.equal(result.status, 0, `make-dist should exit 0 on a clean shell, got status ${result.status}. stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);

        const distDir = resolve(dir, 'dist');
        const distApp = readFileSync(resolve(distDir, 'app.js'), 'utf8');
        const idMatch = distApp.match(/\?v=([0-9a-f]{8})/);
        assert.ok(idMatch, `expected a ?v=<8-hex> stamp in dist/app.js, got:\n${distApp}`);
        const id = idMatch[1];

        // Every relative specifier in dist/app.js carries the same id.
        assert.match(distApp, /from '\.\/views\/foo\.js\?v=[0-9a-f]{8}'/);
        assert.match(distApp, /import\('\.\/lib\/bar\.js\?v=[0-9a-f]{8}'\)/);
        assert.match(distApp, /register\('\/sw\.js'\)/, 'register(\'/sw.js\') must remain unstamped even in dist/');

        // index.html stamped.
        const distHtml = readFileSync(resolve(distDir, 'index.html'), 'utf8');
        assert.match(distHtml, new RegExp(`href="/style\\.css\\?v=${id}"`));
        assert.match(distHtml, new RegExp(`src="/app\\.js\\?v=${id}"`));

        // sw.js: BUILD stamped, PRECACHE entries resolve on disk once ?v= is stripped.
        const distSw = readFileSync(resolve(distDir, 'sw.js'), 'utf8');
        assert.match(distSw, new RegExp(`BUILD = '${id}'`));
        const precacheMatch = distSw.match(/const PRECACHE = \[([\s\S]*?)\]/);
        assert.ok(precacheMatch, 'dist/sw.js should have a PRECACHE block');
        const entries = [...precacheMatch[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
        assert.ok(entries.length > 0, 'dist/sw.js PRECACHE should not be empty');
        for (const entry of entries) {
            const stripped = entry.replace(/\?v=[0-9a-f]+$/, '');
            const rel = stripped === '/' ? 'index.html' : stripped.replace(/^\//, '');
            const exists = existsSync(resolve(distDir, rel));
            assert.ok(exists, `dist/sw.js PRECACHE entry ${entry} (-> ${rel}) does not exist in dist/`);
        }

        // _headers transformed: the four shell rules immutable, navigation stays no-cache.
        const distHeaders = readFileSync(resolve(distDir, '_headers'), 'utf8');
        const blocks = parseHeadersFile(distHeaders);
        for (const p of SHELL_PATHS) {
            const b = blocks.find((x) => x.path === p);
            assert.ok(b, `dist _headers missing ${p} block`);
            assert.match(cacheControlValue(b) || '', /immutable/, `${p} should be immutable in dist/_headers`);
        }
        for (const p of ['/', '/index.html', '/sw.js']) {
            const b = blocks.find((x) => x.path === p);
            assert.ok(b, `dist _headers missing ${p} block`);
            assert.equal(cacheControlValue(b), 'no-cache', `${p} must stay no-cache in dist/_headers`);
        }

        // Non-shell data file staged (hardlink or copy) with matching content.
        const distData = readFileSync(resolve(distDir, 'data', 'sample.json'), 'utf8');
        assert.equal(distData, before.get(join('data', 'sample.json')));

        // Source tree must be byte-unchanged — make-dist only ever reads it.
        const after = snapshotFixtureSources(dir);
        for (const [file, content] of before) {
            assert.equal(after.get(file), content, `source file ${file} was modified by make-dist (must be read-only)`);
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('sandbox: make-dist is deterministic across runs (same shell -> same BUILD_ID)', () => {
    const dir = makeSandbox('determinism');
    try {
        const r1 = runMakeDist(dir);
        assert.equal(r1.status, 0, `first run failed: ${r1.stderr}`);
        const id1 = readFileSync(resolve(dir, 'dist', 'app.js'), 'utf8').match(/\?v=([0-9a-f]{8})/)?.[1];
        assert.ok(id1, 'first run did not produce a stamped dist/app.js');

        const r2 = runMakeDist(dir);
        assert.equal(r2.status, 0, `second run failed: ${r2.stderr}`);
        const id2 = readFileSync(resolve(dir, 'dist', 'app.js'), 'utf8').match(/\?v=([0-9a-f]{8})/)?.[1];

        assert.equal(id2, id1, 'BUILD_ID must be identical across two runs over an unchanged shell');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('THE GUARD TEST (sandbox) — a planted bare shell reference anywhere in the tree makes make-dist exit non-zero', () => {
    // The most important integration-level assertion in this file: plant a
    // bare, unversioned shell reference in a non-shell page (simulating one
    // of the ~250 generated SEO pages) and confirm the real script — not a
    // mock, not a unit-level stand-in — refuses to succeed. A 0 exit here
    // would mean `npm run deploy`'s `&&`-chain proceeds straight to
    // `wrangler pages deploy dist`, shipping `immutable` next to a bare URL:
    // recon 5's "unrecoverable by reload, unfixable by rollback" scenario.
    const dir = makeSandbox('guard');
    try {
        mkdirSync(resolve(dir, 'master'), { recursive: true });
        writeFileSync(
            resolve(dir, 'master', 'badpage.html'),
            '<!doctype html><html><body>\n<script>fetch(\'/app.js\').then(r => r.text());</script>\n</body></html>\n',
            'utf8'
        );

        const result = runMakeDist(dir);
        assert.notEqual(result.status, 0, `make-dist must exit non-zero when a bare shell reference exists anywhere in the tree, got status ${result.status}`);

        const combined = `${result.stdout}\n${result.stderr}`;
        assert.match(combined, /app\.js/, `guard failure output should mention the offending reference, got:\nstdout:${result.stdout}\nstderr:${result.stderr}`);

        // Finding 2: a guard-rejected dist/ must not survive on disk — it is
        // otherwise COMPLETE (stamped shell, transformed _headers with the
        // four immutable rules) and indistinguishable from a good build
        // except by scrollback, one `wrangler pages deploy dist` away from
        // shipping the exact hazard the guard exists to prevent.
        assert.equal(existsSync(resolve(dir, 'dist')), false,
            'a guard-rejected dist/ must be removed, never left on disk where it could be deployed by accident');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('finding 2: a crash between the _headers write and guard completion also leaves no dist/ behind', () => {
    // Simulates the "abort path that has already written _headers" case
    // called out in the review: corrupt the fixture's _headers so
    // transformHeaders() throws partway through main(), after dist/ already
    // has hardlinked data files and stamped shell copies staged. The catch/
    // finally in main() must still remove the uncertified dist/.
    const dir = makeSandbox('crash-mid-write');
    try {
        writeFileSync(resolve(dir, '_headers'), '/only-one-block\n  Cache-Control: no-cache\n', 'utf8');

        const result = runMakeDist(dir);
        assert.notEqual(result.status, 0, `make-dist must exit non-zero when _headers is malformed, got status ${result.status}`);
        assert.equal(existsSync(resolve(dir, 'dist')), false,
            'a dist/ left mid-write by a thrown exception must not survive — got a dist/ on disk after a crash');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
