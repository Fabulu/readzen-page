// lib/share.js
// Shareable URL construction and clipboard copy for any routed view.
// The shell's "Copy Link" button calls copyShareableLink() with the
// current parsed route — every view gets correct deep links for free.

/**
 * Builds a full shareable URL from a parsed route object.
 * Uses `location.origin` as the base so it works on any deployment
 * (readzen.pages.dev, localhost, custom domain).
 * @param {{ rawRoute: string }} route - parsed route with rawRoute
 * @returns {string} full URL like "https://readzen.pages.dev/T48n2005/0292a26-0292a29"
 */
export function buildShareableUrl(route) {
    if (!route || !route.rawRoute) return location.href;
    return location.origin + '/' + route.rawRoute.replace(/^\/+/, '');
}

/**
 * Copies the shareable URL for the current route to the clipboard.
 * Returns the URL string so callers can show it in feedback UI.
 * @param {{ rawRoute: string }} route
 * @returns {Promise<string>}
 */
export async function copyShareableLink(route) {
    const url = buildShareableUrl(route);
    try {
        await navigator.clipboard.writeText(url);
    } catch {
        // Fallback for insecure contexts or older browsers
        const ta = document.createElement('textarea');
        ta.value = url;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
    }
    return url;
}
