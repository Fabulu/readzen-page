// views/master.js
// Renders a Zen master profile card.
//
// Storage shape (mirrored from the desktop app):
//   community/master-dates/{user}.jsonl
//
// Each line is a JSON-encoded MasterDateEntry (see Models/MasterDateEntry.cs):
//   { Names: string[], Floruit: int, Death: int, CreatedBy?: string, WrittenUtc? }
//
// When no user is supplied we also try the base `Assets/Data/master-dates.json`
// bundled with the desktop app, but that file isn't mirrored on GitHub — in
// practice the user parameter is required.

import { DATA_REPO_BASE } from '../lib/github.js';
import { fetchJsonl } from '../lib/jsonl.js';
import * as cache from '../lib/cache.js';
import { renderLookupCard, renderLookupEmpty } from '../lib/lookup-card.js';

const MASTER_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** Route-kind matcher. */
export function match(route) {
    return route && route.kind === 'master';
}

/** Master lookups are instant — no app-first race. */
export function preferAppFirst(_route) {
    return false;
}

/**
 * Render the master card for `route.name`. Shows a not-found card if the
 * requested name isn't present in the user's JSONL file.
 */
export async function render(route, mount, shell) {
    const name = (route && route.name) || '';
    const user = (route && route.user) || '';
    applyChrome(shell, name, user);

    if (!name) {
        renderLookupEmpty({
            title: 'No master supplied',
            detail: 'The master link is missing a name.',
            hint: 'Expected shape: #/master/Linji Yixuan/Fabulu'
        }, mount);
        return;
    }

    if (!user) {
        renderLookupEmpty({
            title: `No user supplied for ${name}`,
            detail: 'Master profiles are stored per-user. The link must include the curator username.',
            hint: 'Expected shape: #/master/Linji Yixuan/Fabulu'
        }, mount);
        return;
    }

    let entries;
    try {
        entries = await loadMasterDates(user);
    } catch (error) {
        const msg = String(error && error.message || '');
        if (msg.includes('404')) {
            renderLookupEmpty({
                title: `No master-dates file for ${user}`,
                detail: `${user} has not published any master profiles yet.`,
                hint: 'Open in Read Zen to browse other users\' collections.'
            }, mount);
            return;
        }
        renderLookupEmpty({
            title: 'Master lookup failed',
            detail: msg || 'Unknown error while fetching the master-dates file.'
        }, mount);
        return;
    }

    const match = findMaster(entries, name);
    if (!match) {
        renderLookupEmpty({
            title: `No master "${name}"`,
            detail: `${user}'s master-dates file does not include "${name}".`,
            hint: 'Check the spelling, or open in Read Zen to browse the full list.'
        }, mount);
        return;
    }

    renderLookupCard(buildMasterCard(match, user), mount);
}

/** Updates title, context strip, and open-in-app link. */
function applyChrome(shell, name, user) {
    if (!shell) return;
    shell.setTitle(name ? 'Master · ' + name : 'Master');
    shell.setContext(
        name ? `Zen Master · ${name}` : 'Zen Master',
        user ? `Curated by ${user}` : 'Unknown curator'
    );
    shell.hideStatus();
}

/**
 * Fetch + parse the user's `community/master-dates/{user}.jsonl` file.
 * JSONL is one JSON object per line. Blank and malformed lines are skipped
 * by the shared `fetchJsonl` helper.
 */
async function loadMasterDates(user) {
    const url = DATA_REPO_BASE
        + 'community/master-dates/'
        + encodeURIComponent(user)
        + '.jsonl';

    const cacheKey = 'master-dates:' + url;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const entries = await fetchJsonl(url);
    cache.set(cacheKey, entries, MASTER_CACHE_TTL_MS);
    return entries;
}

/**
 * Find a master entry by name. Matches are case-insensitive for pinyin and
 * exact for CJK (matching the desktop app's behaviour loosely). We accept
 * both PascalCase and camelCase keys.
 */
function findMaster(entries, name) {
    if (!Array.isArray(entries)) return null;
    const nameLower = name.toLowerCase();

    for (const raw of entries) {
        if (!raw) continue;
        const names = raw.Names || raw.names || [];
        if (!Array.isArray(names)) continue;
        for (const n of names) {
            if (!n) continue;
            if (n === name) return raw;
            if (String(n).toLowerCase() === nameLower) return raw;
        }
    }
    return null;
}

/** Build the card payload for a master entry. */
function buildMasterCard(entry, user) {
    const names = entry.Names || entry.names || [];
    const floruit = entry.Floruit ?? entry.floruit ?? 0;
    const death = entry.Death ?? entry.death ?? 0;
    const createdBy = entry.CreatedBy || entry.createdBy || user || '';

    const primaryName = names[0] || '';
    const otherNames = names.slice(1).filter(Boolean);

    const sections = [];

    if (otherNames.length > 0) {
        sections.push({ heading: 'Also known as', content: otherNames });
    }

    const datesText = formatDates(floruit, death);
    if (datesText) {
        sections.push({ heading: 'Dates', content: datesText });
    }

    return {
        title: primaryName,
        subtitle: datesText || '',
        sections,
        footer: createdBy ? `by ${createdBy}` : ''
    };
}

/** Format the `Floruit` / `Death` pair into a human-readable string. */
function formatDates(floruit, death) {
    const parts = [];
    if (floruit && floruit !== 0) parts.push('fl. ' + floruit);
    if (death && death !== 0) parts.push('d. ' + death);
    return parts.join(' · ');
}
