// views/scholar-graph.js
// Canvas-based force-directed graph showing passage relationships within
// a published scholar collection.
//
// Route: #/scholar/{collectionId}/graph/{user}
//
// Reuses the canvas infrastructure (pan/zoom/touch/hit-test/popup) from
// lineage-graph.js, adapted for circular nodes and typed edges.

import { escapeHtml } from '../lib/format.js';
import { DATA_REPO_BASE } from '../lib/github.js';
import { streamJsonl } from '../lib/jsonl.js';
import * as cache from '../lib/cache.js';

// ── Lineage palette for nodes ──

const LINEAGE_COLORS = {
    'Linji':    '#d4ab58',
    'Caodong':  '#6a8cbc',
    'Fayan':    '#8ca06a',
};
const DEFAULT_NODE_COLOR = '#8b7b69';

// ── Edge colors by relation type ──

const EDGE_COLORS = {
    'quotes':        '#d4ab58',
    'alludes-to':    '#8ca06a',
    'comments-on':   '#6a8cbc',
    'contradicts':   '#bc6a6a',
    'parallels':     '#9a7cbc',
    'responds-to':   '#bc9a6a',
    'is-variant-of': '#6abcb0',
    'translates':    '#7a9abc',
    'summarizes':    '#bca86a',
};
const DEFAULT_EDGE_COLOR = '#888';

// ── Data loading ──

const COLLECTION_CACHE_TTL_MS = 10 * 60 * 1000;

async function loadCollections(user) {
    const key = 'scholar:' + user;
    const cached = cache.get(key);
    if (cached) return cached;
    const url = `${DATA_REPO_BASE}community/collections/${encodeURIComponent(user)}.jsonl`;
    const rows = [];
    for await (const row of streamJsonl(url)) {
        if (row && typeof row === 'object') rows.push(row);
    }
    cache.set(key, rows, COLLECTION_CACHE_TTL_MS);
    return rows;
}

// ── Route matching ──

export function match(route) {
    return route && route.kind === 'scholar-graph';
}

export function preferAppFirst() { return false; }

// ── Main render ──

export async function render(route, mount, shell) {
    const collectionId = (route.collectionId || '').trim();
    const user = (route.user || '').trim();

    if (shell) {
        shell.setTitle(`Scholar Graph · ${collectionId || '?'}`);
        shell.setContext(
            user ? `Collection by ${user}` : 'Scholar collection',
            'Knowledge graph'
        );
        shell.setUpsell(
            'This preview shows a passage relationship graph. The desktop app lets ' +
            'you <strong>build your own collections</strong>, annotate links between passages, ' +
            'and share collection links like this one with your community.'
        );
        shell.hideStatus();
    }

    if (!user) {
        mount.innerHTML = '<article class="panel lookup-card"><p>Missing user in graph URL.</p></article>';
        return;
    }

    mount.innerHTML = `
        <div class="lineage-container">
            <canvas class="lineage-canvas" id="scholar-graph-canvas"></canvas>
            <div class="lineage-controls">
                <div class="lineage-zoom-btns">
                    <button class="lineage-zoom-btn" data-dir="in" title="Zoom in">+</button>
                    <button class="lineage-zoom-btn" data-dir="out" title="Zoom out">&minus;</button>
                    <button class="lineage-zoom-btn" data-dir="reset" title="Reset view">&#8634;</button>
                </div>
            </div>
            <a class="lineage-browse-link" href="#/scholar/${encodeURIComponent(collectionId)}//${encodeURIComponent(user)}">&larr; Back to Collection</a>
        </div>
    `;

    let collections;
    try {
        collections = await loadCollections(user);
    } catch (error) {
        mount.innerHTML = `<article class="panel lookup-card"><p>Failed to load collections: ${escapeHtml(String(error.message || error))}</p></article>`;
        return;
    }

    const collection = collections.find(c =>
        (c.id || c.Id) === collectionId ||
        normalizeName(c.name || c.Name) === normalizeName(collectionId)
    ) || null;

    if (!collection) {
        mount.innerHTML = `<article class="panel lookup-card"><p>Collection <code>${escapeHtml(collectionId)}</code> not found.</p></article>`;
        return;
    }

    const passages = collection.passages || collection.Passages || [];
    const links = collection.links || collection.Links || [];
    const graphLayout = collection.graphLayout || collection.GraphLayout || null;

    if (passages.length === 0) {
        mount.innerHTML = `<article class="panel lookup-card"><p>This collection has no passages to graph.</p></article>`;
        return;
    }

    // Build node map
    const nodeMap = new Map();
    for (const p of passages) {
        const pid = p.id || p.Id || '';
        if (!pid) continue;
        const label = p.sourceRelPath || p.SourceRelPath || pid;
        const lineage = p.lineage || p.Lineage || '';
        nodeMap.set(pid, {
            id: pid,
            label: label,
            lineage: lineage,
            sourceRelPath: p.sourceRelPath || p.SourceRelPath || '',
            x: 0, y: 0,
            vx: 0, vy: 0,
            degree: 0,
        });
    }

    // Build edges
    const edges = [];
    for (const link of links) {
        const fromId = link.fromPassageId || link.FromPassageId || '';
        const toId = link.toPassageId || link.ToPassageId || '';
        const relType = link.relationType || link.RelationType || '';
        const fromNode = nodeMap.get(fromId);
        const toNode = nodeMap.get(toId);
        if (fromNode && toNode) {
            fromNode.degree++;
            toNode.degree++;
            edges.push({ from: fromNode, to: toNode, relationType: relType });
        }
    }

    const nodes = [...nodeMap.values()];

    // Apply saved positions or run force layout
    const savedPositions = graphLayout
        ? (graphLayout.NodePositions || graphLayout.nodePositions || null)
        : null;

    if (savedPositions && typeof savedPositions === 'object') {
        for (const n of nodes) {
            const pos = savedPositions[n.id];
            if (pos) {
                n.x = pos.x || pos.X || 0;
                n.y = pos.y || pos.Y || 0;
            }
        }
        // Check if any node actually got positioned
        const hasPositions = nodes.some(n => n.x !== 0 || n.y !== 0);
        if (!hasPositions) forceLayout(nodes, edges);
    } else {
        forceLayout(nodes, edges);
    }

    const canvas = mount.querySelector('#scholar-graph-canvas');
    initGraph(canvas, nodes, edges, collectionId, user);
}

