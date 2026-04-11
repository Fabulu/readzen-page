// views/termbase.js
// Renders a termbase entry from the CbetaZenTranslations repo.
//
// Storage shapes (mirrored from the desktop app):
//   community/termbases/{user}.json    — per-user pretty JSON array (array of TermbaseEntry)
//   community/termbase.json            — project-wide shared termbase (array of TermbaseEntry)
//
// TermbaseEntry shape (see Models/TermbaseEntry.cs):
//   { SourceTerm, PreferredTarget, AlternateTargets[], Status, Note,
//     CreatedBy, WrittenUtc }
//
// Falls back to the dictionary view when the entry isn't found in the
// requested user's termbase (or the shared one).

import { fetchJson, DATA_REPO_BASE } from '../lib/github.js';
import * as cache from '../lib/cache.js';
import { renderLookupCard, renderLookupEmpty } from '../lib/lookup-card.js';
import { renderDictionaryInto } from './dictionary.js';

const TERMBASE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** Route-kind matcher. */
export function match(route) {
    return route && route.kind === 'termbase';
}

/** Termbase lookups are instant — no app-first race. */
export function preferAppFirst(_route) {
    return false;
}

/**
 * Render the termbase card for `route.entry`. If no entry is found, fall
 * back to a dictionary lookup for the same term (with a banner explaining
 * the fallback).
 */
export async function render(route, mount, shell) {
    const term = (route && route.entry) || '';
    const user = (route && route.user) || '';
    applyChrome(shell, term, user);

    if (!term) {
        renderLookupEmpty({
            title: 'No term supplied',
            detail: 'The termbase link is missing its term.',
            hint: 'Expected shape: #/term/菩提/Fabulu'
        }, mount);
        return;
    }

    // Any failure loading or searching the termbase — 404 or otherwise —
    // falls through to the dictionary view. The banner explains why.
    let match = null;
    try {
        const entries = await loadTermbase(user);
        match = entries ? findEntry(entries, term) : null;
    } catch {
        match = null;
    }

    if (match) {
        renderLookupCard(buildTermbaseCard(match, user), mount);
        return;
    }

    // Fallback: dictionary lookup for the same term.
    await renderDictionaryInto(term, mount);

    // Inject a banner at the top of whatever the dictionary rendered.
    injectFallbackBanner(mount, user, term);
}

/** Updates title, context strip, and open-in-app link. */
function applyChrome(shell, term, user) {
    if (!shell) return;
    shell.setTitle(term ? 'Termbase · ' + term : 'Termbase');
    shell.setContext(
        term ? `Termbase · ${term}` : 'Termbase',
        user ? `Curated by ${user}` : 'Shared project termbase'
    );
    shell.setUpsell(
        'This preview shows one termbase entry. The desktop app lets you ' +
        '<strong>build and manage your own termbase</strong>, see it ' +
        'highlighted live while you read or translate, sync it with the ' +
        'community, and share entry links like this one.'
    );
    shell.hideStatus();
}

/**
 * Load the termbase for a given user. Per-user lookups fall back to the
 * shared project-wide termbase on 404. A missing `user` argument loads the
 * shared termbase directly.
 */
async function loadTermbase(user) {
    if (user) {
        const userUrl = DATA_REPO_BASE
            + 'community/termbases/'
            + encodeURIComponent(user)
            + '.json';
        try {
            return await fetchTermbaseJson(userUrl);
        } catch (error) {
            const msg = String(error && error.message || '');
            if (!msg.includes('404')) throw error;
            // Fall through to shared termbase.
        }
    }

    const sharedUrl = DATA_REPO_BASE + 'community/termbase.json';
    return fetchTermbaseJson(sharedUrl);
}

/** Fetch + cache a termbase JSON file. */
async function fetchTermbaseJson(url) {
    const cacheKey = 'termbase:' + url;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const data = await fetchJson(url);
    cache.set(cacheKey, data, TERMBASE_CACHE_TTL_MS);
    return data;
}

/**
 * Find an entry matching `term`. Termbase entries use PascalCase keys
 * (mirroring the C# model), but we accept the camelCase form too for
 * forward compatibility.
 */
function findEntry(entries, term) {
    if (!Array.isArray(entries)) return null;
    for (const raw of entries) {
        if (!raw) continue;
        const source = raw.SourceTerm || raw.sourceTerm || '';
        if (source === term) return raw;
    }
    return null;
}

/** Build the card payload for a termbase entry. */
function buildTermbaseCard(entry, user) {
    const source = entry.SourceTerm || entry.sourceTerm || '';
    const preferred = entry.PreferredTarget || entry.preferredTarget || '';
    const alternates = entry.AlternateTargets || entry.alternateTargets || [];
    const status = entry.Status || entry.status || '';
    const note = entry.Note || entry.note || '';
    const createdBy = entry.CreatedBy || entry.createdBy || user || '';

    const sections = [];
    if (preferred) {
        sections.push({ heading: 'Preferred translation', content: preferred });
    }
    if (Array.isArray(alternates) && alternates.length > 0) {
        sections.push({ heading: 'Alternates', content: alternates });
    }
    if (note) {
        sections.push({ heading: 'Notes', content: note });
    }
    if (status) {
        sections.push({ heading: 'Status', content: status });
    }

    return {
        title: source,
        subtitle: preferred,
        sections,
        footer: createdBy ? `by ${createdBy}` : ''
    };
}

/**
 * Prepend a banner to whatever the dictionary view rendered, explaining
 * that we're showing the dictionary card because the term isn't in the
 * requested termbase.
 */
function injectFallbackBanner(mount, user, term) {
    const banner = document.createElement('div');
    banner.className = 'lookup-banner lookup-banner--fallback';
    banner.textContent = user
        ? `Not in ${user}'s termbase. Showing dictionary entry instead.`
        : `Not in the shared termbase. Showing dictionary entry for "${term}" instead.`;

    // Attach inside the card so it visually belongs to the result.
    const card = mount.querySelector('.lookup-card');
    if (card) {
        card.insertBefore(banner, card.firstChild);
    } else {
        mount.insertBefore(banner, mount.firstChild);
    }
}
