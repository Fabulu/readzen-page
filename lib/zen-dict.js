// lib/zen-dict.js
// Loader + card builder + longest-match index for the Zen dictionary (the
// curated TERMBASE from CbetaZenTranslations). This is the shared infra for
// the reader highlighter, the click-to-lookup Zen mode, and the dictionary
// browse view.
//
// Data source, in preference order:
//   1. termbase.v2.json  — rich envelope { schemaVersion, entries: [ {Id,
//        SourceTerm, Senses: [ {SenseKey, MasterName, PreferredTarget,
//        AlternateTargets, Status, Explanation, Validation, Note,
//        Occurrences, SourceTexts, RelatedMasters, RelatedTerms} ] } ] }
//   2. termbase.json — legacy flat array of
//        { SourceTerm, PreferredTarget, AlternateTargets, Status, Note, ... }
//        adapted to a single corpus-wide sense.
// If BOTH are missing the loader returns an EMPTY index (no throw) so the
// reader keeps rendering and click/highlight simply do nothing.
//
// Caching: the raw JSON is cached through lib/cache.js (survives into
// sessionStorage). The BUILT index carries Map/Set values that would not
// survive JSON round-tripping, so it is memoized in a module-level promise
// instead — built at most once per tab.

import { fetchJson, DATA_REPO_BASE } from './github.js';
import * as cache from './cache.js';
import { renderLookupCard } from './lookup-card.js';
import { escapeHtml } from './format.js';

const TERMBASE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** Memoized built index (Map/Set) — built at most once per tab. */
let _indexPromise = null;

/**
 * Load (or return the memoized) FULL Zen dictionary — every entry, with all
 * prose. Only the browse view (#/dict) needs this: it full-text searches the
 * explanations and notes. The READER must not call it — see loadZenIndex.
 * @returns {Promise<{entries: Array, byTerm: Map<string,object>, terms: Set<string>, maxLen: number}>}
 */
export function loadZenDict() {
    if (_indexPromise) return _indexPromise;
    _indexPromise = (async () => {
        const entries = await loadRawEntries();
        return buildIndex(entries);
    })();
    return _indexPromise;
}

// ── Sharded delivery: a tiny eager index + one lazy shard per click ───────
// Underlining terms in the reader needs ONLY the headwords. The prose
// (explanation / notes / attribution ≈ 90% of the bytes) is needed for a single
// entry, on click. So the reader loads termbase.index.json (tens of KB) and then
// pulls one shard, keyed by the term's first code point, when the user clicks.
// This keeps the reader's cost flat as the dictionary grows past 1,000 entries.

const SHARD_COUNT = 256;
const shardOf = term => (String(term).codePointAt(0) || 0) % SHARD_COUNT;
const shardName = term => String(shardOf(term)).padStart(3, '0');

/** Memoized headword index. */
let _headIndexPromise = null;
/** term -> entry, filled in as shards arrive. */
const _entryCache = new Map();
/** shard id -> in-flight/settled fetch, so N clicks in one shard cost one request. */
const _shardPromises = new Map();

/**
 * Load (or return the memoized) HEADWORD index: enough to underline terms and
 * show a gloss, and nothing more. This is what the reader uses.
 * @returns {Promise<{terms: Set<string>, gloss: Map<string,string>, maxLen: number}>}
 */
export function loadZenIndex() {
    if (_headIndexPromise) return _headIndexPromise;
    _headIndexPromise = (async () => {
        let rows = null;
        try {
            const file = await fetchTermbaseArtifact('termbase.index.json');
            rows = file && (file.Terms || file.terms);
        } catch { /* fall through */ }

        // No index published yet → fall back to the full termbase, so the reader
        // still highlights (just at the old cost) rather than going dark.
        if (!Array.isArray(rows)) {
            const full = await loadZenDict();
            return { terms: full.terms, gloss: new Map(), maxLen: full.maxLen };
        }

        const terms = new Set();
        const gloss = new Map();
        let maxLen = 0;
        for (const row of rows) {
            const term = Array.isArray(row) ? row[0] : (row && row.term);
            if (!term) continue;
            terms.add(term);
            gloss.set(term, (Array.isArray(row) ? row[1] : row.gloss) || '');
            const len = Array.from(term).length; // code points
            if (len > maxLen) maxLen = len;
        }
        return { terms, gloss, maxLen };
    })();
    return _headIndexPromise;
}

/**
 * Resolve ONE full entry by exact term, fetching (and caching) its shard.
 * @returns {Promise<object|null>}
 */
