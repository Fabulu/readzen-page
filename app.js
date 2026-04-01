(function () {
    'use strict';

    // CBETA file IDs: letters + digits + 'n' + digits, optional suffix (A, B)
    var FILE_ID_PATTERN = /^[A-Za-z]{1,3}\d{1,4}n[a-z]?\d{1,5}[A-Za-z]?$/;
    var RELEASES_URL = 'https://github.com/Fabulu/CBETA-Translator/releases';
    var FALLBACK_DELAY = 2500;

    /**
     * Convert a file ID like "T48n2005" to a full CBETA path.
     * T48n2005 -> T/T48/T48n2005.xml
     * X63n1217 -> X/X63/X63n1217.xml
     * GA000na001 -> GA/GA000/GA000na001.xml
     */
    function fileIdToPath(fileId) {
        var nIdx = fileId.indexOf('n');
        if (nIdx < 1) return null;
        var volume = fileId.substring(0, nIdx);
        var canon = volume.replace(/[0-9]/g, '');
        if (!canon) return null;
        return canon + '/' + volume + '/' + fileId + '.xml';
    }

    /** Parse the current URL path for a passage link. */
    function parsePathname() {
        var parts = window.location.pathname.split('/').filter(Boolean);
        if (parts.length === 0) return null;

        var fileId = parts[0];
        if (!FILE_ID_PATTERN.test(fileId)) return null;

        var range = parts[1] || null;
        var params = new URLSearchParams(window.location.search);

        return {
            fileId: fileId,
            range: range,
            side: params.get('side'),
            highlight: params.get('highlight')
        };
    }

    /** Build a zen:// URI from parsed passage data. */
    function buildZenUri(passage) {
        var fullPath = fileIdToPath(passage.fileId);
        if (!fullPath) return null;

        var uri = 'zen://' + fullPath;
        var q = [];

        if (passage.range) {
            var bounds = passage.range.split('-');
            q.push('from=' + encodeURIComponent(bounds[0]));
            if (bounds.length > 1 && bounds[1]) {
                q.push('to=' + encodeURIComponent(bounds[1]));
            }
        }

        if (passage.side) q.push('side=' + encodeURIComponent(passage.side));
        if (passage.highlight) q.push('highlight=' + encodeURIComponent(passage.highlight));
        if (q.length > 0) uri += '?' + q.join('&');

        return uri;
    }

    /** Show the passage card and attempt to launch the app. */
    function showPassageCard(passage) {
        document.getElementById('landing').style.display = 'none';
        document.getElementById('passage').style.display = 'block';

        // File ID display
        document.getElementById('passage-file-id').textContent = passage.fileId;

        // Range display
        var rangeEl = document.getElementById('passage-range');
        if (passage.range) {
            var bounds = passage.range.split('-');
            rangeEl.textContent = bounds.length === 2
                ? bounds[0] + ' \u2013 ' + bounds[1]
                : bounds[0];
        } else {
            rangeEl.style.display = 'none';
        }

        // Attempt launch
        var zenUri = buildZenUri(passage);
        if (zenUri) {
            window.location.href = zenUri;
        }

        // Show fallback after delay
        setTimeout(function () {
            var action = document.getElementById('passage-action');
            var fallback = document.getElementById('passage-fallback');
            if (action) action.style.display = 'none';
            if (fallback) fallback.classList.add('visible');
        }, FALLBACK_DELAY);
    }

    /** Init: check URL and either show passage card or landing page. */
    function init() {
        var passage = parsePathname();
        if (passage) {
            showPassageCard(passage);
            document.title = 'Zen \u00B7 ' + passage.fileId;
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
