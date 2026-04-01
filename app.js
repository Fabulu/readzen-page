(function () {
    'use strict';

    var FILE_ID_PATTERN = /^[A-Za-z]+\d+n\d+[A-Za-z]?$/;
    var RELEASES_URL = 'https://github.com/Fabulu/CBETA-Translator/releases';
    var FALLBACK_DELAY = 2000;

    function fileIdToPath(fileId) {
        var nIdx = fileId.indexOf('n');
        if (nIdx < 1) return null;
        var volume = fileId.substring(0, nIdx);
        var canon = volume.replace(/[0-9]/g, '');
        return canon + '/' + volume + '/' + fileId + '.xml';
    }

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

    function buildZenUri(passage) {
        var fullPath = fileIdToPath(passage.fileId);
        if (!fullPath) return null;

        var uri = 'zen://' + fullPath;
        var queryParts = [];

        if (passage.range) {
            var bounds = passage.range.split('-');
            queryParts.push('from=' + encodeURIComponent(bounds[0]));
            if (bounds[1]) {
                queryParts.push('to=' + encodeURIComponent(bounds[1]));
            }
        }

        if (passage.side) {
            queryParts.push('side=' + encodeURIComponent(passage.side));
        }

        if (passage.highlight) {
            queryParts.push('highlight=' + encodeURIComponent(passage.highlight));
        }

        if (queryParts.length > 0) {
            uri += '?' + queryParts.join('&');
        }

        return uri;
    }

    function showPassageCard(passage) {
        var landing = document.getElementById('landing');
        var card = document.getElementById('passage');

        landing.style.display = 'none';
        card.style.display = 'block';

        document.getElementById('passage-file-id').textContent = passage.fileId;

        var rangeEl = document.getElementById('passage-range');
        if (passage.range) {
            var bounds = passage.range.split('-');
            rangeEl.textContent = bounds.length === 2
                ? bounds[0] + '  \u2013  ' + bounds[1]
                : bounds[0];
        } else {
            rangeEl.textContent = '';
        }

        var zenUri = buildZenUri(passage);
        if (zenUri) {
            window.location.href = zenUri;
        }

        setTimeout(function () {
            document.getElementById('passage-fallback').classList.add('visible');
        }, FALLBACK_DELAY);
    }

    function init() {
        var passage = parsePathname();

        if (passage) {
            showPassageCard(passage);
        }
        // else: landing page is already visible by default
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
