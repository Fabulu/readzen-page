// views/landing.js
// Rendered when no route is present. Mirrors the marketing copy from the
// previous static index.html so we don't regress the public landing page.

const RELEASES_URL = 'https://github.com/Fabulu/ReadZen/releases';

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
                <p class="cta-note">Windows · Linux · macOS</p>
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
