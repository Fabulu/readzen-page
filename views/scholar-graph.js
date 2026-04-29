// views/scholar-graph.js
// Canvas-based force-directed graph showing passage relationships within
// a published scholar collection.
//
// Route: #/scholar/{collectionId}/graph/{user}
//
// Supports SchemaVersion 2 data (concepts, typed edges) with 5 node shapes,
// ego-on-hover highlighting, popup cards, and animated entry.

import { escapeHtml } from '../lib/format.js';
import { DATA_REPO_BASE } from '../lib/github.js';
import { streamJsonl } from '../lib/jsonl.js';
import * as cache from '../lib/cache.js';

// ── Node colors by type ──

const NODE_COLORS = ['#6EAFF8', '#FF8A65', '#64B5F6', '#81C784', '#AB47BC'];

// ── Edge colors by relation type ──

const EDGE_COLORS = {
    'quotes':        '#59B3FF',
    'alludes-to':    '#C854D9',
    'comments-on':   '#51D996',
    'contradicts':   '#FF6B6B',
    'parallels':     '#C854D9',
    'responds-to':   '#51D996',
    'is-variant-of': '#59B3FF',
    'translates':    '#59B3FF',
    'summarizes':    '#51D996',
    'evidences':     '#FF8A65',
    'refutes':       '#FF6B6B',
    'attributed-to': '#64B5F6',
    'uses-term':     '#81C784',
    'subsumes':      '#FF8A65',
    'opposes':       '#FF6B6B',
    'related-to':    '#FFB347',
    'taught-by':     '#64B5F6',
    'defined-by':    '#81C784',
    'teacher-of':    '#64B5F6',
    'same-school':   '#64B5F6',
    'cross-ref':     '#AB47BC',
};
const DEFAULT_EDGE_COLOR = '#888';

