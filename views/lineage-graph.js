// views/lineage-graph.js
// Full-viewport Canvas lineage web of Zen masters.
// Route: #/lineage  or  #/lineage?focus=Linji_Yixuan
//
// Layout: Sugiyama-lite with temporal Y positioning (death year).
// Port of the desktop ReadZen LineageWebView algorithm.

import { loadMasters } from './master.js';
import { escapeHtml } from '../lib/format.js';

// ── School colors ──

const SCHOOL_COLORS = {
    'Linji':      { fill: '#8c2a2a', stroke: '#b84040', text: '#f0d0c8' },
    'Caodong':    { fill: '#2a4a8c', stroke: '#4070b8', text: '#c8d8f0' },
    'Yunmen':     { fill: '#5c2a8c', stroke: '#8040b8', text: '#dcc8f0' },
    'Fayan':      { fill: '#1a6858', stroke: '#309880', text: '#b0e8d8' },
    'Guiyang':    { fill: '#7a6020', stroke: '#b09030', text: '#f0e0a0' },
    'Hongzhou':   { fill: '#8c5020', stroke: '#c07830', text: '#f0d0a0' },
    'Niutou':     { fill: '#2a6a2a', stroke: '#40a040', text: '#c0e8c0' },
    'Early Chan': { fill: '#6a5a3a', stroke: '#9a8860', text: '#e0d8c0' },
    'Chan':       { fill: '#4a4540', stroke: '#6a6560', text: '#d8d4cc' },
    'Korean Seon': { fill: '#1a7a6a', stroke: '#30a898', text: '#b8e8dc' },
    'Early Korean Buddhism': { fill: '#3a6858', stroke: '#508878', text: '#c0d8c8' },
};
const DEFAULT_COLOR = { fill: '#3a3530', stroke: '#5a5550', text: '#ddd8d0' };

// ── Layout constants ──

const NODE_W = 130;
const NODE_H = 38;
const LAYER_GAP_X = 160;
const MIN_GAP_Y = 44;
const PX_PER_YEAR = 3;
const ORPHAN_COLS = 8;
const ORPHAN_GAP_X = 150;
const ORPHAN_GAP_Y = 54;

// ── Route matching ──

export function match(route) {
    return route && route.kind === 'lineage';
}

export function preferAppFirst() { return false; }

// ── Main render ──

export async function render(route, mount, shell) {
    if (shell) {
        shell.setTitle('Lineage Web');
        shell.setContext('Chan/Zen lineage web', 'Interactive graph of teacher-student relationships');
        shell.setUpsell(
            'Read Zen is a free desktop app for Chinese Zen literature with an interactive ' +
            'lineage web, full-corpus search, and side-by-side translation. ' +
            '<a href="https://github.com/Fabulu/ReadZen/releases">Download free</a> · ' +
            '<a href="https://ko-fi.com/readzen">Support on Ko-fi</a>'
        );
        shell.hideStatus();
    }

    mount.innerHTML = `
        <div class="lineage-container">
            <canvas class="lineage-canvas" id="lineage-canvas"></canvas>
            <div class="lineage-controls">
                <input type="text" class="lineage-search" placeholder="Search master..." aria-label="Search master" />
                <div class="lineage-zoom-btns">
                    <button class="lineage-zoom-btn" data-dir="in" title="Zoom in">+</button>
                    <button class="lineage-zoom-btn" data-dir="out" title="Zoom out">&minus;</button>
                    <button class="lineage-zoom-btn" data-dir="reset" title="Reset view">&#8634;</button>
                </div>
            </div>
            <div class="lineage-legend" id="lineage-legend"></div>
            <a href="#/masters" class="lineage-browse-link">&larr; Browse Masters</a>
        </div>
    `;

    let masters;
    try {
        masters = await loadMasters();
    } catch (error) {
        mount.innerHTML = `<article class="panel lookup-card"><p>Failed to load masters: ${escapeHtml(String(error.message || error))}</p></article>`;
        return;
    }

    const canvas = mount.querySelector('#lineage-canvas');
    const legend = mount.querySelector('#lineage-legend');
    const searchInput = mount.querySelector('.lineage-search');

    initGraph(canvas, legend, searchInput, masters, route.focus || '');
}

// ── Graph engine ──

