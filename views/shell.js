// views/shell.js
// Persistent chrome shared by every view: header (logo + route chip),
// action bar (context strip + "Open in Read Zen" button + extra link),
// status strip, a `main` mount node that per-route views render into,
// the desktop-app upsell card, and a footer with the auto-open toggle.
//
// The shell is intentionally dumb — it owns no route state. Views call
// `setRouteChip`, `setStatus`, etc. to update the pieces they care about.
// The top "Open in Read Zen" button is always shown on routed views (it
// signals that the link can be handed off to the desktop app, even when
// auto-open is on and that handoff is happening silently). It's hidden
// on the landing page, which has its own download CTA front and center.

import { escapeHtml } from '../lib/format.js';
import { buildZenUri, describeRoute } from '../lib/route.js';

const RELEASES_URL = 'https://github.com/Fabulu/ReadZen/releases';
const AUTO_OPEN_PREF_KEY = 'readzen-auto-open';

/** Default-on. The footer toggle in this file flips it. */
function isAutoOpenEnabled() {
    try { return localStorage.getItem(AUTO_OPEN_PREF_KEY) !== 'false'; }
    catch { return true; }
}

function setAutoOpenEnabled(on) {
    try { localStorage.setItem(AUTO_OPEN_PREF_KEY, on ? 'true' : 'false'); }
    catch {}
}

/**
 * Render the shell into `#app` and return the inner mount node plus a set of
 * helper functions bound to the live DOM elements.
 */
