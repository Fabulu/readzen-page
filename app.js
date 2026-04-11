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

// Lookup views share a common contract: instant render, no app-first race.
// They're dispatched before the placeholder path in `init` below.
const LOOKUP_VIEWS = [dictionary, termbase, master, tags, scholar, search];

const DESKTOP_FALLBACK_DELAY = 1800;
const RELEASES_URL = 'https://github.com/Fabulu/ReadZen/releases';

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

    // Lookup views (dictionary / termbase / master): instant render, no race.
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

    // Passage → fire app launch silently in background, render preview immediately.
    if (passage.match(route)) {
        fireAppLaunchSilent(route);
        try {
            await passage.render(route, shell.mount, shell);
        } catch (error) {
            shell.showError('Preview failed', error && error.message || 'Unknown error.', buildZenUri(route));
        }
        return;
    }

    // Compare → fire app launch silently in background, render preview immediately.
    if (compare.match(route)) {
        fireAppLaunchSilent(route);
        try {
            await compare.render(route, shell.mount, shell);
        } catch (error) {
            shell.showError('Preview failed', error && error.message || 'Unknown error.', buildZenUri(route));
        }
        return;
    }

    // Completely unknown kind → show the "install Read Zen" card, then
    // fire the app-first race so the fallback block reveals itself if the
    // desktop app doesn't take over within the grace window.
    shell.setTitle('Read Zen');
    shell.setContext('Someone shared a Read Zen link with you', 'Install Read Zen to open it.');
    renderPlaceholder(route, shell.mount, {
        heading: 'Someone shared a Read Zen link with you',
        sub: 'Install Read Zen to open it.'
    });

    tryOpenDesktop(route, () => {
        const fallback = document.getElementById('placeholder-fallback');
        if (fallback) fallback.classList.add('visible');
        shell.setStatus(
            'Read Zen not detected',
            'This link opens in the Read Zen desktop app. Install the app, then click the link again to open it directly.',
            false
        );
    });
}

/** Renders the "install Read Zen" placeholder card used by Wave 1 for non-passage kinds. */
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

            <div class="passage-action" id="placeholder-action">
                <p class="passage-status">Launching Read Zen<span class="dots"><span>.</span><span>.</span><span>.</span></span></p>
            </div>

            <div class="passage-fallback" id="placeholder-fallback">
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

/**
 * Fires a hidden iframe at the `zen://` deep link. If the tab loses
 * visibility within the grace window, we treat that as "app took over".
 * Otherwise, `onFallback` runs after DESKTOP_FALLBACK_DELAY ms.
 * (Used by the unknown-route placeholder fallback only.)
 */
function tryOpenDesktop(route, onFallback) {
    const zenUri = buildZenUri(route);
    if (!zenUri) {
        onFallback();
        return;
    }

    const launchTime = Date.now();
    let appDetected = false;

    function onAppDetected() {
        if (Date.now() - launchTime < 200) return;
        if (appDetected) return;
        appDetected = true;
        cleanup();
        const action = document.getElementById('placeholder-action');
        if (action) {
            action.innerHTML = '<p class="passage-status">Opened in Read Zen</p>';
        }
    }

    function onVisibilityChange() {
        if (document.hidden) onAppDetected();
    }

    function cleanup() {
        document.removeEventListener('visibilitychange', onVisibilityChange);
        window.removeEventListener('blur', onAppDetected);
    }

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('blur', onAppDetected);

    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    iframe.src = zenUri;
    document.body.appendChild(iframe);
    setTimeout(() => {
        try { document.body.removeChild(iframe); } catch {}
    }, 500);

    setTimeout(() => {
        cleanup();
        if (appDetected) return;
        onFallback();
    }, DESKTOP_FALLBACK_DELAY);
}

// Re-run init on hash changes so users navigating between links inside the
// same tab get a fresh view.
window.addEventListener('hashchange', () => init());

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