export function initGraph(canvas, legendEl, searchInput, masters, focusName) {
    const ctx = canvas.getContext('2d');
    const nodes = buildNodes(masters);
    const edges = buildEdges(nodes);
    layoutNodes(nodes, edges);

    // Build legend
    const usedSchools = [...new Set(nodes.map(n => n.school).filter(Boolean))].sort();
    legendEl.innerHTML = usedSchools.map(s => {
        const c = SCHOOL_COLORS[s] || DEFAULT_COLOR;
        return `<span class="lineage-legend-item"><span class="lineage-legend-swatch" style="background:${c.fill};border-color:${c.stroke}"></span>${escapeHtml(s)}</span>`;
    }).join('');

    // Attestation tier legend (compact)
    legendEl.innerHTML += '<div class="lineage-legend-att">' +
        '<span class="ll-att"><span class="ll-line" style="border-top:2px solid #888"></span>verified</span>' +
        '<span class="ll-att"><span class="ll-line" style="border-top:2px dashed #888"></span>stele</span>' +
        '<span class="ll-att"><span class="ll-line" style="border-top:2px dotted #888"></span>textual</span>' +
        '<span class="ll-att"><span class="ll-line" style="border-top:1px dotted #555"></span>retro.</span>' +
        '</div>';

    // State
    let state = {
        panX: 0, panY: 0,
        zoom: 0.7,
        focused: null,       // node key or null
        hovered: null,       // node key or null
        dragging: false,
        wasDragging: false,
        dragStartX: 0, dragStartY: 0,
        dragPanX: 0, dragPanY: 0,
        width: 0, height: 0,
    };

    // Focus from route
    if (focusName) {
        const focusNode = nodes.find(n =>
            n.names.some(nm => nm.toLowerCase() === focusName.toLowerCase() ||
                nm.replace(/ /g, '_').toLowerCase() === focusName.replace(/ /g, '_').toLowerCase())
        );
        if (focusNode) {
            state.focused = focusNode.key;
            // Center on the focused node after first resize
            setTimeout(() => {
                state.panX = state.width / 2 - focusNode.x * state.zoom;
                state.panY = state.height / 2 - focusNode.y * state.zoom;
                draw();
            }, 50);
        }
    }

    // ── Resize ──
    function resize() {
        // Bug 1 fix: auto-remove listener when canvas is detached (route change)
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
        // Iterate backwards so top-rendered nodes are hit first
        for (let i = nodes.length - 1; i >= 0; i--) {
            const n = nodes[i];
            if (wx >= n.x - NODE_W / 2 && wx <= n.x + NODE_W / 2 &&
                wy >= n.y - NODE_H / 2 && wy <= n.y + NODE_H / 2) {
                return n;
            }
        }
        return null;
    }

    // ── Drawing ──
    function draw() {
        const w = state.width;
        const h = state.height;
        ctx.clearRect(0, 0, w, h);

        ctx.save();
        ctx.translate(state.panX, state.panY);
        ctx.scale(state.zoom, state.zoom);

        // Viewport bounds in world coords for culling
        const vx0 = -state.panX / state.zoom;
        const vy0 = -state.panY / state.zoom;
        const vx1 = (w - state.panX) / state.zoom;
        const vy1 = (h - state.panY) / state.zoom;
        const margin = NODE_W; // extra margin for edges

        // Edges
        for (const e of edges) {
            const from = e.from;
            const to = e.to;
            // Cull edges where both endpoints are off-screen
            if ((from.x + NODE_W / 2 < vx0 - margin && to.x + NODE_W / 2 < vx0 - margin) ||
                (from.x - NODE_W / 2 > vx1 + margin && to.x - NODE_W / 2 > vx1 + margin) ||
                (from.y + NODE_H / 2 < vy0 - margin && to.y + NODE_H / 2 < vy0 - margin) ||
                (from.y - NODE_H / 2 > vy1 + margin && to.y - NODE_H / 2 > vy1 + margin)) {
                continue;
            }

            let alpha = 0.35;
            const hits = state.searchHits;
            if (state.focused) {
                const relevant = (hits ? hits.has(e.from.key) || hits.has(e.to.key) : false) ||
                    e.from.key === state.focused || e.to.key === state.focused ||
                    isLineageOf(e.from.key, state.focused, edges) ||
                    isLineageOf(e.to.key, state.focused, edges);
                alpha = relevant ? 0.6 : 0.06;
            }

            // Attestation-based edge style
            const att = e.to.attestation || '';
            if (att === 'D') { ctx.setLineDash([2, 4]); ctx.globalAlpha = alpha * 0.5; }
            else if (att === 'C') { ctx.setLineDash([3, 3]); }
            else if (att === 'B') { ctx.setLineDash([6, 3]); }
            else { ctx.setLineDash([]); }

            ctx.beginPath();
            ctx.moveTo(from.x + NODE_W / 2, from.y);
            ctx.lineTo(to.x - NODE_W / 2, to.y);
            ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
            ctx.lineWidth = 1.2;
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.globalAlpha = 1.0; // reset
        }

        // Nodes
        for (const n of nodes) {
            // Cull
            if (n.x + NODE_W / 2 < vx0 - margin || n.x - NODE_W / 2 > vx1 + margin ||
                n.y + NODE_H / 2 < vy0 - margin || n.y - NODE_H / 2 > vy1 + margin) {
                continue;
            }

            const col = SCHOOL_COLORS[n.school] || DEFAULT_COLOR;
            let nodeAlpha = 1.0;
            const isSearchHit = state.searchHits && state.searchHits.has(n.key);
            if (state.focused && n.key !== state.focused && !isSearchHit) {
                const connected = isLineageOf(n.key, state.focused, edges);
                nodeAlpha = connected ? 0.8 : 0.2;
            }

            ctx.globalAlpha = nodeAlpha;

            // Rounded rect
            const rx = n.x - NODE_W / 2;
            const ry = n.y - NODE_H / 2;
            const r = 6;
            ctx.beginPath();
            ctx.moveTo(rx + r, ry);
            ctx.lineTo(rx + NODE_W - r, ry);
            ctx.arcTo(rx + NODE_W, ry, rx + NODE_W, ry + r, r);
            ctx.lineTo(rx + NODE_W, ry + NODE_H - r);
            ctx.arcTo(rx + NODE_W, ry + NODE_H, rx + NODE_W - r, ry + NODE_H, r);
            ctx.lineTo(rx + r, ry + NODE_H);
            ctx.arcTo(rx, ry + NODE_H, rx, ry + NODE_H - r, r);
            ctx.lineTo(rx, ry + r);
            ctx.arcTo(rx, ry, rx + r, ry, r);
            ctx.closePath();

            // Dashed border for Korean Seon nodes
            const isKoreanSeon = n.school === 'Korean Seon';
            if (isKoreanSeon) ctx.setLineDash([4, 3]);

            ctx.fillStyle = col.fill;
            ctx.fill();
            ctx.strokeStyle = (n.key === state.hovered || n.key === state.focused || isSearchHit) ? '#d4ab58' : col.stroke;
            ctx.lineWidth = (n.key === state.focused || isSearchHit) ? 2.0 : 1.0;
            ctx.stroke();
            if (isKoreanSeon) ctx.setLineDash([]);

            // Name text
            ctx.fillStyle = col.text;
            ctx.font = '11px "Segoe UI", Arial, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const label = n.primary.length > 18 ? n.primary.substring(0, 17) + '\u2026' : n.primary;
            ctx.fillText(label, n.x, n.y - 4);

            // Dates text
            if (n.datesText) {
                ctx.fillStyle = col.text;
                ctx.globalAlpha = nodeAlpha * 0.6;
                ctx.font = '9px "Segoe UI", Arial, sans-serif';
                ctx.fillText(n.datesText, n.x, n.y + 10);
                ctx.globalAlpha = nodeAlpha;
            }

            ctx.globalAlpha = 1.0;
        }

        ctx.restore();
    }

    // ── Interaction: pan + zoom ──
    canvas.addEventListener('mousedown', e => {
        const hit = hitTest(e.offsetX, e.offsetY);
        if (!hit) {
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
        state.hovered = hit ? hit.key : null;
        canvas.style.cursor = hit ? 'pointer' : 'grab';
        if (prev !== state.hovered) draw();
    });

    canvas.addEventListener('mouseup', (e) => {
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

    canvas.addEventListener('click', e => {
        if (state.dragging) return;
        if (state.wasDragging) { state.wasDragging = false; return; }
        const hit = hitTest(e.offsetX, e.offsetY);
        if (hit) {
            state.focused = hit.key;
        } else {
            state.focused = null;
        }
        draw();
    });

    canvas.addEventListener('dblclick', e => {
        const hit = hitTest(e.offsetX, e.offsetY);
        if (hit) {
            const slug = hit.primary.replace(/ /g, '_');
            window.location.hash = '#/master/' + encodeURIComponent(slug);
        }
    });

    canvas.addEventListener('wheel', e => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.1 : 0.9;
        const newZoom = Math.min(5.0, Math.max(0.1, state.zoom * factor));
        // Zoom toward cursor
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
            // Bug 4 fix: detect tap on touch devices
            const elapsed = Date.now() - touchStartTime;
            const ct = e.changedTouches[0];
            const dx = ct.clientX - touchStartPos.x;
            const dy = ct.clientY - touchStartPos.y;
            if (elapsed < 300 && dx * dx + dy * dy < 100) {
                const rect = canvas.getBoundingClientRect();
                const sx = ct.clientX - rect.left;
                const sy = ct.clientY - rect.top;
                const hit = hitTest(sx, sy);
                const now = Date.now();
                if (now - lastTapTime < 350 && hit) {
                    // Double-tap: navigate to profile
                    const slug = hit.primary.replace(/ /g, '_');
                    window.location.hash = '#/master/' + encodeURIComponent(slug);
                } else if (hit) {
                    state.focused = hit.key;
                    draw();
                } else {
                    state.focused = null;
                    draw();
                }
                lastTapTime = now;
            }
            touchPanning = false;
        }
    });

    // ── Zoom buttons ──
    const zoomBtns = canvas.parentElement.querySelectorAll('.lineage-zoom-btn');
    for (const btn of zoomBtns) {
        btn.addEventListener('click', () => {
            const dir = btn.dataset.dir;
            if (dir === 'reset') {
                state.zoom = 0.7;
                state.panX = 0;
                state.panY = 0;
                state.focused = null;
            } else {
                const factor = dir === 'in' ? 1.3 : 0.7;
                state.zoom = Math.min(5.0, Math.max(0.1, state.zoom * factor));
            }
            draw();
        });
    }

    // ── Search ──
    searchInput.addEventListener('input', () => {
        const q = searchInput.value.trim().toLowerCase();
        if (!q) { state.focused = null; state.searchHits = null; draw(); return; }
        const hits = nodes.filter(n =>
            n.names.some(nm => nm.toLowerCase().includes(q))
        );
        if (hits.length > 0) {
            state.focused = hits[0].key;
            state.searchHits = new Set(hits.map(h => h.key));

            if (hits.length === 1) {
                // Single hit: zoom in noticeably and center
                state.zoom = Math.min(1.2, Math.max(state.zoom, 0.7));
                state.panX = state.width / 2 - hits[0].x * state.zoom;
                state.panY = state.height / 2 - hits[0].y * state.zoom;
            } else {
                // Multiple hits: fit all in view with padding
                const xs = hits.map(h => h.x);
                const ys = hits.map(h => h.y);
                const minX = Math.min(...xs) - NODE_W;
                const maxX = Math.max(...xs) + NODE_W;
                const minY = Math.min(...ys) - NODE_H;
                const maxY = Math.max(...ys) + NODE_H;
                const spanW = maxX - minX;
                const spanH = maxY - minY;
                const fitZoom = Math.min(
                    state.width / (spanW + NODE_W * 4),
                    state.height / (spanH + NODE_H * 4),
                    1.2
                );
                state.zoom = Math.max(0.15, fitZoom);
                const cx = (minX + maxX) / 2;
                const cy = (minY + maxY) / 2;
                state.panX = state.width / 2 - cx * state.zoom;
                state.panY = state.height / 2 - cy * state.zoom;
            }
        } else {
            state.searchHits = null;
        }
        draw();
    });

    // ── Init ──
    window.addEventListener('resize', resize);
    resize();

    // Auto-fit: center the graph initially
    if (!focusName || !state.focused) {
        const bounds = graphBounds(nodes);
        if (bounds) {
            const gw = bounds.maxX - bounds.minX + NODE_W * 2;
            const gh = bounds.maxY - bounds.minY + NODE_H * 2;
            const fitZoom = Math.min(state.width / gw, state.height / gh, 1.0);
            state.zoom = Math.max(0.15, fitZoom);
            state.panX = (state.width - gw * state.zoom) / 2 - bounds.minX * state.zoom + NODE_W * state.zoom;
            state.panY = (state.height - gh * state.zoom) / 2 - bounds.minY * state.zoom + NODE_H * state.zoom;
            draw();
        }
    }
}

// ── Data building ──

function buildNodes(masters) {
    return masters.map((m, i) => {
        const names = m.names || [];
        const primary = names[0] || `Master ${i}`;
        const floruit = m.floruit || 0;
        const death = m.death || 0;
        const dates = floruit && death ? `${floruit}\u2013${death}`
            : floruit ? `fl. ${floruit}`
            : death ? `d. ${death}` : '';
        return {
            key: primary,
            primary,
            names,
            school: m.school || '',
            attestation: m.attestation || '',
            teacher: m.teacher || '',
            students: m.students || [],
            death,
            floruit,
            temporalY: death || floruit || 800,
            datesText: dates,
            x: 0, y: 0,
            layer: -1,
        };
    });
}

function buildEdges(nodes) {
    const byName = new Map();
    for (const n of nodes) {
        for (const nm of n.names) {
            byName.set(nm, n);
        }
    }
    const edges = [];
    for (const n of nodes) {
        if (n.teacher) {
            const teacher = byName.get(n.teacher);
            if (teacher) {
                edges.push({ from: teacher, to: n });
            }
        }
    }
    return edges;
}

function layoutNodes(nodes, edges) {
    // BFS layer assignment from roots
    const children = new Map();
    const hasParent = new Set();
    for (const e of edges) {
        if (!children.has(e.from.key)) children.set(e.from.key, []);
        children.get(e.from.key).push(e.to);
        hasParent.add(e.to.key);
    }

    const roots = nodes.filter(n => !hasParent.has(n.key));
    const visited = new Set();
    const queue = [];
    for (const r of roots) {
        r.layer = 0;
        visited.add(r.key);
        queue.push(r);
    }

    while (queue.length > 0) {
        const n = queue.shift();
        const kids = children.get(n.key) || [];
        for (const kid of kids) {
            if (!visited.has(kid.key)) {
                kid.layer = n.layer + 1;
                visited.add(kid.key);
                queue.push(kid);
            }
        }
    }

    // Assign orphans (unvisited) layer -1
    const orphans = nodes.filter(n => !visited.has(n.key));
    for (const o of orphans) o.layer = -1;

    // Temporal Y positioning
    const allYears = nodes.map(n => n.temporalY).filter(y => y > 0);
    const minYear = allYears.length > 0 ? Math.min(...allYears) : 600;

    // Layout non-orphans: X by layer, Y by temporal
    const treeNodes = nodes.filter(n => n.layer >= 0);
    for (const n of treeNodes) {
        n.x = n.layer * LAYER_GAP_X + 60;
        n.y = (n.temporalY - minYear) * PX_PER_YEAR;
        // Push Korean Seon nodes rightward for physical separation
        if (n.school === 'Korean Seon' || n.school === 'Early Korean Buddhism') n.x += LAYER_GAP_X * 5;
    }

    // Collision resolution within layers
    const layers = new Map();
    for (const n of treeNodes) {
        if (!layers.has(n.layer)) layers.set(n.layer, []);
        layers.get(n.layer).push(n);
    }
    for (const [, layerNodes] of layers) {
        layerNodes.sort((a, b) => a.y - b.y);
        for (let i = 1; i < layerNodes.length; i++) {
            const gap = layerNodes[i].y - layerNodes[i - 1].y;
            if (gap < MIN_GAP_Y) {
                layerNodes[i].y = layerNodes[i - 1].y + MIN_GAP_Y;
            }
        }
    }

    // Orphan grid below the tree
    const maxTreeY = treeNodes.length > 0 ? Math.max(...treeNodes.map(n => n.y)) : 0;
    const orphanStartY = maxTreeY + 120;
    for (let i = 0; i < orphans.length; i++) {
        const col = i % ORPHAN_COLS;
        const row = Math.floor(i / ORPHAN_COLS);
        orphans[i].x = col * ORPHAN_GAP_X + 60;
        orphans[i].y = orphanStartY + row * ORPHAN_GAP_Y;
    }
}

function isLineageOf(nodeKey, focusKey, edges) {
    // Full BFS closure: walk ancestors and descendants from focusKey
    const visited = new Set([focusKey]);
    const queue = [focusKey];
    while (queue.length > 0) {
        const cur = queue.shift();
        for (const e of edges) {
            if (e.from.key === cur && !visited.has(e.to.key)) {
                visited.add(e.to.key);
                queue.push(e.to.key);
            }
            if (e.to.key === cur && !visited.has(e.from.key)) {
                visited.add(e.from.key);
                queue.push(e.from.key);
            }
        }
    }
    return visited.has(nodeKey);
}

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