// ── Force-directed layout ──

function forceLayout(nodes, edges, iterations = 150) {
    const R = Math.sqrt(nodes.length) * 80;
    nodes.forEach((n, i) => {
        const angle = (2 * Math.PI * i) / nodes.length;
        n.x = R * Math.cos(angle);
        n.y = R * Math.sin(angle);
    });

    const k = Math.sqrt((R * R * 4) / nodes.length);
    let temp = R / 5;

    for (let iter = 0; iter < iterations; iter++) {
        // Repulsion (all pairs)
        for (let i = 0; i < nodes.length; i++) {
            nodes[i].vx = 0;
            nodes[i].vy = 0;
            for (let j = 0; j < nodes.length; j++) {
                if (i === j) continue;
                let dx = nodes[i].x - nodes[j].x;
                let dy = nodes[i].y - nodes[j].y;
                let dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
                let force = (k * k) / dist;
                nodes[i].vx += (dx / dist) * force;
                nodes[i].vy += (dy / dist) * force;
            }
        }
        // Attraction (edges)
        for (const e of edges) {
            if (!e.from || !e.to) continue;
            let dx = e.to.x - e.from.x;
            let dy = e.to.y - e.from.y;
            let dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
            let force = (dist * dist) / k;
            let fx = (dx / dist) * force;
            let fy = (dy / dist) * force;
            e.from.vx += fx;
            e.from.vy += fy;
            e.to.vx -= fx;
            e.to.vy -= fy;
        }
        // Gravity toward center
        for (const n of nodes) {
            n.vx -= n.x * 0.01;
            n.vy -= n.y * 0.01;
        }
        // Apply with temperature clamping
        for (const n of nodes) {
            let disp = Math.sqrt(n.vx * n.vx + n.vy * n.vy) || 0.01;
            let scale = Math.min(disp, temp) / disp;
            n.x += n.vx * scale;
            n.y += n.vy * scale;
        }
        temp *= 0.95;
    }
}

// ── Graph engine ──

