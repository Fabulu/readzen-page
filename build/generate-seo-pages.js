#!/usr/bin/env node
// build/generate-seo-pages.js
//
// Generates:
// 1. Static HTML landing pages for texts and masters (rich OG + noscript)
// 2. A crawlable /masters/index.html linking to all master pages
// 3. sitemap.xml
// 4. robots.txt
//
// Usage: node build/generate-seo-pages.js

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const BASE = 'https://readzen.pages.dev';

const CBETA_TITLES = resolve(__dirname, '../../CbetaZenTranslations/titles.jsonl');
const OPEN_TITLES = resolve(__dirname, '../../OpenZenTranslations/titles.jsonl');
const MASTERS = resolve(__dirname, '../../CbetaZenTranslations/masters.json');

function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function makePage(route, title, description, noscriptHtml, jsonLd) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:type" content="article">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${BASE}/${route}">
<meta property="og:site_name" content="Read Zen">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<link rel="canonical" href="${BASE}/${route}">
<style>body { font-family: system-ui, sans-serif; max-width: 720px; margin: 2em auto; padding: 0 1em; line-height: 1.6; color: #333; } a { color: #1a73e8; } h1 { font-size: 1.5em; }</style>${jsonLd ? `\n<script type="application/ld+json">${jsonLd}</script>` : ''}
</head>
<body>
${noscriptHtml}
<p><a href="${BASE}">Read Zen Home</a></p>
<p style="margin-top:2em"><a href="${BASE}/#/${route}">View interactive profile &rarr;</a></p>
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

function buildMasterNoscript(m) {
    const names = m.names || [];
    const canonical = names[0] || '';
    const zh = names[1] || '';
    const school = m.school || '';
    const teacher = m.teacher || '';
    const students = m.students || [];
    const notes = m.notes || '';
    const death = m.death || '';
    const floruit = m.floruit || '';
    const links = m.links || [];

    let html = `<h1>${esc(canonical)}${zh ? ' ' + esc(zh) : ''}</h1>\n`;

    // Key facts
    const facts = [];
    if (school) facts.push(`School: ${esc(school)}`);
    if (floruit && death) facts.push(`${floruit}-${death}`);
    else if (death) facts.push(`d. ${death}`);
    if (teacher) facts.push(`Teacher: ${esc(teacher)}`);
    if (students.length) facts.push(`Students: ${esc(students.join(', '))}`);
    if (facts.length) html += `<p>${facts.join(' | ')}</p>\n`;

    // Bio
    if (notes) html += `<p>${esc(notes)}</p>\n`;

    // Links
    if (links.length) {
        html += '<p>References: ';
        html += links.map(l => `<a href="${esc(l.url)}">${esc(l.label)}</a>`).join(' | ');
        html += '</p>\n';
    }

    return html;
}

async function main() {
    const allRoutes = ['']; // homepage
    let textCount = 0;
    let masterCount = 0;

    // --- Text pages ---
    const cbetaTitles = await readJsonl(CBETA_TITLES);
    const openTitles = await readJsonl(OPEN_TITLES);
    const allTitles = [...cbetaTitles, ...openTitles];

    // Only generate for the 8 featured texts + OpenZen editions
    const featuredIds = new Set([
        'T48n2005', 'T48n2010', 'T48n2004', 'T48n2003',
        'T48n2012A', 'T47n1987A', 'J24nB137', 'T47n1987B'
    ]);
    // Also include any OpenZen texts
    const textEntries = allTitles.filter(e => {
        const fid = e.fileId || '';
        const p = e.path || '';
        const id = fid || p.replace(/\.xml$/, '').split('/').pop();
        return featuredIds.has(id) || fid.startsWith('pd.') || fid.startsWith('ws.') || fid.startsWith('ce.') || fid.startsWith('mit.') || p.startsWith('pd.') || p.startsWith('ws.') || p.startsWith('ce.') || p.startsWith('mit.');
    });

    for (const entry of textEntries) {
        const id = entry.fileId || entry.path?.replace(/\.xml$/, '').split('/').pop() || '';
        if (!id) continue;

        const zh = entry.zh || '';
        const en = entry.en || entry.enShort || '';
        const title = en ? `${en} (${zh}) - Read Zen` : `${zh} - Read Zen`;
        const desc = en
            ? `Read ${en} (${zh}) side by side with hover dictionary and English translation on Read Zen.`
            : `Read ${zh} (${id}) in the Read Zen bilingual reader.`;
        const noscript = `<h1>${esc(en || zh)} ${esc(zh)}</h1>\n<p>${esc(desc)}</p>`;

        const dir = resolve(ROOT, id);
        mkdirSync(dir, { recursive: true });
        writeFileSync(resolve(dir, 'index.html'), makePage(id, title, desc, noscript), 'utf8');
        allRoutes.push(id);
        textCount++;
    }

    // --- Master pages (all 301, with rich bios) ---
    const masterIndex = []; // for the crawlable index page
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
                ? m.notes.substring(0, 200).replace(/\n/g, ' ')
                : `${canonical} ${zh} - ${school} school Zen master profile on Read Zen.`;

            const noscript = buildMasterNoscript(m);
            const route = `master/${slug}`;
            const jsonLd = JSON.stringify({
                "@context": "https://schema.org",
                "@type": "Person",
                "name": canonical,
                "description": desc
            });

            const dir = resolve(ROOT, 'master', slug);
            mkdirSync(dir, { recursive: true });
            writeFileSync(resolve(dir, 'index.html'), makePage(route, title, desc, noscript, jsonLd), 'utf8');
            allRoutes.push(route);
            masterIndex.push({ canonical, zh, school, slug, death: m.death, floruit: m.floruit });
            masterCount++;
        }
    }

    // --- Static pages ---
    const statics = [
        { route: 'search', title: 'Search Chinese Zen Texts - Read Zen', desc: 'Full-text and title search across ~5000 Chinese Zen texts from CBETA and OpenZen.', noscript: '<h1>Search</h1>\n<p>Search across ~5000 Chinese Zen texts from CBETA and OpenZen.</p>' },
        { route: 'lineage', title: 'Zen Lineage Graph - Read Zen', desc: 'Interactive lineage graph of 301 Chan/Zen masters across nine schools, from Bodhidharma to the late Ming.', noscript: '<h1>Zen Lineage</h1>\n<p>Explore the interactive Zen lineage graph.</p>' },
    ];

    for (const s of statics) {
        const dir = resolve(ROOT, s.route);
        mkdirSync(dir, { recursive: true });
        writeFileSync(resolve(dir, 'index.html'), makePage(s.route, s.title, s.desc, s.noscript), 'utf8');
        allRoutes.push(s.route);
    }

    // --- Crawlable master index page ---
    masterIndex.sort((a, b) => a.canonical.localeCompare(b.canonical));
    let masterListHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>301 Zen Master Profiles - Read Zen</title>
