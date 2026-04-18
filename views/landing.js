// views/landing.js
// Rendered when no route is present. Mirrors the marketing copy from the
// previous static index.html so we don't regress the public landing page.

import { getLastRead, getLists } from '../lib/reading-lists.js';
import { loadAllTitlesAsArray } from '../lib/titles.js';
import { loadMasters } from './master.js';
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

    // Continue reading banner
    const lastRead = getLastRead();
    const continueHtml = lastRead
        ? `<div class="continue-reading">
               <a class="continue-reading-link" href="#/${escapeHtml(lastRead.fileId)}">
                   Continue reading: ${escapeHtml(lastRead.title)} (${lastRead.scrollPercent}%)
               </a>
           </div>`
        : '';

    // Start Here section
    const startHereRows = START_HERE.map((t) =>
        `<a class="start-here-item" href="#/${escapeHtml(t.id)}">
            <span class="start-here-zh">${escapeHtml(t.zh)}</span>
            <span class="start-here-en">${escapeHtml(t.en)}</span>
        </a>`
    ).join('');

    // Reading list section
    const lists = getLists();
    const myList = lists['My Reading List'] || [];
    const listHtml = myList.length > 0
        ? `<div class="reading-list-section">
               <h3 class="reading-list-heading">My Reading List</h3>
               <div class="reading-list-items">
                   ${myList.map((i) =>
                       `<a class="reading-list-item" href="#/${escapeHtml(i.fileId)}">${escapeHtml(i.title)}</a>`
                   ).join('')}
               </div>
               <p class="reading-list-upsell">
                   Like Read Zen?
                   <a href="https://ko-fi.com/readzen" target="_blank" rel="noopener">Support us on Ko-fi</a>
                   or <a href="${RELEASES_URL}">get the desktop app</a> for the full experience.
               </p>
           </div>`
        : '';

    mount.innerHTML = `
        <section class="landing">
            ${continueHtml}

            <div class="hero">
                <h2 class="hero-title">Read \u00B7 Translate \u00B7 Research \u00B7 Share</h2>
                <p class="hero-desc">
                    A free desktop workspace for Chinese Zen literature.<br>
                    Side-by-side translation, hover dictionary, managed terminology,
                    full-text search, tagging, scholar collections, and community sharing.
                </p>
            </div>

            <div class="start-here">
                <h3 class="start-here-heading">Start Here</h3>
                <p class="start-here-desc">Core Zen texts — read them in Chinese with hover dictionary, or with community translations.</p>
                <div class="start-here-grid">${startHereRows}</div>
            </div>

            ${listHtml}

            <div class="cta">
                <p class="cta-explain">
                    Read Zen is a free desktop app. Download it, then click any
                    Read Zen link to open the passage directly.
                </p>
                <a class="btn" href="${RELEASES_URL}">Download Read Zen</a>
                <p class="cta-note">Windows \u00B7 Linux \u00B7 macOS \u00B7 Free &amp; open source (MIT)</p>
            </div>

            <div class="install-help">
                <p class="install-help-intro">
                    Read Zen is open source and we don't pay for code-signing
                    certificates yet. That means your OS will probably warn you on first
                    launch. Here's how to get past each warning \u2014 pick your platform:
                </p>

                <details class="install-os">
                    <summary>
                        <span class="install-os-icon">\uD83E\uDE9F</span>
                        Windows \u2014 "Windows protected your PC" warning
                    </summary>
                    <ol class="install-steps">
                        <li>Download the <code>ReadZen-win-x64.zip</code> from the releases page.</li>
                        <li>Extract the zip anywhere (no installer yet \u2014 just a folder of files).</li>
                        <li>Double-click <code>ReadZen.App.exe</code>. Windows SmartScreen will show a blue "Windows protected your PC" panel.</li>
                        <li>Click <strong>More info</strong> at the top of the warning.</li>
                        <li>Click the new <strong>Run anyway</strong> button at the bottom.</li>
                    </ol>
                    <p class="install-tip">
                        <strong>Faster path (once Microsoft merges the manifest PR):</strong>
                        <code>winget install Fabulu.ReadZen</code> \u2014 Microsoft signs the binary on its CDN, no SmartScreen warning at all, and <code>winget upgrade</code> handles updates for you.
                    </p>
                    <p class="install-why">
                        Why the warning? Code-signing certificates cost ~$120/yr.
                        We'll add it once download volume justifies the spend. Until
                        then, verify the source on
                        <a href="${SOURCE_URL}">GitHub</a> if you want to be sure.
                    </p>
                </details>

                <details class="install-os">
                    <summary>
                        <span class="install-os-icon">\uD83C\uDF4E</span>
                        macOS \u2014 "Read Zen.app cannot be opened"
                    </summary>
                    <ol class="install-steps">
                        <li>Download <code>ReadZen-osx-arm64.zip</code> (Apple Silicon) or <code>ReadZen-osx-x64.zip</code> (Intel) from releases.</li>
                        <li>Extract and try to open <strong>Read Zen.app</strong>. macOS will block it: "cannot be opened because the developer cannot be verified."</li>
                        <li>Click <strong>Done</strong> on that warning.</li>
                        <li>Open <strong>System Settings \u2192 Privacy &amp; Security</strong>.</li>
                        <li>Scroll down \u2014 you'll see "Read Zen was blocked..." with an <strong>Open Anyway</strong> button. Click it.</li>
                        <li>Confirm with your password. The next launch (and every one after) works normally.</li>
                    </ol>
                    <p class="install-tip">
                        <strong>On macOS 14 (Sonoma) or older:</strong> right-click the
                        app instead \u2192 <strong>Open</strong> \u2192 confirm. (Apple removed
                        this shortcut in macOS 15 Sequoia.)
                    </p>
                    <p class="install-why">
                        Why? Apple notarization requires a $99/yr Apple Developer
                        account. We're holding off until requested by enough Mac users.
                        The app is open source \u2014 verify on
                        <a href="${SOURCE_URL}">GitHub</a>.
                    </p>
                </details>

                <details class="install-os">
                    <summary>
                        <span class="install-os-icon">\uD83D\uDC27</span>
                        Linux \u2014 make the binary executable
                    </summary>
                    <ol class="install-steps">
                        <li>Download <code>ReadZen-linux-x64.zip</code> from releases.</li>
                        <li>Extract: <code>unzip ReadZen-linux-x64.zip</code></li>
                        <li>Make it executable: <code>chmod +x ReadZen.App</code></li>
                        <li>Run it: <code>./ReadZen.App</code></li>
                    </ol>
                    <p class="install-tip">
                        <strong>Coming in v4.5:</strong> AppImage with auto-update \u2014
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
                        <li><strong>Install Git</strong> if you don't have it: <a href="https://git-scm.com/downloads">git-scm.com/downloads</a>. Read Zen needs it to download the text corpora.</li>
                        <li>Launch Read Zen. The onboarding tutorial walks you through 4 required setup steps (welcome \u2192 Git check \u2192 choose folder &amp; download corpus \u2192 build search index). After that the rest of the tour is optional and you can skip out at any time.</li>
                        <li>The download is large (~2.5 GB) because it includes both CBETA and OpenZen text collections.</li>
                        <li>A free <a href="https://github.com/signup">GitHub account</a> is only needed if you want to share translations or contribute back. Reading + translating locally works without one.</li>
                    </ol>
                </details>

                <p class="install-trust">
                    <a href="${SOURCE_URL}">Source on GitHub</a>
                    \u00B7 <span class="install-license">MIT licensed</span>
                    \u00B7 Built by an independent scholar
                </p>
            </div>

            <div class="explore-masters">
                <h3 class="explore-masters-heading">Explore Zen Masters</h3>
                <p class="explore-masters-desc">
                    Browse 200+ Chan/Zen masters across all five schools, from Bodhidharma
                    to the late Song dynasty. View lineages, biographies, and text appearances.
                </p>
                <div class="explore-masters-links">
                    <a class="btn btn--outline" href="#/masters">Browse All Masters</a>
                    <button class="btn btn--outline" id="random-master-btn">\uD83C\uDFB2 Random Master</button>
                    <a class="btn btn--outline" href="#/lineage">View the Lineage Web</a>
                </div>
            </div>

            <div class="explore-texts-random">
                <button class="btn btn--outline" id="random-text-btn">\uD83C\uDFB2 Random Text</button>
            </div>

            <div class="features">
                <div class="feature">
                    <span class="feature-label">Translate</span>
                    <p>Side-by-side projection editor with translation memory, hover dictionary, and AI assistance.</p>
                </div>
                <div class="feature">
                    <span class="feature-label">Research</span>
                    <p>Tag passages, build scholar collections, manage terminology, compare translations across users.</p>
                </div>
                <div class="feature">
                    <span class="feature-label">Share</span>
                    <p>Sync translations, tags, termbases, and scholar collections with your community.</p>
                </div>
            </div>
        </section>
    `;

    // Wire random buttons (async, non-blocking)
    const randomTextBtn = mount.querySelector('#random-text-btn');
    if (randomTextBtn) {
        randomTextBtn.addEventListener('click', async () => {
            randomTextBtn.disabled = true;
            try {
                const titles = await loadAllTitlesAsArray();
                if (titles.length === 0) return;
                const entry = titles[Math.floor(Math.random() * titles.length)];
                const fileId = entry.fileId || entry.path;
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
}
