#!/usr/bin/env node
// build/generate-seo-pages.js
//
// Generates static HTML landing pages for each text and master so that
// crawlers (Discord, Reddit, Twitter, Google) see route-specific meta tags
// instead of the generic 404.html fallback.
//
// Each generated page has rich <title>, Open Graph, Twitter Card, and
// <noscript> content, then redirects to the SPA hash route via JS.
//
// Usage: node build/generate-seo-pages.js

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const CBETA_TITLES = resolve(__dirname, '../../CbetaZenTranslations/titles.jsonl');
const OPEN_TITLES = resolve(__dirname, '../../OpenZenTranslations/titles.jsonl');
const MASTERS = resolve(__dirname, '../../CbetaZenTranslations/masters.json');

function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function makePage(route, title, description, noscriptTitle, noscriptBody) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta property="og:type" content="article">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="https://readzen.pages.dev/${route}">
<meta property="og:site_name" content="Read Zen">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<link rel="canonical" href="https://readzen.pages.dev/${route}">
<script>window.location.replace('/#/${route}');</script>
</head>
<body>
<noscript>
<h1>${escapeHtml(noscriptTitle)}</h1>
<p>${escapeHtml(noscriptBody)}</p>
<p><a href="https://readzen.pages.dev">Read Zen Home</a></p>
</noscript>
</body>
</html>`;
}

async function readJsonl(path) {
    if (!existsSync(path)) return [];
    const entries = [];
    const rl = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
    for await (const line of rl) {
        if (!line.trim()) continue;
        try { entries.push(JSON.parse(line)); } catch {}
    }
    return entries;
}

function slugify(name) {
    return name.replace(/'/g, '').replace(/\s+/g, '_');
}

async function main() {
    let textCount = 0;
    let masterCount = 0;
    let staticCount = 0;

    // --- Text pages ---
    const cbetaTitles = await readJsonl(CBETA_TITLES);
    const openTitles = await readJsonl(OPEN_TITLES);
    const allTitles = [...cbetaTitles, ...openTitles];

    for (const entry of allTitles) {
        const p = entry.path || '';
        const id = p.replace(/\.xml$/, '').split('/').pop();
        if (!id) continue;

        const zh = entry.zh || '';
        const en = entry.en || entry.enShort || '';
        const title = en ? `${en} (${zh}) - Read Zen` : `${zh} - Read Zen`;
        const desc = en
            ? `Read ${en} (${zh}) side by side with hover dictionary and English translation on Read Zen.`
            : `Read ${zh} (${id}) in the Read Zen bilingual reader.`;
        const noscriptTitle = en ? `${en} ${zh}` : `${zh} (${id})`;
        const noscriptBody = en
            ? `Read ${en} (${zh}) in the Read Zen bilingual reader with hover dictionary.`
            : `Read ${zh} in the Read Zen bilingual reader.`;

        const dir = resolve(ROOT, id);
        mkdirSync(dir, { recursive: true });
        writeFileSync(resolve(dir, 'index.html'), makePage(id, title, desc, noscriptTitle, noscriptBody), 'utf8');
        textCount++;
    }

    // --- Master pages ---
    if (existsSync(MASTERS)) {
        const mastersData = JSON.parse(readFileSync(MASTERS, 'utf8'));
        const masters = mastersData.masters || mastersData;

        for (const m of masters) {
            const names = m.names || [];
            const canonical = names[0];
            if (!canonical) continue;

            const zh = names[1] || '';
            const school = m.school || 'Chan';
            const slug = slugify(canonical);
            const title = zh ? `${canonical} (${zh}) - ${school} - Read Zen` : `${canonical} - ${school} - Read Zen`;
            const desc = m.notes
                ? m.notes.substring(0, 200)
                : `${canonical} ${zh} - ${school} school Zen master profile on Read Zen.`;
            const noscriptTitle = zh ? `${canonical} ${zh}` : canonical;

            const dir = resolve(ROOT, 'master', slug);
            mkdirSync(dir, { recursive: true });
            writeFileSync(resolve(dir, 'index.html'), makePage(`master/${slug}`, title, desc, noscriptTitle, desc), 'utf8');
            masterCount++;
        }
    }

    // --- Static pages ---
    const statics = [
        { route: 'search', title: 'Search Chinese Zen Texts - Read Zen', desc: 'Full-text and title search across ~5000 Chinese Zen texts from CBETA and OpenZen.', h1: 'Search', body: 'Search across ~5000 Chinese Zen texts.' },
        { route: 'masters', title: '301 Zen Master Profiles - Read Zen', desc: 'Browse 301 Zen master profiles with biographical details, lineage connections, and corpus text appearances.', h1: 'Zen Masters', body: 'Browse 301 Zen master profiles.' },
        { route: 'lineage', title: 'Zen Lineage Graph - Read Zen', desc: 'Interactive lineage graph of 301 Chan/Zen masters across nine schools, from Bodhidharma to the late Ming.', h1: 'Zen Lineage', body: 'Explore the interactive Zen lineage graph.' },
    ];

    for (const s of statics) {
        const dir = resolve(ROOT, s.route);
        mkdirSync(dir, { recursive: true });
        writeFileSync(resolve(dir, 'index.html'), makePage(s.route, s.title, s.desc, s.h1, s.body), 'utf8');
        staticCount++;
    }

    console.log(`Generated SEO pages: ${textCount} texts + ${masterCount} masters + ${staticCount} static = ${textCount + masterCount + staticCount} total`);
}

main().catch(err => { console.error(err); process.exitCode = 1; });