<meta name="description" content="Browse 301 Zen master profiles with biographical details, lineage connections, school affiliations, and corpus text appearances.">
<meta property="og:type" content="website">
<meta property="og:title" content="301 Zen Master Profiles - Read Zen">
<meta property="og:description" content="Browse 301 Zen master profiles with biographical details, lineage connections, and corpus text appearances.">
<meta property="og:url" content="${BASE}/masters">
<meta property="og:site_name" content="Read Zen">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="301 Zen Master Profiles - Read Zen">
<link rel="canonical" href="${BASE}/masters">
<style>body { font-family: system-ui, sans-serif; max-width: 720px; margin: 2em auto; padding: 0 1em; line-height: 1.6; color: #333; } a { color: #1a73e8; } h1 { font-size: 1.5em; }</style>
</head>
<body>
<h1>301 Zen Master Profiles</h1>
<p>Browse Zen master profiles with biographical details, lineage connections, school affiliations, and corpus text appearances.</p>
<table>
<tr><th>Name</th><th>Chinese</th><th>School</th><th>Dates</th></tr>
`;
    for (const m of masterIndex) {
        const dates = m.floruit && m.death ? `${m.floruit}-${m.death}` : m.death ? `d. ${m.death}` : '';
        masterListHtml += `<tr><td><a href="${BASE}/master/${m.slug}">${esc(m.canonical)}</a></td><td>${esc(m.zh)}</td><td>${esc(m.school)}</td><td>${dates}</td></tr>\n`;
    }
    masterListHtml += `</table>\n<p><a href="${BASE}">Read Zen Home</a></p>\n<p style="margin-top:2em"><a href="${BASE}/#/masters">View interactive profiles &rarr;</a></p>\n</body>\n</html>`;

    mkdirSync(resolve(ROOT, 'masters'), { recursive: true });
    writeFileSync(resolve(ROOT, 'masters', 'index.html'), masterListHtml, 'utf8');
    allRoutes.push('masters');

    // --- Sitemap ---
    const today = new Date().toISOString().split('T')[0];
    let sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;
    for (const route of allRoutes) {
        const priority = route === '' ? '1.0' : route.startsWith('master/') ? '0.6' : '0.8';
        sitemap += `<url><loc>${BASE}/${route}</loc><lastmod>${today}</lastmod><priority>${priority}</priority></url>\n`;
    }
    sitemap += `</urlset>\n`;
    writeFileSync(resolve(ROOT, 'sitemap.xml'), sitemap, 'utf8');

    // --- robots.txt ---
    const robots = `User-agent: *\nAllow: /\nSitemap: ${BASE}/sitemap.xml\n`;
    writeFileSync(resolve(ROOT, 'robots.txt'), robots, 'utf8');

    console.log(`Generated: ${textCount} texts + ${masterCount} masters (rich bios) + ${statics.length} static + crawlable master index + sitemap.xml + robots.txt`);
    console.log(`Sitemap entries: ${allRoutes.length}`);
}

main().catch(err => { console.error(err); process.exitCode = 1; });
