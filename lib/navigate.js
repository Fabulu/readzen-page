// lib/navigate.js
// History-mode navigation helpers. All internal navigation goes through
// these two functions so the app uses clean URLs (no hash fragments).

/**
 * Navigates to a new path via pushState and dispatches 'routechange'
 * so the app re-renders.
 * @param {string} path - e.g. '/master/Linji' or 'search?q=foo'
 */
export function navigate(path) {
    const clean = '/' + path.replace(/^\/+/, '');
    history.pushState(null, '', clean);
    window.dispatchEvent(new Event('routechange'));
}

/**
 * Replaces the current history entry (no back-button entry created)
 * and dispatches 'routechange'.
 * @param {string} path - e.g. '/search?q=foo'
 */
export function replaceRoute(path) {
    const clean = '/' + path.replace(/^\/+/, '');
    history.replaceState(null, '', clean);
    window.dispatchEvent(new Event('routechange'));
}
