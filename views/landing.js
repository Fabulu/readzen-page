// views/landing.js
// Rendered when no route is present. Mirrors the marketing copy from the
// previous static index.html so we don't regress the public landing page.

const RELEASES_URL = 'https://github.com/Fabulu/ReadZen/releases';
const SOURCE_URL = 'https://github.com/Fabulu/ReadZen';

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

    mount.innerHTML = `
        <section class="landing">
            <div class="hero">
                <h2 class="hero-title">Read · Translate · Research · Share</h2>
                <p class="hero-desc">
                    A free desktop workspace for Chinese Zen literature.<br>
                    Side-by-side translation, hover dictionary, managed terminology,
                    full-text search, tagging, scholar collections, and community sharing.
                </p>
            </div>

            <div class="cta">
                <p class="cta-explain">
                    Read Zen is a free desktop app. Download it, then click any
                    Read Zen link to open the passage directly.
                </p>
                <a class="btn" href="${RELEASES_URL}">Download Read Zen</a>
                <p class="cta-note">Windows · Linux · macOS · Free &amp; open source (MIT)</p>
            </div>

            <div class="install-help">
                <p class="install-help-intro">
                    Read Zen is open source and we don't pay for code-signing
                    certificates yet. That means your OS will probably warn you on first
                    launch. Here's how to get past each warning — pick your platform:
                </p>

                <details class="install-os">
                    <summary>
                        <span class="install-os-icon">🪟</span>
                        Windows — "Windows protected your PC" warning
                    </summary>
                    <ol class="install-steps">
                        <li>Download the <code>ReadZen-win-x64.zip</code> from the releases page.</li>
                        <li>Extract the zip anywhere (no installer yet — just a folder of files).</li>
                        <li>Double-click <code>ReadZen.App.exe</code>. Windows SmartScreen will show a blue "Windows protected your PC" panel.</li>
                        <li>Click <strong>More info</strong> at the top of the warning.</li>
                        <li>Click the new <strong>Run anyway</strong> button at the bottom.</li>
                    </ol>
                    <p class="install-tip">
                        <strong>Faster path (once Microsoft merges the manifest PR):</strong>
                        <code>winget install Fabulu.ReadZen</code> — Microsoft signs the binary on its CDN, no SmartScreen warning at all, and <code>winget upgrade</code> handles updates for you.
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
                        <span class="install-os-icon">🍎</span>
                        macOS — "Read Zen.app cannot be opened"
                    </summary>
                    <ol class="install-steps">
                        <li>Download <code>ReadZen-osx-arm64.zip</code> (Apple Silicon) or <code>ReadZen-osx-x64.zip</code> (Intel) from releases.</li>
                        <li>Extract and try to open <strong>Read Zen.app</strong>. macOS will block it: "cannot be opened because the developer cannot be verified."</li>
                        <li>Click <strong>Done</strong> on that warning.</li>
                        <li>Open <strong>System Settings → Privacy &amp; Security</strong>.</li>
                        <li>Scroll down — you'll see "Read Zen was blocked..." with an <strong>Open Anyway</strong> button. Click it.</li>
                        <li>Confirm with your password. The next launch (and every one after) works normally.</li>
                    </ol>
                    <p class="install-tip">
                        <strong>On macOS 14 (Sonoma) or older:</strong> right-click the
                        app instead → <strong>Open</strong> → confirm. (Apple removed
                        this shortcut in macOS 15 Sequoia.)
                    </p>
                    <p class="install-why">
                        Why? Apple notarization requires a $99/yr Apple Developer
                        account. We're holding off until requested by enough Mac users.
                        The app is open source — verify on
                        <a href="${SOURCE_URL}">GitHub</a>.
                    </p>
                </details>

                <details class="install-os">
                    <summary>
                        <span class="install-os-icon">🐧</span>
                        Linux — make the binary executable
                    </summary>
                    <ol class="install-steps">
                        <li>Download <code>ReadZen-linux-x64.zip</code> from releases.</li>
                        <li>Extract: <code>unzip ReadZen-linux-x64.zip</code></li>
                        <li>Make it executable: <code>chmod +x ReadZen.App</code></li>
                        <li>Run it: <code>./ReadZen.App</code></li>
                    </ol>
                    <p class="install-tip">
                        <strong>Coming in v4.5:</strong> AppImage with auto-update —
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
                        <span class="install-os-icon">📦</span>
                        First-time setup (after install)
                    </summary>
                    <ol class="install-steps">
                        <li><strong>Install Git</strong> if you don't have it: <a href="https://git-scm.com/downloads">git-scm.com/downloads</a>. Read Zen needs it to download the text corpora.</li>
                        <li>Launch Read Zen. The onboarding tutorial walks you through 4 required setup steps (welcome → Git check → choose folder &amp; download corpus → build search index). After that the rest of the tour is optional and you can skip out at any time.</li>
                        <li>The download is large (~2.5 GB) because it includes both CBETA and OpenZen text collections.</li>
                        <li>A free <a href="https://github.com/signup">GitHub account</a> is only needed if you want to share translations or contribute back. Reading + translating locally works without one.</li>
                    </ol>
                </details>

                <p class="install-trust">
                    <a href="${SOURCE_URL}">Source on GitHub</a>
                    · <span class="install-license">MIT licensed</span>
                    · Built by an independent scholar
                </p>
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
}
