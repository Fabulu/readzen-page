import test from 'node:test';
import assert from 'node:assert';
import { readFile, access } from 'node:fs/promises';

// PWA wiring contract: everything the service worker precaches must exist,
// the manifest must stay valid, and the SW must keep the immutable/mutable
// split that mirrors _headers (stale text shards after a redeploy would
// serve wrong docId->text mappings).

test('sw.js precache entries exist on disk', async () => {
    const src = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
    const m = src.match(/const PRECACHE = \[([^\]]*)\]/s);
    assert.ok(m, 'PRECACHE list not found');
    const entries = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    assert.ok(entries.length >= 5);
    for (const e of entries) {
        const rel = e === '/' ? '/index.html' : e;
        await access(new URL('..' + rel, import.meta.url));
    }
});

test('manifest.json is valid and complete', async () => {
    const man = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
    for (const k of ['name', 'short_name', 'start_url', 'display', 'icons', 'theme_color']) {
        assert.ok(man[k], 'manifest missing ' + k);
    }
    assert.ok(man.icons.length >= 1);
});

test('sw.js keeps the immutable/mutable data split from _headers', async () => {
    const src = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
    // hashed shards -> cacheFirst; other /data/search/ (text shards, manifest,
    // docs.txt) -> networkFirst. Order matters: the specific branch must come first.
    const iShards = src.indexOf("/data/search/bigram/shards/");
    const iData = src.indexOf("'/data/search/'");
    assert.ok(iShards >= 0 && iData >= 0 && iShards < iData,
        'hashed-shard branch must precede the generic /data/search/ branch');
    assert.match(src, /cacheFirst/);
    assert.match(src, /networkFirst/);
});

test('index.html links icon and manifest; app.js registers the SW', async () => {
    const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
    assert.ok(html.includes('rel="manifest"'));
    assert.ok(html.includes('/assets/icon.svg'));
    const app = await readFile(new URL('../app.js', import.meta.url), 'utf8');
    assert.ok(app.includes("serviceWorker.register('/sw.js')"));
});
