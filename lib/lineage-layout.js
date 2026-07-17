// lib/lineage-layout.js
// Tidy-forest layout — the hanging scroll, done properly this time.
//
// The lineage graph is a strict FOREST (every master has at most one parent
// edge), so the general Sugiyama pipeline the first version used was the wrong
// tool: its barycenter passes let subtrees drift thousands of pixels sideways,
// which put a teacher and his heir at nearly the same height joined by a long
// horizontal wire (world ~26,000px wide). This version is a Reingold–Tilford
// style contour packing instead:
//
//   - every parent is centered ABOVE its children block, so edges read as
//     mostly-vertical descent by construction (no crossing tree edges at all);
//   - sibling subtrees pack against each other's per-layer contours, so the
//     world is as narrow as the tree allows;
//   - runs of >= STACK_MIN sibling CHAINS fold into vertical columns (read
//     top-to-bottom, like a stele's disciple roster) instead of one wide
//     horizontal row — breadth becomes depth. A "chain" is a single leaf OR
//     an unbranched line of single-child descendants down to one (943-master
//     roster update, 2026-07: generalized past depth-1 so hubs with many
//     short unbranched side-successions, not just single-node leaves, still
//     collapse into shared columns instead of one column each);
//   - LAYER_PITCH grew 96 -> 150 so each generation gets real vertical run.
//
// Overlap safety: packing guarantees node separation by construction, and the
// only multi-layer edges are the stack drop-lines, which are routed down a
// reserved gutter to the LEFT of each stack column (the gutter is part of the
// stack block's contour, so nothing else can occupy it). Plain parent->child
// edges span exactly one layer and live entirely in the inter-layer channel,
// which contains no boxes. assertNoOverlaps() remains the ratchet.
//
// DOM-free, so the overlap assertion runs headless in Node as well as in the
// browser in dev mode.

export const NODE_W = 132;
export const NODE_H = 40;
export const SOURCE_W = 44;
export const LAYER_PITCH = 150;    // 40 node + 110 edge channel

const GAP_SIBLING = 18;            // gutter between sibling subtree contours
const GAP_TREE = 30;               // gutter between separate root trees
const STACK_MIN = 2;               // >= this many sibling chains fold vertical
const STACK_COL_ROWS = 40;         // target rows per stack column
const STACK_COLS_MAX = 2;
const STACK_GUT = 16;              // drop-line gutter left of every stack column

function widthOf(n) { return (n.isSource || n.capsule) ? SOURCE_W : NODE_W; }
function halfW(n) { return widthOf(n) / 2; }

// Contiguous school bands: Linji left-of-center, Caodong right, houses fanning.
const SCHOOL_ORDER = {
    niutou: -6, 'early-chan': -5, heze: -4, hongzhou: -3, linji: -2,
    guiyang: -1, source: 0, 'pre-chan': 0, other: 0,
    shitou: 2, caodong: 3, fayan: 4, yunmen: 5, 'korean-seon': 8,
};
function schoolRank(n) {
    if (n.korean) return 8;
    return SCHOOL_ORDER[n.schoolKey] ?? 0;
}

/**
 * Compute a full layout in place. Assigns layer/x/y to every node in `nodes`
 * and fills `edge.points` (routing polyline).
 * @param {Object[]} nodes  visible real nodes (+ book sources + capsules)
 * @param {Object[]} edges  visible edges among them
 * @returns {{width:number, height:number, minX:number, maxX:number}}
 */
