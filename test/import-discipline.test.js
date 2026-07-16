// test/import-discipline.test.js
//
// House-style meta-test (precedent: test/lib-browser-hygiene.test.js) for the
// one class of bug build/make-dist.js's static-string guard structurally
// cannot see: a shell URL constructed at RUNTIME rather than written as a
// plain literal in source. See PLAN_v1.md §8 point 1 ("Honest caveats — what
// can still go wrong after this ships"):
//
//   "Runtime-constructed bare shell URLs beat static guards. fetch('/app' +
//    '.js') sails past the dist grep... the import-discipline meta-test bans
//    the likeliest vector (non-literal import specifiers)."
//
// This file also pins the sentinel that makes the whole scheme safe in the
// first place (PLAN §2, "Where the stamp lives"): the checked-in repo is
// NEVER stamped. Only dist/ — built fresh by build/make-dist.js on every
// deploy, gitignored, never committed — ever carries a `?v=<BUILD_ID>`
// suffix. If this test ever finds `?v=` in the repo shell, the "no reachable
// deploy state is unsafe" argument (PLAN §1) stops holding.
//
// Source-level, grep-based, no execution — same style as
// lib-browser-hygiene.test.js: a violation fails fast with file:line.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VIEWS_DIR = join(ROOT, 'views');
const LIB_DIR = join(ROOT, 'lib');

function jsFiles(dir) {
    return readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith('.js'))
        .map((e) => e.name)
        .sort();
}

// The shell: app.js + every views/*.js + every lib/*.js. Mirrors the shell
// set build/make-dist.js hashes and stamps (and the same set
// stamp-build-id.js's shellFiles() enumerated before it).
const SHELL_FILES = [
    { rel: 'app.js', path: join(ROOT, 'app.js') },
    ...jsFiles(VIEWS_DIR).map((f) => ({ rel: `views/${f}`, path: join(VIEWS_DIR, f) })),
    ...jsFiles(LIB_DIR).map((f) => ({ rel: `lib/${f}`, path: join(LIB_DIR, f) })),
];

