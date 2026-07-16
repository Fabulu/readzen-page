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
import { copyShareableLink } from '../lib/share.js';
import {
    getDictMode, setDictMode, getZenHighlight, setZenHighlight,
    getChrome, setChrome, getPalette, setPalette, PALETTES, PALETTE_FAMILY,
} from '../lib/reader-prefs.js';

// Colour palettes. Each is a different register, not a different hue: what the
// site should FEEL like to read in. Family is what the existing light/dark
// component overrides key on.
const PALETTE_OPTIONS = [
    { id: 'ink', name: 'Ink', desc: 'The current one. Warm gold on near-black.' },
    { id: 'sumi', name: 'Sumi', desc: 'Ink-wash black with a muted seal red. The red is kept for the accent only, so it reads as a stamp rather than a warning.' },
    { id: 'slate', name: 'Slate', desc: 'Cool blue-grey dark. Low-chroma and quiet; the least decorated of the set.' },
    { id: 'jade', name: 'Jade', desc: 'Deep green-teal night with a pale jade accent. Colourful but calm.' },
    { id: 'persimmon', name: 'Persimmon', desc: 'Brown-black page lit by persimmon orange. The warmest and friendliest of the dark sets.' },
    { id: 'indigo', name: 'Indigo', desc: 'Night-sky violet-blue with a cyan accent. The most vivid thing here.' },
    { id: 'paper', name: 'Paper', desc: 'The existing light theme. Warm off-white, ochre accent.' },
    { id: 'woodblock', name: 'Woodblock', desc: 'Aged block-print parchment, rust-red accent, deep brown text. Reads like a printed book.' },
    { id: 'matcha', name: 'Matcha', desc: 'Soft tea-green paper, deep green accent. Playful without being loud, and easy for long reads.' },
    { id: 'plum', name: 'Plum', desc: 'Blossom-tinted paper with a plum accent. The most playful of the lot — and it still reads.' },
];

// Candidate header layouts, offered live so they can be compared on real pages
// instead of in the abstract. Each is a different ANSWER to the same problem --
// too much in one row -- not a different colour scheme.
const CHROME_OPTIONS = [
    { id: 'compact', name: 'Compact', desc: 'One tight row. The oversized serif title shrinks to a wordmark and the search collapses to an icon, so the nav stops overflowing.' },
    { id: 'masthead', name: 'Masthead', desc: 'Two rows: the brand line, then the nav on its own rule beneath it. Nothing competes; the nav can grow.' },
    { id: 'rail', name: 'Side rail', desc: 'The nav moves to a vertical rail down the left. The top row empties out entirely and the nav scales to any number of destinations.' },
    { id: 'journal', name: 'Journal', desc: 'A printed-journal masthead: centred serif wordmark between hairline rules, nav as plain small-caps text. No pills, no gradients.' },
    { id: 'current', name: 'Current', desc: 'What the site has today, kept here so the others can be judged against it.' },
];

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
    try {
        const stored = localStorage.getItem(THEME_PREF_KEY);
        if (stored) return stored;
        return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    } catch { return 'dark'; }
}

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : '');
    try { localStorage.setItem(THEME_PREF_KEY, theme); } catch {}
}

/**
 * Apply a palette: set the colour tokens (data-palette) AND the light/dark
 * family they belong to (data-theme), because the component overrides are keyed
 * on the family, not the palette.
 */
function applyPalette(id) {
    const family = PALETTE_FAMILY[id] || 'dark';
    document.documentElement.setAttribute('data-palette', id);
    applyTheme(family);
    setPalette(id);
}

// Apply the saved palette (and with it the saved light/dark family) on load. A
// palette the user has never touched falls back to their light/dark preference.
(function initPalette() {
    let saved = null;
    try { saved = localStorage.getItem('zl:palette'); } catch { /* private mode */ }
    if (saved && PALETTES.includes(saved)) {
        applyPalette(saved);
    } else {
        const theme = getTheme();
        document.documentElement.setAttribute('data-palette', theme === 'light' ? 'paper' : 'ink');
        applyTheme(theme);
    }
})();

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


