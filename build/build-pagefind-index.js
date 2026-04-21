#!/usr/bin/env node
// build/build-pagefind-index.js
// Builds a Pagefind full-text search index from CBETA + OpenZen XML corpus.
// Output: pagefind/ directory (static files for client-side search)

import * as pagefind from 'pagefind';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, relative, basename } from 'path';

// === Configuration ===
const CBETA_XML_DIR = process.env.CBETA_XML_DIR || 'C:/Programmieren/CbetaZenTexts/xml-p5';
const OPENZEN_XML_DIR = process.env.OPENZEN_XML_DIR || 'C:/Programmieren/OpenZenTexts/xml-open';
const CBETA_TITLES = process.env.CBETA_TITLES || 'C:/Programmieren/CbetaZenTranslations/titles.jsonl';
const OPENZEN_TITLES = process.env.OPENZEN_TITLES || 'C:/Programmieren/OpenZenTranslations/titles.jsonl';
const CBETA_TRANSLATED_DIR = process.env.CBETA_TRANSLATED_DIR || 'C:/Programmieren/CbetaZenTranslations/xml-p5t';
const OPENZEN_TRANSLATED_DIR = process.env.OPENZEN_TRANSLATED_DIR || 'C:/Programmieren/OpenZenTranslations/xml-open-t';
const ZEN_TEXTS_PATH = process.env.ZEN_TEXTS_PATH || 'C:/Programmieren/CbetaZenTranslations/zen_texts.json';
const OUTPUT_DIR = './pagefind';

// === Text extraction (ported from C# MakeSearchableTextFromXml_Fast) ===
function extractTextFromXml(xml) {
    // Find <body> content
    const iBody = xml.toLowerCase().indexOf('<body');
    if (iBody < 0) return '';
    const iStart = xml.indexOf('>', iBody);
    if (iStart < 0) return '';
    const iEnd = xml.toLowerCase().indexOf('</body>', iStart + 1);
    if (iEnd < 0) return '';

    let result = '';
    let inTag = false;
    let prevSpace = true;

    for (let i = iStart + 1; i < iEnd; i++) {
        const ch = xml[i];
        if (inTag) {
            if (ch === '>') inTag = false;
            continue;
        }
        if (ch === '<') {
            inTag = true;
            if (!prevSpace) { result += ' '; prevSpace = true; }
            continue;
        }
        if (ch === '\r') continue;
        if (ch === '\n' || ch === '\t' || ch === ' ' || ch === '\f' || ch === '\v') {
            if (!prevSpace) { result += ' '; prevSpace = true; }
            continue;
        }
        result += ch;
        prevSpace = false;
    }
    if (result.endsWith(' ')) result = result.slice(0, -1);
    return result;
}

// === Load titles from JSONL ===
async function loadTitles(path) {
    const titles = new Map();
    if (!existsSync(path)) return titles;
    const text = readFileSync(path, 'utf-8');
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
            const obj = JSON.parse(line);
            if (obj.path) titles.set(obj.path, obj);
        } catch {}
    }
    return titles;
}

// === Find all XML files recursively ===
function findXmlFiles(dir) {
    const results = [];
    if (!existsSync(dir)) return results;
    function walk(d) {
        for (const entry of readdirSync(d, { withFileTypes: true })) {
            const full = join(d, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith('.xml')) results.push(full);
        }
    }
    walk(dir);
    return results;
}

// === Check if translated version exists ===
function hasTranslation(relPath, translatedDir) {
    return existsSync(join(translatedDir, relPath));
}