export async function loadZenEntry(term) {
    if (!term) return null;
    if (_entryCache.has(term)) return _entryCache.get(term);

    const id = shardOf(term);
    if (!_shardPromises.has(id)) {
        _shardPromises.set(id, (async () => {
            try {
                const file = await fetchTermbaseArtifact(`termbase/${shardName(term)}.json`);
                const list = file && (file.Entries || file.entries);
                if (!Array.isArray(list)) return;
                for (const raw of list) {
                    const e = normalizeEntry(raw);
                    if (e && e.sourceTerm && !_entryCache.has(e.sourceTerm)) _entryCache.set(e.sourceTerm, e);
                }
            } catch { /* shard missing — fall back below */ }
        })());
    }
    await _shardPromises.get(id);
    if (_entryCache.has(term)) return _entryCache.get(term);

    // Shards absent (not published yet) → fall back to the whole termbase.
    const full = await loadZenDict();
    return (full && full.byTerm && full.byTerm.get(term)) || null;
}

/**
 * True when served from localhost. Used only to allow a not-yet-published
 * termbase to be previewed from files sitting next to index.html, so the
 * dictionary can be reviewed before it is pushed to the data repo. On the
 * deployed site this is always false and the remote fetch is the only path.
 */
function isLocalPreview() {
    return typeof location !== 'undefined'
        && (location.hostname === 'localhost' || location.hostname === '127.0.0.1');
}

/**
 * Fetch a termbase artifact by name (termbase.index.json, termbase/017.json,
 * termbase.v2.json). On localhost an unpublished local copy wins; otherwise —
 * and whenever there is no local copy — it comes from the data repo.
 */
async function fetchTermbaseArtifact(name) {
    if (isLocalPreview()) {
        try {
            const local = await fetchTermbaseJson('./' + name);
            if (local) return local;
        } catch { /* not staged locally — use the published copy */ }
    }
    return fetchTermbaseJson(DATA_REPO_BASE + name);
}

/** Fetch + normalize the termbase entries (v2 first, legacy fallback, else []). */
async function loadRawEntries() {
    // 1. Rich v2 envelope.
    try {
        const v2 = await fetchTermbaseArtifact('termbase.v2.json');
        // Envelope key is case-tolerant: desktop DictionaryStore writes PascalCase "Entries".
        const entriesField = v2 ? (v2.entries || v2.Entries) : null;
        const list = Array.isArray(entriesField) ? entriesField
            : (Array.isArray(v2) ? v2 : null);
        if (list && list.length) return list.map(normalizeEntry).filter(Boolean);
    } catch { /* fall through to legacy */ }

    // 2. Legacy flat array.
    try {
        const legacy = await fetchTermbaseArtifact('termbase.json');
        if (Array.isArray(legacy) && legacy.length) {
            return legacy.map(normalizeLegacyEntry).filter(Boolean);
        }
    } catch { /* both absent — degrade to empty */ }

    return [];
}

/** Fetch + cache a termbase JSON file (mirrors views/termbase.js caching). */
async function fetchTermbaseJson(url) {
    const cacheKey = 'zendict:' + url;
    const cached = cache.get(cacheKey);
    if (cached) return cached;
    const data = await fetchJson(url);
    cache.set(cacheKey, data, TERMBASE_CACHE_TTL_MS);
    return data;
}

/** Pick the first defined value across PascalCase / camelCase key spellings. */
function pick(obj, ...keys) {
    for (const k of keys) {
        if (obj && obj[k] != null) return obj[k];
    }
    return undefined;
}

function asArray(v) {
    return Array.isArray(v) ? v : (v == null ? [] : [v]);
}

/** Normalize a v2 (or v2-shaped) entry into the common in-memory shape. */
function normalizeEntry(raw) {
    if (!raw) return null;
    const senses = pick(raw, 'Senses', 'senses');
    if (!Array.isArray(senses)) {
        // Not v2-shaped after all — treat as a legacy single-sense entry.
        return normalizeLegacyEntry(raw);
    }
    const sourceTerm = String(pick(raw, 'SourceTerm', 'sourceTerm') || '');
    if (!sourceTerm) return null;
    return {
        id: String(pick(raw, 'Id', 'id') || sourceTerm),
        sourceTerm,
        senses: senses.map(normalizeSense).filter(Boolean),
    };
}

