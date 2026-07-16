![Cloudflare Pages](https://img.shields.io/badge/Cloudflare-Pages-F38020?logo=cloudflare&logoColor=white)
![Vanilla ES6](https://img.shields.io/badge/Vanilla-ES6-F7DF1E?logo=javascript&logoColor=black)
![License: MIT](https://img.shields.io/badge/License-MIT-green)
[![Support on Ko-fi](https://img.shields.io/badge/Support_on-Ko--fi-ff5e5b?logo=ko-fi&logoColor=white)](https://ko-fi.com/readzen)

# Read Zen Web

**[readzen.pages.dev](https://readzen.pages.dev)** - a zero-install web app for reading, searching, and exploring Chinese Zen texts across the CBETA (~5000 texts) and OpenZen corpora.

This is the web companion to the [Read Zen desktop app](https://github.com/Fabulu/ReadZen). The web app handles reading, searching, and browsing; the desktop app adds the workbench layer (translation editing, Scholar collections, community sync, qualitative coding, and analytics).

## Features

### Reading
- Side-by-side Chinese / English bilingual reader with paginated navigation
- Translator switching - choose between community translations, with star counts showing popularity
- Passage links with optional line ranges for sharing specific excerpts
- Compare mode: two translations side by side against the original

### Dictionary
- **Hover dictionary** (mouse) - hover over any Chinese character for instant CC-CEDICT lookup with pinyin, definitions, and grammar particle hints
- **Click dictionary** (touch/mobile) - tap for the same lookup card
- Longest-prefix matching (4→3→2→1 characters) for multi-character terms
- Dictionary data bucketed into 201 files from 120K+ CC-CEDICT entries for fast loading

### Search
- **Title search** with typeahead suggestions for masters and texts
- **Full-text search** via [Pagefind](https://pagefind.app) - client-side WASM search across the full corpus
- Federated results: master profiles + title matches + full-text hits
- Master corpus association - searching a master's name surfaces their related texts

### Zen Masters
- 301 master profiles with biographical details, dates, schools, and reference links
- Interactive lineage graph with pan, zoom, school color-coding, and Korean Seon positioning
- Corpus text appearances: which texts mention each master, with snippets
- Master-to-master navigation via teacher/student links

### Scholar Graph
- **Interactive force-directed graph** for scholar collections - visualizes passages, concepts, masters, terms, and their relationships
- **7 node types** with unique shapes: Passage (circle), Concept (diamond), Zen Master (hexagon), Term (pill), Collection (square), Book (rectangle), Link (oval)
- **7 node colors**: Passage blue, Concept coral, Master amber, Term green, Collection purple, Book tan, Link blue-grey
- **Starting node** highlighted with golden ripple pulse animation
- **Click** any node for a popup card with full details: Chinese/English text, masters, tags, notes, and connections
- **Double-click** to navigate: passages open in reader, books open in reader, links open in browser, collections navigate to their own graph
- **Hover dictionary** on Chinese text inside popup cards (CC-CEDICT lookup, same as the reader)
- Auto-generated master attribution edges with suppression support (`SuppressedAutoNodeIds`/`SuppressedAutoEdgeIds`)
- Custom edge type colors and display names
- Non-directional edge types rendered with dashed lines
- Node annotations displayed in gold italic
- `CollectionRef` nodes for cross-collection references
- `ExtraMasters` loading (manually-added masters persist)
- `LinkNodes` loading (web reference nodes)
- Edge labels on hover and in ego-network mode
- Minimap with viewport clipping
- Secondary labels: dates for masters, description snippets for concepts
- Wide node labels (8x radius) for readability
- Full passage text in popups (scrollable)
- Edge-aware popup positioning (never goes off screen)
- Collection title in page header
- Cache-busting for fresh data on reload
- Responsive graph height (800px / 85vh)

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
  compare.js        Side-by-side translation comparison
  landing.js        Home page with lineage graph + search
  passage.js        Bilingual text reader (paginated, ranged)
  search.js         Federated search (title + full-text + masters)
  master.js         Individual master profile page
  masters-browse.js Master list browser
  lineage-graph.js  Interactive lineage web (canvas-based)
  dictionary.js     Dictionary lookup page
  scholar.js        Scholar collection viewer
  scholar-graph.js  Force-directed collection graph (canvas-based)
  tags.js           Tag browser
  termbase.js       Terminology lookup
  shell.js          Shared header, nav, footer
lib/                Shared utilities
  cache.js          In-memory LRU cache
  citation.js       Citation formatting
  corpus.js         Corpus data helpers
  format.js         Line rendering (HTML generation)
  github.js         GitHub raw content fetcher with retry + caching
  highlight.js      Search term highlighting + scroll-to-match
  inline-dict.js    Hover/click dictionary overlay (CC-CEDICT)
  jsonl.js          JSONL streaming parser (scholar collections)
  keyboard.js       Keyboard shortcut handling
  lookup-card.js    Dictionary lookup card component
  reading-lists.js  Reading list management
  route.js          Hash-based routing
  search.js         Pagefind integration + federated search
  share.js          Share / link generation
  tei.js            TEI XML parser
  titles.js         Title resolution helpers
  typeahead.js      Search suggestions (masters, titles, corpus)
dict/               CC-CEDICT dictionary data
  _manifest.json    Character → bucket mapping
  {0-200}.json      201 bucket files (~60 entries each)
pagefind/           Pagefind WASM search index (gitignored, built locally)
build/              Build scripts (Node.js)
```

## Data Sources

All data is fetched at runtime from GitHub - nothing is bundled except the dictionary and Pagefind index.

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

Deployed to Cloudflare Pages, but **manually and locally** - there is no
automatic deploy trigger. `.github/workflows/deploy.yml`'s `push:` trigger is
commented out; the workflow only runs on `workflow_dispatch` (the manual button
in the Actions tab), because the bigram search index build peaks at ~3.5 GB and
OOMs on GitHub Actions runners. Pushing to `main` builds and deploys nothing on
its own - the site only updates when someone runs the deploy command below.

**Cloudflare Pages limits:**
- 20,000 files max per deployment - this is why the dictionary is bucketed (12K → 201 files) and the Pagefind index is deployed separately

### Deploy

```bash
npm run deploy
```

This is the one command. It builds the dictionary shards and search index,
stages a deploy-time copy of the whole site into `dist/` via
`build/make-dist.js` (stamping the app shell's internal references with a
content-hash version and switching its cache headers to `immutable` in that
copy only), and ships `dist/` with `wrangler`. `dist/` is gitignored and
rebuilt from scratch on every run - nothing about it is ever committed.

### Caching architecture

The app shell (`app.js`, `style.css`, `views/*.js`, `lib/*.js`) needs to load
instantly on repeat visits *and* never leave a client frozen on a stale build.
A service worker only reinstalls when its own bytes change, so if `sw.js` isn't
guaranteed to change on every shell deploy, its precache can go silently stale
forever - which is exactly what happened to a real user, who ran a
months-stale build until a hard-refresh. The design here closes that gap by
making the URL name its content, and by keeping that trick confined to a
throwaway build artifact instead of the repo:

- **The repo itself is never stamped.** `app.js`, `views/*.js`, `lib/*.js`,
  `sw.js`, and `_headers` in this tree always reference each other with plain,
  unversioned paths, and `_headers` always serves the shell `no-cache`. That's
  deliberate: it's what keeps the raw tree safe to read, edit, and deploy at
  any time (see "Emergency fallback" below), and it's what the `pwa.test.js`
  precache test enforces - if a stamped `sw.js` is ever committed, that test
  goes red on purpose.
- **`build/make-dist.js` is the only place a stamp is ever written.** It hashes
  the current shell contents into a `BUILD_ID`, copies the whole site into
  `dist/`, rewrites every shell-to-shell reference to `?v=<BUILD_ID>`, and
  edits the four shell rules in a *copy* of `_headers` to
  `immutable, max-age=31536000`. Because the URL now names its own content, a
  cached copy can never disagree with what's live - a new deploy is a new URL,
  never a silent mutation of an old one.
  - After everything above is written, it greps the entire staged tree it
    just produced for any bare reference to a shell file - unstamped, or
    stamped with anything other than that run's own `BUILD_ID` (a hardcoded,
    never-updated `?v=deadbeef` is just as dangerous as no query at all,
    since Cloudflare serves the same file regardless of query string). A
    single hit - or a crash anywhere between the `_headers` rewrite and the
    guard finishing - deletes the `dist/` it just wrote and exits non-zero,
    so a rejected build never leaves a complete-looking `dist/` on disk that
    could be `wrangler pages deploy dist`'d by accident; nothing survives
    to be shipped. **This guard is load-bearing** - it is the only thing
    standing between "content-addressed and safe" and "immutable and wrong."
    Never weaken it to a warning, and never bypass it.
  - `sw.js` itself is dual-mode: an unversioned request (i.e. the raw tree was
    deployed) is handled network-first under `no-cache`; a `?v=`-stamped
    request (i.e. a `dist/` deploy) is cache-first, since the URL can't
    disagree with what's cached.
- **`index.html` is the only file that keeps revalidating.** It stays
  `no-cache` in both the repo and `dist/`, and it's the only place allowed to
  reference a shell URL that isn't itself content-addressed - because
  `make-dist.js` rewrites it every deploy to point at that deploy's `?v=` URLs.
- **Never add a second `_headers` rule for a path that already has one**
  (in particular `/app.js`, `/style.css`, `/views/*`, `/lib/*`). Cloudflare
  joins duplicate header values with a comma instead of overriding them, so a
  second rule adding `immutable` next to the existing `no-cache` produces
  `Cache-Control: no-cache, immutable` - DevTools will proudly show
  "immutable" while the browser keeps revalidating every load and the whole
  trick silently does nothing. `make-dist.js` avoids this by editing the four
  existing rule values in place, in a copy, never by appending a rule.
- **Dev workflow is unaffected.** `npx serve .` (see "Development" below) runs
  the unstamped tree as-is; the service worker isn't even registered on
  `localhost` (see `app.js`/`sw.js`), so none of this is in play locally.

### Known limitation: Cloudflare's tiered cache

Cloudflare Pages fronts everything with Tiered Cache, which can hold an edge
copy of `index.html` for up to about a week **independent of `Cache-Control`**
(community-reported; no header opts out of it). Under this design that's
bounded and benign, not a repeat of the original bug: a stale edge
`index.html` still names a real, internally-consistent build's `?v=` URLs,
which still serve correctly - so the worst case is an old-but-coherent build
for a while, never a torn or frozen one. Purging the edge on every deploy
would close this but needs a Cloudflare API token and is out of scope here.

### Emergency fallback (raw deploy)

```bash
npx wrangler pages deploy . --project-name=readzen --branch=main
```

Deploying the worktree directly - skipping `dist/` and `make-dist.js` entirely
- is still safe. The repo's `_headers` is permanently `no-cache` and its shell
references are permanently unstamped, so this just re-enables the pre-Phase-2
behavior (a cheap revalidation round-trip per load) instead of the
instant-repeat-load win. Reach for it if `make-dist.js` or `wrangler` is
misbehaving and the site needs to go live right now.

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
