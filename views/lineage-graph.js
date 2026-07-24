// views/lineage-graph.js
// The Zen lineage chart — a hanging scroll of 965 masters.
// Route: #/lineage  or  #/lineage?focus=Linji_Yixuan
//
// Design: runs/.../RUN-20260713-1030-lineage-harvest/design/DESIGN_PLAN.md
// The rule of the whole chart: INK MUST BE EARNED. Four dimensions, four
// channels: attestation -> edge ink; transmission -> edge geometry; contested
// -> the vermilion seal; school -> node fill hue. Never sharing a channel.

import { escapeHtml } from '../lib/format.js';
import { buildLineage, loadLineageMasters, SCHOOL_HUES } from '../lib/lineage-data.js';
import {
    computeLayout, assertNoOverlaps,
    NODE_W, NODE_H, SOURCE_W, LAYER_PITCH,
} from '../lib/lineage-layout.js';
import { createPanel } from './lineage-panel.js';

// ── Attestation → edge ink. THE FAIL-SAFE lives in styleFor(). ──
const ATT_STYLES = {
    A: { w: 2.25, dash: [], op: 0.85, faint: false },
    B: { w: 1.40, dash: [], op: 0.60, faint: false },
    C: { w: 1.20, dash: [7, 5], op: 0.50, faint: false },
    D: { w: 1.00, dash: [1.5, 4.5], op: 0.40, faint: true },
};
// A missing / null / misspelled / future attestation renders as the WEAKEST
// style — never a solid confident line. This inverts the original sin.
const styleFor = (att) => ATT_STYLES[att] ?? ATT_STYLES.D;

const ZOOM_MIN = 0.05, ZOOM_MAX = 2.5;   // low floor: the full 965 must fit on a laptop
const DIM = 0.12;                 // focus-dim alpha multiplier

// ── Route ──
export function match(route) { return route && route.kind === 'lineage'; }
export function preferAppFirst() { return false; }

export async function render(route, mount, shell) {
    if (shell) {
        shell.setTitle('Lineage Chart');
        shell.setContext('Chan/Zen lineage chart',
            'Every teacher-student line drawn with exactly as much ink as the evidence earned');
        shell.setUpsell(
            'Read Zen is a free desktop app for Chinese Zen literature with an interactive ' +
            'lineage chart, full-corpus search, and side-by-side translation. ' +
            '<a href="https://github.com/Fabulu/ReadZen/releases">Download free</a> · ' +
            '<a href="https://ko-fi.com/readzen">Support on Ko-fi</a>'
        );
        shell.hideStatus();
    }

    mount.innerHTML = `
        <div class="lin-root" data-lineage>
            <canvas class="lin-canvas" id="lin-canvas"></canvas>
            <div class="lin-controls">
                <div class="lin-search-wrap">
                    <input type="text" class="lin-search" placeholder="Search master…" aria-label="Search master" />
                    <div class="lin-search-drop" hidden></div>
                </div>
                <div class="lin-btnrow">
                    <button class="lin-iconbtn" data-act="in" title="Zoom in">+</button>
                    <button class="lin-iconbtn" data-act="out" title="Zoom out">−</button>
                    <button class="lin-iconbtn" data-act="reset" title="Fit the whole chart in view">⛶</button>
                </div>
                <button class="lin-toggle" data-act="mode">Show key masters only</button>
            </div>
            <div class="lin-legend" id="lin-legend"></div>
            <a href="#/masters" class="lin-browse">← Browse Masters</a>
            <div class="lin-live" aria-live="polite"></div>
        </div>`;

    let masters;
    try {
        masters = await loadLineageMasters();
    } catch (err) {
        mount.innerHTML = `<article class="panel lookup-card"><p>Failed to load lineage data: ${escapeHtml(String(err.message || err))}</p></article>`;
        return;
    }
    if (!mount.querySelector('#lin-canvas')) return; // navigated away

    const canvas = mount.querySelector('#lin-canvas');
    const legend = mount.querySelector('#lin-legend');
    const searchInput = mount.querySelector('.lin-search');
    initGraph(canvas, legend, searchInput, masters, route.focus || '', { full: true });
}