function normalizeSense(raw) {
    if (!raw) return null;
    return {
        senseKey: String(pick(raw, 'SenseKey', 'senseKey') || ''),
        masterName: String(pick(raw, 'MasterName', 'masterName') || ''),
        preferredTarget: String(pick(raw, 'PreferredTarget', 'preferredTarget') || ''),
        alternateTargets: asArray(pick(raw, 'AlternateTargets', 'alternateTargets')).map(String).filter(Boolean),
        status: String(pick(raw, 'Status', 'status') || ''),
        explanation: String(pick(raw, 'Explanation', 'explanation') || ''),
        validation: String(pick(raw, 'Validation', 'validation') || ''),
        note: String(pick(raw, 'Note', 'note') || ''),
        occurrences: asArray(pick(raw, 'Occurrences', 'occurrences')),
        sourceTexts: asArray(pick(raw, 'SourceTexts', 'sourceTexts')).map(String).filter(Boolean),
        relatedMasters: asArray(pick(raw, 'RelatedMasters', 'relatedMasters')).map(String).filter(Boolean),
        relatedTerms: asArray(pick(raw, 'RelatedTerms', 'relatedTerms')).map(String).filter(Boolean),
    };
}

/** Adapt a legacy flat entry into the common shape (single corpus-wide sense). */
function normalizeLegacyEntry(raw) {
    if (!raw) return null;
    const sourceTerm = String(pick(raw, 'SourceTerm', 'sourceTerm') || '');
    if (!sourceTerm) return null;
    return {
        id: sourceTerm,
        sourceTerm,
        senses: [{
            senseKey: '',
            masterName: '',
            preferredTarget: String(pick(raw, 'PreferredTarget', 'preferredTarget') || ''),
            alternateTargets: asArray(pick(raw, 'AlternateTargets', 'alternateTargets')).map(String).filter(Boolean),
            status: String(pick(raw, 'Status', 'status') || ''),
            explanation: String(pick(raw, 'Explanation', 'explanation') || ''),
            validation: '',
            note: String(pick(raw, 'Note', 'note') || ''),
            occurrences: asArray(pick(raw, 'Occurrences', 'occurrences')),
            sourceTexts: [],
            relatedMasters: [],
            relatedTerms: [],
        }],
    };
}

/** Build the longest-match index from normalized entries. */
function buildIndex(entries) {
    const byTerm = new Map();
    const terms = new Set();
    let maxLen = 0;
    for (const e of entries) {
        if (!e || !e.sourceTerm) continue;
        if (!byTerm.has(e.sourceTerm)) byTerm.set(e.sourceTerm, e);
        terms.add(e.sourceTerm);
        const len = Array.from(e.sourceTerm).length; // code points
        if (len > maxLen) maxLen = len;
    }
    return { entries, byTerm, terms, maxLen };
}

// ── Card builder ─────────────────────────────────────────────────────────

/** Map a validation value to a small badge {cls,label}, or null. */
function validationBadge(validation) {
    const v = String(validation || '').toLowerCase().trim();
    if (!v) return null;
    if (v.includes('multi')) return { cls: 'multi', label: 'Multi-source' };
    if (v.includes('disput')) return { cls: 'disputed', label: 'Disputed' };
    if (v.includes('provis')) return { cls: 'provisional', label: 'Provisional' };
    // Unknown validation string — show it verbatim, sanitised for the class.
    return { cls: v.replace(/[^a-z0-9_-]/g, ''), label: validation };
}

/** RelPath (e.g. "T/T48/T48n2005.xml") -> fileId ("T48n2005"). */
function relPathToFileId(relPath) {
    if (!relPath) return '';
    const base = String(relPath).split(/[\\/]/).pop() || '';
    return base.replace(/\.xml$/i, '');
}