// Cheap comment filter (not a real parser — good enough for a source-level
// meta-test, same tradeoff lib-browser-hygiene.test.js makes). Without this,
// lib/titles.js's JSDoc "...for any external import (currently none)." trips
// the computed-import( check below as a false positive.
function isCommentLine(trimmed) {
    return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

test('sanity: the shell file set is non-trivial', () => {
    // Recon 3 counted 47 shell JS files (app.js + 16 views + 30 lib). Guard
    // against the enumeration silently finding nothing (e.g. wrong cwd).
    assert.ok(SHELL_FILES.length >= 40, `expected ~47 shell files, found ${SHELL_FILES.length}`);
});

test('shell: every import( call uses a plain string literal (no template literal, no variable)', () => {
    // A computed `import(...)` is the one dynamic-import vector make-dist's
    // static grep guard cannot see (findBareShellRefs greps text; it cannot
    // evaluate an expression). Banning it here is what keeps that guard's
    // grep-ability honest as the codebase evolves — recon 3 found zero of
    // these today (4 dynamic imports, all plain string literals); this test
    // is what keeps that true.
    const violations = [];
    for (const { rel, path } of SHELL_FILES) {
        const lines = readFileSync(path, 'utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
            const trimmed = lines[i].trim();
            if (isCommentLine(trimmed)) continue;
            // import( followed (mod whitespace) by anything other than a
            // quote character — catches a template literal (`) and a bare
            // identifier/expression alike.
            if (/\bimport\s*\(\s*(?!['"])\S/.test(lines[i])) {
                violations.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
            }
        }
    }
    assert.deepEqual(violations, [], 'computed dynamic import() found (guard cannot see this):\n' + violations.join('\n'));
});

test('shell: nothing builds a shell URL (/app.js, /style.css, /views/, /lib/) at runtime via concatenation or template interpolation', () => {
    // The guard (findBareShellRefs) is a static grep over string literals in
    // the STAGED files. A runtime-assembled URL — string concatenation
    // feeding fetch/src/href, or a template literal interpolating into one of
    // these prefixes — never appears as a matchable literal and sails past
    // it (PLAN §8.1, the disclosed residual risk). This test bans the
    // construction patterns, not just the computed-import case above.
    const FORBIDDEN = [
        { re: /['"]\/app\.js['"]\s*\+/, why: "'/app.js' + ..." },
        { re: /\+\s*['"]\/app\.js['"]/, why: "... + '/app.js'" },
        { re: /['"]\/style\.css['"]\s*\+/, why: "'/style.css' + ..." },
        { re: /\+\s*['"]\/style\.css['"]/, why: "... + '/style.css'" },
        { re: /['"]\/views\/['"]\s*\+/, why: "'/views/' + ..." },
        { re: /\+\s*['"]\/views\/['"]/, why: "... + '/views/'" },
        { re: /['"]\/lib\/['"]\s*\+/, why: "'/lib/' + ..." },
        { re: /\+\s*['"]\/lib\/['"]/, why: "... + '/lib/'" },
        { re: /`\/(?:app\.js|style\.css|views\/|lib\/)[^`]*\$\{/, why: 'template literal interpolating a shell path' },
    ];
    const violations = [];
    for (const { rel, path } of SHELL_FILES) {
        const lines = readFileSync(path, 'utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
            const trimmed = lines[i].trim();
            if (isCommentLine(trimmed)) continue;
            for (const { re, why } of FORBIDDEN) {
                if (re.test(lines[i])) violations.push(`${rel}:${i + 1} [${why}] ${lines[i].trim()}`);
            }
        }
    }
    assert.deepEqual(violations, [], 'runtime-constructed shell URL found:\n' + violations.join('\n'));
});

test('shell: nothing resolves a relative shell .js path via new URL(..., import.meta.url)', () => {
    // Finding 1c: `new URL('../lib/foo.js', import.meta.url)` is invisible to
    // both findBareShellRefs patterns (it's neither a quoted literal shell
    // path nor a `from`/`import(` specifier) and isn't stamped by SPEC_RE
    // either. Per WHATWG URL resolution, a relative reference resolves
    // against the BASE's path but drops the base's query string — so from a
    // stamped module (".../app.js?v=<id>"), this idiom silently resolves to
    // a bare "/lib/foo.js", pinning it immutable forever the moment any
    // client fetches it (same hazard class as 1a/1b). The idiom is already
    // in the codebase (lib/lineage-data.js:338) pointed at a DATA file
    // ('../data/lineage-masters.json') — that is intentional and untouched;
    // this test only bans the shape when the target ends in `.js`.
    const NEW_URL_RELATIVE_JS_RE = /new\s+URL\s*\(\s*(['"`])(\.{1,2}\/[^'"`]*\.js)\1\s*,\s*import\.meta\.url/;
    const violations = [];
    for (const { rel, path } of SHELL_FILES) {
        const lines = readFileSync(path, 'utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
            const trimmed = lines[i].trim();
            if (isCommentLine(trimmed)) continue;
            if (NEW_URL_RELATIVE_JS_RE.test(lines[i])) {
                violations.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
            }
        }
    }
    assert.deepEqual(violations, [], 'new URL(...) resolving a relative .js path found (WHATWG drops the base query - finding 1c):\n' + violations.join('\n'));
});

test('shell + index.html: the repo is never stamped (no "?v=" sentinel)', () => {
    // The entire safety argument for phase 2 (PLAN §2, §1 "why the chosen
    // design closes recon 5's objection") rests on the stamp existing ONLY in
    // the ephemeral, gitignored dist/ tree. NOTE: pwa.test.js is the
    // deliberately-strict sentinel for sw.js/PRECACHE specifically and must
    // NOT be edited (see run instructions) — this test is the broader,
    // whole-shell version of the same invariant.
    const files = [
        { rel: 'index.html', path: join(ROOT, 'index.html') },
        ...SHELL_FILES,
    ];
    const violations = [];
    for (const { rel, path } of files) {
        const src = readFileSync(path, 'utf8');
        if (src.includes('?v=')) violations.push(rel);
    }
    assert.deepEqual(violations, [], 'found "?v=" in checked-in shell source (stamps must only ever exist in dist/):\n' + violations.join('\n'));
});