// ── Graph engine ──
// Backwards-compatible entry point (the landing embed calls this too).
export function initGraph(canvas, legendEl, searchInput, masters, focusName, opts) {
    opts = opts || {};
    const embed = !opts.full;
    const ctx = canvas.getContext('2d');
    const container = canvas.parentElement;

    const graph = buildLineage(masters);
    const { nodes, edges, byId } = graph;

    // trunk subset for the landing embed (~the deep spine only)
    const trunkSet = new Set(
        nodes.filter(n => n.spine && ((n.descendants || 0) >= 18 || n.isSource)).map(n => n.id)
    );
    // ancestor closure of the trunk so it's connected
    for (const n of nodes) {
        if (!trunkSet.has(n.id)) continue;
        let cur = n.parentEdge ? n.parentEdge.from : null, g = 0;
        while (cur && g++ < 100) { trunkSet.add(cur.id); cur = cur.parentEdge ? cur.parentEdge.from : null; }
    }

    // ── view state ──
    // The chart is FULLY EXPANDED by default (user decision 2026-07-15); the
    // spine/capsule machinery is kept as an opt-in "key masters only" view.
    const state = {
        panX: 0, panY: 0, zoom: embed ? 0.5 : 0.42,
        focused: null, hovered: null,
        mode: 'all',                       // 'trunk' | 'spine' | 'all' — the
                                           // hero shows the WHOLE tree too
                                           // (user feedback 2026-07-15); trunk
                                           // subset read as "only a few masters"
        expanded: new Set(),               // capsule roots expanded by the user
        searchHits: null,
        width: 0, height: 0,
        dragging: false, wasDragging: false,
        dx: 0, dy: 0, px0: 0, py0: 0,
    };

    // theme tokens (re-read live on theme/palette change)
    let TOK = readTokens(container);
    let DARK = isDark();

    // panel (skip on embed)
    const panel = embed ? null : createPanel(container);

    // reduced motion
    const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // ── visible set + layout ──
    let vnodes = [], vedges = [], capsules = [];
    let layerYear = new Map();     // layer -> median century-year (for the rail)
    let seals = [];                // contested seal hit targets (screen recomputed on draw)

    function baseSet() {
        if (state.mode === 'all') return new Set(nodes.map(n => n.id));
        const base = new Set((state.mode === 'trunk' ? [...trunkSet] : nodes.filter(n => n.spine).map(n => n.id)));
        for (const rootId of state.expanded) {
            const r = byId.get(rootId);
            if (r) addSubtree(r, base);
        }
        return base;
    }
    function addSubtree(n, set) {
        const stack = [n];
        while (stack.length) {
            const c = stack.pop();
            set.add(c.id);
            for (const e of c.childEdges) stack.push(e.to);
        }
    }

    function rebuild() {
        const visible = state.mode === 'all' ? null : baseSet();
        const isVis = (n) => !visible || visible.has(n.id);
        vnodes = [];
        capsules = [];
        const capByParent = new Map();
        // real + source nodes
        for (const n of nodes) if (isVis(n)) vnodes.push(n);
        // capsules: a visible node's hidden child becomes a capsule chip
        vedges = [];
        for (const e of edges) {
            const fromVis = isVis(e.from), toVis = isVis(e.to);
            if (fromVis && toVis) { vedges.push(e); continue; }
            if (fromVis && !toVis && !e.to.isSource) {
                // collapse this child subtree into a capsule at the parent
                const cap = {
                    id: '__cap__' + e.to.id, capsule: true, capsuleRoot: e.to,
                    count: (e.to.descendants || 0) + 1,
                    schoolKey: e.to.schoolKey, korean: e.to.korean,
                    year: e.to.year, isSource: false, childEdges: [],
                    x: 0, y: 0, layer: -1, order: 0,
                };
                capsules.push(cap);
                vnodes.push(cap);
                vedges.push({
                    from: e.from, to: cap, attestation: e.to.attestation,
                    transmission: e.to.transmission, contested: null, kind: 'capsule',
                });
            }
        }
        const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        computeLayout(vnodes, vedges);
        const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

        // century rail data
        layerYear = new Map();
        const byL = new Map();
        for (const n of vnodes) {
            if (n.capsule || n.isSource || !n.year || !n.death) continue;
            if (!byL.has(n.layer)) byL.set(n.layer, []);
            byL.get(n.layer).push(n.death);
        }
        for (const [L, ys] of byL) {
            if (ys.length < 3) continue;
            ys.sort((a, b) => a - b);
            layerYear.set(L, ys[Math.floor(ys.length / 2)]);
        }

        // dev overlap assertion
        if (isDev()) {
            const a = assertNoOverlaps(vnodes, vedges);
            if (!a.ok) {
                console.warn(`[lineage] OVERLAP ASSERTION FAILED — ${a.nodeNode} node·node, ${a.edgeNode} edge·node (${vnodes.length} nodes)`);
                a.samples.forEach(s => console.warn('  ' + s));
            } else {
                console.info(`[lineage] layout clean: ${vnodes.length} nodes, ${vedges.length} edges, ${Math.round(t1 - t0)}ms — no overlaps`);
            }
        }
    }
    rebuild();

    // ── legend ──
    if (legendEl) buildLegend(legendEl, embed);

    // ── focus relatives (ancestors path + direct heirs) ──
    let relSet = new Set();
    function recomputeRel() {
        relSet = new Set();
        if (!state.focused) return;
        const f = byId.get(state.focused);
        if (!f) return;
        relSet.add(f.id);
        let cur = f.parentEdge ? f.parentEdge.from : null, g = 0;
        while (cur && g++ < 100) { relSet.add(cur.id); cur = cur.parentEdge ? cur.parentEdge.from : null; }
        for (const e of f.childEdges) relSet.add(e.to.id);
    }

    // ── resize ──
    function resize() {
        if (!canvas.isConnected) { teardown(); return; }
        const rect = container.getBoundingClientRect();
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        state.width = rect.width; state.height = rect.height;
        canvas.width = Math.round(rect.width * dpr);
        canvas.height = Math.round(rect.height * dpr);
        canvas.style.width = rect.width + 'px';
        canvas.style.height = rect.height + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        requestDraw();
    }

    // ── RAF-coalesced draw ──
    let dirty = false;
    function requestDraw() {
        if (dirty) return;
        dirty = true;
        requestAnimationFrame(() => { dirty = false; draw(); });
    }

    // ── coordinate helpers ──
    const halfW = (n) => (n.isSource || n.capsule ? SOURCE_W : NODE_W) / 2;
    function worldToScreen(wx, wy) { return [wx * state.zoom + state.panX, wy * state.zoom + state.panY]; }
    function screenToWorld(sx, sy) { return [(sx - state.panX) / state.zoom, (sy - state.panY) / state.zoom]; }

    function hitTest(sx, sy) {
        const [wx, wy] = screenToWorld(sx, sy);
        const padW = 6 / state.zoom;
        for (let i = vnodes.length - 1; i >= 0; i--) {
            const n = vnodes[i];
            const hw = halfW(n) + padW, hh = (n.capsule ? 12 : NODE_H / 2) + padW;
            if (wx >= n.x - hw && wx <= n.x + hw && wy >= n.y - hh && wy <= n.y + hh) return n;
        }
        return null;
    }
    function sealHit(sx, sy) {
        for (const s of seals) {
            const dx = sx - s.sx, dy = sy - s.sy;
            if (dx * dx + dy * dy <= 14 * 14) return s;
        }
        return null;
    }

    // ── drawing ──
    function nodeColors(n) {
        const key = n.schoolKey;
        const hue = SCHOOL_HUES[key];
        if (n.isSource) return DARK
            ? { fill: 'hsl(40 8% 30%)', stroke: 'hsl(40 10% 46%)', label: 'hsl(40 10% 84%)' }
            : { fill: 'hsl(40 14% 86%)', stroke: 'hsl(40 14% 52%)', label: 'hsl(40 18% 28%)' };
        if (hue == null) return DARK   // pre-chan / other: achromatic
            ? { fill: 'hsl(40 6% 24%)', stroke: 'hsl(40 8% 40%)', label: 'hsl(40 8% 80%)' }
            : { fill: 'hsl(40 8% 88%)', stroke: 'hsl(40 10% 54%)', label: 'hsl(40 12% 32%)' };
        const s = key === 'early-chan' ? 0.6 : 1; // early-chan desaturated
        return DARK
            ? { fill: `hsl(${hue} ${30 * s}% 26%)`, stroke: `hsl(${hue} ${35 * s}% 42%)`, label: `hsl(${hue} ${22 * s}% 84%)` }
            : { fill: `hsl(${hue} ${38 * s}% 90%)`, stroke: `hsl(${hue} ${30 * s}% 52%)`, label: `hsl(${hue} ${45 * s}% 22%)` };
    }

    function relevance(id) {
        if (!state.focused) return 1;
        return relSet.has(id) ? 1 : DIM;
    }

    function draw() {
        const w = state.width, h = state.height, z = state.zoom;
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = TOK.bgSoft;
        ctx.fillRect(0, 0, w, h);

        const [vx0, vy0] = screenToWorld(0, 0);
        const [vx1, vy1] = screenToWorld(w, h);
        const m = NODE_W;
        seals = [];

        ctx.save();
        ctx.translate(state.panX, state.panY);
        ctx.scale(z, z);

        // ── edges ──
        for (const e of vedges) {
            const pts = e.points;
            if (!pts) continue;
            const minx = Math.min(e.from.x, e.to.x) - m, maxx = Math.max(e.from.x, e.to.x) + m;
            const miny = e.from.y - m, maxy = e.to.y + m;
            if (maxx < vx0 || minx > vx1 || maxy < vy0 || miny > vy1) continue;
            drawEdge(e, z);
        }

        // ── contested rival arcs + seals (annotation layer, every LOD) ──
        for (const e of vedges) {
            if (!e.contested) continue;
            drawContested(e, z);
        }

        // ── nodes ──
        for (const n of vnodes) {
            const hw = halfW(n);
            if (n.x + hw < vx0 || n.x - hw > vx1 || n.y + NODE_H < vy0 || n.y - NODE_H > vy1) continue;
            if (n.capsule) drawCapsule(n, z);
            else if (n.isSource) drawSource(n, z);
            else drawNode(n, z);
        }

        ctx.restore();

        // ── stubs need screen-independent fade; drawn in world above already ──
        // ── century rail (screen space) ──
        drawRail();
    }

    function edgePath(pts) {
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        if (pts.length === 2) {
            // Vertical launch/landing: the wider the horizontal run, the harder
            // the curve dives out of the teacher and rises into the heir, so a
            // long connector still READS as descent, not as a horizontal wire.
            // Control offsets stay inside the box-free inter-layer channel.
            const span = pts[1].y - pts[0].y;
            const c = Math.max(span * 0.45,
                Math.min(Math.abs(pts[1].x - pts[0].x) * 0.35, span - 24));
            ctx.bezierCurveTo(pts[0].x, pts[0].y + c, pts[1].x, pts[1].y - c, pts[1].x, pts[1].y);
        } else {
            for (let i = 1; i < pts.length; i++) {
                const p0 = pts[i - 1], p1 = pts[i];
                const dy = (p1.y - p0.y) * 0.5;
                ctx.bezierCurveTo(p0.x, p0.y + dy, p1.x, p1.y - dy, p1.x, p1.y);
            }
        }
    }

    function drawEdge(e, z) {
        // Edge carries the (student's) attestation; capsule edges store it on
        // the edge since e.to is a placeholder chip. Fail-safe applies either way.
        const att = e.attestation;
        const st = styleFor(att);
        const rel = Math.max(relevance(e.from.id), relevance(e.to.id));
        const pts = e.points;
        ctx.lineWidth = st.w;
        ctx.strokeStyle = st.faint ? TOK.muted : TOK.text;
        ctx.globalAlpha = st.op * rel;
        ctx.setLineDash(st.dash);
        ctx.lineCap = 'round';

        const trans = e.transmission;
        if (trans === 'disputed') { drawDisputedEdge(pts, st); ctx.setLineDash([]); ctx.globalAlpha = 1; return; }

        edgePath(pts);
        ctx.stroke();
        ctx.setLineDash([]);

        // stub fade for dangling handled on node; here handle midpoint glyphs
        if (z >= 0.5 && (trans === '遙嗣' || trans === '代囑' || trans === 'book')) {
            drawMidGlyph(pts, trans);
        }
        ctx.globalAlpha = 1;
    }

    function midpoint(pts) {
        const i = Math.floor((pts.length - 1) / 2);
        const a = pts[i], b = pts[Math.min(i + 1, pts.length - 1)];
        return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }

    function drawMidGlyph(pts, trans) {
        const mp = midpoint(pts);
        ctx.save();
        ctx.setLineDash([]);
        ctx.fillStyle = TOK.bgSoft;
        ctx.strokeStyle = ctx.strokeStyle;
        ctx.lineWidth = 1.2;
        if (trans === '遙嗣') {           // posthumous: empty circle bridging a gap
            ctx.beginPath(); ctx.arc(mp.x, mp.y, 4.5, 0, Math.PI * 2);
            ctx.fill(); ctx.stroke();
        } else if (trans === '代囑') {     // proxy: empty diamond
            ctx.beginPath();
            ctx.moveTo(mp.x, mp.y - 5); ctx.lineTo(mp.x + 5, mp.y);
            ctx.lineTo(mp.x, mp.y + 5); ctx.lineTo(mp.x - 5, mp.y); ctx.closePath();
            ctx.fill(); ctx.stroke();
        } else if (trans === 'book') {     // small book mark on a real book-edge
            ctx.fillStyle = TOK.text; ctx.globalAlpha = 0.7;
            ctx.font = '10px serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText('冊', mp.x, mp.y);
        }
        ctx.restore();
    }

    function drawDisputedEdge(pts, st) {
        // two thin parallel strands 3px apart for the middle third — a fork
        // that never resolves.
        for (const off of [-1.5, 1.5]) {
            ctx.beginPath();
            ctx.moveTo(pts[0].x + off, pts[0].y);
            const last = pts[pts.length - 1];
            const dy = (last.y - pts[0].y) * 0.45;
            ctx.bezierCurveTo(pts[0].x + off, pts[0].y + dy, last.x + off, last.y - dy, last.x + off, last.y);
            ctx.stroke();
        }
    }

    function drawContested(e, z) {
        const kept = e.points;
        const cb = e.contested;
        // rival arc — bowed out of the lattice, in the ACCENT hue
        const rivalNode = cb && cb.rival ? byId.get(cb.rival) || graph.byName.get(cb.rival) : null;
        const mp = midpoint(kept);
        if (rivalNode) {
            const from = { x: rivalNode.x, y: rivalNode.y + NODE_H / 2 };
            const to = { x: e.to.x, y: e.to.y - NODE_H / 2 };
            const bow = 60 * (from.x <= to.x ? -1 : 1);
            const cx = (from.x + to.x) / 2 + bow, cy = (from.y + to.y) / 2;
            const rivalStyle = /stele|contemporary|first/.test(cb.rival_rung || '') ? 2.25 : 1.4;
            ctx.save();
            ctx.strokeStyle = TOK.accent;
            ctx.globalAlpha = 0.55;
            ctx.lineWidth = rivalStyle;
            ctx.setLineDash([]);
            ctx.beginPath();
            ctx.moveTo(from.x, from.y);
            ctx.quadraticCurveTo(cx, cy, to.x, to.y);
            ctx.stroke();
            ctx.restore();
        }
        // the seal — a tilted cinnabar square stamped over the kept edge midpoint
        const [ssx, ssy] = worldToScreen(mp.x, mp.y);
        seals.push({ sx: ssx, sy: ssy, node: e.to });
        ctx.save();
        ctx.translate(mp.x, mp.y);
        ctx.rotate(-6 * Math.PI / 180);
        const s = 12;
        ctx.beginPath();
        roundRect(ctx, -s / 2, -s / 2, s, s, 1);
        ctx.fillStyle = TOK.accent; ctx.globalAlpha = 0.18; ctx.fill();
        ctx.globalAlpha = 1; ctx.lineWidth = 1.5; ctx.strokeStyle = TOK.accent; ctx.stroke();
        ctx.restore();
    }

    function drawNode(n, z) {
        const c = nodeColors(n);
        const rel = relevance(n.id);
        const hw = NODE_W / 2, hh = NODE_H / 2;
        const isHit = state.searchHits && state.searchHits.has(n.id);
        const active = n.id === state.hovered || n.id === state.focused || isHit;

        // dangling stub: a fade-out edge rising from the top port ending in "…"
        if (n.stub) drawStub(n, z, rel);

        ctx.globalAlpha = rel;
        roundRect(ctx, n.x - hw, n.y - hh, NODE_W, NODE_H, 5);
        ctx.fillStyle = c.fill; ctx.fill();
        ctx.lineWidth = active ? 2 : 1;
        ctx.strokeStyle = active ? TOK.accent : c.stroke;
        ctx.setLineDash([]); ctx.stroke();

        // LOD content
        if (z < 0.28) {
            // dot handled elsewhere via label grid; draw a small dot
            ctx.globalAlpha = rel;
            ctx.beginPath(); ctx.arc(n.x, n.y, 4, 0, Math.PI * 2);
            ctx.fillStyle = c.stroke; ctx.fill();
        } else if (z < 0.5) {
            label(n.primary, n.x, n.y, c.label, 11, rel, NODE_W - 12);
        } else if (z < 1.2) {
            label(n.primary, n.x, n.y - 5, c.label, 11, rel, NODE_W - 12, 'sans');
            if (n.datesText) label(n.datesText, n.x, n.y + 9, c.label, 9, rel * 0.6, NODE_W - 12, 'sans');
        } else {
            if (n.cjk) label(n.cjk, n.x, n.y - 5, c.label, 13, rel, NODE_W - 12, 'serif');
            const sub = [n.primary, n.datesText].filter(Boolean).join(' · ');
            label(sub, n.x, n.y + 10, c.label, 8.5, rel * 0.7, NODE_W - 10, 'sans');
        }
        ctx.globalAlpha = 1;
    }

    function drawStub(n, z, rel) {
        // 24px fade rising from the top port
        const g = ctx.createLinearGradient(0, n.y - NODE_H / 2 - 24, 0, n.y - NODE_H / 2);
        const c0 = TOK.muted;
        g.addColorStop(0, 'transparent');
        g.addColorStop(1, c0);
        ctx.save();
        ctx.globalAlpha = 0.5 * rel;
        ctx.strokeStyle = g; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
        ctx.beginPath(); ctx.moveTo(n.x, n.y - NODE_H / 2 - 24); ctx.lineTo(n.x, n.y - NODE_H / 2); ctx.stroke();
        ctx.setLineDash([]);
        if (z >= 0.4) {
            ctx.globalAlpha = 0.6 * rel; ctx.fillStyle = TOK.muted;
            ctx.font = '10px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText('…', n.x, n.y - NODE_H / 2 - 26);
        }
        ctx.restore();
    }

    function drawSource(n, z) {
        // folded-sutra glyph: vertical rect, spine line, three text lines
        const rel = relevance(n.id);
        const active = n.id === state.hovered || n.id === state.focused ||
            (state.searchHits && state.searchHits.has(n.id));
        ctx.save();
        ctx.globalAlpha = rel;
        const wpx = 22, hpx = 28;
        const x = n.x - wpx / 2, y = n.y - hpx / 2;
        ctx.fillStyle = DARK ? 'hsl(40 8% 30%)' : 'hsl(40 14% 86%)';
        ctx.strokeStyle = active ? TOK.accent : TOK.muted;
        ctx.lineWidth = active ? 2 : 1;
        roundRect(ctx, x, y, wpx, hpx, 2); ctx.fill(); ctx.stroke();
        ctx.strokeStyle = TOK.muted; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x + 5, y); ctx.lineTo(x + 5, y + hpx); ctx.stroke();
        ctx.globalAlpha = rel * 0.6;
        for (let i = 1; i <= 3; i++) {
            ctx.beginPath(); ctx.moveTo(x + 9, y + i * 7); ctx.lineTo(x + wpx - 3, y + i * 7); ctx.stroke();
        }
        // Bilingual label — the English title shows FIRST (lower zoom), the
        // hanja joins it when there is room. Never hanja-only.
        let ly = y + hpx + 3;
        if (z >= 0.45 && n.sourceTitleEn) {
            ctx.globalAlpha = rel; ctx.fillStyle = TOK.textSoft;
            ctx.font = '10px "Segoe UI", system-ui, sans-serif';
            ctx.textAlign = 'center'; ctx.textBaseline = 'top';
            ctx.fillText(n.sourceTitleEn, n.x, ly);
            ly += 13;
        }
        if (z >= 0.75 && n.sourceTitle) {
            ctx.globalAlpha = rel * 0.85; ctx.fillStyle = TOK.textSoft;
            ctx.font = '11px Georgia, "Songti SC", serif';
            ctx.textAlign = 'center'; ctx.textBaseline = 'top';
            ctx.fillText(n.sourceTitle, n.x, ly);
        }
        ctx.restore();
    }

    function drawCapsule(n, z) {
        const c = nodeColors(n.capsuleRoot);
        const rel = relevance(n.capsuleRoot.id);
        ctx.save();
        ctx.globalAlpha = rel;
        roundRect(ctx, n.x - SOURCE_W / 2, n.y - 12, SOURCE_W, 24, 4);
        ctx.fillStyle = withAlpha(c.fill, 0.4); ctx.fill();
        ctx.lineWidth = 1; ctx.strokeStyle = c.stroke; ctx.stroke();
        ctx.fillStyle = c.label; ctx.font = '10px sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('＋' + n.count, n.x, n.y);
        ctx.restore();
    }

    function label(text, x, y, color, size, alpha, maxW, family) {
        if (!text) return;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = color;
        const fam = family === 'serif' ? 'Georgia, "Songti SC", serif' : '"Segoe UI", system-ui, sans-serif';
        ctx.font = `${size}px ${fam}`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        let t = text;
        if (ctx.measureText(t).width > maxW) {
            while (t.length > 2 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
            t += '…';
        }
        ctx.fillText(t, x, y);
    }

    function drawRail() {
        if (embed || state.width < 40) return;
        const narrow = state.width < 480;
        ctx.save();
        ctx.font = '10px system-ui, sans-serif';
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        let lastCentury = null;
        const layersSorted = [...layerYear.keys()].sort((a, b) => a - b);
        for (const L of layersSorted) {
            const yr = layerYear.get(L);
            const century = Math.floor(yr / 100) * 100;
            if (century === lastCentury) continue;
            lastCentury = century;
            const [, sy] = worldToScreen(0, L * LAYER_PITCH);
            if (sy < 10 || sy > state.height - 6) continue;
            ctx.strokeStyle = TOK.border; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(narrow ? 6 : 10, sy); ctx.stroke();
            if (!narrow) {
                ctx.fillStyle = TOK.muted;
                ctx.fillText(century + 's', 13, sy);
            }
        }
        ctx.restore();
    }

    // ── interactions ──
    canvas.addEventListener('mousedown', (e) => {
        const hit = hitTest(e.offsetX, e.offsetY);
        if (!hit) {
            state.dragging = true;
            state.px0 = e.clientX; state.py0 = e.clientY;
            state.dx = state.panX; state.dy = state.panY;
            canvas.style.cursor = 'grabbing';
        }
    });
    canvas.addEventListener('mousemove', (e) => {
        if (state.dragging) {
            state.panX = state.dx + (e.clientX - state.px0);
            state.panY = state.dy + (e.clientY - state.py0);
            if (Math.abs(e.clientX - state.px0) + Math.abs(e.clientY - state.py0) > 4) state.wasDragging = true;
            requestDraw();
            return;
        }
        const hit = hitTest(e.offsetX, e.offsetY);
        const seal = !hit && sealHit(e.offsetX, e.offsetY);
        const key = hit ? hit.id : null;
        canvas.style.cursor = (hit || seal) ? 'pointer' : 'grab';
        if (key !== state.hovered) { state.hovered = key; updateTooltip(hit, e.offsetX, e.offsetY); requestDraw(); }
        else updateTooltip(hit, e.offsetX, e.offsetY);
    });
    window.addEventListener('mouseup', () => {
        state.dragging = false;
        if (canvas.style) canvas.style.cursor = 'grab';
        setTimeout(() => { state.wasDragging = false; }, 0);
    });
    canvas.addEventListener('mouseleave', () => { state.hovered = null; hideTooltip(); requestDraw(); });

    canvas.addEventListener('click', (e) => {
        if (state.wasDragging) return;
        const seal = sealHit(e.offsetX, e.offsetY);
        if (seal && panel) { focusNode(seal.node.id, { openPanel: true }); return; }
        const hit = hitTest(e.offsetX, e.offsetY);
        if (hit && hit.capsule) { state.expanded.add(hit.capsuleRoot.id); rebuild(); requestDraw(); return; }
        // book sources are first-class: click opens their panel (no pushState —
        // they have no share-slug of their own)
        if (hit) focusNode(hit.id, { openPanel: !embed, pushState: !embed && !hit.isSource });
        else { clearFocus(); if (panel) panel.hide(); }
    });
    canvas.addEventListener('dblclick', (e) => {
        const hit = hitTest(e.offsetX, e.offsetY);
        if (hit && !hit.capsule && !hit.isSource) {
            window.location.hash = '#/master/' + encodeURIComponent(hit.primary.replace(/ /g, '_'));
        }
    });
    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        zoomAt(e.offsetX, e.offsetY, e.deltaY < 0 ? 1.12 : 0.893);
    }, { passive: false });

    function zoomAt(sx, sy, factor) {
        const nz = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, state.zoom * factor));
        state.panX = sx - (sx - state.panX) * (nz / state.zoom);
        state.panY = sy - (sy - state.panY) * (nz / state.zoom);
        state.zoom = nz;
        requestDraw();
    }

    // ── touch (pan + pinch) ──
    let tDist = 0, tMid = null, tPan = false, tStart = 0, tPos = { x: 0, y: 0 }, tLast = 0;
    canvas.addEventListener('touchstart', (e) => {
        if (e.touches.length === 1) {
            tPan = true; state.px0 = e.touches[0].clientX; state.py0 = e.touches[0].clientY;
            state.dx = state.panX; state.dy = state.panY;
            tStart = Date.now(); tPos = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        } else if (e.touches.length === 2) {
            tPan = false; tDist = tDistf(e.touches); tMid = tMidf(e.touches);
        }
        e.preventDefault();
    }, { passive: false });
    canvas.addEventListener('touchmove', (e) => {
        if (e.touches.length === 1 && tPan) {
            state.panX = state.dx + (e.touches[0].clientX - state.px0);
            state.panY = state.dy + (e.touches[0].clientY - state.py0);
            requestDraw();
        } else if (e.touches.length === 2) {
            const d = tDistf(e.touches), mid = tMidf(e.touches);
            const rect = canvas.getBoundingClientRect();
            if (tDist > 0) zoomAt(mid.x - rect.left, mid.y - rect.top, d / tDist);
            if (tMid) { state.panX += mid.x - tMid.x; state.panY += mid.y - tMid.y; }
            tDist = d; tMid = mid; requestDraw();
        }
        e.preventDefault();
    }, { passive: false });
    canvas.addEventListener('touchend', (e) => {
        if (e.touches.length < 2) { tDist = 0; tMid = null; }
        if (e.touches.length === 0) {
            const el = Date.now() - tStart, ct = e.changedTouches[0];
            const dx = ct.clientX - tPos.x, dy = ct.clientY - tPos.y;
            if (el < 300 && dx * dx + dy * dy < 100) {
                const rect = canvas.getBoundingClientRect();
                const sx = ct.clientX - rect.left, sy = ct.clientY - rect.top;
                const seal = sealHit(sx, sy);
                if (seal && panel) { focusNode(seal.node.id, { openPanel: true }); }
                else {
                    const hit = hitTest(sx, sy);
                    if (hit && hit.capsule) { state.expanded.add(hit.capsuleRoot.id); rebuild(); requestDraw(); }
                    else if (hit) focusNode(hit.id, { openPanel: !embed, pushState: !embed && !hit.isSource });
                    else { clearFocus(); if (panel) panel.hide(); }
                }
                tLast = Date.now();
            }
            tPan = false;
        }
    });

    // ── focus ──
    function focusNode(id, o) {
        o = o || {};
        state.focused = id;
        recomputeRel();
        const n = byId.get(id);
        if (n) {
            announce(`${n.primary}${n.datesText ? ', ' + n.datesText : ''}${n.schoolKey ? ', ' + n.schoolKey : ''}${n.attestation ? ', evidence grade ' + n.attestation : ''}`);
            if (o.center !== false) flyTo(n, o.animate !== false && !reduceMotion);
            if (o.openPanel && panel) panel.show(n, panelCtx);
            if (o.pushState) {
                const slug = n.primary.replace(/ /g, '_');
                try { history.pushState({ linFocus: id }, '', '#/lineage?focus=' + encodeURIComponent(slug)); } catch { }
            }
        }
        requestDraw();
    }
    function clearFocus() { state.focused = null; relSet = new Set(); requestDraw(); }

    const panelCtx = {
        onFocus: (id) => { revealTo(id); focusNode(id, { openPanel: true, pushState: true }); },
        onClose: () => { clearFocus(); },
    };

    function revealTo(id) {
        // make sure the node is visible (expand its ancestor capsules)
        const n = byId.get(id);
        if (!n || state.mode === 'all') return;
        const anc = [];
        let cur = n;
        while (cur) { anc.unshift(cur); cur = cur.parentEdge ? cur.parentEdge.from : null; }
        for (const a of anc) state.expanded.add(a.id);
        rebuild();
    }

    function flyTo(n, animate) {
        const tz = Math.max(state.zoom, 0.7);
        const tx = state.width / 2 - n.x * tz;
        const ty = state.height / 2 - n.y * tz;
        if (!animate) { state.zoom = tz; state.panX = tx; state.panY = ty; requestDraw(); return; }
        const z0 = state.zoom, x0 = state.panX, y0 = state.panY;
        const t0 = performance.now(), dur = 300;
        const step = (t) => {
            const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
            state.zoom = z0 + (tz - z0) * e;
            state.panX = x0 + (tx - x0) * e;
            state.panY = y0 + (ty - y0) * e;
            draw();
            if (k < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
    }

    // ── tooltip ──
    let tip = null;
    function updateTooltip(hit, sx, sy) {
        if (!hit || hit.capsule || state.zoom < 0.2) { hideTooltip(); return; }
        if (!tip) { tip = document.createElement('div'); tip.className = 'lin-tip'; container.appendChild(tip); }
        const meta = hit.isSource
            ? [hit.cjk, hit.sourceAuthor].filter(Boolean).join(' · ')
            : [hit.cjk, hit.datesText, hit.schoolKey].filter(Boolean).join(' · ');
        tip.innerHTML = `<strong>${escapeHtml(hit.primary)}</strong>${meta ? '<br>' + escapeHtml(meta) : ''}`;
        tip.style.left = (sx + 14) + 'px';
        tip.style.top = (sy + 10) + 'px';
        tip.hidden = false;
    }
    function hideTooltip() { if (tip) tip.hidden = true; }

    // ── announce ──
    const liveEl = container.querySelector('.lin-live');
    function announce(t) { if (liveEl) liveEl.textContent = t; }

    // ── search ──
    if (searchInput) wireSearch();
    function wireSearch() {
        // Enter cycles through matches ONE at a time. A name like "Yuanwu"
        // matches several masters (Keqin, Miyun); each Enter focuses the next
        // one (wrapping), so the same working single-node path that "Nanquan"
        // uses is reused for every match. cycleKey pins the query the cycle
        // belongs to — a new/changed query restarts at index 0.
        let cycleKey = null, cycleIdx = -1;

        // Position/count indicator ("Yuanwu — 1 of 2"), shown only for
        // multi-match queries. Created once, kept next to the input (survives
        // the fullscreen input relocation via re-insert on each update). Inline
        // theme tokens keep it one-file + dark/light aware; no display in the
        // base style so the `hidden` attribute can hide it via the UA rule.
        const indicator = document.createElement('div');
        indicator.className = 'lin-search-count';
        indicator.hidden = true;
        indicator.style.cssText =
            'font-size:0.72rem;color:var(--muted);margin-top:4px;padding:0 2px;white-space:nowrap;';
        searchInput.insertAdjacentElement('afterend', indicator);

        function showCount(name, idx, total) {
            if (total > 1) {
                indicator.textContent = `${name} — ${idx + 1} of ${total}`;
                indicator.hidden = false;
            } else {
                indicator.hidden = true;
                indicator.textContent = '';
            }
            // Keep the indicator adjacent to the input even after a fullscreen
            // relocation (insertAdjacentElement moves it if already in the DOM).
            searchInput.insertAdjacentElement('afterend', indicator);
        }

        // Resolve the dropdown LIVE on each keystroke (not captured once): in
        // fullscreen the embed's input is relocated into a floating overlay
        // that carries its own .lin-search-drop, and the full page's drop lives
        // in .lin-controls. Either way there is exactly one in the container.
        searchInput.addEventListener('input', () => {
            const drop = container.querySelector('.lin-search-drop');
            const q = searchInput.value.trim().toLowerCase();
            // Typing edits the query: retire a stale cycle indicator until the
            // next Enter recomputes it.
            if (q !== cycleKey) { cycleKey = null; cycleIdx = -1; indicator.hidden = true; }
            if (!q) { state.searchHits = null; if (drop) { drop.hidden = true; drop.innerHTML = ''; } requestDraw(); return; }
            // books (source nodes) are searchable by English title and hanja
            const hits = nodes.filter(n => n.names.some(nm => nm.toLowerCase().includes(q))).slice(0, 8);
            if (drop) {
                drop.innerHTML = hits.map(n =>
                    `<button class="lin-drop-item" data-id="${escapeHtml(n.id)}">
                        <span class="lin-drop-name">${escapeHtml(n.cjk || n.primary)}</span>
                        <span class="lin-drop-meta">${escapeHtml(n.isSource
                            ? [n.sourceTitleEn, 'book'].filter(Boolean).join(' · ')
                            : [n.primary, n.datesText].filter(Boolean).join(' · '))}</span>
                        ${n.schoolKey && !n.preChan && !n.isSource ? `<span class="lin-drop-chip" data-school="${escapeHtml(n.schoolKey)}"></span>` : ''}
                    </button>`).join('');
                drop.hidden = hits.length === 0;
                drop.querySelectorAll('.lin-drop-item').forEach(b => b.addEventListener('click', () => {
                    // A mouse click picks THAT specific master (unchanged) — only
                    // the Enter key cycles.
                    const id = b.getAttribute('data-id');
                    revealTo(id);
                    focusNode(id, { openPanel: !embed, pushState: !embed });
                    drop.hidden = true; searchInput.value = b.querySelector('.lin-drop-name').textContent;
                }));
            }
            state.searchHits = new Set(hits.map(h => h.id));
            requestDraw();
        });
        searchInput.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            const q = searchInput.value.trim().toLowerCase();
            if (!q) { cycleKey = null; cycleIdx = -1; indicator.hidden = true; return; }
            // EVERY matching node (not just the top hit).
            const matches = nodes.filter(n => n.names.some(nm => nm.toLowerCase().includes(q)));
            if (matches.length === 0) { indicator.hidden = true; return; }
            // Same query as last Enter → advance (wrap); new query → start at 0.
            if (q === cycleKey) cycleIdx = (cycleIdx + 1) % matches.length;
            else { cycleKey = q; cycleIdx = 0; }
            const node = matches[cycleIdx];
            // Close the dropdown if one is open (full page / fullscreen).
            const drop = container.querySelector('.lin-search-drop');
            if (drop) drop.hidden = true;
            // Reuse the working single-node path — focus + centre + zoom in.
            revealTo(node.id);
            focusNode(node.id, { openPanel: !embed, pushState: !embed });
            // Highlight ONLY the current match so exactly one node lights up.
            state.searchHits = new Set([node.id]);
            requestDraw();
            showCount(node.primary || (node.names && node.names[0]) || '', cycleIdx, matches.length);
        });
    }

    // ── control buttons ──
    // Two controls, two distinct jobs (user feedback 2026-07-15):
    //   ⛶  fit the whole chart in view (zoom/pan reset; never changes mode)
    //   toggle  switches full chart <-> key-masters (spine) view; its label is
    //           always the ACTION it would take, so it can never claim to take
    //           you somewhere you already are.
    const toggle = container.querySelector('.lin-toggle');
    function updateModeUI() {
        if (!toggle) return;
        toggle.textContent = state.mode === 'all'
            ? 'Show key masters only'
            : 'Show all 965 masters';
    }
    const btnRow = container.querySelector('.lin-btnrow');
    if (btnRow) btnRow.addEventListener('click', (e) => {
        const b = e.target.closest('[data-act]'); if (!b) return;
        const act = b.dataset.act;
        if (act === 'in') zoomAt(state.width / 2, state.height / 2, 1.3);
        else if (act === 'out') zoomAt(state.width / 2, state.height / 2, 0.77);
        else if (act === 'reset') fitAll();
    });
    if (toggle) toggle.addEventListener('click', () => {
        state.mode = state.mode === 'all' ? 'spine' : 'all';
        state.expanded.clear();
        updateModeUI();
        rebuild(); fitAll();
    });
    updateModeUI();

    // ── fullscreen (present in BOTH the embed and the full #/lineage page) ──
    // The chart element (the wrap on the landing embed, .lin-root on the full
    // page) goes fullscreen. Native Fullscreen API when available; a fixed
    // full-viewport overlay as a graceful fallback. Either way the canvas
    // backing store is rebuilt and the whole scroll re-fit to the new box, so
    // the legend + pan/zoom stay usable and both themes keep working (tokens
    // still cascade from :root while the element is fullscreen).
    let fsFallback = false;
    const fsBtn = document.createElement('button');
    fsBtn.type = 'button';
    fsBtn.className = 'lin-fs-btn';
    fsBtn.setAttribute('aria-label', 'Enter fullscreen');
    fsBtn.title = 'Fullscreen';
    fsBtn.textContent = '⤢'; // ⤢ enter-fullscreen glyph
    container.appendChild(fsBtn);

    const nativeFsEl = () => document.fullscreenElement || document.webkitFullscreenElement || null;
    function isFs() { return fsFallback || nativeFsEl() === container; }
    function reflowFs() {
        // The box just changed size — rebuild the canvas backing store and
        // re-fit the whole chart. A second pass catches the browser settling
        // the new fullscreen box a frame late.
        resize(); fitAll();
        setTimeout(() => { if (canvas.isConnected) { resize(); fitAll(); } }, 60);
    }
    function syncFsBtn() {
        const on = isFs();
        fsBtn.textContent = on ? '⤡' : '⤢'; // ⤡ exit / ⤢ enter
        fsBtn.setAttribute('aria-label', on ? 'Exit fullscreen' : 'Enter fullscreen');
        fsBtn.title = on ? 'Exit fullscreen' : 'Fullscreen';
    }

    // In fullscreen the chart element is the ONLY visible element, so a search
    // input living OUTSIDE it (the landing embed's input is a sibling of the
    // wrap) would disappear. Move the real input node — its event listeners
    // travel with it — into a floating overlay inside the container, giving it
    // its own dropdown; restore it verbatim on exit (no duplication, no lost
    // listeners). The full page's input already lives inside the container and
    // floats on top there, so it is left untouched.
    let searchHome = null, fsSearchWrap = null;
    function mountSearchOverlay() {
        if (!searchInput || fsSearchWrap) return;
        if (container.contains(searchInput)) return; // already inside (full page)
        searchHome = { parent: searchInput.parentNode, next: searchInput.nextSibling };
        fsSearchWrap = document.createElement('div');
        fsSearchWrap.className = 'lin-fs-search';
        const drop = document.createElement('div');
        drop.className = 'lin-search-drop';
        drop.hidden = true;
        fsSearchWrap.appendChild(searchInput); // MOVE (keeps listeners intact)
        fsSearchWrap.appendChild(drop);
        container.appendChild(fsSearchWrap);
    }
    function unmountSearchOverlay() {
        if (!fsSearchWrap) return;
        if (searchHome && searchHome.parent) {
            const { parent, next } = searchHome;
            if (next && next.parentNode === parent) parent.insertBefore(searchInput, next);
            else parent.appendChild(searchInput);
        }
        fsSearchWrap.remove();
        fsSearchWrap = null; searchHome = null;
    }
    // Single post-transition sync: button glyph, floating search, re-fit.
    function afterFsChange() {
        syncFsBtn();
        if (isFs()) mountSearchOverlay(); else unmountSearchOverlay();
        reflowFs();
    }
    function enterFallback() {
        fsFallback = true;
        container.classList.add('lin-fs-fallback');
        afterFsChange();
    }
    function exitFallback() {
        fsFallback = false;
        container.classList.remove('lin-fs-fallback');
        afterFsChange();
    }
    function enterFs() {
        const req = container.requestFullscreen || container.webkitRequestFullscreen;
        if (req) {
            try { Promise.resolve(req.call(container)).catch(enterFallback); }
            catch { enterFallback(); }
        } else { enterFallback(); }
    }
    function exitFs() {
        if (fsFallback) { exitFallback(); return; }
        const ex = document.exitFullscreen || document.webkitExitFullscreen;
        if (ex) { try { ex.call(document); } catch { /* ignore */ } }
    }
    function toggleFs() { if (isFs()) exitFs(); else enterFs(); }
    fsBtn.addEventListener('click', toggleFs);
    // Native API exits (Esc / browser chrome) fire this; keep the button + fit
    // in sync. isFs() is container-scoped, so another element's change is inert.
    function onFsChange() { afterFsChange(); }
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);

    // ── keyboard ──
    function onKey(e) {
        if (!canvas.isConnected) return;
        if (e.key === 'Escape') {
            // The native Fullscreen API handles its own Esc; the fixed-overlay
            // fallback does not, so exit it here first.
            if (fsFallback) { exitFallback(); return; }
            if (state.focused) { clearFocus(); if (panel) panel.hide(); }
            else fitAll();   // second Esc = step out to the whole chart
            return;
        }
        if (!state.focused) return;
        const f = byId.get(state.focused);
        if (!f) return;
        let target = null;
        if (e.key === 'ArrowUp' && f.parentEdge) target = f.parentEdge.from;
        else if (e.key === 'ArrowDown' && f.childEdges[0]) target = f.childEdges[0].to;
        else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && f.parentEdge) {
            const sib = f.parentEdge.from.childEdges.map(x => x.to);
            const idx = sib.indexOf(f);
            target = sib[idx + (e.key === 'ArrowRight' ? 1 : -1)];
        } else if (e.key === 'Enter' && panel) { panel.show(f, panelCtx); return; }
        if (target) { e.preventDefault(); revealTo(target.id); focusNode(target.id, { openPanel: !!panel && !panel.el.hidden, pushState: !target.isSource }); }
    }
    window.addEventListener('keydown', onKey);

    // ── popstate (browser Back walks focus history) ──
    function onPop() {
        const m = location.hash.match(/focus=([^&]+)/);
        if (m) { const id = decodeURIComponent(m[1]).replace(/_/g, ' '); revealTo(id); focusNode(id, { openPanel: !embed, pushState: false }); }
        else { clearFocus(); if (panel) panel.hide(); }
    }
    window.addEventListener('popstate', onPop);

    // ── theme observer ──
    const themeObs = new MutationObserver(() => {
        TOK = readTokens(container); DARK = isDark();
        if (legendEl) buildLegend(legendEl, embed);
        requestDraw();
    });
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-palette'] });

    // ── teardown ──
    function teardown() {
        window.removeEventListener('resize', resize);
        window.removeEventListener('keydown', onKey);
        window.removeEventListener('popstate', onPop);
        window.removeEventListener('mouseup', onUp);
        document.removeEventListener('fullscreenchange', onFsChange);
        document.removeEventListener('webkitfullscreenchange', onFsChange);
        if (fsFallback) { fsFallback = false; container.classList.remove('lin-fs-fallback'); }
        unmountSearchOverlay(); // restore a relocated search input to its home
        if (fsBtn) fsBtn.remove();
        themeObs.disconnect();
        if (tip) tip.remove();
    }
    const onUp = () => { state.dragging = false; };
    window.addEventListener('mouseup', onUp);

    // ── fit ──
    function fitAll() {
        recomputeRel();
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const n of vnodes) {
            minX = Math.min(minX, n.x - halfW(n)); maxX = Math.max(maxX, n.x + halfW(n));
            minY = Math.min(minY, n.y - NODE_H); maxY = Math.max(maxY, n.y + NODE_H);
        }
        if (!isFinite(minX)) { requestDraw(); return; }
        const gw = maxX - minX + 80, gh = maxY - minY + 80;
        const z = Math.min(state.width / gw, state.height / gh, embed ? 0.55 : 1);
        state.zoom = Math.max(ZOOM_MIN, z);
        state.panX = state.width / 2 - (minX + maxX) / 2 * state.zoom;
        state.panY = (embed ? 20 : 40) - minY * state.zoom;
        requestDraw();
    }

    // ── init ──
    window.addEventListener('resize', resize);
    resize();

    if (focusName) {
        const fn = focusName.replace(/_/g, ' ').toLowerCase();
        const node = nodes.find(n => n.names.some(nm => nm.toLowerCase() === fn));
        if (node) { revealTo(node.id); setTimeout(() => focusNode(node.id, { openPanel: !embed, pushState: false }), 60); }
        else fitAll();
    } else {
        fitAll();
    }
    setTimeout(fitAll, 60); // after first real size
}

