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
import { navigate } from '../lib/navigate.js';
import { buildZenUri, describeRoute } from '../lib/route.js';
import { copyShareableLink } from '../lib/share.js';

const RELEASES_URL = 'https://github.com/Fabulu/ReadZen/releases';
const AUTO_OPEN_PREF_KEY = 'readzen-auto-open';
const THEME_PREF_KEY = 'readzen-theme';

function isAutoOpenEnabled() {
    try { return localStorage.getItem(AUTO_OPEN_PREF_KEY) === 'true'; }
    catch { return false; }
}

function setAutoOpenEnabled(on) {
    try { localStorage.setItem(AUTO_OPEN_PREF_KEY, on ? 'true' : 'false'); }
    catch {}
}

function getTheme() {
    try { return localStorage.getItem(THEME_PREF_KEY) || 'dark'; }
    catch { return 'dark'; }
}

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : '');
    try { localStorage.setItem(THEME_PREF_KEY, theme); } catch {}
}

// Apply saved theme immediately on module load.
applyTheme(getTheme());

// ── Reading engagement tracking for support toast ──
let readingStartTime = 0;
let toastShown = false;

function trackReading() {
    if (toastShown) return;
    if (!readingStartTime) { readingStartTime = Date.now(); return; }

    var elapsed = (Date.now() - readingStartTime) / 1000;
    if (elapsed < 120) return; // 2 minutes minimum

    // Check 7-day cooldown
    var key = 'readzen-toast-dismissed';
    var dismissed = localStorage.getItem(key);
    if (dismissed && Date.now() - parseInt(dismissed, 10) < 7 * 24 * 3600 * 1000) return;

    // Check minimum engagement (at least 2 page views this session)
    var views = parseInt(sessionStorage.getItem('readzen-views') || '0', 10);
    if (views < 2) return;

    toastShown = true;
    showSupportToast();
}

function showSupportToast() {
    var toast = document.createElement('div');
    toast.className = 'support-toast';
    toast.innerHTML =
        '<div class="support-toast-content">' +
        '<p class="support-toast-title">Enjoying ReadZen?</p>' +
        '<p class="support-toast-text">Help keep it free and open source.</p>' +
        '<a href="#" class="support-toast-btn" id="support-toast-btn">\u2661 Support</a>' +
        '<button class="support-toast-close" aria-label="Dismiss">\u00d7</button>' +
        '</div>';
    document.body.appendChild(toast);

    // Auto-dismiss after 10 seconds
    var autoHide = setTimeout(function() { toast.remove(); }, 10000);

    toast.querySelector('.support-toast-close').addEventListener('click', function() {
        clearTimeout(autoHide);
        toast.remove();
        localStorage.setItem('readzen-toast-dismissed', String(Date.now()));
    });

    toast.querySelector('#support-toast-btn').addEventListener('click', function(e) {
        e.preventDefault();
        clearTimeout(autoHide);
        toast.remove();
        var supportBtn = document.querySelector('#support-btn');
        if (supportBtn) supportBtn.click();
    });
}


/**
 * Render the shell into `#app` and return the inner mount node plus a set of
 * helper functions bound to the live DOM elements.
 */