export function mountShell(root, route) {
    root.innerHTML = `
        <div class="shell">
            <header class="shell-header">
                <div class="shell-brand">
                    <div class="hero-mark" aria-hidden="true"></div>
                    <div class="shell-brand-text">
                        <p class="shell-kicker">Read Zen Preview</p>
                        <h1 class="shell-title" id="shell-title">Read Zen</h1>
                    </div>
                </div>
                <div class="shell-route" id="shell-route-box">
                    <span class="route-chip" id="route-chip" hidden></span>
                    <span class="route-chip route-chip--corpus" id="corpus-chip" hidden></span>
                    <a class="support-btn" href="https://ko-fi.com/readzen" target="_blank" rel="noreferrer" title="Support ReadZen + OpenZenTexts on Ko-fi">\u2661 Support</a>
                </div>
            </header>

            <section class="shell-actions" id="shell-actions" hidden>
                <div class="shell-actions-info">
                    <p class="context-title" id="context-title"></p>
                    <p class="context-subtitle" id="context-subtitle"></p>
                </div>
                <div class="shell-actions-buttons">
                    <a class="btn btn--small" id="open-desktop" href="#" hidden>Open in Read Zen</a>
                    <a class="text-link" id="shell-extra-link" href="#" target="_blank" rel="noreferrer" hidden></a>
                </div>
            </section>

            <section class="status-panel" id="status-panel" hidden>
                <p class="status-title" id="status-title"></p>
                <p class="status-detail" id="status-detail"></p>
            </section>

            <main class="shell-main" id="view-mount"></main>

            <aside class="upsell" id="upsell" hidden>
                <p class="upsell-kicker">This is just a preview</p>
                <h2 class="upsell-title">Get the full Read Zen desktop app</h2>
                <p class="upsell-desc" id="upsell-desc">
                    Read both the CBETA and OpenZenTexts corpora, translate side-by-side with
                    a hover dictionary and translation memory, search every
                    text at once, build scholar collections, manage terminology,
                    and <strong>create and share links like this one</strong>
                    — all offline, all free.
                </p>
                <div class="upsell-actions">
                    <a class="btn" id="upsell-download" href="${RELEASES_URL}">Download Read Zen</a>
                    <p class="upsell-platforms">Free · Windows · Linux · macOS</p>
                    <p class="upsell-support"><a href="https://ko-fi.com/readzen" target="_blank" rel="noreferrer">This project is supported by people like you</a></p>
                </div>
            </aside>

            <footer class="shell-foot">
                <p>Open source on <a href="https://github.com/Fabulu/ReadZen">GitHub</a> · Source: CBETA + OpenZenTexts · <a href="https://ko-fi.com/readzen" target="_blank" rel="noreferrer">Support this project</a></p>
                <p class="shell-foot-pref">
                    Auto-open links in the Read Zen app:
                    <a href="#" id="auto-open-toggle" class="shell-foot-toggle"></a>
                </p>
            </footer>
        </div>
    `;

    const mount = root.querySelector('#view-mount');
    const chip = root.querySelector('#route-chip');
    const corpusChip = root.querySelector('#corpus-chip');
    const titleEl = root.querySelector('#shell-title');
    const actions = root.querySelector('#shell-actions');
    const ctxTitle = root.querySelector('#context-title');
    const ctxSubtitle = root.querySelector('#context-subtitle');
    const openDesktop = root.querySelector('#open-desktop');
    const extraLink = root.querySelector('#shell-extra-link');
    const statusPanel = root.querySelector('#status-panel');
    const statusTitle = root.querySelector('#status-title');
    const statusDetail = root.querySelector('#status-detail');
    const upsell = root.querySelector('#upsell');
    const upsellDesc = root.querySelector('#upsell-desc');

    const autoOpenOn = isAutoOpenEnabled();

    if (route) {
        chip.hidden = false;
        chip.textContent = describeRoute(route);
        actions.hidden = false;
        // Routed views always get the desktop-app upsell card. Landing has no
        // route and skips it (it has its own download CTA).
        upsell.hidden = false;

        if (corpusChip) {
            const corpus = route.corpus;
            if (corpus === 'cbeta' || corpus === 'openzen') {
                corpusChip.hidden = false;
                corpusChip.textContent = corpus === 'cbeta' ? 'CBETA' : 'OpenZenTexts';
                corpusChip.classList.remove('route-chip--cbeta', 'route-chip--openzen');
                corpusChip.classList.add(corpus === 'cbeta' ? 'route-chip--cbeta' : 'route-chip--openzen');
            } else {
                corpusChip.hidden = true;
            }
        }

        // Top "Open in Read Zen" button: visible on every routed view as a
        // signal that the link can be opened directly in the desktop app.
        // Even when auto-open is on (default) and the silent launch already
        // fires, the button stays visible — it's the affordance that
        // communicates "this is a Read Zen link, the desktop app handles it".
        // Hidden on landing (the else branch below leaves it hidden by default).
        const zenUri = buildZenUri(route);
        if (zenUri) {
            openDesktop.href = zenUri;
            openDesktop.hidden = false;
        }
    }

    // Footer toggle: shows current auto-open state, flips on click, reloads
    // so the new preference takes effect immediately for this view.
    const toggle = root.querySelector('#auto-open-toggle');
    if (toggle) {
        toggle.textContent = autoOpenOn ? 'on' : 'off';
        toggle.addEventListener('click', (ev) => {
            ev.preventDefault();
            setAutoOpenEnabled(!autoOpenOn);
            window.location.reload();
        });
    }

    return {
        mount,
        setTitle(text) { titleEl.textContent = text || 'Read Zen'; document.title = text ? 'Read Zen · ' + text : 'Read Zen'; },
        setContext(title, subtitle) {
            ctxTitle.textContent = title || '';
            ctxSubtitle.textContent = subtitle || '';
            actions.hidden = !(title || subtitle);
        },
        setExtraLink(label, href) {
            if (!label || !href) { extraLink.hidden = true; return; }
            extraLink.hidden = false;
            extraLink.textContent = label;
            extraLink.href = href;
        },
        setStatus(title, detail, isError) {
            statusPanel.hidden = false;
            statusPanel.classList.toggle('status-panel--error', !!isError);
            statusTitle.textContent = title || '';
            statusDetail.textContent = detail || '';
        },
        hideStatus() { statusPanel.hidden = true; },
        /**
         * Replace the desktop-app upsell description with kind-specific copy.
         * Pass an HTML string (already escaped where needed). The card itself
         * stays visible — only the body paragraph is swapped.
         */
        setUpsell(html) {
            if (!upsellDesc) return;
            if (typeof html === 'string' && html.length > 0) {
                upsellDesc.innerHTML = html;
            }
            upsell.hidden = false;
        },
        showError(title, detail, zenUri) {
            this.setStatus(title, detail, true);
            // If we know the `zen://` deep link for the current route, surface
            // it alongside the Releases fallback so users who already have the
            // desktop app installed can still open the link in one click.
            const zen = typeof zenUri === 'string' && zenUri ? zenUri : null;
            const zenLine = zen
                ? ` · or <a href="${escapeHtml(zen)}">open in Read Zen</a>`
                : '';
            mount.innerHTML = `
                <div class="error-card">
                    <p class="error-card-title">${escapeHtml(title || 'Something went wrong')}</p>
                    <p class="error-card-detail">${escapeHtml(detail || '')}</p>
                    <p class="error-card-hint">Check your connection or try the
                    <a href="${RELEASES_URL}">Read Zen desktop app</a>${zenLine}.</p>
                </div>
            `;
        }
    };
}