const NON_DIRECTIONAL_TYPES = new Set([
    'parallels', 'is-variant-of', 'opposes', 'related-to', 'same-school', 'cross-ref',
]);

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
        <div class="lineage-container lineage-container--scholar">
            <canvas class="lineage-canvas" id="scholar-graph-canvas"></canvas>
            <div class="lineage-controls">
                <div class="lineage-zoom-btns">
                    <button class="lineage-zoom-btn" data-dir="in" title="Zoom in">+</button>
                    <button class="lineage-zoom-btn" data-dir="out" title="Zoom out">&minus;</button>
                    <button class="lineage-zoom-btn" data-dir="reset" title="Reset view">&#8634;</button>
                </div>
                <div class="lineage-search" style="margin-top:8px">
                    <input type="text" class="lineage-search-input" placeholder="Search nodes..." id="scholar-graph-search"
                           style="width:100%;padding:4px 8px;font-size:11px;background:#2A2A32;border:1px solid #3A3A42;color:#fff;border-radius:4px" />
                </div>
                <label style="display:flex;align-items:center;gap:4px;margin-top:8px;font-size:11px;color:#B8B8C8;cursor:pointer">
                    <input type="checkbox" id="scholar-physics-toggle" checked />
                    Physics
                </label>
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

    // Schema v2 support
    const schemaVersion = collection.schemaVersion || collection.SchemaVersion || 1;
    const concepts = collection.concepts || collection.Concepts || [];
    const newEdges = collection.edges || collection.Edges || [];

    if (passages.length === 0 && concepts.length === 0) {
        mount.innerHTML = `<article class="panel lookup-card"><p>This collection has no passages to graph.</p></article>`;
        return;
    }

    // Build node map
    const nodeMap = new Map();

    // Passages → type 0
    for (const p of passages) {
        const pid = p.id || p.Id || '';
        if (!pid) continue;
        const relPath = p.sourceRelPath || p.SourceRelPath || '';
        const lineage = p.lineage || p.Lineage || '';
        const label = p.summary || p.Summary
            || (p.zhText || p.ZhText || '').slice(0, 30)
            || relPath?.split('/').pop()?.replace(/\.xml$/i, '')
            || pid;
        nodeMap.set(pid, {
            id: pid,
            type: 0,
            label: label,
            lineage: lineage,
            sourceRelPath: relPath,
            zhSnippet: p.zhSnippet || p.ZhSnippet || '',
            tags: p.tags || p.Tags || [],
            zhText: p.zhText || p.ZhText || '',
            enText: p.enText || p.EnText || '',
            summary: p.summary || p.Summary || '',
            notes: p.notes || p.Notes || '',
            masterNames: p.masterNames || p.MasterNames || [],
            readingStatus: (p.readingStatus || p.ReadingStatus || '').toLowerCase(),
            importance: parseInt(p.importance || p.Importance || '0', 10),
            doctrinalTopic: p.doctrinalTopic || p.DoctrinalTopic || '',
            literaryForm: p.literaryForm || p.LiteraryForm || '',
            fromLb: p.fromLb || p.FromLb || '',
            toLb: p.toLb || p.ToLb || '',
            x: 0, y: 0,
            vx: 0, vy: 0,
            degree: 0,
        });
    }

    // Concepts → type 1
    for (const c of concepts) {
        const cid = c.id || c.Id || '';
        if (!cid) continue;
        nodeMap.set(cid, {
            id: cid,
            type: 1,
            label: c.name || c.Name || '?',
            color: c.colorHex || c.ColorHex || '#FF8A65',
            description: c.description || c.Description || '',
            status: c.status || c.Status || 0,
            tags: c.tags || c.Tags || [],
            x: 0, y: 0,
            vx: 0, vy: 0,
            degree: 0,
        });
    }

    // Auto-create Master nodes from passage MasterNames
    for (const p of passages) {
        const masters = p.masterNames || p.MasterNames || [];
        for (const masterName of masters) {
            const masterId = 'master:' + masterName;
            if (nodeMap.has(masterId)) continue;
            nodeMap.set(masterId, {
                id: masterId,
                type: 2,
                label: masterName,
                x: 0, y: 0, vx: 0, vy: 0, degree: 0,
            });
        }
    }

    // Build edges
    const edges = [];

    if (schemaVersion >= 2 && newEdges.length > 0) {
        // Schema v2: use typed edges with fromNodeId/toNodeId
        for (const edge of newEdges) {
            const fromId = edge.fromNodeId || edge.FromNodeId || '';
            const toId = edge.toNodeId || edge.ToNodeId || '';
            const relType = edge.relationType || edge.RelationType || '';
            const fromNode = nodeMap.get(fromId);
            const toNode = nodeMap.get(toId);
            if (fromNode && toNode) {
                fromNode.degree++;
                toNode.degree++;
                edges.push({ from: fromNode, to: toNode, relationType: relType });
            }
        }
    } else {
        // Schema v1 fallback: use links (old format)
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
    canvas.style.touchAction = 'none';
    initGraph(canvas, nodes, edges, collectionId, user, graphLayout);
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
        let maxDisp = 0;

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
            if (disp * scale > maxDisp) maxDisp = disp * scale;
        }
        temp *= 0.95;

        // Early exit if layout has converged
        if (maxDisp < 0.5) break;
    }
}

// ── Continuous subtle physics tick ──