export function computeLayout(nodes, edges) {
    for (const n of nodes) { n.layer = -1; n.stack = null; n.x = 0; }

    // adjacency — book-source edges are ANNOTATIONS, not tree edges (a master
    // can hold several books, which would break the forest invariant). They
    // are collected per master and the books are shelved above him later.
    const outR = new Map(), inR = new Map();
    const sourcesOf = new Map();               // master -> [{src, edge}]
    for (const n of nodes) { outR.set(n, []); inR.set(n, []); }
    for (const e of edges) {
        if (!outR.has(e.from) || !inR.has(e.to)) continue;
        if (e.from.isSource) {
            if (!sourcesOf.has(e.to)) sourcesOf.set(e.to, []);
            sourcesOf.get(e.to).push({ src: e.from, edge: e });
            continue;
        }
        outR.get(e.from).push(e); inR.get(e.to).push(e);
    }

    // ── Stage 1: layering (generation = depth; dates nudge parentless nodes) ──
    const roots = nodes.filter(n => !n.isSource && inR.get(n).length === 0);
    assignLongestPath(nodes, outR, inR, roots);
    dateNudge(nodes, inR, outR);
    assignLongestPath(nodes, outR, inR, roots, /*keepMin*/ true);

    // normalize min layer to 0
    let minLayer = Infinity;
    for (const n of nodes) if (n.layer < minLayer) minLayer = n.layer;
    if (minLayer !== 0 && isFinite(minLayer)) for (const n of nodes) n.layer -= minLayer;

    // children lists (tree edges; a node is positioned under its FIRST parent)
    const childrenOf = new Map();
    for (const n of nodes) childrenOf.set(n, []);
    const seenChild = new Set();
    for (const e of edges) {
        if (!outR.has(e.from) || !inR.has(e.to) || e.from.isSource) continue;
        if (seenChild.has(e.to)) continue;      // defensive: forest by contract
        seenChild.add(e.to);
        childrenOf.get(e.from).push(e.to);
    }

    // ── Stage 2: chain stacking — sibling runs with NO branching anywhere in
    // them become vertical columns. A "chain" (single leaf, or an unbranched
    // line of single-child descendants down to a leaf) has zero lateral width
    // of its own by construction, so folding a run of >= STACK_MIN of them
    // into a shared column costs nothing but depth — the same "breadth
    // becomes depth" idea the old pure-leaf-only version used, generalized
    // past depth-1 so a hub with many short unbranched successions (common:
    // one famous heir + a handful of 2-4-generation side lines) doesn't burn
    // one full-width column per side line.
    function isPureChain(n) {
        if (sourcesOf.has(n)) return false;      // a book shelf needs its own width
        const kids = childrenOf.get(n);
        if (kids.length > 1) return false;
        for (const k of kids) if (!isPureChain(k)) return false;
        return true;
    }
    function chainNodes(n) {
        const arr = [n];
        let cur = n;
        for (; ;) {
            const kids = childrenOf.get(cur);
            if (!kids.length) break;
            cur = kids[0];
            arr.push(cur);
        }
        return arr;
    }
    const chainOf = new Map();   // chain head node -> full chain node array
    for (const p of nodes) {
        const kids = childrenOf.get(p);
        if (!kids || !kids.length) continue;
        const heads = kids.filter(k => !k.isSource && !k.capsule && isPureChain(k));
        if (heads.length < STACK_MIN) continue;
        const chains = heads.map(k => chainNodes(k)).sort((a, b) =>
            (a[0].year || 9999) - (b[0].year || 9999) ||
            (a[0].id || '').localeCompare(b[0].id || ''));
        const totalRows = chains.reduce((s, c) => s + c.length, 0);
        const cols = Math.max(1, Math.min(STACK_COLS_MAX,
            Math.ceil(totalRows / STACK_COL_ROWS)));
        const targetPerCol = totalRows / cols;
        // sequential fill, chronological within and across columns (reads
        // top-to-bottom then left-to-right, like the old leaf stacks), but
        // moves to the next column by accumulated ROW WEIGHT rather than by
        // item count, since chains vary in length.
        const colRows = new Array(cols).fill(0);
        let col = 0;
        for (const chain of chains) {
            if (col < cols - 1 && colRows[col] > 0 &&
                colRows[col] + chain.length / 2 > targetPerCol) col++;
            const startRow = colRows[col];
            chain.forEach((node, i) => { node.layer = p.layer + 1 + startRow + i; });
            chain[0].stack = { parent: p, col, row: startRow, cols };
            chainOf.set(chain[0], chain);
            colRows[col] += chain.length;
        }
    }

    // ── Stage 3: tidy contour packing (Reingold–Tilford over the forest) ──
    function contourAdd(contour, layer, min, max) {
        const e = contour.get(layer);
        if (!e) contour.set(layer, { min, max });
        else { e.min = Math.min(e.min, min); e.max = Math.max(e.max, max); }
    }
    function shiftFor(merged, contour, gap) {
        let delta = -Infinity;
        for (const [L, e] of contour) {
            const m = merged.get(L);
            if (m) delta = Math.max(delta, m.max + gap - e.min);
        }
        return isFinite(delta) ? delta : 0;
    }
    function shiftForLeft(merged, contour, gap) {
        let delta = Infinity;
        for (const [L, e] of contour) {
            const m = merged.get(L);
            if (m) delta = Math.min(delta, m.min - gap - e.max);
        }
        return isFinite(delta) ? delta : 0;
    }
    function applyShift(list, dx) { if (dx) for (const n of list) n.x += dx; }
    function mergeInto(merged, contour, dx) {
        for (const [L, e] of contour) contourAdd(merged, L, e.min + dx, e.max + dx);
        return merged;
    }

    function layoutStack(heads) {
        // vertical columns; every column reserves a drop-line gutter on its left.
        // Each head may carry a whole chain of descendants below it in the SAME
        // column (see Stage 2) — every node in every chain gets an x and a
        // contour entry at its own layer, so overlap-safety holds row by row.
        const colPitch = NODE_W + STACK_GUT;
        const contour = new Map();
        const list = [];
        for (const h of heads) {
            const x = h.stack.col * colPitch;
            for (const node of chainOf.get(h)) {
                node.x = x;
                contourAdd(contour, node.layer,
                    x - NODE_W / 2 - STACK_GUT, x + NODE_W / 2);
                list.push(node);
            }
        }
        let mn = Infinity, mx = -Infinity;
        for (const [, e] of contour) { mn = Math.min(mn, e.min); mx = Math.max(mx, e.max); }
        return { list, contour, anchor: (mn + mx) / 2 };
    }

    // Book sources: shelved in a row directly ABOVE their master, inside his
    // subtree's contour so nothing else can pack into that shelf.
    function shelveSources(n, list, contour) {
        const srcs = sourcesOf.get(n);
        if (!srcs || !srcs.length) return;
        const pitch = SOURCE_W + 12;
        const total = srcs.length * pitch - 12;
        srcs.forEach(({ src, edge }, i) => {
            src.layer = n.layer - 1;
            src.x = n.x - total / 2 + SOURCE_W / 2 + i * pitch;
            edge.fromPort = 0;
            edge.toPort = srcs.length > 1
                ? (i - (srcs.length - 1) / 2) * Math.min(NODE_W / (srcs.length + 1), 22) : 0;
            list.push(src);
        });
        contourAdd(contour, n.layer - 1, n.x - total / 2, n.x + total / 2);
    }

    function layoutSubtree(n) {
        const all = childrenOf.get(n);
        const stacked = all.filter(k => k.stack && k.stack.parent === n);
        const items = all.filter(k => !(k.stack && k.stack.parent === n))
            .sort((a, b) => schoolRank(a) - schoolRank(b) ||
                (a.year || 9999) - (b.year || 9999) ||
                (a.id || '').localeCompare(b.id || ''));
        if (!items.length && !stacked.length) {
            n.x = 0;
            const contour = new Map();
            contourAdd(contour, n.layer, -halfW(n), halfW(n));
            const list = [n];
            shelveSources(n, list, contour);
            return { list, contour, anchor: 0 };
        }
        let merged = null;
        const list = [n];
        const anchors = [];
        const weights = [];
        const place = (r, w) => {
            const delta = merged ? shiftFor(merged, r.contour, GAP_SIBLING) : 0;
            applyShift(r.list, delta);
            merged = mergeInto(merged || new Map(), r.contour, delta);
            for (const m of r.list) list.push(m);
            anchors.push(r.anchor + delta);
            weights.push(w);
        };
        for (const c of items) place(layoutSubtree(c), Math.sqrt(sizeOf.get(c) || 1));
        if (stacked.length) {
            const stackedRows = stacked.reduce((s, h) => s + chainOf.get(h).length, 0);
            place(layoutStack(stacked), Math.sqrt(stackedRows));
        }
        // Size-weighted centering (sqrt-damped): the trunk leans over its
        // heavier branches — the main descent line runs near-straight, like a
        // real genealogy scroll — without fully orphaning the light twigs.
        let wSum = 0, wx = 0;
        for (let i = 0; i < anchors.length; i++) { wSum += weights[i]; wx += anchors[i] * weights[i]; }
        n.x = wSum > 0 ? wx / wSum : (anchors[0] + anchors[anchors.length - 1]) / 2;
        contourAdd(merged, n.layer, n.x - halfW(n), n.x + halfW(n));
        shelveSources(n, list, merged);
        return { list, contour: merged, anchor: n.x };
    }

    // subtree sizes so the great tree packs first and small trees tuck after
    const sizeOf = new Map();
    function measure(n) {
        if (sizeOf.has(n)) return sizeOf.get(n);
        sizeOf.set(n, 1);
        let s = 1;
        for (const c of childrenOf.get(n)) s += measure(c);
        sizeOf.set(n, s);
        return s;
    }
    for (const r of roots) measure(r);
    const orderedRoots = roots.slice().sort((a, b) =>
        (sizeOf.get(b) || 0) - (sizeOf.get(a) || 0) ||
        (a.year || 9999) - (b.year || 9999) ||
        (a.id || '').localeCompare(b.id || ''));

    // Pack root trees around the great tree, LEFT or RIGHT, whichever grows
    // the world less — unresolved-teacher subtrees become wings, not a tail.
    const global = new Map();
    let gMin = Infinity, gMax = -Infinity;
    for (const r of orderedRoots) {
        const res = layoutSubtree(r);
        let cMin = Infinity, cMax = -Infinity;
        for (const [, e] of res.contour) { cMin = Math.min(cMin, e.min); cMax = Math.max(cMax, e.max); }
        let delta = 0;
        if (global.size) {
            const dR = shiftFor(global, res.contour, GAP_TREE);
            const dL = shiftForLeft(global, res.contour, GAP_TREE);
            const wR = Math.max(gMax, cMax + dR) - Math.min(gMin, cMin + dR);
            const wL = Math.max(gMax, cMax + dL) - Math.min(gMin, cMin + dL);
            delta = wL < wR ? dL : dR;
        }
        applyShift(res.list, delta);
        mergeInto(global, res.contour, delta);
        gMin = Math.min(gMin, cMin + delta);
        gMax = Math.max(gMax, cMax + delta);
    }

    // ── y + edge routing ──
    for (const n of nodes) n.y = n.layer * LAYER_PITCH;
    assignPorts(nodes, outR, inR);
    for (const e of edges) buildEdgePoints(e);

    // bounds
    let minX = Infinity, maxX = -Infinity, maxY = 0;
    for (const n of nodes) {
        minX = Math.min(minX, n.x - halfW(n));
        maxX = Math.max(maxX, n.x + halfW(n));
        maxY = Math.max(maxY, n.y + NODE_H / 2);
    }
    return { width: maxX - minX, height: maxY, minX, maxX };
}

