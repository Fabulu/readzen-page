// views/termbase.js
// Legacy #/term/{entry} route — now a thin alias for the canonical Zen entry.
//
// Personal termbases are local-only and are NEVER surfaced on the web. This
// view no longer fetches or renders any per-user or shared termbase card (and
// never exposes the internal CreatedBy line). A #/term/{entry} link resolves to
// exactly what #/dict/{entry} does — the rich Zen dictionary entry, falling back
// to CC-CEDICT when the term has no Zen entry. Any trailing per-user segment in
// the old #/term/{entry}/{user} form is ignored.

import * as dictionary from './dictionary.js';

/** Route-kind matcher used by `app.js`. */
export function match(route) {
    return route && route.kind === 'termbase';
}

/** Lookups are instant — no app-first race. */
export function preferAppFirst(_route) {
    return false;
}

/**
 * Render the canonical dictionary entry for `route.entry`, identical to the
 * `#/dict/` route (rich Zen entry, else CC-CEDICT). The legacy `termbase` route
 * kind is kept only so old `#/term/` links keep resolving.
 */
export async function render(route, mount, shell) {
    const term = (route && route.entry) || '';
    await dictionary.render(
        { kind: 'dictionary', term, rawRoute: route && route.rawRoute },
        mount,
        shell
    );
}
