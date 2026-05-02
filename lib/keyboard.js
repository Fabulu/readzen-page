// lib/keyboard.js
// Global keyboard shortcuts. Ignores keystrokes when the user is typing in
// an input or textarea to avoid hijacking form fields.

import { dismissInlineDict } from './inline-dict.js';

let helpOverlay = null;

const SHORTCUTS = [
    { key: '/', description: 'Focus search' },
    { key: 'Escape', description: 'Dismiss popups' },
    { key: '?', description: 'Show this help' }
];

function isTyping(ev) {
    const tag = (ev.target.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || ev.target.isContentEditable;
}

function dismissHelp() {
    if (helpOverlay) { helpOverlay.remove(); helpOverlay = null; }
}

function showHelp() {
    if (helpOverlay) { dismissHelp(); return; }
    helpOverlay = document.createElement('div');
    helpOverlay.className = 'shortcuts-overlay';
    const rows = SHORTCUTS.map(
        s => `<tr><td class="shortcuts-key"><kbd>${s.key === ' ' ? 'Space' : s.key}</kbd></td><td>${s.description}</td></tr>`
    ).join('');
    helpOverlay.innerHTML =
        '<div class="shortcuts-backdrop"></div>' +
        '<div class="shortcuts-card">' +
        '<h3>Keyboard shortcuts</h3>' +
        '<table>' + rows + '</table>' +
        '<p class="shortcuts-dismiss">Press <kbd>?</kbd> or <kbd>Esc</kbd> to close</p>' +
        '</div>';
    helpOverlay.querySelector('.shortcuts-backdrop').addEventListener('click', dismissHelp);
    document.body.appendChild(helpOverlay);
}

export function dismissAllPopups() {
    dismissInlineDict();
    dismissHelp();
    // dismiss citation popup if present
    const cite = document.querySelector('.cite-popup');
    if (cite) cite.remove();
}

export function initKeyboard() {
    document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') {
            dismissAllPopups();
            return;
        }

        if (isTyping(ev)) return;

        if (ev.key === '/') {
            ev.preventDefault();
            const searchInput = document.querySelector('.search-input');
            if (searchInput) {
                searchInput.focus();
            } else {
                window.location.hash = '#/search';
            }
            return;
        }

        if (ev.key === '?') {
            ev.preventDefault();
            showHelp();
        }
    });
}