function initGraph(canvas, nodes, edges, collectionId, user) {
    const ctx = canvas.getContext('2d');

    // State
    let state = {
        panX: 0, panY: 0,
        zoom: 1.0,
        focused: null,       // node id or null
        hovered: null,       // node id or null
        dragging: false,
        wasDragging: false,
        dragStartX: 0, dragStartY: 0,
        dragPanX: 0, dragPanY: 0,
        width: 0, height: 0,
    };

    // Precompute connected sets for ego network
    const connectedTo = new Map();
    for (const n of nodes) connectedTo.set(n.id, new Set());
    for (const e of edges) {
        connectedTo.get(e.from.id).add(e.to.id);
        connectedTo.get(e.to.id).add(e.from.id);
    }

    function isConnected(nodeId, focusId) {
        if (nodeId === focusId) return true;
        const set = connectedTo.get(focusId);
        return set ? set.has(nodeId) : false;
    }

    // ── Resize ──
    function resize() {
        if (!canvas.isConnected) {
            window.removeEventListener('resize', resize);
            return;
        }
        const rect = canvas.parentElement.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        state.width = rect.width;
        state.height = rect.height;
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        canvas.style.width = rect.width + 'px';
        canvas.style.height = rect.height + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        draw();
    }

    // ── Hit test ──
    function hitTest(screenX, screenY) {
        const wx = (screenX - state.panX) / state.zoom;
        const wy = (screenY - state.panY) / state.zoom;
        for (let i = nodes.length - 1; i >= 0; i--) {
            const n = nodes[i];
            const r = nodeRadius(n);
            const dx = wx - n.x;
            const dy = wy - n.y;
            if (dx * dx + dy * dy <= r * r) return n;
        }
        return null;
    }

    function nodeRadius(n) {
        return 16 + Math.min(n.degree * 3, 12);
    }

    function nodeColor(n) {
        return LINEAGE_COLORS[n.lineage] || DEFAULT_NODE_COLOR;
    }

    function edgeColor(e) {
        return EDGE_COLORS[e.relationType] || DEFAULT_EDGE_COLOR;
    }

    // ── Drawing ──
    function draw() {
        const w = state.width;
        const h = state.height;
        ctx.clearRect(0, 0, w, h);

        ctx.save();
        ctx.translate(state.panX, state.panY);
        ctx.scale(state.zoom, state.zoom);

        // Draw edges
        for (const e of edges) {
            let alpha = 0.6;
            if (state.focused) {
                const relevant = isConnected(e.from.id, state.focused) || isConnected(e.to.id, state.focused);
                alpha = relevant ? 0.8 : 0.15;
            }

            const color = edgeColor(e);
            ctx.globalAlpha = alpha;
            ctx.beginPath();
            ctx.moveTo(e.from.x, e.from.y);
            ctx.lineTo(e.to.x, e.to.y);
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.5;
            ctx.stroke();

            // Arrowhead
            const toR = nodeRadius(e.to);
            const dx = e.to.x - e.from.x;
            const dy = e.to.y - e.from.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            const ux = dx / dist;
            const uy = dy / dist;
            const tipX = e.to.x - ux * toR;
            const tipY = e.to.y - uy * toR;
            const arrowLen = 8;
            const arrowW = 4;
            ctx.beginPath();
            ctx.moveTo(tipX, tipY);
            ctx.lineTo(tipX - ux * arrowLen + uy * arrowW, tipY - uy * arrowLen - ux * arrowW);
            ctx.lineTo(tipX - ux * arrowLen - uy * arrowW, tipY - uy * arrowLen + ux * arrowW);
            ctx.closePath();
            ctx.fillStyle = color;
            ctx.fill();

            ctx.globalAlpha = 1.0;
        }

        // Draw nodes
        for (const n of nodes) {
            const r = nodeRadius(n);
            const color = nodeColor(n);
            let nodeAlpha = 1.0;
            if (state.focused && !isConnected(n.id, state.focused)) {
                nodeAlpha = 0.15;
            }

            ctx.globalAlpha = nodeAlpha;

            // Circle
            ctx.beginPath();
            ctx.arc(n.x, n.y, r, 0, 2 * Math.PI);
            ctx.fillStyle = color;
            ctx.fill();
            ctx.strokeStyle = (n.id === state.hovered || n.id === state.focused) ? '#fff' : 'rgba(0,0,0,0.3)';
            ctx.lineWidth = (n.id === state.focused) ? 2.5 : 1.2;
            ctx.stroke();

            // Label below node
            if (state.zoom >= 0.5) {
                const fontSize = Math.round(11 * Math.min(Math.max(state.zoom, 0.7), 1.5));
                ctx.font = fontSize + 'px "Segoe UI", Arial, sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'top';
                ctx.fillStyle = '#ddd8d0';
                const label = n.label.length > 20 ? n.label.substring(0, 19) + '\u2026' : n.label;
                ctx.fillText(label, n.x, n.y + r + 4);
            }

            ctx.globalAlpha = 1.0;
        }

        ctx.restore();
    }

    // ── Interaction: mouse ──
    canvas.addEventListener('mousedown', e => {
        const hit = hitTest(e.offsetX, e.offsetY);
        if (!hit) {
            removeNodePopup();
            state.dragging = true;
            state.dragStartX = e.clientX;
            state.dragStartY = e.clientY;
            state.dragPanX = state.panX;
            state.dragPanY = state.panY;
            canvas.style.cursor = 'grabbing';
        }
    });

    canvas.addEventListener('mousemove', e => {
        if (state.dragging) {
            state.panX = state.dragPanX + (e.clientX - state.dragStartX);
            state.panY = state.dragPanY + (e.clientY - state.dragStartY);
            draw();
            return;
        }
        const hit = hitTest(e.offsetX, e.offsetY);
        const prev = state.hovered;
        state.hovered = hit ? hit.id : null;
        canvas.style.cursor = hit ? 'pointer' : 'grab';
        if (prev !== state.hovered) draw();
    });

    canvas.addEventListener('mouseup', e => {
        if (state.dragging) {
            const dx = e.clientX - state.dragStartX;
            const dy = e.clientY - state.dragStartY;
            if (dx * dx + dy * dy > 25) {
                state.wasDragging = true;
            }
        }
        state.dragging = false;
        canvas.style.cursor = 'grab';
    });

    canvas.addEventListener('mouseleave', () => {
        state.dragging = false;
        if (state.hovered) {
            state.hovered = null;
            draw();
        }
    });

    // ── Click: focus / popup ──
    canvas.addEventListener('click', e => {
        if (state.dragging) return;
        if (state.wasDragging) { state.wasDragging = false; return; }
        const hit = hitTest(e.offsetX, e.offsetY);
        if (hit) {
            state.focused = hit.id;
            draw();
            showNodePopup(hit);
        } else {
            state.focused = null;
            removeNodePopup();
            draw();
        }
    });

    // ── Wheel zoom ──
    canvas.addEventListener('wheel', e => {
        e.preventDefault();
        removeNodePopup();
        const factor = e.deltaY < 0 ? 1.1 : 0.9;
        const newZoom = Math.min(5.0, Math.max(0.1, state.zoom * factor));
        const mx = e.offsetX;
        const my = e.offsetY;
        state.panX = mx - (mx - state.panX) * (newZoom / state.zoom);
        state.panY = my - (my - state.panY) * (newZoom / state.zoom);
        state.zoom = newZoom;
        draw();
    }, { passive: false });

    // ── Touch support ──
    let lastTouchDist = 0;
    let lastTouchMid = null;
    let touchPanning = false;
    let touchStartTime = 0;
    let touchStartPos = { x: 0, y: 0 };
    let lastTapTime = 0;

    canvas.addEventListener('touchstart', e => {
        removeNodePopup();
        if (e.touches.length === 1) {
            touchPanning = true;
            state.dragStartX = e.touches[0].clientX;
            state.dragStartY = e.touches[0].clientY;
            state.dragPanX = state.panX;
            state.dragPanY = state.panY;
            touchStartTime = Date.now();
            touchStartPos = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        } else if (e.touches.length === 2) {
            touchPanning = false;
            lastTouchDist = touchDistance(e.touches);
            lastTouchMid = touchMidpoint(e.touches);
        }
        e.preventDefault();
    }, { passive: false });

    canvas.addEventListener('touchmove', e => {
        if (e.touches.length === 1 && touchPanning) {
            state.panX = state.dragPanX + (e.touches[0].clientX - state.dragStartX);
            state.panY = state.dragPanY + (e.touches[0].clientY - state.dragStartY);
            draw();
        } else if (e.touches.length === 2) {
            const dist = touchDistance(e.touches);
            const mid = touchMidpoint(e.touches);
            if (lastTouchDist > 0) {
                const factor = dist / lastTouchDist;
                const newZoom = Math.min(5.0, Math.max(0.1, state.zoom * factor));
                const rect = canvas.getBoundingClientRect();
                const mx = mid.x - rect.left;
                const my = mid.y - rect.top;
                state.panX = mx - (mx - state.panX) * (newZoom / state.zoom);
                state.panY = my - (my - state.panY) * (newZoom / state.zoom);
                state.zoom = newZoom;
            }
            if (lastTouchMid) {
                state.panX += mid.x - lastTouchMid.x;
                state.panY += mid.y - lastTouchMid.y;
            }
            lastTouchDist = dist;
            lastTouchMid = mid;
            draw();
        }
        e.preventDefault();
    }, { passive: false });

    canvas.addEventListener('touchend', e => {
        if (e.touches.length < 2) {
            lastTouchDist = 0;
            lastTouchMid = null;
        }
        if (e.touches.length === 0) {
            const elapsed = Date.now() - touchStartTime;
            const ct = e.changedTouches[0];
            const dx = ct.clientX - touchStartPos.x;
            const dy = ct.clientY - touchStartPos.y;
            if (elapsed < 300 && dx * dx + dy * dy < 100) {
                const rect = canvas.getBoundingClientRect();
                const sx = ct.clientX - rect.left;
                const sy = ct.clientY - rect.top;
                const hit = hitTest(sx, sy);
                if (hit) {
                    state.focused = hit.id;
                    draw();
                    showNodePopup(hit);
                } else {
                    state.focused = null;
                    removeNodePopup();
                    draw();
                }
            }
            touchPanning = false;
        }
    });

    // ── Zoom buttons ──
    const zoomBtns = canvas.parentElement.querySelectorAll('.lineage-zoom-btn');
    for (const btn of zoomBtns) {
        btn.addEventListener('click', () => {
            removeNodePopup();
            const dir = btn.dataset.dir;
            if (dir === 'reset') {
                state.zoom = 1.0;
                state.panX = 0;
                state.panY = 0;
                state.focused = null;
                autoFit();
            } else {
                const factor = dir === 'in' ? 1.3 : 0.7;
                state.zoom = Math.min(5.0, Math.max(0.1, state.zoom * factor));
            }
            draw();
        });
    }

    // ── Popup ──
    function showNodePopup(node) {
        removeNodePopup();
        const rect = canvas.getBoundingClientRect();
        const sx = node.x * state.zoom + state.panX + rect.left;
        const sy = node.y * state.zoom + state.panY + rect.top;

        const meta = [node.sourceRelPath, node.lineage].filter(Boolean).join(' \u00b7 ');
        const cid = collectionId;
        const pid = node.id;

        const popup = document.createElement('div');
        popup.className = 'lineage-popup';
        popup.style.left = sx + 'px';
        popup.style.top = (sy - 10) + 'px';
        popup.innerHTML =
            '<strong>' + escapeHtml(node.label || '') + '</strong>' +
            (meta ? '<br><span class="lineage-popup-meta">' + escapeHtml(meta) + '</span>' : '') +
            '<div class="lineage-popup-actions">' +
            '<a href="#/scholar/' + encodeURIComponent(cid) + '/' + encodeURIComponent(pid) + '/' + encodeURIComponent(user) + '">View Passage</a>' +
            '</div>';
        popup.querySelectorAll('a').forEach(a => a.addEventListener('click', () => removeNodePopup()));
        document.body.appendChild(popup);
    }

    function removeNodePopup() {
        document.querySelectorAll('.lineage-popup').forEach(el => el.remove());
    }

    // ── Escape key ──
    function onKeyDown(e) {
        if (e.key === 'Escape') {
            removeNodePopup();
            state.focused = null;
            draw();
        }
    }
    window.addEventListener('keydown', onKeyDown);

    // ── Clean up on route change ──
    const popupObserver = new MutationObserver(() => {
        if (!canvas.isConnected) {
            removeNodePopup();
            window.removeEventListener('keydown', onKeyDown);
            popupObserver.disconnect();
        }
    });
    popupObserver.observe(canvas.parentElement || document.body, { childList: true, subtree: true });

    // ── Auto-fit ──
    function autoFit() {
        if (nodes.length === 0) return;
        const bounds = graphBounds(nodes);
        if (!bounds) return;
        const pad = 60;
        const gw = bounds.maxX - bounds.minX + pad * 2;
        const gh = bounds.maxY - bounds.minY + pad * 2;
        const fitZoom = Math.min(state.width / gw, state.height / gh, 2.0);
        state.zoom = Math.max(0.15, fitZoom);
        const cx = (bounds.minX + bounds.maxX) / 2;
        const cy = (bounds.minY + bounds.maxY) / 2;
        state.panX = state.width / 2 - cx * state.zoom;
        state.panY = state.height / 2 - cy * state.zoom;
    }

    // ── Init ──
    window.addEventListener('resize', resize);
    resize();
    autoFit();
    draw();
}

// ── Helpers ──

function graphBounds(nodes) {
    if (nodes.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
        if (n.x < minX) minX = n.x;
        if (n.y < minY) minY = n.y;
        if (n.x > maxX) maxX = n.x;
        if (n.y > maxY) maxY = n.y;
    }
    return { minX, minY, maxX, maxY };
}

function touchDistance(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
}

function touchMidpoint(touches) {
    return {
        x: (touches[0].clientX + touches[1].clientX) / 2,
        y: (touches[0].clientY + touches[1].clientY) / 2,
    };
}

function normalizeName(s) {
    return String(s || '').trim().toLowerCase();
}
