#!/usr/bin/env node
// build/make-dist.js — build the deploy artifact: dist/, a byte-mirror of the
// repo with the app shell content-versioned and immutably cacheable.
//
// ── Why this exists ────────────────────────────────────────────────────────
// A service worker only reinstalls when its own bytes change. sw.js once sat
// unchanged for 27 deploys, so returning visitors were served a months-old
// shell until they hard-reloaded. The fix is the trick the search shards
// already use: put the version in the URL, so a URL that names its own
// content can be cached forever and can never be stale.
//
// Cloudflare Pages' `_headers` matches PATH ONLY — an `immutable` rule on
// `/app.js` also covers a *bare*, unversioned request for `/app.js`. If any
// stray unversioned reference to the shell ever shipped alongside that rule,
// the browser would pin it `immutable` for a year: unrecoverable by reload,
// unfixable by rollback. So the stamped, `immutable`-headed artifact must be
// impossible to produce with an unversioned shell reference still in it.
//
// This script is the only thing that can produce that artifact. It:
//   1. builds dist/ fresh from the repo (repo files are read-only inputs —
//      this script never writes into the repo, only into dist/);
//   2. computes BUILD_ID = sha256(canonical shell contents).slice(0, 8);
//   3. stamps every relative shell reference (app.js, views/*.js, lib/*.js,
//      index.html) with `?v=<BUILD_ID>`, rewrites sw.js's BUILD constant and
//      its whole PRECACHE list, and edits the four shell `_headers` rules to
//      `immutable` — all only inside dist/, never in the repo;
//   4. scans EVERY .html/.js file that will ship, looking for any bare
//      (unversioned, or versioned with anything other than THIS run's own
//      BUILD_ID) reference to the shell. A single hit — or a crash anywhere
//      after step 3 rewrites `_headers` — aborts the build and deletes the
//      dist/ it just wrote, so an uncertified dist/ never survives on disk
//      long enough for `wrangler pages deploy dist` to ship it by accident.
//
// Deploying the raw repo tree (the escape hatch this script doesn't touch)
// stays possible and stays safe: `_headers` there is still `no-cache` for
// the shell, so an unversioned reference just revalidates normally, slower
// but never wrong. There is no reachable deploy state that pins a bare URL.
//
// Zero npm dependencies — plain node:fs / node:path / node:crypto / node:url.
//
// Usage:  node build/make-dist.js

import { createHash } from 'node:crypto';
import {
    readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync,
    linkSync, copyFileSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT_FILE), '..');
const DIST = join(ROOT, 'dist');

// ── The ship-set exclusion list ─────────────────────────────────────────────
// Mirrors today's .wranglerignore + the dot-dirs it implicitly leaves out.
// Checked ONLY against direct children of the repo root — a nested directory
// that happens to share one of these names (e.g. lib/build/, a Node-only
// helper subfolder) is a legitimate shipped file, not a build artifact, and
// must not be swept up by a same-named top-level exclusion.
const EXCLUDE_TOP_LEVEL = new Set([
    'node_modules', '.git', '.github', '.wrangler', '.claude',
    'build', 'test', 'dist', 'corpus', 'pagefind-old',
    '.gitignore', '.wranglerignore', '.assetsignore', '.cfignore',
    'package.json', 'package-lock.json',
]);

/** `*.md` is excluded at any depth (gitignore-glob semantics, no path separator). */
function shouldExclude(name, isTopLevel) {
    if (name.endsWith('.md')) return true;
    if (isTopLevel && EXCLUDE_TOP_LEVEL.has(name)) return true;
    return false;
}

/** Recursively enumerate the ship set as repo-relative POSIX paths. */
function walkShipSet() {
    const out = [];
    (function recurse(relDir, isTopLevel) {
        const absDir = relDir ? join(ROOT, relDir) : ROOT;
        for (const entry of readdirSync(absDir, { withFileTypes: true })) {
            if (shouldExclude(entry.name, isTopLevel)) continue;
            const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
            if (entry.isDirectory()) recurse(rel, false);
            else if (entry.isFile()) out.push(rel);
        }
    })('', true);
    return out;
}