function runPhysicsTick(nodes, edges) {
    const N = nodes.length;
    if (N <= 1 || N > 300) return false;

    const R = Math.sqrt(N) * 80;
    const k = Math.sqrt((R * R * 4) / N);
    const alpha = 0.015;   // halved vs desktop 0.03 to compensate for ~60fps

    // Center of mass
    let cx = 0, cy = 0;
    for (const n of nodes) { cx += n.x; cy += n.y; }
    cx /= N; cy /= N;

    // Reset velocities
    for (const n of nodes) { n.vx *= 0.92; n.vy *= 0.92; }

    // Repulsion (all pairs)
    for (let i = 0; i < N; i++) {
        if (nodes[i].pinned) continue;
        for (let j = 0; j < N; j++) {
            if (i === j) continue;
            let dx = nodes[i].x - nodes[j].x;
            let dy = nodes[i].y - nodes[j].y;
            let dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
            let force = (k * k) / dist * alpha;
            nodes[i].vx += (dx / dist) * force;
            nodes[i].vy += (dy / dist) * force;
        }
    }

    // Gravity toward center of mass
    for (const n of nodes) {
        if (n.pinned) continue;
        n.vx -= (n.x - cx) * 0.008;
        n.vy -= (n.y - cy) * 0.008;
    }

    // Edge attraction (keeps connected nodes loosely together)
    for (const e of edges) {
        if (!e.from || !e.to) continue;
        if (e.from.pinned && e.to.pinned) continue;
        let dx = e.to.x - e.from.x;
        let dy = e.to.y - e.from.y;
        let dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
        let attract = dist * 0.002;
        if (!e.from.pinned) {
            e.from.vx += (dx / dist) * attract;
            e.from.vy += (dy / dist) * attract;
        }
        if (!e.to.pinned) {
            e.to.vx -= (dx / dist) * attract;
            e.to.vy -= (dy / dist) * attract;
        }
    }

    // Apply with damping and max displacement clamp
    let moved = false;
    for (const n of nodes) {
        if (n.pinned) continue;
        // (damping already applied at top of tick)
        let disp = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
        if (disp > 0.8) {
            n.vx = n.vx / disp * 0.8;
            n.vy = n.vy / disp * 0.8;
        }
        if (disp > 0.01) {
            n.x += n.vx;
            n.y += n.vy;
            n.x = Math.max(-2000, Math.min(2000, n.x));
            n.y = Math.max(-2000, Math.min(2000, n.y));
            moved = true;
        }
    }
    return moved;
}

// ── Node shape rendering ──

function drawNodeShape(ctx, node, x, y, r, color, alpha, strokeStyle, lineWidth) {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    const type = node.type || 0;

    if (type === 1) {
        // Concept: Diamond
        ctx.beginPath();
        ctx.moveTo(x, y - r);
        ctx.lineTo(x + r, y);
        ctx.lineTo(x, y + r);
        ctx.lineTo(x - r, y);
        ctx.closePath();
        ctx.fill();
        if (strokeStyle) { ctx.strokeStyle = strokeStyle; ctx.lineWidth = lineWidth; ctx.stroke(); }
    } else if (type === 2) {
        // Master: Hexagon
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
            const angle = Math.PI / 3 * i - Math.PI / 2; // pointy-top
            const px = x + r * Math.cos(angle);
            const py = y + r * Math.sin(angle);
            if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();
        if (strokeStyle) { ctx.strokeStyle = strokeStyle; ctx.lineWidth = lineWidth; ctx.stroke(); }
    } else if (type === 3 || type === 4) {
        // Term/Collection: Rounded rect
        const w = r * 2, h = r * 1.4;
        const rx = x - r, ry = y - h / 2;
        const cr = r * 0.2;
        ctx.beginPath();
        ctx.moveTo(rx + cr, ry);
        ctx.lineTo(rx + w - cr, ry);
        ctx.arcTo(rx + w, ry, rx + w, ry + cr, cr);
        ctx.lineTo(rx + w, ry + h - cr);
        ctx.arcTo(rx + w, ry + h, rx + w - cr, ry + h, cr);
        ctx.lineTo(rx + cr, ry + h);
        ctx.arcTo(rx, ry + h, rx, ry + h - cr, cr);
        ctx.lineTo(rx, ry + cr);
        ctx.arcTo(rx, ry, rx + cr, ry, cr);
        ctx.closePath();
        ctx.fill();
        if (strokeStyle) { ctx.strokeStyle = strokeStyle; ctx.lineWidth = lineWidth; ctx.stroke(); }
    } else {
        // Passage: Circle (default, type 0)
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        if (strokeStyle) { ctx.strokeStyle = strokeStyle; ctx.lineWidth = lineWidth; ctx.stroke(); }
    }
    ctx.globalAlpha = 1;
}

function nodeRadius(n) {
    const base = [10, 12, 14, 12, 14][n.type || 0];
    const scale = [2, 2, 1.5, 1.5, 2][n.type || 0];
    const cap = [12, 14, 10, 10, 12][n.type || 0];
    return base + Math.min(n.degree * scale, cap);
}

