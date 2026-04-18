// views/landing.js
// Rendered when no route is present. Landing page with hero, corpus
// explainer, feature showcase, masters, curated texts, and install help.

import { getLastRead, getLists, removeFromList } from '../lib/reading-lists.js';
import { loadAllTitlesAsArray } from '../lib/titles.js';
import { loadMasters } from './master.js';
import { initGraph } from './lineage-graph.js';
import { escapeHtml } from '../lib/format.js';

const RELEASES_URL = 'https://github.com/Fabulu/ReadZen/releases';
const SOURCE_URL = 'https://github.com/Fabulu/ReadZen';

const START_HERE = [
    { id: 'T48n2005', zh: '\u7121\u9580\u95DC', en: 'Gateless Barrier (Wumenguan)' },
    { id: 'T48n2010', zh: '\u78A7\u5DCC\u9304', en: 'Blue Cliff Record (Biyan Lu)' },
    { id: 'T48n2004', zh: '\u5F9E\u5BB9\u9304', en: 'Book of Equanimity (Congrong Lu)' },
    { id: 'T48n2003', zh: '\u50B3\u71C8\u9304', en: 'Transmission of the Lamp (Chuandeng Lu)' },
    { id: 'T48n2012A', zh: '\u4EBA\u5929\u773C\u76EE', en: 'Eye of Humans and Gods' },
    { id: 'T47n1987A', zh: '\u5927\u6167\u666E\u899A\u79AA\u5E2B\u8A9E\u9304', en: 'Record of Dahui Pujue' },
    { id: 'T47n1987B', zh: '\u5927\u6167\u666E\u899A\u79AA\u5E2B\u5B97\u9580\u6B66\u5EAB', en: 'Arsenal of Dahui' },
    { id: 'J24nB137', zh: '\u7121\u9580\u95DC', en: 'Wumenguan (Jiaxing ed.)' }
];

/** Returns `true` when there is no route (or an empty one). */
export function match(route) {
    return !route;
}

/** The landing page is never an app-first handoff — it has no route. */
export function preferAppFirst(_route) {
    return false;
}