// ── The shell: every file whose staleness would freeze the app ─────────────
function listDirJsFiles(dir) {
    return readdirSync(join(ROOT, dir), { withFileTypes: true })
        .filter((d) => d.isFile() && d.name.endsWith('.js'))
        .map((d) => d.name)
        .sort();
}

/** The 47 JS files that get `?v=` stamped into every relative import. */
function shellJsFiles() {
    return [
        'app.js',
        ...listDirJsFiles('views').map((f) => `views/${f}`),
        ...listDirJsFiles('lib').map((f) => `lib/${f}`),
    ];
}

/**
 * The 49 files hashed to derive BUILD_ID: the 47 shell JS files, plus
 * style.css (no imports of its own, but its content still defines "the
 * shell") and index.html (its two shell refs are part of what the ID names).
 * sw.js is deliberately excluded: its BUILD constant is an OUTPUT of this
 * hash, so including it would be self-referential.
 */
function hashedShellFiles(shellJs) {
    return [...shellJs, 'style.css', 'index.html'];
}

// ── Regexes (recon-3-validated design, carried over from stamp-build-id.js) ─
// Anchored on ./ or ../ so string concatenation that merely contains the word
// "from" (lib/github.js's `'Invalid JSON from ' + url`, lib/tei.js's
// getAttribute('from'), views/scholar-graph.js's edge-label literals like
// 'derived-from', JSDoc "from `x`" comments, etc.) is never mistaken for an
// import specifier.
const SPEC_RE = /((?:\bfrom|\bimport\s*\()\s*')(\.{1,2}\/[^'?]*?)(?:\?v=[0-9a-f]+)?(')/g;
const HTML_RE = /((?:href|src)=")(\/(?:style\.css|app\.js))(?:\?v=[0-9a-f]+)?(")/g;
const SW_RE = /(const BUILD = ')([^']*)(')/;
const SW_PRECACHE_RE = /const PRECACHE = \[[\s\S]*?\];/;

/**
 * Strip any existing `?v=` stamp before hashing, so BUILD_ID depends only on
 * what the shell actually says, never on whether it happens to be stamped
 * right now. Repo files are never stamped in practice (the stamp exists only
 * in dist/) — this is a defensive no-op safety net, not a load-bearing path.
 */
function stripForHash(text, relPath) {
    if (relPath === 'index.html') return text.replace(HTML_RE, '$1$2$3');
    if (relPath.endsWith('.js')) return text.replace(SPEC_RE, '$1$2$3');
    return text; // style.css: no import specifiers to strip.
}

/**
 * BUILD_ID = sha256(canonical shell contents).slice(0, 8).
 * `fileMap`: Map<repo-relative POSIX path, raw file text> for the 49 hashed
 * shell files, read from the REPO (never from dist/). Deterministic and
 * order-independent (keys are sorted internally); flipping one byte in any
 * one shell file changes the ID.
 */
export function computeBuildId(fileMap) {
    const hash = createHash('sha256');
    const names = [...fileMap.keys()].sort();
    for (const name of names) {
        hash.update(name, 'utf8');
        hash.update('\0');
        hash.update(stripForHash(fileMap.get(name), name), 'utf8');
        hash.update('\0');
    }
    return hash.digest('hex').slice(0, 8);
}

/** Stamp every relative static/dynamic import specifier in a shell JS file. */
export function stampJs(text, id) {
    return text.replace(SPEC_RE, `$1$2?v=${id}$3`);
}

/** Stamp index.html's two shell refs (`href="/style.css"`, `src="/app.js"`). */
export function stampHtml(text, id) {
    return text.replace(HTML_RE, `$1$2?v=${id}$3`);
}

/**
 * Stamp sw.js: replace the BUILD constant, and replace the WHOLE PRECACHE
 * array with `precacheList` (already fully formed — base entries plus every
 * stamped shell URL). Regenerating the entire block, rather than patching
 * entries in place, is what keeps offline coverage complete across deploys
 * and avoids version-tearing mid-deploy (see PLAN §4 step 5).
 */
export function stampSw(text, id, precacheList) {
    if (!SW_RE.test(text)) {
        throw new Error('stampSw: could not find `const BUILD = \'...\'` in sw.js');
    }
    if (!SW_PRECACHE_RE.test(text)) {
        throw new Error('stampSw: could not find `const PRECACHE = [...]` block in sw.js');
    }
    let out = text.replace(SW_RE, `$1${id}$3`);
    const block = `const PRECACHE = [\n${precacheList.map((u) => `    '${u}',`).join('\n')}\n];`;
    out = out.replace(SW_PRECACHE_RE, block);
    return out;
}

// ── _headers: edit the four shell rules' values in place ────────────────────
const SHELL_HEADER_PATHS = ['/app.js', '/style.css', '/views/*', '/lib/*'];
const IMMUTABLE_VALUE = 'public, max-age=31536000, immutable';

/**
 * Rewrite the Cache-Control value of exactly the four shell rules to
 * `immutable`, in place — never appended as a new rule (Cloudflare joins
 * duplicate-path headers with a comma, and "no-cache, immutable" means
 * no-cache). Throws if a block is missing/renamed, or if the total replaced
 * count is not exactly 4 — a half-transformed policy must never ship.
 */
export function transformHeaders(text) {
    let result = text;
    let replacements = 0;
    for (const p of SHELL_HEADER_PATHS) {
        const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`(^${escaped}\\r?\\n[ \\t]*Cache-Control:\\s*)([^\\r\\n]*)`, 'm');
        if (!re.test(result)) {
            throw new Error(`transformHeaders: could not find Cache-Control block for ${p}`);
        }
        result = result.replace(re, (_m, prefix) => {
            replacements++;
            return `${prefix}${IMMUTABLE_VALUE}`;
        });
    }
    if (replacements !== 4) {
        throw new Error(`transformHeaders: expected exactly 4 replacements, got ${replacements}`);
    }
    return result;
}