function assignLongestPath(nodes, outR, inR, roots, keepMin) {
    if (!keepMin) for (const n of nodes) n.layer = -1;
    // Kahn topological order
    const indeg = new Map();
    for (const n of nodes) indeg.set(n, inR.get(n).length);
    const q = roots.slice();
    for (const r of q) if (r.layer < 0) r.layer = 0;
    const seen = new Set();
    let head = 0;
    while (head < q.length) {
        const n = q[head++];
        if (seen.has(n)) continue;
        seen.add(n);
        if (n.layer < 0) n.layer = 0;
        for (const e of outR.get(n)) {
            const c = e.to;
            if (c.layer < n.layer + 1) c.layer = n.layer + 1;
            indeg.set(c, indeg.get(c) - 1);
            if (indeg.get(c) <= 0) q.push(c);
        }
    }
    // any node left unlayered (cycle remnant): BFS relax
    for (const n of nodes) if (n.layer < 0) n.layer = 0;
    let changed = true, guard = 0;
    while (changed && guard++ < 100) {
        changed = false;
        for (const n of nodes) for (const e of outR.get(n)) {
            if (e.to.layer < n.layer + 1) { e.to.layer = n.layer + 1; changed = true; }
        }
    }
}

function dateNudge(nodes, inR, outR) {
    // Median year per layer — computed from the LARGEST root tree only (the
    // Bodhidharma line, ~70% of the chart). Unresolved-teacher subtrees start
    // piled at layer 0, so using them (or their children) in the curve would
    // drag the early layers to the Ming dynasty and wreck the year->layer
    // inversion that is about to place those very subtrees.
    const roots = nodes.filter(n => inR.get(n).length === 0);
    let mainRoot = null, mainSize = -1;
    const sizeOf = (r) => {
        let s = 0; const stack = [r]; let guard = 0;
        while (stack.length && guard++ < 5000) {
            const n = stack.pop(); s++;
            for (const e of outR.get(n) || []) stack.push(e.to);
        }
        return s;
    };
    for (const r of roots) {
        const s = sizeOf(r);
        if (s > mainSize) { mainSize = s; mainRoot = r; }
    }
    const inMain = new Set();
    if (mainRoot) {
        const stack = [mainRoot]; let guard = 0;
        while (stack.length && guard++ < 5000) {
            const n = stack.pop(); inMain.add(n);
            for (const e of outR.get(n) || []) stack.push(e.to);
        }
    }
    const byLayer = new Map();
    for (const n of nodes) {
        if (!n.year || !inMain.has(n)) continue;
        if (!byLayer.has(n.layer)) byLayer.set(n.layer, []);
        byLayer.get(n.layer).push(n.year);
    }
    const med = new Map();
    for (const [L, ys] of byLayer) {
        ys.sort((a, b) => a - b);
        med.set(L, ys[Math.floor(ys.length / 2)]);
    }
    const layersSorted = [...med.keys()].sort((a, b) => a - b);
    if (layersSorted.length < 2) return;
    const yearToLayer = (yr) => {
        // piecewise-linear inverse of layer->medianYear
        let lo = layersSorted[0], hi = layersSorted[layersSorted.length - 1];
        if (yr <= med.get(lo)) return lo;
        if (yr >= med.get(hi)) return hi;
        for (let i = 0; i < layersSorted.length - 1; i++) {
            const a = layersSorted[i], b = layersSorted[i + 1];
            const ya = med.get(a), yb = med.get(b);
            if (yr >= ya && yr <= yb && yb !== ya) {
                return a + (b - a) * (yr - ya) / (yb - ya);
            }
        }
        return lo;
    };
    // Only parentless nodes get nudged downward (keeps chains straight).
    // A root without its own dates borrows an estimate from its dated
    // descendants (year minus ~28y per generation) so an unresolved-teacher
    // subtree of Ming masters hangs in the Ming rows, not at the top edge.
    const estimateYear = (root) => {
        if (root.year) return root.year;
        const ests = [];
        const stack = [[root, 0]];
        let guard = 0;
        while (stack.length && guard++ < 2000) {
            const [n, d] = stack.pop();
            if (d > 0 && n.year) ests.push(n.year - 28 * d);
            for (const e of outR.get(n) || []) stack.push([e.to, d + 1]);
        }
        if (!ests.length) return null;
        ests.sort((a, b) => a - b);
        return ests[Math.floor(ests.length / 2)];
    };
    for (const n of nodes) {
        if (inR.get(n).length > 0) continue;
        const yr = estimateYear(n);
        if (!yr) continue;
        const est = Math.round(yearToLayer(yr));
        if (est > n.layer) n.layer = est;
    }
}