export function render(_route, mount, shell) {
    if (shell) {
        shell.setTitle('Read Zen');
        shell.setContext('', '');
        shell.hideStatus();
    }

    // ── Continue reading banner ──
    const lastRead = getLastRead();
    const continueHtml = lastRead
        ? `<div class="continue-reading">
               <a class="continue-reading-link" href="#/${escapeHtml(lastRead.route || lastRead.fileId)}">
                   Continue reading: ${escapeHtml(lastRead.title)} (${lastRead.scrollPercent}%)
               </a>
           </div>`
        : '';

    // ── Reading list section ──
    const lists = getLists();
    const myList = lists['My Reading List'] || [];
    const listHtml = myList.length > 0
        ? `<div class="reading-list-section">
               <h3 class="reading-list-heading">My Reading List</h3>
               <div class="reading-list-items">
                   ${myList.map((i) =>
                       `<div class="reading-list-entry">
                            <a class="reading-list-item" href="#/${escapeHtml(i.route || i.fileId)}">${escapeHtml(i.title)}</a>
                            <button class="reading-list-remove" data-file-id="${escapeHtml(i.fileId)}" title="Remove from reading list">\u00d7</button>
                        </div>`
                   ).join('')}
               </div>
           </div>`
        : '';

    // ── Start Here rows ──
    const startHereRows = START_HERE.map((t) =>
        `<a class="start-here-item" href="#/${escapeHtml(t.id)}">
            <span class="start-here-zh">${escapeHtml(t.zh)}</span>
            <span class="start-here-en">${escapeHtml(t.en)}</span>
        </a>`
    ).join('');

    mount.innerHTML = `
        <section class="landing">
            ${continueHtml}

            <div class="hero">
                <h2 class="hero-title">Read Zen</h2>
                <p class="hero-tagline">Read, search, and study classical Chinese Zen texts &mdash; with English translations and a built-in dictionary.</p>
            </div>

            <form class="landing-search" id="landing-search-form" autocomplete="off">
                <input class="landing-search-input" id="landing-search-input" type="text"
                       placeholder="Search 5,000+ texts by title\u2026" />
                <button class="btn" type="submit">Search</button>
            </form>

            <div class="lineage-showcase">
                <h3 class="lineage-showcase-heading">The Zen Lineage</h3>
                <p class="lineage-showcase-desc">
                    204 Chan/Zen masters from Bodhidharma to the late Ming.
                    Click a master to trace their lineage. Double-click to visit their profile.
                </p>
                <input type="text" id="landing-lineage-search" class="lineage-search--landing"
                       placeholder="Search masters by name\u2026" />
                <div class="lineage-showcase-canvas-wrap">
                    <canvas id="landing-lineage-canvas" class="lineage-showcase-canvas"></canvas>
                    <div id="landing-lineage-legend" class="lineage-legend lineage-legend--landing"></div>
                </div>
                <div class="lineage-showcase-controls">
                    <a class="btn btn--outline btn--small" href="#/lineage">Open Full Screen</a>
                    <a class="btn btn--outline btn--small" href="#/masters">Browse All Masters</a>
                    <button class="btn btn--outline btn--small" id="random-master-btn">\uD83C\uDFB2 Random Master</button>
                </div>
            </div>

            <div class="hero-actions">
                <a class="btn" href="#/search">Start Reading</a>
                <a class="btn btn--outline" href="${RELEASES_URL}">Download Desktop App</a>
                <a class="btn btn--outline" href="https://ko-fi.com/readzen">Support on Ko-fi</a>
            </div>

            <div class="corpus-cards">
                <div class="corpus-card">
                    <h3 class="corpus-card-title">CBETA</h3>
                    <p class="corpus-card-desc">5,000+ texts from the Chinese Buddhist canon. The complete Taisho, supplementary collections, and more.</p>
                    <p class="corpus-card-license">Non-commercial use &middot; <a href="https://www.cbeta.org" target="_blank" rel="noopener">cbeta.org</a></p>
                </div>
                <div class="corpus-card corpus-card--openzen">
                    <h3 class="corpus-card-title">OpenZen</h3>
                    <p class="corpus-card-desc">Freely-licensed critical editions and community translations. A growing collection you can build on.</p>
                    <p class="corpus-card-license">CC0 / CC BY 4.0 &middot; <a href="https://github.com/OpenZenTexts" target="_blank" rel="noopener">OpenZenTexts</a></p>
                </div>
            </div>

            <div class="feature-showcase">
                <div class="feature-group">
                    <h3 class="feature-group-title">Read</h3>
                    <ul class="feature-group-list">
                        <li>Side-by-side Chinese/English reading</li>
                        <li>Hover dictionary (CC-CEDICT) on every character</li>
                        <li class="feature-desktop">Translation editor with translation memory</li>
                        <li class="feature-desktop">AI-assisted translation drafts</li>
                    </ul>
                    <a class="feature-group-cta" href="#/T48n2005">Try a text</a>
                </div>
                <div class="feature-group">
                    <h3 class="feature-group-title">Research</h3>
                    <ul class="feature-group-list">
                        <li>Search work titles across both corpora</li>
                        <li class="feature-desktop">Full-text search across all 5,000+ texts</li>
                        <li class="feature-desktop">Tag passages and build scholar collections</li>
                        <li class="feature-desktop">Managed terminology (termbases)</li>
                    </ul>
                    <a class="feature-group-cta" href="#/search">Search the corpus</a>
                </div>
                <div class="feature-group">
                    <h3 class="feature-group-title">Explore</h3>
                    <ul class="feature-group-list">
                        <li>200+ Zen masters with lineages and biographies</li>
                        <li>Interactive lineage web across all five schools</li>
                        <li>Share links to any passage, master, or search</li>
                        <li class="feature-desktop">Sync translations and tags via GitHub</li>
                    </ul>
                    <a class="feature-group-cta" href="#/masters">Browse masters</a>
                </div>
            </div>

            <!-- Explore Zen Masters section removed — replaced by the embedded lineage graph above -->

            <div class="start-here">
                <h3 class="start-here-heading">Start Here</h3>
                <p class="start-here-desc">Core Zen texts &mdash; read them in Chinese with hover dictionary, or with community translations.</p>
                <div class="start-here-grid">${startHereRows}</div>
                <div class="start-here-random">
                    <button class="btn btn--outline" id="random-text-btn">\uD83C\uDFB2 Random Text</button>
                </div>
            </div>

            ${listHtml}

            <details class="install-collapsed">
                <summary class="install-collapsed-summary">Having trouble installing? Platform-specific help</summary>
                <div class="install-collapsed-body">
                    <p class="install-help-intro">
                        Read Zen is open source and we don't pay for code-signing
                        certificates yet. That means your OS will probably warn you on first
                        launch. Here's how to get past each warning:
                    </p>

                    <details class="install-os">
                        <summary>
                            <span class="install-os-icon">\uD83E\uDE9F</span>
                            Windows
                        </summary>
                        <p class="install-intro"><strong>Three ways to install:</strong></p>
                        <ol class="install-steps">
                            <li><strong>WinGet (recommended):</strong> <code>winget install ReadZen</code> &mdash; installs cleanly, SmartScreen-safe, and <code>winget upgrade</code> handles updates.</li>
                            <li><strong>Installer:</strong> Download <code>Setup.exe</code> from the releases page. Run it &mdash; the app auto-updates from then on.</li>
                            <li><strong>Portable ZIP:</strong> Download <code>ReadZen-win-x64.zip</code>, extract anywhere, and run <code>ReadZen.App.exe</code>. SmartScreen may warn once &mdash; click <strong>More info</strong> then <strong>Run anyway</strong>.</li>
                        </ol>
                        <p class="install-tip">
                            <strong>Git is bundled.</strong> You do not need to install Git separately &mdash; Read Zen ships with Portable Git built in.
                        </p>
                    </details>

                    <details class="install-os">
                        <summary>
                            <span class="install-os-icon">\uD83C\uDF4E</span>
                            macOS &mdash; "Read Zen.app cannot be opened"
                        </summary>
                        <ol class="install-steps">
                            <li>Download <code>ReadZen-osx-arm64.zip</code> (Apple Silicon) or <code>ReadZen-osx-x64.zip</code> (Intel) from releases.</li>
                            <li>Extract and try to open <strong>Read Zen.app</strong>. macOS will block it: "cannot be opened because the developer cannot be verified."</li>
                            <li>Click <strong>Done</strong> on that warning.</li>
                            <li>Open <strong>System Settings &rarr; Privacy &amp; Security</strong>.</li>
                            <li>Scroll down &mdash; you'll see "Read Zen was blocked..." with an <strong>Open Anyway</strong> button. Click it.</li>
                            <li>Confirm with your password. The next launch (and every one after) works normally.</li>
                        </ol>
                        <p class="install-tip">
                            <strong>On macOS 14 (Sonoma) or older:</strong> right-click the
                            app instead &rarr; <strong>Open</strong> &rarr; confirm. (Apple removed
                            this shortcut in macOS 15 Sequoia.)
                        </p>
                        <p class="install-why">
                            Why? Apple notarization requires a $99/yr Apple Developer
                            account. We're holding off until requested by enough Mac users.
                            The app is open source &mdash; verify on
                            <a href="${SOURCE_URL}">GitHub</a>.
                        </p>
                    </details>

                    <details class="install-os">
                        <summary>
                            <span class="install-os-icon">\uD83D\uDC27</span>
                            Linux &mdash; make the binary executable
                        </summary>
                        <ol class="install-steps">
                            <li>Download <code>ReadZen-linux-x64.zip</code> from releases.</li>
                            <li>Extract: <code>unzip ReadZen-linux-x64.zip</code></li>
                            <li>Make it executable: <code>chmod +x ReadZen.App</code></li>
                            <li>Run it: <code>./ReadZen.App</code></li>
                        </ol>
                        <p class="install-tip">
                            <strong>Coming in v4.5:</strong> AppImage with auto-update &mdash;
                            single executable file, no extraction required, in-app updates
                            instead of redownloading.
                        </p>
                        <p class="install-why">
                            Linux gets first-class treatment. No signing required, no
                            Gatekeeper, just <code>chmod +x</code> and go.
                        </p>
                    </details>

                    <details class="install-os">
                        <summary>
                            <span class="install-os-icon">\uD83D\uDCE6</span>
                            First-time setup (after install)
                        </summary>
                        <ol class="install-steps">
                            <li>Launch Read Zen. The onboarding walks you through 4 setup steps (welcome &rarr; Git check &rarr; choose folder &amp; download corpus &rarr; build search index). Skip the rest of the tour any time.</li>
                            <li>Git is bundled on Windows. On macOS/Linux, install Git if you don't have it: <a href="https://git-scm.com/downloads">git-scm.com/downloads</a>.</li>
                            <li>The corpus download is ~2.5 GB (CBETA + OpenZen).</li>
                            <li>A <a href="https://github.com/signup">GitHub account</a> is only needed to share translations. Reading and translating locally works without one.</li>
                        </ol>
                    </details>
                </div>
            </details>

            <div class="trust-strip">
                <span>MIT licensed</span>
                <span class="trust-sep">&middot;</span>
                <span>1,132 tests</span>
                <span class="trust-sep">&middot;</span>
                <span>Built by an independent scholar</span>
                <span class="trust-sep">&middot;</span>
                <a href="https://ko-fi.com/readzen" target="_blank" rel="noopener">Support on Ko-fi</a>
                <span class="trust-sep">&middot;</span>
                <a href="${SOURCE_URL}">Source on GitHub</a>
            </div>
        </section>
    `;

    // ── Landing search form ──
    const landingSearchForm = mount.querySelector('#landing-search-form');
    const landingSearchInput = mount.querySelector('#landing-search-input');
    if (landingSearchForm) {
        landingSearchForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const q = (landingSearchInput.value || '').trim();
            window.location.hash = '#/search' + (q ? '?q=' + encodeURIComponent(q) : '');
        });
    }

    // ── Reading list remove buttons ──
    mount.querySelectorAll('.reading-list-remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const fileId = btn.dataset.fileId;
            if (fileId) {
                removeFromList('My Reading List', fileId);
                const entry = btn.closest('.reading-list-entry');
                if (entry) entry.remove();
                // If list is now empty, remove the section
                const section = mount.querySelector('.reading-list-section');
                if (section && !section.querySelector('.reading-list-entry')) {
                    section.remove();
                }
            }
        });
    });

    // Wire random buttons (async, non-blocking)
    const randomTextBtn = mount.querySelector('#random-text-btn');
    if (randomTextBtn) {
        randomTextBtn.addEventListener('click', async () => {
            randomTextBtn.disabled = true;
            try {
                const titles = await loadAllTitlesAsArray();
                if (titles.length === 0) return;
                const entry = titles[Math.floor(Math.random() * titles.length)];
                let fileId = entry.fileId || '';
                if (!fileId && entry.path) {
                    // Derive fileId from path like "T/T48/T48n2005.xml" -> "T48n2005"
                    const fname = entry.path.split('/').pop() || '';
                    fileId = fname.replace(/\.xml$/i, '');
                }
                if (fileId) window.location.hash = '#/' + fileId;
            } catch { /* silent */ }
            randomTextBtn.disabled = false;
        });
    }

    const randomMasterBtn = mount.querySelector('#random-master-btn');
    if (randomMasterBtn) {
        randomMasterBtn.addEventListener('click', async () => {
            randomMasterBtn.disabled = true;
            try {
                const masters = await loadMasters();
                if (masters.length === 0) return;
                const m = masters[Math.floor(Math.random() * masters.length)];
                const name = (m.names && m.names[0]) || '';
                if (name) window.location.hash = '#/master/' + encodeURIComponent(name.replace(/ /g, '_'));
            } catch { /* silent */ }
            randomMasterBtn.disabled = false;
        });
    }

    // ── Embedded lineage graph (the showpiece) ──
    const canvas = mount.querySelector('#landing-lineage-canvas');
    const legend = mount.querySelector('#landing-lineage-legend');
    const searchInput = mount.querySelector('#landing-lineage-search');
    if (canvas) {
        loadMasters().then(masters => {
            if (!canvas.isConnected) return; // navigated away during load
            initGraph(canvas, legend, searchInput, masters, null);
        }).catch(() => {
            // If masters fail to load, hide the canvas area gracefully
            const wrap = mount.querySelector('.lineage-showcase-canvas-wrap');
            if (wrap) wrap.innerHTML = '<p style="text-align:center;opacity:0.5;padding:2rem;">Could not load lineage data.</p>';
        });
    }
}