// ── The guard: bare (unversioned) shell references anywhere in dist/ ────────
// Broader than SPEC_RE/HTML_RE on purpose: this runs over EVERY .html/.js
// file that will ship (SEO pages, meta pages, 404.html, sw.js, everything),
// not just the 49 known shell files, and must not assume single-quote style.
//
// The base-path capture excludes `?` and a query is captured SEPARATELY
// (group 3), rather than requiring the closing quote to sit immediately
// after `.js`/`.css`. That anchor used to be the only thing keeping a
// stamped literal (`'/app.js?v=abcd1234'`) from matching — but it also let
// ANY query defeat the guard, stamped or not: `fetch('/app.js?raw=1')` and a
// hardcoded, never-updated `fetch('/lib/data.js?v=deadbeef')` both slipped
// through silently (finding 1b). Cloudflare Pages serves the same file
// content regardless of query string, so a query that isn't THIS run's own
// BUILD_ID is just a bare reference wearing a costume — the file it names
// gets cached `immutable` under that exact literal URL, and nothing ever
// refreshes it on a future deploy. So a query is only trusted when it is
// exactly `?v=<currentBuildId>`; findBareShellRefs takes that id as a
// parameter and checks equality explicitly (see isCurrentStamp below) —
// there is no way to satisfy the check without knowing the real, freshly
// computed BUILD_ID for this run.
const BARE_ABS_RE = /(['"`])(\/app\.js|\/style\.css|\/(?:views|lib)\/[^'"`?]*\.js)(\?[^'"`]*)?\1/g;
const BARE_REL_RE = /(?:\bfrom\s*|\bimport\s*\(\s*)(['"`])(\.{1,2}\/[^'"`?]*\.js)(\?[^'"`]*)?\1/g;

// Finding 1a: `<script src=/app.js></script>` / `<link href=/style.css>` are
// valid, unquoted HTML5 attribute values that match neither pattern above
// (both require a matching quote/backtick). Scoped to `.html` files only —
// see findBareShellRefs. The lookahead requires whitespace or `>` right
// after the path/query so a value that merely starts with a shell path but
// continues (e.g. `/app.js.map`) or trails a stamp query isn't chopped off
// mid-token; the optional query group gets the same currentBuildId check.
const BARE_UNQUOTED_ATTR_RE = /\b(?:href|src)=(\/app\.js|\/style\.css|\/(?:views|lib)\/[^\s"'`>?]*\.js)(\?[^\s"'`>]*)?(?=[\s>])/g;

/** True if a relative specifier resolves to a shell target (app.js/views/lib). */
function isShellRelativeSpecifier(spec) {
    return /(^|\/)app\.js$/.test(spec) || /\/(?:views|lib)\/[^/]+\.js$/.test(spec);
}

// sw.js's own dual-mode routing legitimately compares url.pathname (which by
// definition never carries a query string) against these same bare literals,
// e.g. `p === '/app.js'` guarded by `url.searchParams.has('v')`. That is a
// pathname COMPARISON, not a reference that causes the browser to fetch/
// import/link the bare URL — the only case a static scan can safely tell
// apart from a real reference is "immediately preceded by an equality
// operator". Every other context (fetch(...), import(...), href=, src=,
// register(...), or a bare standalone literal) is still flagged. `/sw.js`,
// `/index.html`, and `/` never match BARE_ABS_RE's three path shapes at all
// (app.js / style.css / views|lib *.js), so they need no allowlist entry.
const COMPARISON_PRECEDING_RE = /(?:===|!==|==|!=)\s*$/;

/** True only when `query` is exactly this run's own `?v=<currentBuildId>`. */
function isCurrentStamp(query, currentBuildId) {
    return Boolean(currentBuildId) && query === `?v=${currentBuildId}`;
}

/**
 * Scan `text` (the contents of one dist file) for bare shell references.
 * `currentBuildId` is the BUILD_ID this run computed — the only stamp value
 * findBareShellRefs will treat as legitimate; omit it (as most unit tests
 * do) to mean "no query is trusted", which is the strictest, always-safe
 * default. Returns an array of `"path:line: match"` strings — empty when clean.
 */
export function findBareShellRefs(text, path, currentBuildId) {
    const hits = [];
    const lineAt = (index) => text.slice(0, index).split('\n').length;

    for (const m of text.matchAll(BARE_ABS_RE)) {
        if (COMPARISON_PRECEDING_RE.test(text.slice(0, m.index))) continue;
        if (isCurrentStamp(m[3], currentBuildId)) continue;
        hits.push({ line: lineAt(m.index), match: m[0] });
    }
    for (const m of text.matchAll(BARE_REL_RE)) {
        if (!isShellRelativeSpecifier(m[2])) continue;
        if (isCurrentStamp(m[3], currentBuildId)) continue;
        hits.push({ line: lineAt(m.index), match: m[0] });
    }
    if (path.endsWith('.html')) {
        for (const m of text.matchAll(BARE_UNQUOTED_ATTR_RE)) {
            if (isCurrentStamp(m[2], currentBuildId)) continue;
            hits.push({ line: lineAt(m.index), match: m[0] });
        }
    }
    hits.sort((a, b) => a.line - b.line);
    return hits.map((h) => `${path}:${h.line}: ${h.match}`);
}

// ── fs helpers ───────────────────────────────────────────────────────────────
function linkOrCopy(srcAbs, destAbs) {
    mkdirSync(dirname(destAbs), { recursive: true });
    try {
        linkSync(srcAbs, destAbs);
    } catch {
        copyFileSync(srcAbs, destAbs);
    }
}

function writeDist(relPath, text) {
    const destAbs = join(DIST, relPath);
    mkdirSync(dirname(destAbs), { recursive: true });
    writeFileSync(destAbs, text, 'utf8');
}

/** True if a PRECACHE entry names one of the four stamped shell path shapes. */
function isShellPrecacheEntry(entry) {
    return entry === '/app.js' || entry === '/style.css'
        || entry.startsWith('/views/') || entry.startsWith('/lib/');
}

/**
 * The non-shell ("base") PRECACHE entries, read from the SOURCE sw.js's own
 * existing PRECACHE array — not hardcoded — so the base list is whatever the
 * repo's sw.js already declares (today: '/', '/index.html', '/manifest.json',
 * '/assets/icon.svg') and never drifts out of sync with it.
 */
function readBasePrecacheEntries(swSourceText) {
    const m = swSourceText.match(SW_PRECACHE_RE);
    if (!m) throw new Error('main: could not find `const PRECACHE = [...]` in source sw.js');
    const entries = [...m[0].matchAll(/'([^']*)'/g)].map((x) => x[1]);
    return entries.filter((e) => !isShellPrecacheEntry(e));
}

/** Recursively list .html/.js files under dist/, for the guard pass. */
function walkDistCode() {
    const out = [];
    (function recurse(relDir) {
        const absDir = relDir ? join(DIST, relDir) : DIST;
        for (const entry of readdirSync(absDir, { withFileTypes: true })) {
            const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
            if (entry.isDirectory()) recurse(rel);
            else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.html'))) {
                out.push(rel);
            }
        }
    })('');
    return out;
}

// Deleting dist/ means unlinking ~13k hardlinks. On Windows, NTFS and AV hold
// transient handles and rmSync throws ENOTEMPTY often enough to matter: measured
// at 3 failures in 6 consecutive runs on this repo. Node's own retry is the
// right tool — and this must be robust, because `npm run deploy` does the 3.5 GB
// bigram build FIRST, so a coin-flip abort here throws away ten minutes of work.
const RM_OPTS = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 };

function main() {
    // 1. Delete and recreate dist/ — fresh every run, idempotent by construction.
    rmSync(DIST, RM_OPTS);
    mkdirSync(DIST, { recursive: true });

    // `certified` flips to true only once the guard has actually run and
    // found nothing. Finding 2: a dist/ that has the four `_headers` rules
    // rewritten to `immutable` but never passed the guard — whether because
    // the guard found a hit, or because something threw between the
    // `_headers` write (step 5) and the guard finishing (step 6) — is
    // COMPLETE-looking and indistinguishable from a good build except by
    // scrollback, and is one `wrangler pages deploy dist` away from pinning
    // a bare URL for a year. The try/finally below is what makes "no
    // reachable deploy state is unsafe" literally true: it removes dist/ on
    // every exit path except the one where the guard explicitly passed,
    // including a thrown exception, not just the explicit guard-fail return.
    let certified = false;
    try {
        // 2. The shell + BUILD_ID, read from the REPO (never from dist/).
        const shellJs = shellJsFiles();
        const hashedShell = hashedShellFiles(shellJs);
        const hashMap = new Map(hashedShell.map((f) => [f, readFileSync(join(ROOT, f), 'utf8')]));
        const BUILD_ID = computeBuildId(hashMap);

        // Full PRECACHE list: whatever non-shell entries the source sw.js already
        // declares, plus every stamped shell URL (48 = 47 JS + style.css).
        const swSourceText = readFileSync(join(ROOT, 'sw.js'), 'utf8');
        const precacheList = [
            ...readBasePrecacheEntries(swSourceText),
            ...shellJs.map((f) => `/${f}?v=${BUILD_ID}`),
            `/style.css?v=${BUILD_ID}`,
        ];

        // 3. Enumerate the ship set.
        const shipSet = walkShipSet();
        const TRANSFORM_SET = new Set([...shellJs, 'index.html', 'sw.js', '_headers']);

        // 4. Hardlink every non-shell file (data/ is ~950 MB / ~12k files — do not copy).
        let hardlinked = 0;
        for (const rel of shipSet) {
            if (TRANSFORM_SET.has(rel)) continue;
            linkOrCopy(join(ROOT, rel), join(DIST, rel));
            hardlinked++;
        }

        // 5. Write transformed copies into dist/ (repo files are read-only inputs).
        for (const rel of shellJs) {
            writeDist(rel, stampJs(readFileSync(join(ROOT, rel), 'utf8'), BUILD_ID));
        }
        writeDist('index.html', stampHtml(readFileSync(join(ROOT, 'index.html'), 'utf8'), BUILD_ID));
        writeDist('sw.js', stampSw(swSourceText, BUILD_ID, precacheList));
        writeDist('_headers', transformHeaders(readFileSync(join(ROOT, '_headers'), 'utf8')));

        // 6. The guard pass — the load-bearing safety. Scan EVERY .html/.js
        // file that will ship for a bare (unversioned, or versioned with
        // anything other than THIS run's own BUILD_ID — finding 1b) shell
        // reference.
        const violations = [];
        for (const rel of walkDistCode()) {
            const text = readFileSync(join(DIST, rel), 'utf8');
            violations.push(...findBareShellRefs(text, rel, BUILD_ID));
        }

        // 7. Receipt.
        console.log(`BUILD_ID: ${BUILD_ID}`);
        console.log(`Shell: ${shellJs.length} JS files + style.css + index.html (${hashedShell.length} hashed)`);
        console.log(`Files staged in dist/: ${shipSet.length} (${hardlinked} hardlinked, ${shipSet.length - hardlinked} stamped/transformed)`);

        if (violations.length > 0) {
            // Print every violation IN FULL — debuggability must survive the
            // dist/ removal that happens in the finally block below.
            console.error(`Guard: FAIL — ${violations.length} bare shell reference(s) found:`);
            for (const v of violations) console.error(`  ${v}`);
            process.exitCode = 1;
            return;
        }

        console.log('Guard: PASS — no bare shell references found in dist/');
        certified = true;
    } catch (err) {
        console.error(`make-dist: aborted — ${err.message}`);
        process.exitCode = 1;
    } finally {
        if (!certified) {
            removeUncertifiedDist();
        }
    }
}

/**
 * Remove an uncertified dist/. The invariant this protects is the whole safety
 * argument: `dist/ exists` must imply `dist/ passed the guard`.
 *
 * An unguarded throw HERE is the worst possible place for one: it would leave
 * the uncertified tree on disk (immutable `_headers` and all) *and* mask the
 * guard failure that sent us here — recreating exactly the state this cleanup
 * exists to prevent. RM_OPTS already retries; if the tree still will not die,
 * DEFANG it instead: overwrite dist/_headers with the repo's no-cache copy. A
 * surviving dist/ is then merely slow — the same safe-but-slow fallback a raw
 * worktree deploy already has — never a year-long pin. Cleanup must never
 * throw: an unremovable dist/ is bad, but losing the reason for the failure is
 * worse.
 */
function removeUncertifiedDist() {
    try {
        rmSync(DIST, RM_OPTS);
        return;
    } catch (err) {
        process.exitCode = 1;
        try {
            writeFileSync(join(DIST, '_headers'), readFileSync(join(ROOT, '_headers'), 'utf8'));
            console.error(
                `make-dist: could not remove dist/ (${err.code}). Its _headers has been reset to ` +
                `the repo's no-cache policy, so the leftover tree is SLOW BUT SAFE. ` +
                `Delete dist/ before the next build.`);
        } catch (inner) {
            console.error(
                `make-dist: DANGER — could not remove dist/ (${err.code}) and could not reset its ` +
                `_headers (${inner.code}). dist/ may carry immutable headers WITHOUT having passed ` +
                `the guard. DO NOT DEPLOY dist/. Delete it by hand.`);
        }
    }
}

// Only auto-run when invoked as a script (not when imported by tests).
const isMain = process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE;
if (isMain) {
    main();
}