// === Main ===
async function main() {
    console.log('Building Pagefind index...');

    // Load titles
    const cbetaTitles = await loadTitles(CBETA_TITLES);
    const openzenTitles = await loadTitles(OPENZEN_TITLES);
    console.log(`Loaded ${cbetaTitles.size} CBETA titles, ${openzenTitles.size} OpenZen titles`);

    // Load zen text IDs
    let zenIds = new Set();
    try {
        const zenData = JSON.parse(readFileSync(ZEN_TEXTS_PATH, 'utf-8'));
        zenIds = new Set((zenData.Zen || []).map(p => p.replace(/\.xml$/, '').split('/').pop()));
    } catch {}
    console.log(`Loaded ${zenIds.size} zen text IDs`);

    // Create Pagefind index
    const { index } = await pagefind.createIndex();

    let count = 0;

    // Process CBETA corpus
    const cbetaFiles = findXmlFiles(CBETA_XML_DIR);
    console.log(`Found ${cbetaFiles.length} CBETA XML files`);

    for (const absPath of cbetaFiles) {
        const relPath = relative(CBETA_XML_DIR, absPath).replace(/\\/g, '/');
        const xml = readFileSync(absPath, 'utf-8');
        const text = extractTextFromXml(xml);
        if (!text) continue;

        const titleEntry = cbetaTitles.get(relPath) || {};
        const fileId = basename(absPath, '.xml');
        const translated = hasTranslation(relPath, CBETA_TRANSLATED_DIR);
        const isZen = zenIds.has(fileId);
        const collection = relPath.split('/')[0] || 'T';

        await index.addCustomRecord({
            url: '/' + fileId,
            content: text,
            language: 'zh',
            meta: {
                title: titleEntry.zh || fileId,
                title_en: titleEntry.en || '',
                file_id: fileId
            },
            filters: {
                corpus: ['cbeta'],
                translated: [translated ? 'true' : 'false'],
                zen: [isZen ? 'true' : 'false'],
                collection: [collection]
            }
        });

        count++;
        if (count % 500 === 0) console.log(`  Indexed ${count} files...`);
    }

    // Process OpenZen corpus
    const openzenFiles = findXmlFiles(OPENZEN_XML_DIR);
    console.log(`Found ${openzenFiles.length} OpenZen XML files`);

    for (const absPath of openzenFiles) {
        const relPath = relative(OPENZEN_XML_DIR, absPath).replace(/\\/g, '/');
        const xml = readFileSync(absPath, 'utf-8');
        const text = extractTextFromXml(xml);
        if (!text) continue;

        const titleEntry = openzenTitles.get(relPath) || {};
        const fileId = 'oz.' + basename(absPath, '.xml');
        const translated = hasTranslation(relPath, OPENZEN_TRANSLATED_DIR);

        await index.addCustomRecord({
            url: '/' + fileId,
            content: text,
            language: 'zh',
            meta: {
                title: titleEntry.zh || fileId,
                title_en: titleEntry.en || '',
                file_id: fileId
            },
            filters: {
                corpus: ['openzen'],
                translated: [translated ? 'true' : 'false'],
                zen: ['false'],
                collection: ['openzen']
            }
        });
        count++;
    }

    // Process CBETA translations
    const cbetaTransFiles = findXmlFiles(CBETA_TRANSLATED_DIR);
    console.log(`Found ${cbetaTransFiles.length} CBETA translation files`);

    for (const absPath of cbetaTransFiles) {
        const relPath = relative(CBETA_TRANSLATED_DIR, absPath).replace(/\\/g, '/');
        const xml = readFileSync(absPath, 'utf-8');
        const text = extractTextFromXml(xml);
        if (!text) continue;

        const fileId = basename(absPath, '.xml');
        const titleEntry = cbetaTitles.get(relPath) || {};

        await index.addCustomRecord({
            url: '/' + fileId,
            content: text,
            language: 'en',
            meta: {
                title: titleEntry.en || titleEntry.zh || fileId,
                title_zh: titleEntry.zh || '',
                file_id: fileId
            },
            filters: {
                corpus: ['cbeta'],
                translated: ['true'],
                side: ['translation'],
                zen: [zenIds.has(fileId) ? 'true' : 'false']
            }
        });
        count++;
    }

    // Process OpenZen translations
    const openzenTransFiles = findXmlFiles(OPENZEN_TRANSLATED_DIR);
    console.log(`Found ${openzenTransFiles.length} OpenZen translation files`);

    for (const absPath of openzenTransFiles) {
        const relPath = relative(OPENZEN_TRANSLATED_DIR, absPath).replace(/\\/g, '/');
        const xml = readFileSync(absPath, 'utf-8');
        const text = extractTextFromXml(xml);
        if (!text) continue;

        const fileId = 'oz.' + basename(absPath, '.xml');
        const titleEntry = openzenTitles.get(relPath) || {};

        await index.addCustomRecord({
            url: '/' + fileId,
            content: text,
            language: 'en',
            meta: {
                title: titleEntry.en || titleEntry.zh || fileId,
                title_zh: titleEntry.zh || '',
                file_id: fileId
            },
            filters: {
                corpus: ['openzen'],
                translated: ['true'],
                side: ['translation'],
                zen: ['false']
            }
        });
        count++;
    }

    // Process community translations
    const COMMUNITY_DIR = process.env.COMMUNITY_DIR || 'C:/Programmieren/CbetaZenTranslations/community/translations';
    if (existsSync(COMMUNITY_DIR)) {
        const users = readdirSync(COMMUNITY_DIR, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name);

        console.log(`Found ${users.length} community translators: ${users.join(', ')}`);

        for (const user of users) {
            const userDir = join(COMMUNITY_DIR, user);
            const userFiles = findXmlFiles(userDir);

            for (const absPath of userFiles) {
                const relPath = relative(userDir, absPath).replace(/\\/g, '/');
                const xml = readFileSync(absPath, 'utf-8');
                const text = extractTextFromXml(xml);
                if (!text) continue;

                const fileId = basename(absPath, '.xml');
                const titleEntry = cbetaTitles.get(relPath) || {};

                await index.addCustomRecord({
                    url: '/' + fileId,
                    content: text,
                    language: 'en',
                    meta: {
                        title: titleEntry.en || titleEntry.zh || fileId,
                        title_zh: titleEntry.zh || '',
                        file_id: fileId,
                        translator: user
                    },
                    filters: {
                        corpus: ['cbeta'],
                        translated: ['true'],
                        side: ['community'],
                        translator: [user]
                    }
                });
                count++;
            }
            console.log(`  ${user}: ${userFiles.length} files`);
        }
    }

    console.log(`Total indexed: ${count} files (source + translations + community)`);
    console.log(`Writing Pagefind output to ${OUTPUT_DIR}...`);

    await index.writeFiles({ outputPath: OUTPUT_DIR });
    await pagefind.close();

    console.log('Done!');
}

main().catch(err => { console.error(err); process.exit(1); });
