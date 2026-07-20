// views/shared-list.js
// Read-only renderer for a reading list shared via URL hash.
//
// Route: #/list?d=<base64-encoded-list>
// The route parser (lib/route.js) decodes the payload and attaches it as
// `route.list`. This view just renders it like the user's own reading list,
// with a banner and a "Save to my reading list" button.

import { escapeHtml } from '../lib/format.js';
import { mergeIntoLocalList } from '../lib/reading-list-share.js';

export function match(route) {
    return route && route.kind === 'shared-list';
}

export function preferAppFirst(_route) { return false; }

export async function render(route, mount, shell) {
    const list = Array.isArray(route && route.list) ? route.list : [];

    if (shell) {
        shell.setTitle('Shared Reading List');
        shell.setContext(
            list.length > 0
                ? `Shared list: ${list.length} text${list.length === 1 ? '' : 's'}`
                : 'Shared list',
            'Click any text to read.'
        );
        shell.hideStatus();
    }

    if (list.length === 0) {
        mount.innerHTML = `
            <section class="shared-list">
                <div class="shared-list-banner">
                    <p class="shared-list-banner-title">Shared list</p>
                    <p class="shared-list-banner-sub">This shared link is empty or could not be decoded.</p>
                </div>
                <p class="shared-list-empty">No items to display. <a class="text-link" href="#">Return home</a>.</p>
            </section>
        `;
        return;
    }

    const items = list.map((i) => {
        const route = (i.route || i.fileId || '').replace(/^\/+/, '');
        return `<div class="reading-list-entry">
            <a class="reading-list-item" href="#/${escapeHtml(route)}">${escapeHtml(i.title || i.fileId)}</a>
        </div>`;
    }).join('');

    mount.innerHTML = `
        <section class="shared-list">
            <div class="shared-list-banner">
                <p class="shared-list-banner-title">Shared list: click any text to read</p>
                <p class="shared-list-banner-sub">Read-only. Save to your reading list to keep these items locally.</p>
            </div>

            <div class="reading-list-section">
                <h3 class="reading-list-heading">Shared Reading List (${list.length})</h3>
                <div class="reading-list-items">${items}</div>
            </div>

            <div class="shared-list-actions">
                <button class="btn" id="save-shared-list">Save to my reading list</button>
                <a class="btn btn--outline" href="#">Back to home</a>
            </div>

            <p class="shared-list-saved" id="shared-list-saved" hidden>
                Saved. Open the home page to see your reading list.
            </p>
        </section>
    `;

    const saveBtn = mount.querySelector('#save-shared-list');
    const savedMsg = mount.querySelector('#shared-list-saved');
    if (saveBtn) {
        saveBtn.addEventListener('click', () => {
            const count = mergeIntoLocalList(list);
            saveBtn.disabled = true;
            saveBtn.textContent = `Saved ${count} text${count === 1 ? '' : 's'}`;
            if (savedMsg) savedMsg.hidden = false;
        });
    }
}