function assignPorts(nodes, outR, inR) {
    const routeX = (e) => e.to.stack
        ? e.to.x - halfW(e.to) - STACK_GUT / 2    // stack edges aim at the gutter
        : e.to.x;
    for (const n of nodes) {
        const outs = outR.get(n).slice().sort((a, b) => routeX(a) - routeX(b));
        const k = outs.length;
        outs.forEach((e, i) => {
            const spread = Math.min(NODE_W / (k + 1), 22);
            e.fromPort = k > 1 ? (i - (k - 1) / 2) * spread : 0;
        });
        const ins = inR.get(n).slice().sort((a, b) => a.from.x - b.from.x);
        const m = ins.length;
        ins.forEach((e, i) => {
            const spread = Math.min(NODE_W / (m + 1), 22);
            e.toPort = m > 1 ? (i - (m - 1) / 2) * spread : 0;
        });
    }
}

function buildEdgePoints(e) {
    if (e.to.stack) {
        // comb routing: diagonal into the column's reserved gutter inside the
        // teacher's edge channel, straight drop beside the column, short stub
        // into the leaf's left edge. The gutter is inside the stack block's
        // contour, so the drop can never cross a foreign box.
        const hw = halfW(e.to);
        const gx = e.to.x - hw - STACK_GUT / 2;
        e.points = [
            { x: e.from.x + (e.fromPort || 0), y: e.from.y + NODE_H / 2 },
            { x: gx, y: e.from.y + LAYER_PITCH - NODE_H / 2 - 8 },
            { x: gx, y: e.to.y },
            { x: e.to.x - hw, y: e.to.y },
        ];
        return;
    }
    e.points = [
        { x: e.from.x + (e.fromPort || 0), y: e.from.y + NODE_H / 2 },
        { x: e.to.x + (e.toPort || 0), y: e.to.y - NODE_H / 2 },
    ];
}

