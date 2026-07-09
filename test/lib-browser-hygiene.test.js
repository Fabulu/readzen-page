// test/lib-browser-hygiene.test.js
// Browser-compatibility guard for runtime modules: every top-level lib/*.js
// file ships to the browser as a plain ES module behind a strict CSP, so it
// must never import Node built-ins or touch Node globals. (lib/build/ is
// exempt — it is shared BUILD code imported only by the Node-only builders
// in build/ and by tests.)
//
// This is a source-level meta-test: it greps for the telltale patterns
// rather than executing anything, so a violation fails fast with the
// offending file + line.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const LIB_DIR = fileURLToPath(new URL('../lib', import.meta.url));

const RUNTIME_LIB_FILES = readdirSync(LIB_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.js'))
    .map((e) => e.name)
    .sort();

// Patterns that indicate Node-only API usage. NOTE: a bare /node:/ or /fs\./
// would false-positive on object keys like `{ node: ... }` (lib/inline-dict.js)
// and arbitrary `x.fs.` member chains, so the import/require forms are
// matched explicitly and the globals by their canonical spellings.
const FORBIDDEN = [
    { re: /\brequire\s*\(/, why: 'CommonJS require()' },
    { re: /from\s+['"]node:/, why: "static import from 'node:*'" },
    { re: /import\s*\(\s*['"]node:/, why: "dynamic import('node:*')" },
    { re: /from\s+['"](fs|path|crypto|url|os|child_process|module|stream|util|zlib)['"]/, why: 'bare Node built-in import' },
    { re: /\bprocess\.(env|argv|exit|platform|cwd|memoryUsage)\b/, why: 'Node process global' },
    { re: /\b(readFileSync|writeFileSync|readdirSync|existsSync|mkdirSync|createWriteStream|rmSync)\s*\(/, why: 'fs API call' },
    { re: /\b__dirname\b|\b__filename\b/, why: 'CommonJS path globals' },
    { re: /\bBuffer\.(from|alloc|byteLength)\b/, why: 'Node Buffer API' },
];

// Known-safe exemptions: pre-existing, feature-detected Node fallbacks that
// never execute in a browser (guarded by `typeof btoa/atob === 'function'`).
const ALLOWLIST = [
    { file: 'reading-list-share.js', re: /\bBuffer\.from\(s, '(utf-8|base64)'\)/ },
];

function isAllowlisted(file, line) {
    return ALLOWLIST.some((a) => a.file === file && a.re.test(line));
}

test('runtime lib/*.js modules contain no Node-only APIs (browser/CSP hygiene)', () => {
    assert.ok(RUNTIME_LIB_FILES.length >= 20, `sanity: found ${RUNTIME_LIB_FILES.length} lib modules`);
    const violations = [];
    for (const name of RUNTIME_LIB_FILES) {
        const src = readFileSync(join(LIB_DIR, name), 'utf8');
        const lines = src.split('\n');
        for (let i = 0; i < lines.length; i++) {
            for (const { re, why } of FORBIDDEN) {
                if (re.test(lines[i]) && !isAllowlisted(name, lines[i])) {
                    violations.push(`lib/${name}:${i + 1} [${why}] ${lines[i].trim()}`);
                }
            }
        }
    }
    assert.deepEqual(violations, [], 'Node-only API usage found in runtime lib modules:\n' + violations.join('\n'));
});

test('the v3 search modules are covered by the hygiene scan', () => {
    // Guard the guard: the files this mission touched must be in the scanned set.
    for (const f of ['bigram-search.js', 'bigram-codec.js', 'search.js', 'cjk-normalize.js', 'fnv.js', 'cache.js']) {
        assert.ok(RUNTIME_LIB_FILES.includes(f), `lib/${f} missing from hygiene scan`);
    }
});
