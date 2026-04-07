(function () {
    'use strict';

    var FILE_ID_PATTERN = /^[A-Za-z]{1,3}\d{1,4}n[a-z]?\d{1,5}[A-Za-z]?$/;
    var RELEASES_URL = 'https://github.com/Fabulu/ReadZen/releases';
    var FALLBACK_DELAY = 2500;

    function getRawRoute() {
        var raw = window.location.hash.length > 1
            ? window.location.hash.substring(1)
            : window.location.pathname + window.location.search;

        if (!raw) return '';
        if (raw[0] === '/') raw = raw.substring(1);
        return raw;
    }

    function splitRoute(rawRoute) {
        var qIdx = rawRoute.indexOf('?');
        return {
            pathPart: qIdx >= 0 ? rawRoute.substring(0, qIdx) : rawRoute,
            queryPart: qIdx >= 0 ? rawRoute.substring(qIdx + 1) : ''
        };
    }

    function parseRoute(rawRoute) {
        if (!rawRoute) return null;

        var pieces = splitRoute(rawRoute);
        var parts = pieces.pathPart.split('/').filter(Boolean);
        if (parts.length === 0) return null;

        var first = parts[0];
        if (FILE_ID_PATTERN.test(first)) {
            return {
                kind: 'passage',
                title: first,
                subtitle: parts[1] ? parts[1] : 'Passage link',
                rawRoute: rawRoute
            };
        }

        switch (first.toLowerCase()) {
            case 'search':
                return {
                    kind: 'search',
                    title: 'Search',
                    subtitle: decodeURIComponent((new URLSearchParams(pieces.queryPart)).get('q') || 'Saved search'),
                    rawRoute: rawRoute
                };
            case 'dict':
            case 'term':
                return {
                    kind: 'dictionary',
                    title: 'Dictionary',
                    subtitle: parts[1] ? decodeURIComponent(parts[1]) : 'Dictionary link',
                    rawRoute: rawRoute
                };
            case 'scholar':
                return {
                    kind: 'scholar',
                    title: 'Scholar',
                    subtitle: parts[1] ? decodeURIComponent(parts[1]) : 'Scholar link',
                    rawRoute: rawRoute
                };
            case 'tags':
                return {
                    kind: 'tags',
                    title: 'Tags',
                    subtitle: parts[1] ? decodeURIComponent(parts[1]) : 'Tag link',
                    rawRoute: rawRoute
                };
            case 'master':
                return {
                    kind: 'master',
                    title: 'Zen Master',
                    subtitle: parts[1] ? decodeURIComponent(parts[1]) : 'Zen master link',
                    rawRoute: rawRoute
                };
            case 'compare':
                return {
                    kind: 'compare',
                    title: 'Compare',
                    subtitle: parts[1] ? decodeURIComponent(parts[1]) : 'Comparison link',
                    rawRoute: rawRoute
                };
            default:
                return null;
        }
    }

    function buildZenUri(route) {
        if (!route || !route.rawRoute) return null;
        return 'zen://' + route.rawRoute.replace(/^\/+/, '');
    }

    function showRouteCard(route) {
        document.getElementById('landing').style.display = 'none';
        document.getElementById('passage').style.display = 'block';

        var label = document.getElementById('passage-label');
        if (label) {
            label.textContent = route.kind === 'passage'
                ? 'Someone shared a passage with you'
                : 'Someone shared a Read Zen link with you';
        }

        var fileEl = document.getElementById('passage-file-id');
        if (fileEl) fileEl.textContent = route.title;

        var rangeEl = document.getElementById('passage-range');
        if (rangeEl) {
            if (route.subtitle) {
                rangeEl.style.display = '';
                rangeEl.textContent = route.subtitle;
            } else {
                rangeEl.style.display = 'none';
            }
        }

        var zenUri = buildZenUri(route);
        if (!zenUri) return;

        var appDetected = false;
        var launchTime = Date.now();

        function onAppDetected() {
            if (Date.now() - launchTime < 200) return;
            if (appDetected) return;
            appDetected = true;
            cleanup();

            var action = document.getElementById('passage-action');
            if (action) {
                action.innerHTML = '<p class="passage-status">Opened in Read Zen</p>';
            }
            setTimeout(function () { window.close(); }, 600);
        }

        function onVisChange() {
            if (document.hidden) onAppDetected();
        }

        function cleanup() {
            document.removeEventListener('visibilitychange', onVisChange);
            window.removeEventListener('blur', onAppDetected);
        }

        document.addEventListener('visibilitychange', onVisChange);
        window.addEventListener('blur', onAppDetected);

        var iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        iframe.src = zenUri;
        document.body.appendChild(iframe);
        setTimeout(function () {
            try { document.body.removeChild(iframe); } catch (e) {}
        }, 500);

        setTimeout(function () {
            cleanup();
            if (appDetected) return;
            var action = document.getElementById('passage-action');
            var fallback = document.getElementById('passage-fallback');
            if (action) action.style.display = 'none';
            if (fallback) fallback.classList.add('visible');
        }, FALLBACK_DELAY);
    }

    function init() {
        var route = parseRoute(getRawRoute());
        if (route) {
            showRouteCard(route);
            document.title = 'Read Zen · ' + route.title;
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