/** Build the inner HTML for one sense. All dynamic text is escaped. */
function senseHtml(sense) {
    const parts = [];

    if (sense.preferredTarget) {
        parts.push(`<p class="zen-sense-target">${escapeHtml(sense.preferredTarget)}</p>`);
    }

    const badge = validationBadge(sense.validation);
    const statusChip = sense.status
        ? `<span class="zen-badge zen-badge--status">${escapeHtml(sense.status)}</span>` : '';
    if (badge || statusChip) {
        const b = badge
            ? `<span class="zen-badge zen-badge--${escapeHtml(badge.cls)}">${escapeHtml(badge.label)}</span>` : '';
        parts.push(`<p class="zen-sense-badges">${b}${statusChip}</p>`);
    }

    if (sense.explanation) {
        parts.push(`<p class="zen-sense-expl">${escapeHtml(sense.explanation)}</p>`);
    }

    if (sense.alternateTargets && sense.alternateTargets.length) {
        parts.push(`<p class="zen-sense-alts"><span class="zen-lbl">Also:</span> ${escapeHtml(sense.alternateTargets.join(', '))}</p>`);
    }

    if (sense.note) {
        parts.push(`<p class="zen-sense-note">${escapeHtml(sense.note)}</p>`);
    }

    // Occurrence links: #/{fileId}/{fromLb}
    const occLinks = (sense.occurrences || []).map((occ) => {
        if (!occ) return '';
        const relPath = pick(occ, 'RelPath', 'relPath', 'FileId', 'fileId');
        let fileId = pick(occ, 'FileId', 'fileId');
        if (!fileId) fileId = relPathToFileId(relPath);
        const lb = pick(occ, 'FromLb', 'fromLb', 'Lb', 'lb', 'LineId', 'lineId', 'StartLine', 'startLine');
        const kwic = pick(occ, 'Kwic', 'kwic', 'Snippet', 'snippet', 'Text', 'text');
        if (!fileId) return '';
        const href = '#/' + encodeURIComponent(fileId) + (lb ? '/' + encodeURIComponent(lb) : '');
        const label = lb ? String(lb) : String(fileId);
        const title = kwic ? ` title="${escapeHtml(String(kwic))}"` : '';
        return `<a class="zen-link" href="${href}"${title}>${escapeHtml(label)}</a>`;
    }).filter(Boolean);
    if (occLinks.length) {
        parts.push(`<p class="zen-sense-links"><span class="zen-lbl">Occurrences:</span> ${occLinks.join(' ')}</p>`);
    }

    // Related master links: #/master/{name}
    const masterLinks = (sense.relatedMasters || []).map((name) => {
        const slug = String(name).replace(/ /g, '_');
        return `<a class="zen-link" href="#/master/${encodeURIComponent(slug)}">${escapeHtml(name)}</a>`;
    });
    if (masterLinks.length) {
        parts.push(`<p class="zen-sense-links"><span class="zen-lbl">Masters:</span> ${masterLinks.join(' ')}</p>`);
    }

    // Related term links: #/term/{term}
    const termLinks = (sense.relatedTerms || []).map((t) =>
        `<a class="zen-link" href="#/term/${encodeURIComponent(t)}">${escapeHtml(t)}</a>`);
    if (termLinks.length) {
        parts.push(`<p class="zen-sense-links"><span class="zen-lbl">Related:</span> ${termLinks.join(' ')}</p>`);
    }

    return parts.join('');
}

/**
 * Build the lookup-card payload for a normalized Zen entry. Each sense becomes
 * a labeled section. Legacy entries show their single corpus-wide sense.
 */
export function buildZenCard(entry) {
    const senses = (entry && entry.senses) || [];
    const primary = senses[0] || {};
    const multi = senses.length > 1;

    const sections = senses.map((sense, i) => {
        let heading;
        if (sense.masterName) heading = 'Sense · ' + sense.masterName;
        else if (multi) heading = 'Corpus-wide sense' + (senses.length > 1 ? ' ' + (i + 1) : '');
        else heading = 'Meaning';
        return { heading, content: { html: senseHtml(sense) } };
    }).filter((s) => s.content.html);

    return {
        title: (entry && entry.sourceTerm) || '',
        subtitle: primary.preferredTarget || '',
        sections,
        footer: 'Zen dictionary',
    };
}

/** The shareable permalink for one entry. */
export function zenEntryHref(term) {
    return '#/dict/' + encodeURIComponent(term);
}

/** Absolute URL for one entry — what "Copy link" puts on the clipboard. */
function zenEntryUrl(term) {
    const base = typeof location !== 'undefined'
        ? location.origin + location.pathname + location.search
        : '';
    return base + zenEntryHref(term);
}

/**
 * Render a Zen entry card into a mount, with a link bar so the entry can be
 * shared from wherever it is shown — the reader's side panel and the entry
 * page both come through here.
 */
export function renderZenCard(entry, mount, opts) {
    renderLookupCard(buildZenCard(entry), mount);

    const term = entry && entry.sourceTerm;
    if (!term || typeof document === 'undefined') return;

    const bar = document.createElement('div');
    bar.className = 'zen-card-links';

    // On the entry page itself there is nowhere to "open" — only a link to copy.
    const showOpen = !(opts && opts.showOpenLink === false);
    const open = document.createElement('a');
    open.className = 'zen-card-link';
    open.href = zenEntryHref(term);
    open.textContent = 'Open entry page';
    if (!showOpen) open.hidden = true;

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'zen-card-link zen-card-copy';
    copy.textContent = 'Copy link';
    copy.addEventListener('click', async () => {
        const url = zenEntryUrl(term);
        try {
            await navigator.clipboard.writeText(url);
            copy.textContent = 'Copied';
            setTimeout(() => { copy.textContent = 'Copy link'; }, 1400);
        } catch {
            // Clipboard blocked (insecure origin / permissions) — show it instead.
            window.prompt('Copy link:', url);
        }
    });

    bar.append(open, copy);
    mount.appendChild(bar);
}