export function mountShell(root, route) {
    root.innerHTML = `
        <div class="shell">
            <header class="shell-header">
                <a class="shell-brand" href="#">
                    <div class="hero-mark" aria-hidden="true"></div>
                    <div class="shell-brand-text">
                        <p class="shell-kicker">Read Zen Preview</p>
                        <h1 class="shell-title" id="shell-title">Read Zen</h1>
                    </div>
                </a>
                <form class="header-search" id="header-search-form" autocomplete="off">
                    <button type="button" class="header-search-toggle" aria-label="Search">&#x1F50D;</button>
                    <input class="header-search-input" id="header-search-input"
                           type="text" placeholder="Search texts..." />
                    <kbd class="header-search-kbd">Ctrl K</kbd>
                </form>
                <div class="header-nav-dropdown" id="research-dropdown">
                    <button class="header-nav-trigger" aria-expanded="false" aria-label="Research tools menu">
                        <span class="header-nav-label">Research</span>
                        <span class="header-nav-icon">&#9662;</span>
                    </button>
                    <div class="header-nav-menu" id="research-menu" hidden>
                        <a class="header-nav-item" href="/scholar">Browse Collections</a>
                        <a class="header-nav-item" href="/lineage">Lineage Graph</a>
                        <a class="header-nav-item" href="/masters">Zen Masters</a>
                    </div>
                </div>
                <div class="shell-route" id="shell-route-box">
                    <span class="route-chip" id="route-chip" hidden></span>
                    <span class="route-chip route-chip--corpus" id="corpus-chip" hidden></span>
                    <a class="support-btn" href="#" id="support-btn" title="Support ReadZen + OpenZen on Ko-fi">\u2661 Support</a>
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
                <p class="upsell-kicker">Want more power?</p>
                <h2 class="upsell-title">Read Zen Desktop</h2>
                <p class="upsell-desc" id="upsell-desc">
                    Full corpus search with co-occurrence analysis, hover dictionary,
                    side-by-side translation editor, scholar collections, and
                    terminology management - all offline, all free.
                </p>
                <div class="upsell-actions">
                    <a class="btn" id="upsell-download" href="${RELEASES_URL}">Download Read Zen</a>
                    <p class="upsell-platforms">Free · Windows · Linux · macOS</p>
                    <p class="upsell-support"><a href="https://ko-fi.com/readzen" target="_blank" rel="noreferrer">This project is supported by people like you</a></p>
                </div>
            </aside>

            <footer class="shell-foot">
                <p>Open source on <a href="https://github.com/Fabulu/ReadZen">GitHub</a> · Source: CBETA + OpenZenTexts · <a href="https://ko-fi.com/readzen" target="_blank" rel="noreferrer">Support this project</a> · <a href="#" id="contact-link" class="shell-foot-contact">Contact</a></p>
                <p class="shell-foot-pref">
                    Auto-open in desktop app:
                    <a href="#" id="auto-open-toggle" class="shell-foot-toggle"></a>
                </p>
                <p class="shell-foot-pref font-size-ctrl">
                    Text size:
                    <button class="font-btn" id="font-decrease" aria-label="Decrease text size">A&minus;</button>
                    <button class="font-btn" id="font-increase" aria-label="Increase text size">A+</button>
                </p>
                <p class="shell-foot-pref">
                    Hover dictionary:
                    <a href="#" id="hover-dict-toggle" class="shell-foot-toggle"></a>
                </p>
                <p class="shell-foot-pref">
                    <a href="#" id="theme-toggle" class="shell-foot-toggle" title="Toggle light/dark theme"></a>
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
    const copyLinkBtn = root.querySelector('#copy-link-btn');

    const autoOpenOn = isAutoOpenEnabled();

    // Hide header search on landing page (hero search is already prominent there)
    const headerSearchForm = root.querySelector('#header-search-form');
    if (headerSearchForm) headerSearchForm.style.display = route ? '' : 'none';

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
                corpusChip.textContent = corpus === 'cbeta' ? 'CBETA' : 'OpenZen';
                corpusChip.classList.remove('route-chip--cbeta', 'route-chip--openzen');
                corpusChip.classList.add(corpus === 'cbeta' ? 'route-chip--cbeta' : 'route-chip--openzen');
            } else {
                corpusChip.hidden = true;
            }
        }

        // Copy Link button: visible on every routed view. Copies a
        // shareable URL (readzen.pages.dev/#/...) to the clipboard with
        // brief "Copied!" feedback.
        if (copyLinkBtn) {
            copyLinkBtn.hidden = false;
            copyLinkBtn.addEventListener('click', async () => {
                try {
                    await copyShareableLink(route);
                    const orig = copyLinkBtn.textContent;
                    copyLinkBtn.textContent = 'Copied!';
                    copyLinkBtn.classList.add('btn--copied');
                    setTimeout(() => {
                        copyLinkBtn.textContent = orig;
                        copyLinkBtn.classList.remove('btn--copied');
                    }, 1800);
                } catch { /* silent */ }
            });
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

    // Auto-open toggle: off by default, user opts in.
    const toggle = root.querySelector('#auto-open-toggle');
    if (toggle) {
        toggle.textContent = autoOpenOn ? 'on' : 'off';
        toggle.addEventListener('click', (ev) => {
            ev.preventDefault();
            setAutoOpenEnabled(!autoOpenOn);
            window.location.reload();
        });
    }

    // Hover dictionary toggle
    const dictToggle = root.querySelector('#hover-dict-toggle');
    if (dictToggle) {
        const dictOn = localStorage.getItem('readzen-hover-dict') !== 'off';
        dictToggle.textContent = dictOn ? 'on' : 'off';
        dictToggle.addEventListener('click', (ev) => {
            ev.preventDefault();
            const nowOn = localStorage.getItem('readzen-hover-dict') !== 'off';
            localStorage.setItem('readzen-hover-dict', nowOn ? 'off' : 'on');
            dictToggle.textContent = nowOn ? 'off' : 'on';
        });
    }

    // Theme toggle: flips between dark (default) and light.
    const themeBtn = root.querySelector('#theme-toggle');
    if (themeBtn) {
        const cur = getTheme();
        themeBtn.textContent = cur === 'light' ? '\u2600\ufe0f dark' : '\u263c light';
        themeBtn.addEventListener('click', (ev) => {
            ev.preventDefault();
            const next = getTheme() === 'light' ? 'dark' : 'light';
            applyTheme(next);
            themeBtn.textContent = next === 'light' ? '\u2600\ufe0f dark' : '\u263c light';
        });
    }

    // Font size buttons
    const fontDecrease = root.querySelector('#font-decrease');
    const fontIncrease = root.querySelector('#font-increase');
    function adjustFontSize(delta) {
        const cur = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--text-size') || '16', 10);
        const next = Math.min(24, Math.max(12, cur + delta));
        document.documentElement.style.setProperty('--text-size', next + 'px');
        try { localStorage.setItem('readzen-font-size', String(next)); } catch {}
    }
    if (fontDecrease) fontDecrease.addEventListener('click', () => adjustFontSize(-2));
    if (fontIncrease) fontIncrease.addEventListener('click', () => adjustFontSize(2));

    // Contact link — assembled in JS to defeat email scrapers
    const contactLink = root.querySelector('#contact-link');
    if (contactLink) {
        contactLink.addEventListener('click', (ev) => {
            ev.preventDefault();
            var u = 'fabian.trunz';
            var d = 'gmail.com';
            window.location.href = 'mai' + 'lto:' + u + '@' + d;
        });
    }

    // Ko-fi overlay: opens the donation form in an iframe modal so the user
    // stays on readzen.pages.dev. No external SDK needed.
    function openKofiOverlay(ev) {
        if (ev) ev.preventDefault();
        if (document.querySelector('.kofi-overlay')) return; // already open
        const overlay = document.createElement('div');
        overlay.className = 'kofi-overlay';
        overlay.innerHTML =
            '<div class="kofi-overlay-backdrop"></div>' +
            '<div class="kofi-overlay-frame">' +
            '<button class="kofi-overlay-close" aria-label="Close">\u00d7</button>' +
            '<iframe src="https://ko-fi.com/readzen/?hidefeed=true&widget=true&embed=true" ' +
            'style="border:none;width:100%;height:100%;background:#1a1a2e;border-radius:12px;" ' +
            'title="Support ReadZen on Ko-fi"></iframe>' +
            '</div>';
        overlay.querySelector('.kofi-overlay-backdrop').addEventListener('click', () => overlay.remove());
        overlay.querySelector('.kofi-overlay-close').addEventListener('click', () => overlay.remove());
        document.addEventListener('keydown', function esc(e) {
            if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', esc); }
        });
        document.body.appendChild(overlay);
    }

    // Header search bar: submit navigates to #/search?q=...
    const headerSearchInput = root.querySelector('#header-search-input');

    if (headerSearchForm && headerSearchInput) {
        headerSearchForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const q = headerSearchInput.value.trim();
            navigate(q ? '/search?q=' + encodeURIComponent(q) : '/search');
            headerSearchInput.blur();
        });
    }

    // Ctrl+K / Cmd+K focuses the search bar; Escape blurs it
    document.addEventListener('keydown', (e) => {
        if (headerSearchInput && (e.ctrlKey || e.metaKey) && e.key === 'k') {
            e.preventDefault();
            headerSearchInput.focus();
            headerSearchInput.select();
        }
        if (headerSearchInput && e.key === 'Escape' && document.activeElement === headerSearchInput) {
            headerSearchInput.blur();
        }
    });

    // Mobile toggle: magnifying glass expands to full-width input
    const searchToggle = root.querySelector('.header-search-toggle');
    if (searchToggle) {
        searchToggle.addEventListener('click', () => {
            headerSearchForm.classList.add('header-search--expanded');
            headerSearchInput.focus();
        });
        headerSearchInput.addEventListener('blur', () => {
            setTimeout(() => headerSearchForm.classList.remove('header-search--expanded'), 200);
        });
    }

    // Research dropdown toggle
    const researchToggle = root.querySelector('#research-dropdown .header-nav-trigger');
    const researchMenu = root.querySelector('#research-menu');
    if (researchToggle && researchMenu) {
        researchToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = !researchMenu.hidden;
            researchMenu.hidden = isOpen;
            researchToggle.setAttribute('aria-expanded', !isOpen);
        });
        // Store handler reference to prevent duplicates on re-mount
        if (window._researchMenuCloseHandler) {
            document.removeEventListener('click', window._researchMenuCloseHandler);
        }
        window._researchMenuCloseHandler = () => {
            if (researchMenu) {
                researchMenu.hidden = true;
                researchToggle.setAttribute('aria-expanded', 'false');
            }
        };
        document.addEventListener('click', window._researchMenuCloseHandler);
        researchMenu.querySelectorAll('a').forEach(link => {
            link.addEventListener('click', () => {
                researchMenu.hidden = true;
                researchToggle.setAttribute('aria-expanded', 'false');
            });
        });
    }

    // Wire all support links to open the overlay instead of navigating away
    const supportBtn = root.querySelector('#support-btn');
    if (supportBtn) supportBtn.addEventListener('click', openKofiOverlay);
    root.querySelectorAll('a[href*="ko-fi.com/readzen"]').forEach(a => {
        a.addEventListener('click', openKofiOverlay);
        a.removeAttribute('target');
    });

    // ── Reading engagement: increment page view count and start tracking ──
    var currentViews = parseInt(sessionStorage.getItem('readzen-views') || '0', 10);
    sessionStorage.setItem('readzen-views', String(currentViews + 1));
    if (route) {
        // Start the reading timer on the first routed view
        if (!readingStartTime) readingStartTime = Date.now();
        // Debounced scroll handler checks reading engagement
        var scrollTick = false;
        window.addEventListener('scroll', function() {
            if (scrollTick) return;
            scrollTick = true;
            window.requestAnimationFrame(function() {
                scrollTick = false;
                trackReading();
            });
        }, { passive: true });
    }

    return {
        mount,
        headerSearchInput,
        focusSearch() { headerSearchInput?.focus(); headerSearchInput?.select(); },
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
