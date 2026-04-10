// views/shell.js
// Persistent chrome shared by every view: header (logo + route chip),
// action bar ("Open in Read Zen"), status strip, and a single `main`
// mount node that per-route views render into.
//
// The shell is intentionally dumb — it owns no route state. Views call
// `setRouteChip`, `setStatus`, etc. to update the pieces they care about.

import { escapeHtml } from '../lib/format.js';
import { buildZenUri, describeRoute } from '../lib/route.js';

const RELEASES_URL = 'https://github.com/Fabulu/ReadZen/releases';

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
                </div>
            </header>

            <section class="shell-actions" id="shell-actions" hidden>
                <div class="shell-actions-info">
                    <p class="context-title" id="context-title"></p>
                    <p class="context-subtitle" id="context-subtitle"></p>
                </div>
                <div class="shell-actions-buttons">
                    <a class="btn btn--small" id="open-desktop" href="#">Open in Read Zen</a>
                    <a class="text-link" id="shell-extra-link" href="#" target="_blank" rel="noreferrer" hidden></a>
                </div>
            </section>

            <section class="status-panel" id="status-panel" hidden>
                <p class="status-title" id="status-title"></p>
                <p class="status-detail" id="status-detail"></p>
            </section>

            <main class="shell-main" id="view-mount"></main>

            <footer class="shell-foot">
                <p>Open source on <a href="https://github.com/Fabulu/ReadZen">GitHub</a> · Source: CBETA · Non-commercial use</p>
            </footer>
        </div>
    `;

    const mount = root.querySelector('#view-mount');
    const chip = root.querySelector('#route-chip');
    const titleEl = root.querySelector('#shell-title');
    const actions = root.querySelector('#shell-actions');
    const ctxTitle = root.querySelector('#context-title');
    const ctxSubtitle = root.querySelector('#context-subtitle');
    const openDesktop = root.querySelector('#open-desktop');
    const extraLink = root.querySelector('#shell-extra-link');
    const statusPanel = root.querySelector('#status-panel');
    const statusTitle = root.querySelector('#status-title');
    const statusDetail = root.querySelector('#status-detail');

    if (route) {
        chip.hidden = false;
        chip.textContent = describeRoute(route);
        const zenUri = buildZenUri(route);
        openDesktop.href = zenUri || RELEASES_URL;
        actions.hidden = false;
    } else {
        openDesktop.href = RELEASES_URL;
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