// ── helpers ──
function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

function readTokens(el) {
    const cs = getComputedStyle(el);
    const g = (v, f) => (cs.getPropertyValue(v).trim() || f);
    return {
        text: g('--text', '#ede3d1'),
        textSoft: g('--text-soft', '#cbbfa9'),
        muted: g('--muted', '#8b7b69'),
        accent: g('--accent', '#d4ab58'),
        bgSoft: g('--bg-soft', '#13100c'),
        border: g('--border', 'rgba(211,180,112,0.16)'),
    };
}
function isDark() {
    const cs = getComputedStyle(document.documentElement).colorScheme || '';
    if (cs.includes('dark')) return true;
    if (cs.includes('light')) return false;
    const t = document.documentElement.getAttribute('data-theme');
    if (t === 'light') return false;
    return true;
}
function isDev() {
    try {
        return location.hostname === 'localhost' || location.hostname === '127.0.0.1' ||
            localStorage.getItem('lineageDebug') === '1';
    } catch { return false; }
}
function withAlpha(hsl, a) {
    // hsl(H S% L%) -> hsla(H S% L% / a)
    const m = hsl.match(/hsl\(([^)]+)\)/);
    return m ? `hsla(${m[1]} / ${a})` : hsl;
}
function tDistf(t) { const dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY; return Math.hypot(dx, dy); }
function tMidf(t) { return { x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 }; }