// The main navigation. Flat and always visible on every page: the destinations
// used to live behind a "Research" dropdown, which meant the Dictionary was
// unreachable from, say, the Zen Masters page unless you knew to open a menu.
// `kinds` are the route kinds that should light the link up as the current page.
const NAV_LINKS = [
    { href: '#/masters', label: 'Masters', kinds: ['masters', 'master'] },
    { href: '#/lineage', label: 'Lineage', kinds: ['lineage'] },
    { href: '#/scholar', label: 'Collections', kinds: ['scholar', 'shared-list'] },
    { href: '#/dict', label: 'Dictionary', kinds: ['dict-browse', 'dictionary', 'termbase'] },
];

function isNavActive(link, route) {
    return !!(route && link.kinds.includes(route.kind));
}

/**
 * Render the shell into `#app` and return the inner mount node plus a set of
 * helper functions bound to the live DOM elements.
 */
export function mountShell(root, route) {
    const chrome = getChrome();
    const palette = getPalette();
    root.innerHTML = `
        <div class="shell shell--${chrome}">
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
                <nav class="header-nav" aria-label="Main">
                    ${NAV_LINKS.map((l) => `
                        <a class="header-nav-link${isNavActive(l, route) ? ' header-nav-link--active' : ''}"
                           href="${l.href}"${isNavActive(l, route) ? ' aria-current="page"' : ''}>${l.label}</a>`).join('')}
                </nav>
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

            <div class="chrome-switch" id="chrome-switch">
                <button type="button" class="chrome-switch-trigger" id="chrome-switch-trigger"
                        aria-expanded="false">Design</button>
                <div class="chrome-switch-panel" id="chrome-switch-panel" hidden>
                    <p class="chrome-switch-title">Header layout</p>
                    <p class="chrome-switch-hint">Try them on a real page. Your choice is remembered.</p>
                    ${CHROME_OPTIONS.map((o) => `
                        <button type="button" class="chrome-switch-opt${o.id === chrome ? ' chrome-switch-opt--on' : ''}"
                                data-chrome="${o.id}">
                            <span class="chrome-switch-opt-name">${escapeHtml(o.name)}</span>
                            <span class="chrome-switch-opt-desc">${escapeHtml(o.desc)}</span>
                        </button>`).join('')}

                    <p class="chrome-switch-title chrome-switch-title--sep">Theme</p>
                    <div class="chrome-swatches">
                        ${PALETTE_OPTIONS.map((o) => `
                            <button type="button" class="chrome-swatch${o.id === palette ? ' chrome-swatch--on' : ''}"
                                    data-palette="${o.id}" title="${escapeHtml(o.desc)}">
                                <span class="chrome-swatch-chip chrome-swatch-chip--${o.id}" aria-hidden="true"></span>
                                <span class="chrome-swatch-name">${escapeHtml(o.name)}</span>
                            </button>`).join('')}
                    </div>
                    <p class="chrome-switch-hint" id="palette-desc">${escapeHtml((PALETTE_OPTIONS.find((o) => o.id === palette) || {}).desc || '')}</p>
                </div>
            </div>

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
                <p>Open source on <a href="https://github.com/Fabulu/ReadZen">GitHub</a> · Source: CBETA + OpenZenTexts · <a href="/credits">Credits &amp; licenses</a> · <a href="https://ko-fi.com/readzen" target="_blank" rel="noreferrer">Support this project</a> · <a href="#" id="contact-link" class="shell-foot-contact">Contact</a></p>
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
                    Dictionary:
                    <a href="#" id="dict-mode-toggle" class="shell-foot-toggle" title="Switch the click dictionary between the Zen termbase and CC-CEDICT"></a>
                </p>
                <p class="shell-foot-pref">
                    Zen word highlight:
                    <a href="#" id="zen-highlight-toggle" class="shell-foot-toggle" title="Highlight curated Zen terms in the Chinese text"></a>
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

    // Dictionary mode toggle: Zen ⇄ CC-CEDICT. Click-only, mutually exclusive.
    // The chosen mode drives which dictionary a click on Chinese text opens.
    const dictModeToggle = root.querySelector('#dict-mode-toggle');
    if (dictModeToggle) {
        const label = (m) => (m === 'cedict' ? 'CC-CEDICT' : 'Zen');
        dictModeToggle.textContent = label(getDictMode());
        dictModeToggle.addEventListener('click', (ev) => {
            ev.preventDefault();
            const next = getDictMode() === 'zen' ? 'cedict' : 'zen';
            setDictMode(next);
            dictModeToggle.textContent = label(next);
        });
    }

    // Zen word highlight toggle: purely visual highlighting of curated terms
    // in the Chinese source. Takes effect on the next passage render.
    const zenHlToggle = root.querySelector('#zen-highlight-toggle');
    if (zenHlToggle) {
        zenHlToggle.textContent = getZenHighlight() ? 'on' : 'off';
        zenHlToggle.addEventListener('click', (ev) => {
            ev.preventDefault();
            const next = !getZenHighlight();
            setZenHighlight(next);
            zenHlToggle.textContent = next ? 'on' : 'off';
        });
    }

    // Theme toggle: flips between dark (default) and light.
    // Footer light/dark toggle. It must flip the PALETTE, not just the family:
    // setting data-theme alone would leave a dark palette's tokens on a light
    // page. Flipping jumps to the default of the other family; the Design panel
    // is where a specific palette is chosen.
    const themeBtn = root.querySelector('#theme-toggle');
    if (themeBtn) {
        const label = (fam) => (fam === 'light' ? '\u2600\ufe0f dark' : '\u263c light');
        themeBtn.textContent = label(PALETTE_FAMILY[getPalette()] || 'dark');
        themeBtn.addEventListener('click', (ev) => {
            ev.preventDefault();
            const isLight = (PALETTE_FAMILY[getPalette()] || 'dark') === 'light';
            const next = isLight ? 'ink' : 'paper';
            applyPalette(next);
            themeBtn.textContent = label(PALETTE_FAMILY[next]);
            root.querySelectorAll('.chrome-swatch').forEach((b) => {
                b.classList.toggle('chrome-swatch--on', b.dataset.palette === next);
            });
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
            window.location.hash = q ? '#/search?q=' + encodeURIComponent(q) : '#/search';
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

    // The nav is now flat links -- no toggle to wire. Clean up the document-level
    // click handler the old dropdown installed, so a stale one cannot survive a
    // re-mount and swallow clicks.
    if (window._researchMenuCloseHandler) {
        document.removeEventListener('click', window._researchMenuCloseHandler);
        window._researchMenuCloseHandler = null;
    }

    // Header-layout switcher. Applying a layout only swaps a class on .shell --
    // every variant is the same markup laid out differently -- so switching is
    // instant and needs no re-render.
    const chromeTrigger = root.querySelector('#chrome-switch-trigger');
    const chromePanel = root.querySelector('#chrome-switch-panel');
    if (chromeTrigger && chromePanel) {
        chromeTrigger.addEventListener('click', (e) => {
            e.stopPropagation();
            const open = chromePanel.hidden;
            chromePanel.hidden = !open;
            chromeTrigger.setAttribute('aria-expanded', String(open));
        });
        chromePanel.addEventListener('click', (e) => {
            const layoutBtn = e.target.closest('.chrome-switch-opt');
            if (layoutBtn) {
                const id = layoutBtn.dataset.chrome;
                setChrome(id);
                root.querySelector('.shell').className = 'shell shell--' + id;
                chromePanel.querySelectorAll('.chrome-switch-opt').forEach((b) => {
                    b.classList.toggle('chrome-switch-opt--on', b.dataset.chrome === id);
                });
                return;
            }

            const paletteBtn = e.target.closest('.chrome-swatch');
            if (paletteBtn) {
                const id = paletteBtn.dataset.palette;
                applyPalette(id);
                chromePanel.querySelectorAll('.chrome-swatch').forEach((b) => {
                    b.classList.toggle('chrome-swatch--on', b.dataset.palette === id);
                });
                const desc = chromePanel.querySelector('#palette-desc');
                const opt = PALETTE_OPTIONS.find((o) => o.id === id);
                if (desc && opt) desc.textContent = opt.desc;
            }
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
