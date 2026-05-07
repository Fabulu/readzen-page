// views/landing.js
// Rendered when no route is present. Landing page with hero, corpus
// explainer, feature showcase, masters, curated texts, and install help.

import { getLastRead, clearLastRead, getLists, removeFromList } from '../lib/reading-lists.js';
import { loadAllTitlesAsArray } from '../lib/titles.js';
import { loadMasters } from './master.js';
import { initGraph } from './lineage-graph.js';
import { escapeHtml } from '../lib/format.js';
import { initTypeahead } from '../lib/typeahead.js';
import { DATA_REPO_BASE } from '../lib/github.js';

const RELEASES_URL = 'https://github.com/Fabulu/ReadZen/releases';
const SOURCE_URL = 'https://github.com/Fabulu/ReadZen';

const START_HERE = [
    { id: 'T48n2005', zh: '\u7121\u9580\u95DC', en: 'Gateless Barrier (Wumenguan)' },
    { id: 'T48n2010', zh: '\u4FE1\u5FC3\u9298', en: 'Faith in Mind (Xinxin Ming)' },
    { id: 'T48n2004', zh: '\u5F9E\u5BB9\u9304', en: 'Book of Equanimity (Congrong Lu)' },
    { id: 'T48n2003', zh: '\u78A7\u5DCC\u9304', en: 'Blue Cliff Record (Biyan Lu)' },
    { id: 'T48n2012A', zh: '\u9EC3\u6A97\u5C71\u65B7\u969B\u79AA\u5E2B\u50B3\u5FC3\u6CD5\u8981', en: 'Transmission of Mind (Huangbo)' },
    { id: 'T47n1987A', zh: '\u64AB\u5DDE\u66F9\u5C71\u5143\u8B49\u79AA\u5E2B\u8A9E\u9304', en: 'Record of Caoshan Yuanzheng' },
    { id: 'J24nB137', zh: '\u8D99\u5DDE\u548C\u5C1A\u8A9E\u9304', en: 'Recorded Sayings of Zhaozhou' },
    { id: 'T47n1987B', zh: '\u64AB\u5DDE\u66F9\u5C71\u672C\u5BC2\u79AA\u5E2B\u8A9E\u9304', en: 'Record of Caoshan Benji' }
];

async function loadCommunityCards(mount) {
    const scrollEl = mount.querySelector('#community-research-scroll');
    if (!scrollEl) return;

    try {
        // Fetch INDEX.json
        const indexResp = await fetch(DATA_REPO_BASE + 'community/INDEX.json');
        if (!indexResp.ok) { hideCommunitySection(mount); return; }
        const indexData = await indexResp.json();
        const users = (indexData.users || []).filter(u => u.collections > 0).slice(0, 5);
        if (users.length === 0) { hideCommunitySection(mount); return; }

        // Load first collection per user for card data
        const cards = [];
        for (const u of users.slice(0, 4)) {
            try {
                const url = `${DATA_REPO_BASE}community/collections/${encodeURIComponent(u.name)}.jsonl`;
                const resp = await fetch(url);
                if (!resp.ok) continue;
                const text = await resp.text();
                const firstLine = text.split('\n').find(l => l.trim());
                if (!firstLine) continue;
                const coll = JSON.parse(firstLine);
                const passages = coll.passages || coll.Passages || [];
                const concepts = coll.concepts || coll.Concepts || [];
                const links = coll.links || coll.Links || [];
                cards.push({
                    user: u.name,
                    name: coll.name || coll.Name || 'Untitled',
                    id: coll.id || coll.Id || '',
                    passageCount: passages.length,
                    conceptCount: concepts.length,
                    linkCount: links.length,
                });
            } catch { /* skip failed user */ }
            if (cards.length >= 4) break;
        }

        if (cards.length === 0) { hideCommunitySection(mount); return; }

        if (!scrollEl.isConnected) return; // User navigated away

        // Render cards
        scrollEl.innerHTML = cards.map(c => `
            <div class="community-card" onclick="window.location.hash='#/scholar/${encodeURIComponent(c.name)}//${encodeURIComponent(c.user)}'">
                <div class="community-card-head">
                    <span class="community-card-avatar">${escapeHtml((c.user[0] || '?').toUpperCase())}</span>
                    <div class="community-card-info">
                        <span class="community-card-title">${escapeHtml(c.name)}</span>
                        <span class="community-card-user">by ${escapeHtml(c.user)}</span>
                    </div>
                </div>
                <div class="community-card-stats">
                    ${c.passageCount} passages${c.conceptCount ? ' \u00b7 ' + c.conceptCount + ' concepts' : ''}
                </div>
                ${(c.linkCount > 0 || c.conceptCount > 0) ? `<button class="community-card-graph-link" onclick="event.stopPropagation(); window.location.hash='#/scholar/${encodeURIComponent(c.name)}/graph/${encodeURIComponent(c.user)}';">View Graph \u2192</button>` : ''}
            </div>
        `).join('');
    } catch {
        hideCommunitySection(mount);
    }
}