// ── legend (§2.9) — the chart's thesis in ~40 words ──
function buildLegend(el, embed) {
    const hueChip = (key, label) => {
        const hue = SCHOOL_HUES[key];
        const bg = hue == null ? 'var(--muted)' : `hsl(${hue} 40% 55%)`;
        return `<span class="lin-leg-school"><span class="lin-leg-sw" style="background:${bg}"></span>${label}</span>`;
    };
    el.innerHTML = `
        <div class="lin-leg-head">Key <button class="lin-leg-toggle" aria-label="Toggle legend">▾</button></div>
        <div class="lin-leg-body">
            <div class="lin-leg-sec">
                <div class="lin-leg-att"><span class="lin-leg-line lin-leg-line--a"></span><b>A</b> his own words, or his stone</div>
                <div class="lin-leg-att"><span class="lin-leg-line lin-leg-line--b"></span><b>B</b> a living witness</div>
                <div class="lin-leg-att"><span class="lin-leg-line lin-leg-line--c"></span><b>C</b> a lineage index</div>
                <div class="lin-leg-att"><span class="lin-leg-line lin-leg-line--d"></span><b>D</b> a lamp record only</div>
            </div>
            <div class="lin-leg-sec lin-leg-glyphs">
                <span>○ posthumous</span><span>◇ by proxy</span><span>▤ from a book</span><span>⊣… teacher off-chart</span>
            </div>
            <div class="lin-leg-sec lin-leg-seal"><span class="lin-leg-sealmark"></span> contested: an earlier source disagrees. Click it.</div>
            <div class="lin-leg-sec lin-leg-schools">
                ${hueChip('linji', 'Linji')}${hueChip('caodong', 'Caodong')}${hueChip('yunmen', 'Yunmen')}${hueChip('fayan', 'Fayan')}${hueChip('guiyang', 'Guiyang')}${hueChip('hongzhou', 'Hongzhou')}${hueChip('shitou', 'Shitou')}${hueChip('niutou', 'Niutou')}${hueChip('heze', 'Heze')}${hueChip('korean-seon', 'Korean Seon')}${hueChip('early-chan', 'Early Chan')}${hueChip('pre-chan', 'Pre-Chan')}
            </div>
        </div>`;
    const t = el.querySelector('.lin-leg-toggle');
    if (t) t.addEventListener('click', () => el.classList.toggle('lin-leg--collapsed'));
    if (embed) el.classList.add('lin-leg--collapsed');
}