/**
 * Dev/headless overlap assertion (§1.6 stage 6).
 * @returns {{ok:boolean, nodeNode:number, edgeNode:number, samples:string[]}}
 */
export function assertNoOverlaps(nodes, edges) {
    const real = nodes.filter(n => !n.dummy);
    const issues = { ok: true, nodeNode: 0, edgeNode: 0, samples: [] };

    // node-node: only same-layer pairs can collide (layers differ in y >= pitch)
    const byLayer = new Map();
    for (const n of real) {
        if (!byLayer.has(n.layer)) byLayer.set(n.layer, []);
        byLayer.get(n.layer).push(n);
    }
    for (const [, arr] of byLayer) {
        arr.sort((a, b) => a.x - b.x);
        for (let i = 1; i < arr.length; i++) {
            const a = arr[i - 1], b = arr[i];
            const gap = (b.x - halfW(b)) - (a.x + halfW(a));
            if (gap < -0.01) {
                issues.ok = false; issues.nodeNode++;
                if (issues.samples.length < 8)
                    issues.samples.push(`NODE↔NODE L${a.layer}: ${a.id} / ${b.id} overlap ${gap.toFixed(1)}px`);
            }
        }
    }

    // edge-node: sample each edge polyline, test against non-endpoint node rects
    for (const e of edges) {
        const pts = e.points;
        if (!pts) continue;
        const spanLayers = new Set();
        for (let L = Math.min(e.from.layer, e.to.layer); L <= Math.max(e.from.layer, e.to.layer); L++) spanLayers.add(L);
        const candidates = [];
        for (const L of spanLayers) for (const n of (byLayer.get(L) || [])) {
            if (n === e.from || n === e.to) continue;
            candidates.push(n);
        }
        if (!candidates.length) continue;
        for (let s = 0; s < pts.length - 1; s++) {
            const p0 = pts[s], p1 = pts[s + 1];
            for (let t = 0; t <= 8; t++) {
                const x = p0.x + (p1.x - p0.x) * t / 8;
                const y = p0.y + (p1.y - p0.y) * t / 8;
                for (const n of candidates) {
                    if (x > n.x - halfW(n) && x < n.x + halfW(n) &&
                        y > n.y - NODE_H / 2 && y < n.y + NODE_H / 2) {
                        issues.ok = false; issues.edgeNode++;
                        if (issues.samples.length < 8)
                            issues.samples.push(`EDGE↔NODE ${e.from.id}->${e.to.id} hits ${n.id} @(${x.toFixed(0)},${y.toFixed(0)})`);
                        t = 99; s = pts.length; break;
                    }
                }
            }
        }
    }
    return issues;
}
