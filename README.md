![Cloudflare Pages](https://img.shields.io/badge/Cloudflare-Pages-F38020?logo=cloudflare&logoColor=white)
![Vanilla ES6](https://img.shields.io/badge/Vanilla-ES6-F7DF1E?logo=javascript&logoColor=black)
![License: MIT](https://img.shields.io/badge/License-MIT-green)
[![Support on Ko-fi](https://img.shields.io/badge/Support_on-Ko--fi-ff5e5b?logo=ko-fi&logoColor=white)](https://ko-fi.com/readzen)

# Read Zen Web

**[readzen.pages.dev](https://readzen.pages.dev)** — a zero-install web app for reading, searching, and exploring Chinese Zen texts across the CBETA (~5000 texts) and OpenZen corpora.

This is the web companion to the [Read Zen desktop app](https://github.com/Fabulu/ReadZen). The web app handles reading, searching, and browsing; the desktop app adds the workbench layer (translation editing, Scholar collections, community sync, qualitative coding, and analytics).

## Features

### Reading
- Side-by-side Chinese / English bilingual reader with paginated navigation
- Translator switching — choose between community translations, with star counts showing popularity
- Passage links with optional line ranges for sharing specific excerpts
- Compare mode: two translations side by side against the original

### Dictionary
- **Hover dictionary** (mouse) — hover over any Chinese character for instant CC-CEDICT lookup with pinyin, definitions, and grammar particle hints
- **Click dictionary** (touch/mobile) — tap for the same lookup card
- Longest-prefix matching (4→3→2→1 characters) for multi-character terms
- Dictionary data bucketed into 201 files from 120K+ CC-CEDICT entries for fast loading

### Search
- **Title search** with typeahead suggestions for masters and texts
- **Full-text search** via [Pagefind](https://pagefind.app) — client-side WASM search across the full corpus
- Federated results: master profiles + title matches + full-text hits
- Master corpus association — searching a master's name surfaces their related texts

### Zen Masters
- 301 master profiles with biographical details, dates, schools, and reference links
- Interactive lineage graph with pan, zoom, school color-coding, and Korean Seon positioning
- Corpus text appearances: which texts mention each master, with snippets
- Master-to-master navigation via teacher/student links

### Other
- Scholar collection browser (community-shared research collections)
- Termbase / terminology lookup
- Tag browser
- Deep links compatible with the desktop app's `zen://` URI scheme
- "Open in Read Zen" handoff to the desktop app (toggleable per user preference)

## Architecture

Zero-build vanilla ES6 SPA. No framework, no bundler, no transpiler. Deployed as static files to Cloudflare Pages.

```
index.html          Entry point (hash router)
app.js              Router + view dispatcher
style.css           All styles (single file)
views/              Page-level view modules
  landing.js        Home page with lineage graph + search
  passage.js        Bilingual text reader (paginated, ranged, compare)
  search.js         Federated search (title + full-text + masters)
  master.js         Individual master profile page
  masters-browse.js Master list browser
  lineage-graph.js  Interactive lineage web (canvas-based)
  dictionary.js     Dictionary lookup page
  scholar.js        Scholar collection viewer
  shell.js          Shared header, nav, footer
lib/                Shared utilities
  github.js         GitHub raw content fetcher with retry + caching
  inline-dict.js    Hover/click dictionary overlay
  search.js         Pagefind integration + federated search
  typeahead.js       Search suggestions (masters, titles, corpus)
  route.js          Hash-based routing
  tei.js            TEI XML parser
  format.js         Line rendering (HTML generation)
  highlight.js      Search term highlighting + scroll-to-match
  cache.js          In-memory LRU cache
dict/               CC-CEDICT dictionary data
  _manifest.json    Character → bucket mapping
  {0-200}.json      201 bucket files (~60 entries each)
pagefind/           Pagefind WASM search index (gitignored, built locally)
build/              Build scripts (Node.js)
```

## Data Sources

All data is fetched at runtime from GitHub — nothing is bundled except the dictionary and Pagefind index.

| Data | Source | Repo |
|------|--------|------|
| Chinese source texts | CBETA XML (TEI P5) | [CbetaZenTexts](https://github.com/Fabulu/CbetaZenTexts) |
| English translations | Community translations | [CbetaZenTranslations](https://github.com/Fabulu/CbetaZenTranslations) |
| OpenZen source texts | Freely-licensed witnesses | [OpenZenTexts](https://github.com/Fabulu/OpenZenTexts) |
| OpenZen translations | Community translations | [OpenZenTranslations](https://github.com/Fabulu/OpenZenTranslations) |
| Master profiles | `masters.json` | CbetaZenTranslations |
| Master corpus data | `corpus/masters/*.json` | CbetaZenTranslations |
| Star counts | `star-counts.json` | CbetaZenTranslations |
| Dictionary | CC-CEDICT (bundled) | This repo (`dict/`) |
| Full-text index | Pagefind (built locally) | This repo (`pagefind/`, gitignored) |

## Build Scripts

Located in `build/`. Require Node.js 18+.

### Dictionary buckets

Bundles 12K per-character CC-CEDICT shards into 201 numbered bucket files + manifest:

```bash
node build/bundle-dict-buckets.js
```

### Pagefind full-text index

Builds the WASM search index from corpus XML (~10-15 min, ~4GB RAM):

```bash
npm install
npm run build:search
```

### Master corpus shards

Splits the monolithic master-corpus.json into per-master files:

```bash
node build/shard-master-corpus.js
```

## Deployment

Deployed to Cloudflare Pages. Push to `main` triggers automatic deployment.

**Cloudflare Pages limits:**
- 20,000 files max per deployment — this is why the dictionary is bucketed (12K → 201 files) and the Pagefind index is deployed separately

### Manual deploy (if GitHub Actions OOMs)

```bash
npx wrangler pages deploy . --project-name=readzen --branch=main
```

## Development

No build step needed for development. Serve the directory with any static file server:

```bash
npx serve .
# or
python -m http.server 8000
```

Open `http://localhost:8000` (or whatever port). The app fetches all corpus data from GitHub raw URLs, so an internet connection is required.

## Tests

```bash
npm test
```

## Legal

MIT License.

Data sources:
- **CBETA corpus**: non-commercial terms
- **OpenZen**: per-file license (CC0, CC BY-SA)
- **CC-CEDICT**: CC BY-SA 4.0
