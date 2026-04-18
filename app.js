// app.js
// Bootstrap. Parses the route, picks a view, mounts the shell, and — for
// kinds that want app-first handoff — fires the `zen://` deep link via a
// hidden iframe and waits 1.8s to see if the desktop app takes over.
//
// ES module. Loaded with <script type="module"> in index.html.

import { getRawRoute, parseRoute, buildZenUri } from './lib/route.js';
import { escapeHtml } from './lib/format.js';
import { mountShell } from './views/shell.js';
import * as landing from './views/landing.js';
import * as passage from './views/passage.js';
import * as dictionary from './views/dictionary.js';
import * as termbase from './views/termbase.js';
import * as master from './views/master.js';
import * as tags from './views/tags.js';
import * as scholar from './views/scholar.js';
import * as search from './views/search.js';
import * as compare from './views/compare.js';
import { dismissInlineDict } from './lib/inline-dict.js';

// Lookup views share a common contract: instant render, no app-first race.
// They're dispatched before the placeholder path in `init` below.
const LOOKUP_VIEWS = [dictionary, termbase, master, tags, scholar, search];

const RELEASES_URL = 'https://github.com/Fabulu/ReadZen/releases';

// localStorage key for the user's auto-open-in-desktop-app preference.
// Default is "on" — set to 'false' to disable. The footer toggle in
// views/shell.js flips this and reloads the page.
const AUTO_OPEN_PREF_KEY = 'readzen-auto-open';

/** Returns true if the user has NOT opted out of silent auto-launch. */
function isAutoOpenEnabled() {
    try {
        return localStorage.getItem(AUTO_OPEN_PREF_KEY) !== 'false';
    } catch {
        return true; // localStorage unavailable → default on
    }
}

/**
 * Mount the correct view for the current hash and wire the app-first race.
 */
async function init() {
    const root = document.getElementById('app');
    if (!root) return;

    const rawRoute = getRawRoute();
    const route = parseRoute(rawRoute);
    const shell = mountShell(root, route);

    // No route → landing.
    if (landing.match(route)) {
        landing.render(route, shell.mount, shell);
        return;
    }

    // For ANY routed view that resolves to a valid zen:// URI, fire the
    // desktop app silently in the background — UNLESS the user has
    // opted out via the footer toggle. If the app is installed it takes
    // over the OS tab; if not, the iframe load fails silently and the
    // preview below stays visible. When auto-open is off, the shell shows
    // an explicit "Open in Read Zen" button instead.
    if (isAutoOpenEnabled()) {
        fireAppLaunchSilent(route);
    }

    // Lookup views (dictionary / termbase / master / tags / scholar / search):
    // instant render alongside the silent launch.
    for (const view of LOOKUP_VIEWS) {
        if (view.match(route)) {
            try {
                await view.render(route, shell.mount, shell);
            } catch (error) {
                shell.showError('Lookup failed', error && error.message || 'Unknown error.');
            }
            return;
        }
    }

    // Passage → preview renders immediately while the app launch races.
    if (passage.match(route)) {
        try {
            await passage.render(route, shell.mount, shell);
        } catch (error) {
            shell.showError('Preview failed', error && error.message || 'Unknown error.', buildZenUri(route));
        }
        return;
    }

    // Compare → same flow as passage.
    if (compare.match(route)) {
        try {
            await compare.render(route, shell.mount, shell);
        } catch (error) {
            shell.showError('Preview failed', error && error.message || 'Unknown error.', buildZenUri(route));
        }
        return;
    }

    // Completely unknown kind → show the "install Read Zen" card. The
    // silent app launch fired at the top of init() handles the "app
    // installed" path; this fallback covers everyone else.
    shell.setTitle('Read Zen');
    shell.setContext('Someone shared a Read Zen link with you', 'Install Read Zen to open it.');
    renderPlaceholder(route, shell.mount, {
        heading: 'Someone shared a Read Zen link with you',
        sub: 'Install Read Zen to open it.'
    });
}

/** Renders the "install Read Zen" placeholder card used for unknown route kinds. */
function renderPlaceholder(route, mount, messages) {
    const zenUri = buildZenUri(route) || '';
    const routeText = route && route.rawRoute ? route.rawRoute : '';

    mount.innerHTML = `
        <div class="placeholder-card">
            <p class="passage-label">${escapeHtml(messages.heading)}</p>
            <p class="passage-sub">${escapeHtml(messages.sub)}</p>

            <div class="passage-ref">
                <code class="passage-raw">${escapeHtml(routeText)}</code>
            </div>

            <div class="passage-fallback visible">
                <p class="fallback-msg">
                    This link opens in the <strong>Read Zen</strong> desktop app.<br>
                    If you don't have it yet, download it below — it's free.
                </p>
                <a class="btn" href="${RELEASES_URL}">Download Read Zen</a>
                <p class="fallback-hint">After installing, click the shared link again to open it directly.</p>
                ${zenUri ? `<p class="fallback-hint"><a class="text-link" href="${escapeHtml(zenUri)}">Try opening manually</a></p>` : ''}
            </div>
        </div>
    `;
}

/**
 * Fires the zen:// deep link silently in the background. If the desktop app
 * is installed, the OS handles it and the user switches focus. If not, the
 * iframe load fails silently and we keep showing the preview. No UI delay.
 */
function fireAppLaunchSilent(route) {
    const zenUri = buildZenUri(route);
    if (!zenUri) return;
    try {
        const iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        iframe.src = zenUri;
        document.body.appendChild(iframe);
        setTimeout(() => {
            try { document.body.removeChild(iframe); } catch {}
        }, 500);
    } catch {
        // Browser blocked the protocol or it doesn't exist — preview is the answer.
    }
}

// Re-run init on hash changes so users navigating between links inside the
// same tab get a fresh view.
window.addEventListener('hashchange', () => {
    dismissInlineDict(); // clean up any active dict popup before route change
    init();
});

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