function hideCommunitySection(mount) {
    const section = mount.querySelector('#community-research');
    if (section) section.style.display = 'none';
}

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
        ? `<div class="continue-reading" id="continue-reading">
               <a class="continue-reading-link" href="#/${escapeHtml(lastRead.route || lastRead.fileId)}">
                   Continue reading: ${escapeHtml(lastRead.title)} (${lastRead.scrollPercent}%)
               </a>
               <button class="continue-reading-dismiss" id="dismiss-continue" title="Dismiss">\u00d7</button>
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
                <p class="hero-tagline">Read, search, and study classical Chinese Zen texts - with full-text corpus search, English translations, and a built-in dictionary.</p>
            </div>

            <form class="landing-search" id="landing-search-form" autocomplete="off">
                <input class="landing-search-input" id="landing-search-input" type="text"
                       placeholder="Search masters, titles, and full text (Chinese + English)\u2026" />
                <button class="btn" type="submit">Search</button>
            </form>

            <div class="lineage-showcase">
                <h3 class="lineage-showcase-heading">The Zen Lineage</h3>
                <p class="lineage-showcase-desc">
                    301 Zen masters from Bodhidharma to the late Qing.
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

            <div class="community-research" id="community-research">
                <h3 class="community-research-heading">Community Research</h3>
                <p class="community-research-desc">Browse knowledge graphs and passage collections shared by scholars. Sync your own collections, translations, termbases, and translation memory with the community &mdash; all your local data is preserved during sync.</p>
                <div class="community-research-scroll" id="community-research-scroll">
                    <div class="community-card community-card--skeleton"></div>
                    <div class="community-card community-card--skeleton"></div>
                    <div class="community-card community-card--skeleton"></div>
                </div>
                <div class="community-research-cta">
                    <a class="text-link" href="#/scholar">Browse All Collections \u2192</a>
                </div>
            </div>

            <div class="graph-showcase">
                <h3 class="graph-showcase-heading">Interactive Knowledge Graphs</h3>
                <p class="graph-showcase-desc">
                    Every collection can be visualized as a force-directed graph. Seven node types &mdash;
                    passages, concepts, Zen masters, terms, collections, books, and web links &mdash;
                    connected by typed, labeled edges.
                </p>
                <div class="graph-showcase-features">
                    <div class="graph-showcase-feature">
                        <span class="graph-showcase-icon" style="font-size:1.3rem;color:#FFD700">&#x25C9;</span>
                        <div>
                            <strong>Starting node highlight</strong>
                            <p>The collection author marks an entry point so readers know where to begin.</p>
                        </div>
                    </div>
                    <div class="graph-showcase-feature">
                        <span class="graph-showcase-icon" style="font-size:1.3rem;color:var(--accent)">&#x25A3;</span>
                        <div>
                            <strong>Rich popup cards</strong>
                            <p>Click any node for a card with full Chinese/English text, metadata, connections, and dictionary lookup.</p>
                        </div>
                    </div>
                    <div class="graph-showcase-feature">
                        <span class="graph-showcase-icon" style="font-size:1.3rem;color:var(--accent)">&#x2192;</span>
                        <div>
                            <strong>Click to navigate</strong>
                            <p>Click a passage to see its details. Open it in the reader to see it in full context.</p>
                        </div>
                    </div>
                    <div class="graph-showcase-feature">
                        <span class="graph-showcase-icon" style="font-size:1.3rem;color:var(--accent)">&#x5B57;</span>
                        <div>
                            <strong>Hover dictionary</strong>
                            <p>CC-CEDICT lookup on any Chinese character &mdash; in the reader, graph popups, and collection views.</p>
                        </div>
                    </div>
                </div>
            </div>

            <div class="hero-actions">
                <a class="btn" href="#/search">Advanced Search &amp; Filters</a>
                <a class="btn btn--outline" href="${RELEASES_URL}">Download Desktop App</a>
                <a class="btn btn--outline" href="https://ko-fi.com/readzen">Support on Ko-fi</a>
            </div>

            <div class="corpus-cards">
                <div class="corpus-card">
                    <h3 class="corpus-card-title">CBETA</h3>
                    <p class="corpus-card-desc">5,000+ texts from the Chinese canon. The complete Taisho, supplementary collections, and more.</p>
                    <p class="corpus-card-license">Non-commercial use &middot; <a href="https://www.cbeta.org" target="_blank" rel="noopener">cbeta.org</a></p>
                </div>
                <div class="corpus-card corpus-card--openzen">
                    <h3 class="corpus-card-title">OpenZen</h3>
                    <p class="corpus-card-desc">Freely-licensed critical editions and community translations. A growing collection you can build on.</p>
                    <p class="corpus-card-license">CC0 / CC BY 4.0 &middot; <a href="https://github.com/Fabulu/OpenZenTexts" target="_blank" rel="noopener">OpenZenTexts</a></p>
                </div>
            </div>

            <div class="feature-showcase feature-showcase--four">
                <div class="feature-group">
                    <h3 class="feature-group-title">Read &amp; Translate</h3>
                    <ul class="feature-group-list">
                        <li>Side-by-side Chinese/English reading</li>
                        <li>Click or hover on any Chinese character for instant CC-CEDICT dictionary lookup</li>
                        <li class="feature-desktop">Translation editor with translation memory assistant</li>
                        <li class="feature-desktop">AI-assisted translation drafts</li>
                    </ul>
                    <a class="feature-group-cta" href="#/T48n2005">Try a text</a>
                </div>
                <div class="feature-group">
                    <h3 class="feature-group-title">Collections &amp; Graphs</h3>
                    <ul class="feature-group-list">
                        <li class="feature-desktop">Build research collections of passages from across the corpus</li>
                        <li class="feature-desktop">Organize with concepts, typed edges, and web links</li>
                        <li>Interactive force-directed knowledge graphs</li>
                        <li>7 node types with unique shapes and colors</li>
                        <li>Share and browse collections via URL</li>
                    </ul>
                    <a class="feature-group-cta" href="#/scholar">Browse collections</a>
                </div>
                <div class="feature-group">
                    <h3 class="feature-group-title">Research</h3>
                    <ul class="feature-group-list">
                        <li>Full-text corpus search across 5,000+ texts</li>
                        <li class="feature-desktop">Co-occurrence analysis, n-gram charts, and TSV export</li>
                        <li class="feature-desktop">Tag &amp; code passages for qualitative research</li>
                        <li>Hover dictionary in reader, graph popups, and collection views</li>
                    </ul>
                    <a class="feature-group-cta" href="#/search">Search the corpus</a>
                </div>
                <div class="feature-group">
                    <h3 class="feature-group-title">Explore</h3>
                    <ul class="feature-group-list">
                        <li>301 Zen masters with lineages and biographies</li>
                        <li>Interactive lineage web across nine schools</li>
                        <li class="feature-desktop">Compare translations side by side</li>
                        <li class="feature-desktop">Critical edition provenance &amp; apparatus</li>
                    </ul>
                    <a class="feature-group-cta" href="#/masters">Browse masters</a>
                </div>
            </div>

            <div class="desktop-features">
                <h3 class="desktop-features-heading">In the Desktop App</h3>
                <p class="desktop-features-desc">Everything above, plus research tools that need local processing power:</p>
                <div class="desktop-features-grid">
                    <div class="desktop-feature-card">
                        <h4>Translation Assistant</h4>
                        <p>Translation memory matches, terminology lookup, and QA warnings - all in a live sidebar while you translate.</p>
                    </div>
                    <div class="desktop-feature-card">
                        <h4>Search Assistant</h4>
                        <p>Full-text search with co-occurrence charts, n-gram analysis, association metrics, and TSV export.</p>
                    </div>
                    <div class="desktop-feature-card">
                        <h4>Scholar Collections &amp; Graphs</h4>
                        <p>Build and edit passage collections, add concepts and typed edges, set starting nodes, rename passages, and manage web links. Graphs are viewable on the web; editing requires the desktop app.</p>
                    </div>
                    <div class="desktop-feature-card">
                        <h4>Tagging &amp; Coding</h4>
                        <p>Tag vocabulary editor, per-passage coding, inter-rater reliability (Cohen&rsquo;s kappa), and cross-tabulation.</p>
                    </div>
                    <div class="desktop-feature-card">
                        <h4>Translation Comparison</h4>
                        <p>Compare community translations side by side. See how different translators handle the same passage.</p>
                    </div>
                    <div class="desktop-feature-card">
                        <h4>Critical Edition Tools</h4>
                        <p>Witness evidence viewer, apparatus display, correction timeline, and forensic provenance per character.</p>
                    </div>
                </div>
                <div class="desktop-features-cta">
                    <a class="btn" href="${RELEASES_URL}">Download Free</a>
                    <span class="desktop-features-platforms">Windows &middot; macOS &middot; Linux</span>
                </div>
            </div>

            <!-- Explore Zen Masters section removed — replaced by the embedded lineage graph above -->

            <div class="start-here">
                <h3 class="start-here-heading">Start Here</h3>
                <p class="start-here-desc">Core Zen texts - read them in Chinese with hover dictionary, or with community translations.</p>
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
                            <li><strong>WinGet (recommended):</strong> <code>winget install ReadZen</code> - installs cleanly, SmartScreen-safe, and <code>winget upgrade</code> handles updates.</li>
                            <li><strong>Installer:</strong> Download <code>Setup.exe</code> from the releases page. Run it - the app auto-updates from then on.</li>
                            <li><strong>Portable ZIP:</strong> Download <code>ReadZen-win-x64.zip</code>, extract anywhere, and run <code>ReadZen.App.exe</code>. SmartScreen may warn once - click <strong>More info</strong> then <strong>Run anyway</strong>.</li>
                        </ol>
                        <p class="install-tip">
                            <strong>Git is bundled.</strong> You do not need to install Git separately - Read Zen ships with Portable Git built in.
                        </p>
                    </details>

                    <details class="install-os">
                        <summary>
                            <span class="install-os-icon">\uD83C\uDF4E</span>
                            macOS - "Read Zen.app cannot be opened"
                        </summary>
                        <ol class="install-steps">
                            <li>Download <code>ReadZen-osx-arm64.zip</code> (Apple Silicon) or <code>ReadZen-osx-x64.zip</code> (Intel) from releases.</li>
                            <li>Extract and try to open <strong>Read Zen.app</strong>. macOS will block it: "cannot be opened because the developer cannot be verified."</li>
                            <li>Click <strong>Done</strong> on that warning.</li>
                            <li>Open <strong>System Settings &rarr; Privacy &amp; Security</strong>.</li>
                            <li>Scroll down - you'll see "Read Zen was blocked..." with an <strong>Open Anyway</strong> button. Click it.</li>
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
                            The app is open source - verify on
                            <a href="${SOURCE_URL}">GitHub</a>.
                        </p>
                    </details>

                    <details class="install-os">
                        <summary>
                            <span class="install-os-icon">\uD83D\uDC27</span>
                            Linux - make the binary executable
                        </summary>
                        <ol class="install-steps">
                            <li>Download <code>ReadZen-linux-x64.zip</code> from releases.</li>
                            <li>Extract: <code>unzip ReadZen-linux-x64.zip</code></li>
                            <li>Make it executable: <code>chmod +x ReadZen.App</code></li>
                            <li>Run it: <code>./ReadZen.App</code></li>
                        </ol>
                        <p class="install-tip">
                            <strong>Tip:</strong> For the simplest experience, download the
                            self-contained zip — no .NET runtime needed, just extract and run.
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

        </section>
    `;

    // ── Dismiss continue-reading ──
    const dismissBtn = mount.querySelector('#dismiss-continue');
    if (dismissBtn) {
        dismissBtn.addEventListener('click', (e) => {
            e.preventDefault();
            clearLastRead();
            const banner = mount.querySelector('#continue-reading');
            if (banner) banner.remove();
        });
    }

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

    // ── Typeahead autocomplete on hero search ──
    if (landingSearchInput) {
        // Pagefind preload: start downloading WASM on first keystroke
        landingSearchInput.addEventListener('input', () => {
            import('/pagefind/pagefind.js').catch(() => {});
        }, { once: true });

        // Wire typeahead once data is available
        Promise.all([loadAllTitlesAsArray(), loadMasters()]).then(([titles, masters]) => {
            if (!landingSearchInput.isConnected) return;
            initTypeahead(landingSearchInput, {
                titles: titles,
                masters: masters,
                onSelect(item) {
                    if (item.kind === 'fulltext') {
                        window.location.hash = '#/search?q=' + encodeURIComponent(item.query);
                    } else if (item.href) {
                        const qSuffix = item.query ? '?q=' + encodeURIComponent(item.query) : '';
                        window.location.hash = item.href + qSuffix;
                    }
                }
            });
        }).catch(() => { /* typeahead is non-essential */ });
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

    // ── Community research cards (async, non-blocking) ──
    loadCommunityCards(mount);
}