function nodeColor(n) {
    if (n.type === 1 && n.status === 1) return '#666'; // deprecated = dim gray
    if (n.type === 1 && n.color) return n.color; // Concept uses custom color
    return NODE_COLORS[n.type || 0];
}

function edgeColor(e) {
    return EDGE_COLORS[e.relationType] || DEFAULT_EDGE_COLOR;
}

// ── Graph engine ──

function initGraph(canvas, nodes, edges, collectionId, user, savedLayout) {
    const ctx = canvas.getContext('2d');

    // Declare easing helper before first use (used in draw())
    function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

    // Animated entry: nodes start at scale 0 and grow in
    let entryProgress = 0;
    const ENTRY_DURATION = 400; // ms
    let entryStart = performance.now();

    // State
    // Restore saved viewport if available
    const savedZoom = savedLayout ? (savedLayout.Zoom || savedLayout.zoom || 0) : 0;
    const savedPanX = savedLayout ? (savedLayout.OffsetX || savedLayout.offsetX || 0) : 0;
    const savedPanY = savedLayout ? (savedLayout.OffsetY || savedLayout.offsetY || 0) : 0;
    const hasSavedViewport = savedZoom > 0.01;

    let state = {
        panX: hasSavedViewport ? savedPanX : 0,
        panY: hasSavedViewport ? savedPanY : 0,
        zoom: hasSavedViewport ? savedZoom : 1.0,
        focused: null,       // node id or null
        hovered: null,       // node id or null
        egoHover: null,      // node id for ego highlight on hover
        dragging: false,
        wasDragging: false,
        dragStartX: 0, dragStartY: 0,
        dragPanX: 0, dragPanY: 0,
        width: 0, height: 0,
        highlightedIds: new Set(),
        physicsEnabled: true,
        physicsRAF: null,
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
        if (!document.body.contains(canvas)) {
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

    // ── Drawing ──
    function draw() {
        const w = state.width;
        const h = state.height;

        // Save transform, reset to identity for clearing (high-DPI safe)
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = '#1E1E23';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.restore();

        // Compute entry animation scale
        const elapsed = performance.now() - entryStart;
        entryProgress = Math.min(elapsed / ENTRY_DURATION, 1.0);
        const entryScale = easeOutCubic(entryProgress);

        // Subtle physics (only after entry animation finishes)
        if (entryProgress >= 1.0 && state.physicsEnabled && !state.dragging) {
            runPhysicsTick(nodes, edges);
        }

        // Compute ego set (from focus or hover)
        const egoId = state.focused || state.egoHover;
        let connectedSet = null;
        if (egoId) {
            connectedSet = new Set([egoId]);
            for (const e of edges) {
                if (e.from.id === egoId) connectedSet.add(e.to.id);
                if (e.to.id === egoId) connectedSet.add(e.from.id);
            }
        }

        ctx.save();
        ctx.translate(state.panX, state.panY);
        ctx.scale(state.zoom, state.zoom);

        // Draw edges
        for (const e of edges) {
            // Skip degenerate edges (endpoints at same position)
            const edx = e.to.x - e.from.x;
            const edy = e.to.y - e.from.y;
            const elen = Math.sqrt(edx * edx + edy * edy);
            if (elen < 0.5) continue;

            // Ego highlight: only edges directly connected to the ego node
            const egoNodeId = state.focused || state.egoHover;
            const edgeRelevant = egoNodeId && (e.from.id === egoNodeId || e.to.id === egoNodeId);
            let alpha = egoNodeId ? (edgeRelevant ? 0.8 : 0.35) : 0.6;

            const color = edgeColor(e);
            const isNonDirectional = NON_DIRECTIONAL_TYPES.has(e.relationType);
            ctx.globalAlpha = alpha * entryScale;
            ctx.beginPath();
            if (isNonDirectional) {
                ctx.setLineDash([6, 4]);
            }
            ctx.moveTo(e.from.x, e.from.y);
            ctx.lineTo(e.to.x, e.to.y);
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.5;
            ctx.stroke();
            if (isNonDirectional) {
                ctx.setLineDash([]);
            }

            // Arrowhead (only for directional edges)
            if (!isNonDirectional) {
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
            }

            // Edge type labels for ego-relevant edges
            if (egoNodeId && edgeRelevant && state.zoom >= 0.7) {
                const midX = (e.from.x + e.to.x) / 2;
                const midY = (e.from.y + e.to.y) / 2;
                ctx.font = '9px sans-serif';
                ctx.fillStyle = color;
                ctx.globalAlpha = 0.8;
                ctx.textAlign = 'center';
                ctx.fillText(e.relationType, midX, midY - 4);
                ctx.textAlign = 'start';
            }

            ctx.globalAlpha = 1.0;
        }

        // Draw nodes
        for (const n of nodes) {
            const r = nodeRadius(n) * entryScale;
            const color = nodeColor(n);
            let nodeAlpha = connectedSet && !connectedSet.has(n.id) ? 0.35 : 1.0;

            // Drop shadow (skip for dimmed nodes; skip on very small radii)
            if (nodeAlpha > 0.5 && r > 3) {
                drawNodeShape(ctx, n, n.x + 2.5, n.y + 2.5, r + 1, 'rgba(0,0,0,0.15)', nodeAlpha * entryScale, null, 0);
                drawNodeShape(ctx, n, n.x + 1.5, n.y + 1.5, r + 0.5, 'rgba(0,0,0,0.25)', nodeAlpha * entryScale, null, 0);
            }

            // Draw shape with integrated stroke
            const isHighlighted = state.highlightedIds && state.highlightedIds.has(n.id);
            const strokeColor = (n.id === state.hovered || n.id === state.focused)
                ? '#FFD700'
                : isHighlighted
                    ? '#00E5FF'
                    : 'rgba(255,255,255,0.6)';
            const strokeWidth = (n.id === state.focused) ? 2.5 : isHighlighted ? 2.5 : 1.2;
            drawNodeShape(ctx, n, n.x, n.y, r, color, nodeAlpha * entryScale, strokeColor, strokeWidth);

            // Label below node
            if (state.zoom >= 0.5 && entryScale > 0.3) {
                const fontSize = Math.max(10, Math.round(13 * state.zoom));
                ctx.font = fontSize + 'px "Segoe UI", Arial, sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'top';
                ctx.globalAlpha = nodeAlpha * entryScale;
                // Measure and truncate by pixel width (handles CJK vs Latin correctly)
                const maxLabelWidth = Math.max(40, nodeRadius(n) * 4);
                let label = n.label || '';
                if (ctx.measureText(label).width > maxLabelWidth) {
                    let lo = 0, hi = label.length;
                    while (lo < hi) {
                        const mid = (lo + hi + 1) >> 1;
                        if (ctx.measureText(label.slice(0, mid) + '\u2026').width <= maxLabelWidth) {
                            lo = mid;
                        } else {
                            hi = mid - 1;
                        }
                    }
                    label = label.slice(0, lo) + '\u2026';
                }
                const labelOffset = [4, 6, 5, 8, 8][n.type || 0];

                // Text shadow for readability
                ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
                ctx.lineWidth = 3;
                ctx.lineJoin = 'round';
                ctx.strokeText(label, n.x, n.y + r + labelOffset);

                ctx.fillStyle = '#ffffff';
                ctx.fillText(label, n.x, n.y + r + labelOffset);
            }

            ctx.globalAlpha = 1.0;
        }

        ctx.restore();

        // Continue animation or physics
        if (entryProgress < 1.0 || state.physicsEnabled) {
            state.physicsRAF = requestAnimationFrame(draw);
        } else {
            state.physicsRAF = null;
        }
    }

    // ── Interaction: mouse ──
    canvas.addEventListener('mousedown', e => {
        const hit = hitTest(e.offsetX, e.offsetY);
        if (!hit) {
            removeNodeCard();
            state.focused = null;
            draw();
            state.dragging = true;
            state.dragStartX = e.clientX;
            state.dragStartY = e.clientY;
            state.dragPanX = state.panX;
            state.dragPanY = state.panY;
            canvas.style.cursor = 'grabbing';
        }
    });

    let hoverThrottleTimer = null;
    canvas.addEventListener('mousemove', e => {
        if (state.dragging) {
            state.panX = state.dragPanX + (e.clientX - state.dragStartX);
            state.panY = state.dragPanY + (e.clientY - state.dragStartY);
            draw();
            return;
        }

        // Throttle hover detection
        if (hoverThrottleTimer) return;
        hoverThrottleTimer = setTimeout(() => { hoverThrottleTimer = null; }, 16);

        const hit = hitTest(e.offsetX, e.offsetY);
        const prev = state.hovered;
        state.hovered = hit ? hit.id : null;
        state.egoHover = hit ? hit.id : null;
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
        if (state.hovered || state.egoHover) {
            state.hovered = null;
            state.egoHover = null;
            draw();
        }
    });

    // ── Click: focus / popup card ──
    canvas.addEventListener('click', e => {
        if (state.dragging) return;
        if (state.wasDragging) { state.wasDragging = false; return; }
        const hit = hitTest(e.offsetX, e.offsetY);
        if (hit) {
            state.focused = hit.id;
            draw();
            showNodeCard(hit);
        } else {
            state.focused = null;
            removeNodeCard();
            draw();
        }
    });

    // ── Wheel zoom ──
    canvas.addEventListener('wheel', e => {
        e.preventDefault();
        removeNodeCard();
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

    canvas.addEventListener('touchstart', e => {
        removeNodeCard();
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
                    showNodeCard(hit);
                } else {
                    state.focused = null;
                    removeNodeCard();
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
            removeNodeCard();
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

    // ── Search highlighting ──
    const searchInput = canvas.parentElement.querySelector('#scholar-graph-search');
    if (searchInput) {
        searchInput.addEventListener('input', () => {
            const query = searchInput.value.trim().toLowerCase();
            state.highlightedIds.clear();
            if (query.length >= 2) {
                for (const n of nodes) {
                    if ((n.label || '').toLowerCase().includes(query)) {
                        state.highlightedIds.add(n.id);
                    }
                }
            }
            draw();
        });
    }

    // ── Physics toggle ──
    const physicsToggle = canvas.parentElement.querySelector('#scholar-physics-toggle');
    if (physicsToggle) {
        physicsToggle.addEventListener('change', () => {
            state.physicsEnabled = physicsToggle.checked;
            if (state.physicsEnabled && !state.physicsRAF) {
                state.physicsRAF = requestAnimationFrame(draw);
            }
        });
    }

    // ── Popup Card ──
    function showNodeCard(node) {
        removeNodeCard();
        const backdrop = document.createElement('div');
        backdrop.className = 'graph-card-backdrop';
        backdrop.style.background = 'rgba(0, 0, 0, 0.3)';
        backdrop.onclick = removeNodeCard;

        const card = document.createElement('div');
        card.className = 'graph-card';

        const typeNames = ['Passage', 'Concept', 'Master', 'Term', 'Collection'];
        const typeName = typeNames[node.type || 0];

        let content = `<button class="graph-card-close">\u2715</button>`;
        content += `<div class="graph-card-type">${typeName}</div>`;
        content += `<div class="graph-card-title">${escapeHtml(node.label)}</div>`;

        // Type-specific content
        if (node.type === 0) {
            // Passage: summary highlight
            if (node.summary) {
                content += `<div class="graph-card-snippet" style="border-left:2px solid var(--accent);padding-left:0.6rem">${escapeHtml(node.summary)}</div>`;
            }
            // Chinese text
            if (node.zhText) {
                content += `<div style="font-size:0.82rem;color:var(--text-soft);margin-bottom:0.4rem">${escapeHtml(node.zhText.slice(0, 120))}${node.zhText.length > 120 ? '\u2026' : ''}</div>`;
            }
            // English text
            if (node.enText) {
                content += `<div style="font-size:0.8rem;opacity:0.8;margin-bottom:0.4rem">${escapeHtml(node.enText.slice(0, 120))}${node.enText.length > 120 ? '\u2026' : ''}</div>`;
            }
            // Tags
            if (node.tags && node.tags.length) {
                content += `<div class="graph-card-tags">${node.tags.slice(0, 4).map(t => `<span class="graph-card-tag">${escapeHtml(t)}</span>`).join('')}</div>`;
            }
            // Masters
            if (node.masterNames && node.masterNames.length) {
                content += `<div style="font-size:0.78rem;color:var(--muted);margin-top:0.3rem">Masters: ${escapeHtml(node.masterNames.join(', '))}</div>`;
            }
            // Reading status + importance
            if (node.readingStatus || node.importance > 0) {
                let meta = '';
                if (node.readingStatus) meta += node.readingStatus;
                if (node.importance > 0) meta += (meta ? ' \u00b7 ' : '') + '\u2605'.repeat(node.importance);
                content += `<div style="font-size:0.75rem;color:var(--muted);margin-top:0.2rem">${escapeHtml(meta)}</div>`;
            }
        } else if (node.type === 1) {
            // Concept
            if (node.description) content += `<div class="graph-card-snippet">${escapeHtml(node.description.slice(0, 150))}</div>`;
            if (node.tags && node.tags.length) {
                content += `<div class="graph-card-tags">${node.tags.slice(0, 4).map(t => `<span class="graph-card-tag">${escapeHtml(t)}</span>`).join('')}</div>`;
            }
        } else if (node.type === 2) {
            // Master
            if (node.dates) content += `<div class="graph-card-snippet">${escapeHtml(node.dates)}</div>`;
        } else if (node.type === 3) {
            // Term node
            content += `<div class="graph-card-snippet" style="font-size:1.1rem;font-weight:600">${escapeHtml(node.label)}</div>`;
            content += `<div style="font-size:0.8rem;color:var(--muted);margin-top:0.3rem">Termbase Entry</div>`;
            if (node.definition) {
                content += `<div style="font-size:0.85rem;margin-top:0.4rem">${escapeHtml(node.definition)}</div>`;
            }
            // Count edges to/from this term
            const termEdges = edges.filter(e => e.from.id === node.id || e.to.id === node.id);
            if (termEdges.length > 0) {
                content += `<div style="font-size:0.78rem;color:var(--muted);margin-top:0.3rem">Used in ${termEdges.length} connection${termEdges.length !== 1 ? 's' : ''}</div>`;
            }
        } else if (node.type === 4) {
            // Collection node
            content += `<div style="font-size:0.85rem;color:var(--muted)">Collection Reference</div>`;
            if (node.description) {
                content += `<div class="graph-card-snippet">${escapeHtml(node.description.slice(0, 100))}</div>`;
            }
            if (node.ownerUser) {
                content += `<div style="font-size:0.78rem;color:var(--muted);margin-top:0.3rem">by ${escapeHtml(node.ownerUser)}</div>`;
            }
            const collEdges = edges.filter(e => e.from.id === node.id || e.to.id === node.id);
            if (collEdges.length > 0) {
                content += `<div style="font-size:0.78rem;color:var(--muted);margin-top:0.3rem">${collEdges.length} connection${collEdges.length !== 1 ? 's' : ''}</div>`;
            }
        }

        // Connected edges summary
        const nodeEdges = edges.filter(e => e.from.id === node.id || e.to.id === node.id);
        if (nodeEdges.length > 0) {
            content += `<div style="font-size:0.78rem;border-top:1px solid rgba(255,255,255,0.1);padding-top:0.4rem;margin-top:0.4rem">`;
            content += `<div style="color:var(--muted);margin-bottom:0.2rem">${nodeEdges.length} connection${nodeEdges.length !== 1 ? 's' : ''}</div>`;
            const shown = nodeEdges.slice(0, 5);
            for (const e of shown) {
                const other = e.from.id === node.id ? e.to : e.from;
                const dir = e.from.id === node.id ? '\u2192' : '\u2190';
                content += `<div style="font-size:0.75rem;color:var(--text-soft)">${dir} ${escapeHtml(other.label)} <span style="color:${edgeColor(e)}">(${escapeHtml(e.relationType)})</span></div>`;
            }
            if (nodeEdges.length > 5) {
                content += `<div style="font-size:0.72rem;color:var(--muted)">+${nodeEdges.length - 5} more</div>`;
            }
            content += `</div>`;
        }

        // Footer with links
        content += `<div class="graph-card-footer">`;
        if (node.type === 0) {
            const workId = (node.sourceRelPath || '').split('/').pop()?.replace(/\.xml$/i, '') || '';
            if (workId && node.fromLb) {
                const range = node.toLb && node.toLb !== node.fromLb
                    ? `${node.fromLb}-${node.toLb}`
                    : node.fromLb;
                content += `<a href="#/${encodeURIComponent(workId)}/${encodeURIComponent(range)}">Open in Reader \u2192</a>`;
            }
            content += `<a href="#/scholar/${encodeURIComponent(collectionId)}/${encodeURIComponent(node.id)}/${encodeURIComponent(user)}">View in Collection \u2192</a>`;
        } else if (node.type === 1) {
            content += `<a href="#/scholar/${encodeURIComponent(collectionId)}//${encodeURIComponent(user)}">View Collection \u2192</a>`;
        } else if (node.type === 2) {
            const masterName = node.id.startsWith('master:') ? node.id.slice(7) : node.label;
            content += `<a href="#/master/${encodeURIComponent(masterName)}">Master Profile \u2192</a>`;
        } else if (node.type === 3) {
            // Term — link to dictionary if we have the source term
            const term = node.label;
            content += `<a href="#/dict/${encodeURIComponent(term)}">View in Dictionary \u2192</a>`;
        } else if (node.type === 4) {
            // Collection — link to browse it
            const collId = node.id.startsWith('collection:') ? node.id.slice(11) : node.id;
            if (node.ownerUser) {
                content += `<a href="#/scholar/${encodeURIComponent(collId)}//${encodeURIComponent(node.ownerUser)}">Browse Collection \u2192</a>`;
            }
        }
        content += `</div>`;

        card.innerHTML = content;

        // Position near clicked node, not viewport center
        const rect = canvas.getBoundingClientRect();
        const sx = node.x * state.zoom + state.panX + rect.left;
        const sy = node.y * state.zoom + state.panY + rect.top;

        let cardX = sx + 30;
        let cardY = sy - 50;

        const cardW = 380;
        const cardH = 350;
        if (cardX + cardW > window.innerWidth) cardX = sx - cardW - 30;
        if (cardY < 10) cardY = 10;
        if (cardY + cardH > window.innerHeight) cardY = window.innerHeight - cardH - 10;
        cardX = Math.max(10, cardX);

        card.style.position = 'fixed';
        card.style.left = cardX + 'px';
        card.style.top = cardY + 'px';
        card.style.transform = 'none';

        document.body.appendChild(backdrop);
        document.body.appendChild(card);

        const closeBtn = card.querySelector('.graph-card-close');
        closeBtn.addEventListener('click', () => {
            state.focused = null;
            removeNodeCard();
            draw();
        });
    }

    function removeNodeCard() {
        document.querySelector('.graph-card-backdrop')?.remove();
        document.querySelector('.graph-card')?.remove();
    }

    // ── Escape key ──
    function onKeyDown(e) {
        if (e.key === 'Escape') {
        if (!document.body.contains(canvas)) { window.removeEventListener("keydown", onKeyDown); return; }
            removeNodeCard();
            state.focused = null;
            draw();
        }
    }
    window.addEventListener('keydown', onKeyDown);

    // ── Clean up on route change ──
    const popupObserver = new MutationObserver(() => {
        if (!document.body.contains(canvas)) {
            removeNodeCard();
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
    if (!hasSavedViewport) autoFit();  // Only auto-fit if no saved zoom/pan
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
    if (!touches || touches.length < 2) return 0;
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
