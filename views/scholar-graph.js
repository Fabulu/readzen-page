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
import { loadMasters } from './master.js';

// ── Title metadata loading ──
let _titlesMap = null;
async function loadTitlesMap() {
    if (_titlesMap) return _titlesMap;
    _titlesMap = new Map();
    try {
        const lines = [];
        await streamJsonl(DATA_REPO_BASE + 'titles.jsonl', obj => lines.push(obj));
        for (const t of lines) {
            if (t.path) _titlesMap.set(t.path, t);
        }
    } catch { /* titles unavailable */ }
    return _titlesMap;
}

// ── Node colors by type ──

const NODE_COLORS = ['#6EAFF8', '#FF8A65', '#FFB74D', '#81C784', '#AB47BC', '#D4A574', '#78909C'];

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
    'excerpted-from-book': '#D4A574',
    'appears-in':    '#D4A574',
    'book-contains': '#D4A574',
    'book-explores': '#D4A574',
    'book-attributed-to': '#D4A574',
    'book-records':  '#D4A574',
    'related-book':  '#D4A574',
    'commentary-on-book': '#51D996',
    'book-in-collection': '#AB47BC',
    'master-authored-book': '#D4A574',
    'spoken-by':           '#FF8A65',
    'passage-references-master': '#59B3FF',
    'influenced-by':       '#FF8A65',
    'belongs-to':          '#AB47BC',
    'passage-references-collection': '#59B3FF',
    'excerpted-from':      '#AB47BC',
    'formulated-by':       '#FF8A65',
    'concept-associated-with-master': '#59B3FF',
    'rejected-by':         '#FF6B6B',
    'featured-in-concept-collection': '#AB47BC',
    'central-to':          '#AB47BC',
    'concept-references-collection': '#59B3FF',
    'authored':            '#FF8A65',
    'master-commented-on': '#51D996',
    'endorsed':            '#51D996',
    'taught':              '#FF8A65',
    'developed':           '#51D996',
    'opposed':             '#FF6B6B',
    'coined':              '#FF8A65',
    'master-defined':      '#51D996',
    'popularized':         '#FF8A65',
    'subject-of':          '#AB47BC',
    'master-featured-in':  '#AB47BC',
    'preserved-in':        '#AB47BC',
    'used-in':             '#59B3FF',
    'defined-in-passage':  '#51D996',
    'exemplified-in':      '#59B3FF',
    'expresses':           '#59B3FF',
    'exemplifies':         '#59B3FF',
    'term-defines-concept':'#51D996',
    'coined-by':           '#FF8A65',
    'term-associated-with':'#59B3FF',
    'term-defined-by':     '#51D996',
    'synonym-of':          '#59B3FF',
    'antonym-of':          '#FF6B6B',
    'term-related-to':     '#FFB347',
    'variant-of':          '#59B3FF',
    'term-featured-in':    '#AB47BC',
    'defined-in-collection':'#51D996',
    'contains':            '#AB47BC',
    'collection-references-passage': '#59B3FF',
    'complements-passage': '#51D996',
    'explores':            '#59B3FF',
    'develops':            '#51D996',
    'collection-features-concept': '#AB47BC',
    'collection-features-master': '#AB47BC',
    'about':               '#59B3FF',
    'preserves':           '#AB47BC',
    'collection-defines':  '#51D996',
    'collection-features-term': '#AB47BC',
    'introduces':          '#51D996',
    'builds-on':           '#51D996',
    'complements-collection': '#59B3FF',
    'contrasts-with':      '#FF6B6B',
    'link-references-passage': '#78909C',
    'link-supports':       '#78909C',
    'link-about-master':   '#78909C',
    'link-references-book':'#78909C',
    'related-link':        '#78909C',
    'passage-references-link': '#78909C',
    'concept-references-link': '#78909C',
};
const DEFAULT_EDGE_COLOR = '#9E9E9E';

const NON_DIRECTIONAL_TYPES = new Set([
    'parallels', 'is-variant-of', 'opposes', 'related-to', 'same-school', 'cross-ref', 'related-book',
    'synonym-of', 'antonym-of', 'term-related-to', 'variant-of', 'complements-collection', 'contrasts-with',
    'related-link',
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
                <label style="display:none;align-items:center;gap:4px;margin-top:8px;font-size:11px;color:#B8B8C8;cursor:pointer">
                    <input type="checkbox" id="scholar-physics-toggle" />
                    Physics
                </label>
                <label style="display:flex;align-items:center;gap:4px;margin-top:4px;font-size:11px;color:#B8B8C8;cursor:pointer">
                    <input type="checkbox" id="scholar-minimap-toggle" checked />
                    Minimap
                </label>
                <label style="display:flex;align-items:center;gap:4px;margin-top:4px;font-size:11px;color:#B8B8C8;cursor:pointer">
                    <input type="checkbox" id="scholar-clusters-toggle" />
                    Clusters
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

    // Update title with actual collection name
    const collectionName = collection.name || collection.Name || collectionId;
    if (shell) shell.setTitle(`Scholar Graph \u00b7 ${collectionName}`);

    const passages = collection.passages || collection.Passages || [];
    const links = collection.links || collection.Links || [];
    const graphLayout = collection.graphLayout || collection.GraphLayout || null;

    // Suppressed nodes and edges
    const suppressedNodes = new Set(collection.suppressedAutoNodeIds || collection.SuppressedAutoNodeIds || []);
    const suppressedEdges = new Set(collection.suppressedAutoEdgeIds || collection.SuppressedAutoEdgeIds || []);

    // Custom edge type colors and display names
    const customEdgeTypes = collection.customEdgeTypes || collection.CustomEdgeTypes || [];
    const edgeNameMap = {};
    for (const ct of customEdgeTypes) {
        const id = ct.id || ct.Id || '';
        const color = ct.colorHex || ct.ColorHex || '';
        const name = ct.displayName || ct.DisplayName || '';
        if (id && color) EDGE_COLORS[id] = color;
        if (id && name) edgeNameMap[id] = name;
    }

    // Node annotations
    const nodeAnnotations = collection.nodeAnnotations || collection.NodeAnnotations || {};

    // Schema v2 support
    const schemaVersion = collection.schemaVersion || collection.SchemaVersion || 1;
    const concepts = collection.concepts || collection.Concepts || [];
    const newEdges = collection.edges || collection.Edges || [];

    // Find sub-collections whose parent is this collection
    const collId = collection.id || collection.Id || '';
    const subCollections = collections.filter(c => {
        const parentId = c.parentCollectionId || c.ParentCollectionId || '';
        return parentId === collId;
    });

    if (passages.length === 0 && concepts.length === 0 && subCollections.length === 0) {
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
            type: (p.annotationType || p.AnnotationType || '').toLowerCase() === 'book' ? 5 : 0,
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
            if (nodeMap.has(masterId) || suppressedNodes.has(masterId)) continue;
            nodeMap.set(masterId, {
                id: masterId,
                type: 2,
                label: masterName,
                x: 0, y: 0, vx: 0, vy: 0, degree: 0,
            });
        }
    }

    // ExtraMasters (manually-added masters not derived from passages)
    const extraMasters = collection.extraMasters || collection.ExtraMasters || [];
    for (const name of extraMasters) {
        const masterId = 'master:' + name;
        if (nodeMap.has(masterId) || suppressedNodes.has(masterId)) continue;
        nodeMap.set(masterId, {
            id: masterId, type: 2, label: name,
            x: 0, y: 0, vx: 0, vy: 0, degree: 0,
        });
    }

    // Link nodes (web references)
    const linkNodes = collection.linkNodes || collection.LinkNodes || [];
    for (const ln of linkNodes) {
        const lid = ln.id || ln.Id || '';
        if (!lid) continue;
        const linkId = 'link:' + lid;
        if (nodeMap.has(linkId)) continue;
        nodeMap.set(linkId, {
            id: linkId, type: 6,
            label: ln.name || ln.Name || 'Link',
            url: ln.url || ln.Url || '',
            description: ln.description || ln.Description || '',
            x: 0, y: 0, vx: 0, vy: 0, degree: 0,
        });
    }

    // Enrich master nodes with full names and metadata from masters.json
    loadMasters().then(masters => {
        if (!masters || !masters.length) return;
        for (const [id, node] of nodeMap) {
            if (node.type !== 2) continue;
            const name = id.startsWith('master:') ? id.slice(7) : node.label;
            const m = masters.find(r =>
                (r.names || []).some(n => n === name || (n && n.toLowerCase() === name.toLowerCase())));
            if (!m) continue;
            if (m.names && m.names[0]) node.label = m.names[0];
            if (m.floruit && m.death) node.dates = `${m.floruit}\u2013${m.death}`;
            else if (m.floruit) node.dates = `fl. ${m.floruit}`;
            else if (m.death) node.dates = `d. ${m.death}`;
            node.masterData = m;
        }
        draw();
    }).catch(() => {});

    // Sub-collections → type 4
    for (const sc of subCollections) {
        const scId = sc.id || sc.Id || '';
        if (!scId || nodeMap.has(scId) || suppressedNodes.has(scId)) continue;
        const scName = sc.name || sc.Name || 'Sub-collection';
        const scPassages = sc.passages || sc.Passages || [];
        const scDesc = sc.description || sc.Description || '';
        nodeMap.set(scId, {
            id: scId,
            type: 4,
            label: scName,
            description: scDesc,
            ownerUser: user,
            passageCount: scPassages.length,
            x: 0, y: 0, vx: 0, vy: 0, degree: 0,
        });
    }

    // CollectionRefs (explicit references to other collections)
    const collectionRefs = collection.collectionRefs || collection.CollectionRefs || [];
    for (const ref of collectionRefs) {
        const refId = ref.collectionId || ref.CollectionId || '';
        if (!refId) continue;
        const nodeId = 'collection:' + refId;
        if (nodeMap.has(nodeId) || suppressedNodes.has(nodeId)) continue;
        nodeMap.set(nodeId, {
            id: nodeId, type: 4,
            label: ref.collectionName || ref.CollectionName || 'Collection',
            ownerUser: ref.ownerUsername || ref.OwnerUsername || user,
            x: 0, y: 0, vx: 0, vy: 0, degree: 0,
        });
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
                const weight = parseFloat(edge.weight || edge.Weight || '1') || 1.0;
                edges.push({ from: fromNode, to: toNode, relationType: relType, weight, colorHex: edge.colorHex || edge.ColorHex || '' });
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
                const weight = parseFloat(link.weight || link.Weight || '1') || 1.0;
                edges.push({ from: fromNode, to: toNode, relationType: relType, weight, colorHex: link.colorHex || link.ColorHex || '' });
            }
        }
    }

    // Auto-edges: connect passages to their masters (like desktop app)
    const edgePairSet = new Set(edges.map(e => e.from.id + '|' + e.to.id));
    for (const p of passages) {
        const pid = p.id || p.Id || '';
        const masters = p.masterNames || p.MasterNames || [];
        if ((p.annotationType || p.AnnotationType || '').toLowerCase() === 'book') continue;
        for (const mn of masters) {
            const masterId = 'master:' + mn;
            const autoEdgeId = `auto:attributed:${pid}\u2192${masterId}`;
            if (suppressedEdges.has(autoEdgeId)) continue;
            const fromNode = nodeMap.get(pid);
            const toNode = nodeMap.get(masterId);
            if (fromNode && toNode) {
                if (edgePairSet.has(pid + '|' + masterId) || edgePairSet.has(masterId + '|' + pid)) continue;
                fromNode.degree++;
                toNode.degree++;
                edges.push({ from: fromNode, to: toNode, relationType: 'attributed-to', weight: 0.5, colorHex: '', isAuto: true });
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
    initGraph(canvas, nodes, edges, collectionId, user, graphLayout, nodeAnnotations, edgeNameMap);
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
    const alpha = 0.0025;   // halved vs desktop 0.005 to compensate for ~60fps

    // Gravity pulls toward FIXED canvas center (not center of mass which drifts)
    const cx = (state.width / 2 - state.panX) / state.zoom;
    const cy = (state.height / 2 - state.panY) / state.zoom;

    // Dampen existing velocities
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

    // Gravity toward fixed viewport center
    for (const n of nodes) {
        if (n.pinned) continue;
        n.vx -= (n.x - cx) * 0.003;
        n.vy -= (n.y - cy) * 0.003;
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
        if (disp > 0.3) {
            n.vx = n.vx / disp * 0.3;
            n.vy = n.vy / disp * 0.3;
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
    } else if (type === 3) {
        // Term: Wide pill shape (distinct from Collection)
        const w = r * 2.4, h = r * 1.0;
        const rx = x - w / 2, ry = y - h / 2;
        const cr = r * 0.4;
        ctx.beginPath();
        ctx.roundRect(rx, ry, w, h, cr);
        ctx.fill();
        if (strokeStyle) { ctx.strokeStyle = strokeStyle; ctx.lineWidth = lineWidth; ctx.stroke(); }
    } else if (type === 4) {
        // Collection: Square with minimal rounding
        const s = r * 1.6;
        const rx = x - s / 2, ry = y - s / 2;
        const cr = r * 0.1;
        ctx.beginPath();
        ctx.roundRect(rx, ry, s, s, cr);
        ctx.fill();
        if (strokeStyle) { ctx.strokeStyle = strokeStyle; ctx.lineWidth = lineWidth; ctx.stroke(); }
    } else if (type === 5) {
        // Book: Tall rectangle
        const w = r * 1.2, h = r * 1.8;
        const rx = x - w / 2, ry = y - h / 2;
        const cr = r * 0.15;
        ctx.beginPath();
        ctx.roundRect(rx, ry, w, h, cr);
        ctx.fill();
        if (strokeStyle) { ctx.strokeStyle = strokeStyle; ctx.lineWidth = lineWidth; ctx.stroke(); }
    } else if (type === 6) {
        // Link: Horizontal oval
        ctx.beginPath();
        ctx.ellipse(x, y, r, r * 0.7, 0, 0, Math.PI * 2);
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
    const base = [10, 12, 14, 12, 14, 14, 12][n.type || 0];
    const scale = [2, 2, 1.5, 1.5, 2, 2, 1.5][n.type || 0];
    const cap = [12, 14, 10, 10, 12, 12, 10][n.type || 0];
    return base + Math.min(n.degree * scale, cap);
}

function nodeColor(n) {
    if (n.type === 1 && n.status === 1) return '#666'; // deprecated = dim gray
    if (n.type === 1 && n.color) return n.color; // Concept uses custom color
    return NODE_COLORS[n.type || 0];
}

function edgeColor(e) {
    return e.colorHex || e.ColorHex || EDGE_COLORS[e.relationType] || DEFAULT_EDGE_COLOR;
}

// ── Graph engine ──

function initGraph(canvas, nodes, edges, collectionId, user, savedLayout, nodeAnnotations, edgeNameMap) {
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
        dragNode: null,
        dragStartX: 0, dragStartY: 0,
        dragPanX: 0, dragPanY: 0,
        width: 0, height: 0,
        highlightedIds: new Set(),
        physicsEnabled: false,
        physicsRAF: null,
        showMinimap: true,
        showClusters: false,
        hoveredEdge: null,
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

    // ── Point-to-segment distance for edge hit-testing ──
    function pointToSegmentDist(px, py, ax, ay, bx, by) {
        const dx = bx - ax, dy = by - ay;
        const len2 = dx * dx + dy * dy;
        if (len2 === 0) return Math.hypot(px - ax, py - ay);
        let t = ((px - ax) * dx + (py - ay) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    }

    // ── Distance from point to quadratic Bezier curve (sampled) ──
    function distToQuadBezier(px, py, x0, y0, cx, cy, x1, y1) {
        let best = Infinity;
        const steps = 16;
        for (let i = 0; i <= steps; i++) {
            const t = i / steps, u = 1 - t;
            const bx = u * u * x0 + 2 * u * t * cx + t * t * x1;
            const by = u * u * y0 + 2 * u * t * cy + t * t * y1;
            const d2 = (px - bx) * (px - bx) + (py - by) * (py - by);
            if (d2 < best) best = d2;
        }
        return Math.sqrt(best);
    }

    // ── Edge hit-test: matches curved/straight rendering logic ──
    function edgeDistFromPoint(px, py, ed, zoom, panX, panY) {
        const x1 = ed.from.x * zoom + panX, y1 = ed.from.y * zoom + panY;
        const x2 = ed.to.x * zoom + panX, y2 = ed.to.y * zoom + panY;
        const dx = x2 - x1, dy = y2 - y1;
        const screenLen = Math.sqrt(dx * dx + dy * dy);
        if (screenLen < 0.1) return Infinity;
        // Rendering decides curve vs straight in graph space (edgeLen >= 50)
        const graphDx = ed.to.x - ed.from.x, graphDy = ed.to.y - ed.from.y;
        const graphLen = Math.sqrt(graphDx * graphDx + graphDy * graphDy);
        if (graphLen >= 50) {
            const perpX = -dy / screenLen, perpY = dx / screenLen;
            const curveOffset = Math.min(20 * zoom, screenLen * 0.12);
            const cpx = (x1 + x2) / 2 + perpX * curveOffset;
            const cpy = (y1 + y2) / 2 + perpY * curveOffset;
            return distToQuadBezier(px, py, x1, y1, cpx, cpy, x2, y2);
        }
        return pointToSegmentDist(px, py, x1, y1, x2, y2);
    }

    // ── Drawing ──
    function draw() {
        state.physicsRAF = null; // clear so re-entry doesn't create parallel chains
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

        // Type clustering backgrounds
        if (state.showClusters) {
            const groups = {};
            for (const n of nodes) {
                if (!groups[n.type]) groups[n.type] = [];
                groups[n.type].push(n);
            }
            for (const [type, gnodes] of Object.entries(groups)) {
                if (gnodes.length < 2) continue;
                let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
                for (const n of gnodes) {
                    minX=Math.min(minX,n.x); minY=Math.min(minY,n.y);
                    maxX=Math.max(maxX,n.x); maxY=Math.max(maxY,n.y);
                }
                const pad = 30, w = maxX-minX+pad*2, h = maxY-minY+pad*2;
                const color = NODE_COLORS[parseInt(type)] || '#888';
                const r = parseInt(color.slice(1,3),16), g = parseInt(color.slice(3,5),16), b = parseInt(color.slice(5,7),16);
                ctx.fillStyle = `rgba(${r},${g},${b},0.08)`;
                const cr = Math.min(w,h)*0.3;
                ctx.beginPath(); ctx.roundRect(minX-pad, minY-pad, w, h, cr); ctx.fill();
            }
        }

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
            // Use quadratic Bezier curve for edges > 50px, straight line for short edges
            const edgeDx = e.to.x - e.from.x;
            const edgeDy = e.to.y - e.from.y;
            const edgeLen = Math.sqrt(edgeDx * edgeDx + edgeDy * edgeDy) || 1;
            const useCurve = edgeLen >= 50;
            let cpx, cpy; // control point for Bezier
            if (useCurve) {
                const perpX = -edgeDy / edgeLen;
                const perpY = edgeDx / edgeLen;
                const curveOffset = Math.min(20, edgeLen * 0.12);
                cpx = (e.from.x + e.to.x) / 2 + perpX * curveOffset;
                cpy = (e.from.y + e.to.y) / 2 + perpY * curveOffset;
                ctx.quadraticCurveTo(cpx, cpy, e.to.x, e.to.y);
            } else {
                ctx.lineTo(e.to.x, e.to.y);
            }
            // Glow layer for hovered edge
            if (e === state.hoveredEdge) {
                ctx.save();
                ctx.globalAlpha = 0.25 * entryScale;
                ctx.strokeStyle = color;
                ctx.lineWidth = 8;
                ctx.stroke();
                ctx.restore();
                ctx.beginPath();
                ctx.moveTo(e.from.x, e.from.y);
                if (useCurve) ctx.quadraticCurveTo(cpx, cpy, e.to.x, e.to.y);
                else ctx.lineTo(e.to.x, e.to.y);
            }
            ctx.strokeStyle = color;
            const baseWidth = (e === state.hoveredEdge) ? 3.0 : 1.5;
            ctx.lineWidth = baseWidth * Math.max(0.5, Math.min(4.0, e.weight || 1));
            ctx.stroke();
            if (isNonDirectional) {
                ctx.setLineDash([]);
            }

            // Arrowhead (only for directional edges)
            if (!isNonDirectional) {
                const toR = nodeRadius(e.to);
                // Arrow tangent follows curve at endpoint
                let ux, uy;
                if (useCurve) {
                    // Tangent at t=1 of quadratic Bezier: B'(1) = 2*(to - control)
                    const tdx = e.to.x - cpx;
                    const tdy = e.to.y - cpy;
                    const tlen = Math.sqrt(tdx * tdx + tdy * tdy) || 1;
                    ux = tdx / tlen;
                    uy = tdy / tlen;
                } else {
                    const dx = e.to.x - e.from.x;
                    const dy = e.to.y - e.from.y;
                    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
                    ux = dx / dist;
                    uy = dy / dist;
                }
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

            // Edge type labels for hovered or ego-relevant edges
            if ((e === state.hoveredEdge) || (egoNodeId && edgeRelevant && state.zoom >= 0.7)) {
                // For curved edges, use the quadratic Bezier midpoint at t=0.5
                const midX = useCurve
                    ? 0.25 * e.from.x + 0.5 * cpx + 0.25 * e.to.x
                    : (e.from.x + e.to.x) / 2;
                const midY = useCurve
                    ? 0.25 * e.from.y + 0.5 * cpy + 0.25 * e.to.y
                    : (e.from.y + e.to.y) / 2;
                ctx.font = '9px sans-serif';
                ctx.fillStyle = color;
                ctx.globalAlpha = 0.8;
                ctx.textAlign = 'center';
                const edgeLbl = (edgeNameMap && edgeNameMap[e.relationType]) || e.relationType.replace(/^custom-/, '');
                ctx.fillText(edgeLbl, midX, midY - 4);
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
            const strokeWidth = (n.id === state.focused) ? 3 : isHighlighted ? 3 : 1.2;
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
                const labelOffset = [4, 6, 5, 8, 8, 10, 4][n.type || 0];

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

        // Minimap
        if (state.showMinimap !== false) {
            const mmW = 120, mmH = 80, mmM = 10;
            const mmX = state.width - mmW - mmM, mmY = state.height - mmH - mmM;
            ctx.fillStyle = 'rgba(0,0,0,0.5)';
            ctx.fillRect(mmX, mmY, mmW, mmH);
            ctx.strokeStyle = 'rgba(255,255,255,0.3)';
            ctx.strokeRect(mmX, mmY, mmW, mmH);

            const bounds = graphBounds(nodes);
            if (bounds) {
                const gw = bounds.maxX - bounds.minX || 1, gh = bounds.maxY - bounds.minY || 1;
                const sc = Math.min((mmW-10)/gw, (mmH-10)/gh);
                const ox = mmX + 5 + ((mmW-10) - gw*sc)/2;
                const oy = mmY + 5 + ((mmH-10) - gh*sc)/2;

                // Edges
                ctx.strokeStyle = 'rgba(128,128,128,0.4)'; ctx.lineWidth = 0.5;
                for (const e of edges) {
                    if (!e.from || !e.to) continue;
                    ctx.beginPath();
                    ctx.moveTo(ox+(e.from.x-bounds.minX)*sc, oy+(e.from.y-bounds.minY)*sc);
                    ctx.lineTo(ox+(e.to.x-bounds.minX)*sc, oy+(e.to.y-bounds.minY)*sc);
                    ctx.stroke();
                }
                // Nodes
                for (const n of nodes) {
                    ctx.fillStyle = NODE_COLORS[n.type] || '#888';
                    ctx.beginPath();
                    ctx.arc(ox+(n.x-bounds.minX)*sc, oy+(n.y-bounds.minY)*sc, 1.5, 0, Math.PI*2);
                    ctx.fill();
                }
                // Viewport rect
                const vl = (-state.panX/state.zoom - bounds.minX)*sc;
                const vt = (-state.panY/state.zoom - bounds.minY)*sc;
                const vw = (state.width/state.zoom)*sc;
                const vh = (state.height/state.zoom)*sc;
                ctx.save();
                ctx.beginPath();
                ctx.rect(mmX, mmY, mmW, mmH);
                ctx.clip();
                ctx.strokeStyle = '#00E5FF'; ctx.lineWidth = 1;
                ctx.strokeRect(ox+vl, oy+vt, vw, vh);
                ctx.restore();
            }
        }

        // Continue animation or physics
        if (entryProgress < 1.0 || state.physicsEnabled) {
            state.physicsRAF = requestAnimationFrame(draw);
        } else {
            state.physicsRAF = null;
        }
    }

    // ── Interaction: mouse ──
    canvas.addEventListener('mousedown', e => {
        // Minimap click-to-pan
        if (state.showMinimap) {
            const mmW = 120, mmH = 80, mmM = 10;
            const mmX = state.width - mmW - mmM, mmY = state.height - mmH - mmM;
            if (e.offsetX >= mmX && e.offsetX <= mmX + mmW &&
                e.offsetY >= mmY && e.offsetY <= mmY + mmH) {
                const bounds = graphBounds(nodes);
                if (bounds) {
                    const gw = bounds.maxX - bounds.minX || 1;
                    const gh = bounds.maxY - bounds.minY || 1;
                    const sc = Math.min((mmW - 10) / gw, (mmH - 10) / gh);
                    const ox = mmX + 5 + ((mmW - 10) - gw * sc) / 2;
                    const oy = mmY + 5 + ((mmH - 10) - gh * sc) / 2;
                    const graphX = (e.offsetX - ox) / sc + bounds.minX;
                    const graphY = (e.offsetY - oy) / sc + bounds.minY;
                    state.panX = -graphX * state.zoom + state.width / 2;
                    state.panY = -graphY * state.zoom + state.height / 2;
                    draw();
                }
                return;
            }
        }
        const hit = hitTest(e.offsetX, e.offsetY);
        if (hit) {
            // Start dragging this individual node
            state.dragNode = hit;
            canvas.style.cursor = 'grabbing';
        } else {
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
        if (state.dragNode) {
            // Convert screen coords to graph coords and update node position
            state.dragNode.x = (e.offsetX - state.panX) / state.zoom;
            state.dragNode.y = (e.offsetY - state.panY) / state.zoom;
            state.dragNode.pinned = true;
            draw();
            return;
        }
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

        // Edge hover detection (only when no node is hovered)
        if (!hit) {
            let bestEdge = null, bestDist = 10;
            for (const ed of edges) {
                if (!ed.from || !ed.to) continue;
                const d = edgeDistFromPoint(e.offsetX, e.offsetY, ed, state.zoom, state.panX, state.panY);
                if (d < bestDist) { bestDist = d; bestEdge = ed; }
            }
            if (state.hoveredEdge !== bestEdge) {
                state.hoveredEdge = bestEdge;
                draw();
            }
        } else if (state.hoveredEdge) {
            state.hoveredEdge = null;
            draw();
        }

        if (prev !== state.hovered) draw();
    });

    canvas.addEventListener('mouseup', e => {
        if (state.dragNode) {
            state.dragNode = null;
            canvas.style.cursor = 'grab';
            return;
        }
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
        state.dragNode = null;
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

    // ── Double-click: navigate into sub-collection or open text in reader ──
    canvas.addEventListener('dblclick', e => {
        const hit = hitTest(e.offsetX, e.offsetY);
        if (hit && hit.type === 4) {
            const scId = hit.id.startsWith('collection:') ? hit.id.slice(11) : hit.id;
            const owner = hit.ownerUser || user;
            window.location.hash = '#/scholar/' + encodeURIComponent(scId) + '/graph/' + encodeURIComponent(owner);
        } else if (hit && hit.type === 5) {
            const workId = (hit.sourceRelPath || '').split('/').pop()?.replace(/\.xml$/i, '') || '';
            if (workId) window.location.hash = '#/' + encodeURIComponent(workId);
        } else if (hit && hit.type === 6 && hit.url) {
            window.open(hit.url, '_blank', 'noopener');
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
            } else if (!state.physicsEnabled && state.physicsRAF) {
                cancelAnimationFrame(state.physicsRAF);
                state.physicsRAF = null;
                draw(); // one final frame to show settled state
            }
        });
    }

    // ── Minimap toggle ──
    const minimapToggle = canvas.parentElement.querySelector('#scholar-minimap-toggle');
    if (minimapToggle) {
        minimapToggle.addEventListener('change', () => {
            state.showMinimap = minimapToggle.checked;
            draw();
        });
    }

    // ── Clusters toggle ──
    const clustersToggle = canvas.parentElement.querySelector('#scholar-clusters-toggle');
    if (clustersToggle) {
        clustersToggle.addEventListener('change', () => {
            state.showClusters = clustersToggle.checked;
            draw();
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

        const typeNames = ['Passage', 'Concept', 'Master', 'Term', 'Collection', 'Text', 'Link'];
        const typeName = typeNames[node.type || 0];

        let content = `<button class="graph-card-close">\u2715</button>`;
        content += `<div class="graph-card-type">${typeName}</div>`;
        content += `<div class="graph-card-title">${escapeHtml(node.label)}</div>`;
        // Node annotation
        const annotation = nodeAnnotations ? nodeAnnotations[node.id] : null;
        if (annotation) {
            content += `<div style="font-size:0.82rem;color:#FFD700;background:rgba(255,215,0,0.08);padding:0.4rem 0.6rem;margin:0.3rem 0;border-left:2px solid #FFD700;border-radius:2px;font-style:italic">${escapeHtml(annotation)}</div>`;
        }

        // Type-specific content
        if (node.type === 0) {
            // Source text title (async)
            if (node.sourceRelPath) {
                content += `<div id="passage-source-title" style="font-size:0.78rem;color:var(--muted);margin-bottom:0.3rem">${escapeHtml(node.sourceRelPath)}</div>`;
                loadTitlesMap().then(titles => {
                    const el = document.getElementById('passage-source-title');
                    if (!el) return;
                    const t = titles.get(node.sourceRelPath);
                    if (t) {
                        const parts = [t.enShort || t.en, t.zh].filter(Boolean);
                        el.textContent = parts.join(' \u2014 ') || node.sourceRelPath;
                    }
                }).catch(() => {});
            }
            // Passage: summary highlight
            if (node.summary) {
                content += `<div class="graph-card-snippet" style="border-left:2px solid var(--accent);padding-left:0.6rem">${escapeHtml(node.summary)}</div>`;
            }
            // Chinese text (full, scrollable)
            if (node.zhText) {
                content += `<div style="max-height:150px;overflow-y:auto;font-size:0.82rem;color:var(--text-soft);margin-bottom:0.4rem;padding:0.3rem;border:1px solid rgba(255,255,255,0.06);border-radius:4px">${escapeHtml(node.zhText)}</div>`;
            }
            // English text (full, scrollable)
            if (node.enText) {
                content += `<div style="max-height:150px;overflow-y:auto;font-size:0.8rem;opacity:0.8;margin-bottom:0.4rem;padding:0.3rem;border:1px solid rgba(255,255,255,0.06);border-radius:4px">${escapeHtml(node.enText)}</div>`;
            }
            // Tags
            if (node.tags && node.tags.length) {
                content += `<div class="graph-card-tags">${node.tags.slice(0, 4).map(t => `<span class="graph-card-tag">${escapeHtml(t)}</span>`).join('')}</div>`;
            }
            // Masters
            if (node.masterNames && node.masterNames.length) {
                content += `<div style="font-size:0.78rem;color:var(--muted);margin-top:0.3rem">Masters: ${escapeHtml(node.masterNames.join(', '))}</div>`;
            }
            // Notes
            if (node.notes) {
                content += `<div style="max-height:120px;overflow-y:auto;font-size:0.78rem;color:var(--text-soft);margin-top:0.3rem;border-top:1px solid rgba(255,255,255,0.08);padding-top:0.3rem"><strong>Notes.</strong> ${escapeHtml(node.notes)}</div>`;
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
            // Master — show rich info from pre-loaded masterData
            const m = node.masterData;
            if (m) {
                // Aliases
                if (m.names && m.names.length > 1)
                    content += `<div style="font-size:0.78rem;color:var(--muted)">${m.names.slice(0, 4).map(n => escapeHtml(n)).join(' \u00B7 ')}</div>`;
                if (node.dates)
                    content += `<div class="graph-card-snippet">${escapeHtml(node.dates)}</div>`;
                if (m.school)
                    content += `<div style="font-size:0.82rem;margin-top:0.2rem">School: ${escapeHtml(m.school)}</div>`;
                if (m.teacher)
                    content += `<div style="font-size:0.82rem">Teacher: ${escapeHtml(m.teacher)}</div>`;
                if (m.students && m.students.length > 0)
                    content += `<div style="font-size:0.82rem">Students: ${escapeHtml(m.students.slice(0, 8).join(', '))}${m.students.length > 8 ? '\u2026' : ''}</div>`;
                if (m.notes)
                    content += `<div style="margin-top:0.3rem;font-size:0.75rem;opacity:0.8">${escapeHtml(m.notes.slice(0, 300))}${m.notes.length > 300 ? '\u2026' : ''}</div>`;
                if (m.links && m.links.length > 0) {
                    content += `<div style="margin-top:0.3rem">`;
                    for (const link of m.links.slice(0, 3)) {
                        const label = escapeHtml(link.label || link.url || 'Link');
                        const url = escapeHtml(link.url || '');
                        content += `<a href="${url}" target="_blank" rel="noopener" style="display:block;font-size:0.75rem;color:var(--accent);text-decoration:none;margin-top:0.15rem">\uD83D\uDD17 ${label}</a>`;
                    }
                    content += `</div>`;
                }
            } else {
                // Fallback: async-load
                if (node.dates) content += `<div class="graph-card-snippet">${escapeHtml(node.dates)}</div>`;
                content += `<div id="master-extra-info" style="font-size:0.78rem;color:var(--muted)">Loading...</div>`;
                const masterName = node.id.startsWith('master:') ? node.id.slice(7) : node.label;
                loadMasters().then(masters => {
                    const el = document.getElementById('master-extra-info');
                    if (!el) return;
                    const found = (masters || []).find(r =>
                        (r.names || []).some(n => n === masterName || (n && n.toLowerCase() === masterName.toLowerCase())));
                    if (!found) { el.textContent = ''; return; }
                    let info = '';
                    if (found.school) info += `<div>School: ${escapeHtml(found.school)}</div>`;
                    if (found.teacher) info += `<div>Teacher: ${escapeHtml(found.teacher)}</div>`;
                    if (found.students && found.students.length > 0)
                        info += `<div>Students: ${escapeHtml(found.students.slice(0, 5).join(', '))}</div>`;
                    if (found.notes) info += `<div style="margin-top:0.3rem;font-size:0.75rem;opacity:0.8">${escapeHtml(found.notes.slice(0, 200))}</div>`;
                    el.innerHTML = info || '';
                }).catch(() => {});
            }
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
            // Collection node (sub-collection or CollectionRef)
            const isCollRef = node.id.startsWith('collection:');
            content += `<div style="font-size:0.85rem;color:var(--muted)">${isCollRef ? 'Collection Reference' : 'Sub-Collection'}</div>`;
            if (node.description) {
                content += `<div class="graph-card-snippet">${escapeHtml(node.description)}</div>`;
            }
            if (node.passageCount > 0) {
                content += `<div style="font-size:0.78rem;color:var(--muted);margin-top:0.3rem">${node.passageCount} passage${node.passageCount !== 1 ? 's' : ''}</div>`;
            }
            const collEdges = edges.filter(e => e.from.id === node.id || e.to.id === node.id);
            if (collEdges.length > 0) {
                content += `<div style="font-size:0.78rem;color:var(--muted);margin-top:0.3rem">${collEdges.length} connection${collEdges.length !== 1 ? 's' : ''}</div>`;
            }
            {
                content += `<div style="font-size:0.75rem;color:var(--accent);margin-top:0.3rem">Double-click to open graph \u2192</div>`;
            }
        } else if (node.type === 5) {
            // Text node — show titles and metadata
            content += `<div id="text-meta-info" style="font-size:0.82rem;color:var(--text-soft)">Loading...</div>`;
            const textRelPath = node.sourceRelPath || '';
            loadTitlesMap().then(titles => {
                const el = document.getElementById('text-meta-info');
                if (!el) return;
                const t = titles.get(textRelPath);
                let info = '';
                if (t) {
                    if (t.en) info += `<div style="font-size:0.9rem;font-weight:600">${escapeHtml(t.en)}</div>`;
                    if (t.zh) info += `<div style="font-size:0.9rem">${escapeHtml(t.zh)}</div>`;
                }
                if (node.zhTitle && !t?.zh) info += `<div style="font-size:0.9rem">${escapeHtml(node.zhTitle)}</div>`;
                if (textRelPath) info += `<div style="font-size:0.75rem;color:var(--muted);margin-top:0.3rem">${escapeHtml(textRelPath)}</div>`;
                if (node.masterNames && node.masterNames.length)
                    info += `<div style="font-size:0.78rem;margin-top:0.2rem">Masters: ${escapeHtml(node.masterNames.join(', '))}</div>`;
                const bookEdges = edges.filter(e => e.from.id === node.id || e.to.id === node.id);
                if (bookEdges.length > 0)
                    info += `<div style="font-size:0.78rem;color:var(--muted);margin-top:0.3rem">${bookEdges.length} connection${bookEdges.length !== 1 ? 's' : ''}</div>`;
                el.innerHTML = info || '<span style="color:var(--muted)">No metadata available</span>';
            }).catch(() => {});
        } else if (node.type === 6) {
            // Link node
            if (node.url) {
                content += `<div style="font-size:0.85rem;margin-top:0.3rem"><a href="${escapeHtml(node.url)}" target="_blank" rel="noopener" style="color:cornflowerblue;text-decoration:none;word-break:break-all">${escapeHtml(node.url)}</a></div>`;
            }
            if (node.description) {
                content += `<div style="font-size:0.82rem;color:var(--text-soft);margin-top:0.3rem">${escapeHtml(node.description)}</div>`;
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
                const edgeDisplayName = edgeNameMap[e.relationType] || e.relationType.replace(/^custom-/, '');
                content += `<div style="font-size:0.75rem;color:var(--text-soft)">${dir} ${escapeHtml(other.label)} <span style="color:${edgeColor(e)}">(${escapeHtml(edgeDisplayName)})</span></div>`;
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
            // Collection — browse and open graph
            const scCollId = node.id.startsWith('collection:') ? node.id.slice(11) : node.id;
            const scOwner = node.ownerUser || user;
            content += `<a href="#/scholar/${encodeURIComponent(scCollId)}/graph/${encodeURIComponent(scOwner)}"><strong>Open Graph \u2192</strong></a>`;
            content += `<a href="#/scholar/${encodeURIComponent(scCollId)}//${encodeURIComponent(scOwner)}">Browse Collection \u2192</a>`;
        } else if (node.type === 5) {
            // Book — link to reader
            const bookWorkId = (node.sourceRelPath || '').split('/').pop()?.replace(/\.xml$/i, '') || '';
            if (bookWorkId) {
                content += `<a href="#/${encodeURIComponent(bookWorkId)}">Open in Reader \u2192</a>`;
            }
        } else if (node.type === 6) {
            // Link — open in browser
            if (node.url) {
                content += `<a href="${escapeHtml(node.url)}" target="_blank" rel="noopener">Open Link \u2192</a>`;
            }
        }
        content += `</div>`;

        card.innerHTML = content;

        // Position near clicked node, edge-aware
        const rect = canvas.getBoundingClientRect();
        const sx = node.x * state.zoom + state.panX + rect.left;
        const sy = node.y * state.zoom + state.panY + rect.top;

        const cardW = 420;
        const cardMaxH = Math.min(window.innerHeight * 0.8, 600);
        const margin = 10;
        const offset = 30;

        let cardX = sx + offset;
        let cardY = sy - 50;

        if (cardX + cardW + margin > window.innerWidth) {
            cardX = sx - cardW - offset;
        }
        cardX = Math.max(margin, Math.min(cardX, window.innerWidth - cardW - margin));
        cardY = Math.max(margin, Math.min(cardY, window.innerHeight - cardMaxH - margin));

        card.style.position = 'fixed';
        card.style.left = cardX + 'px';
        card.style.top = cardY + 'px';
        card.style.transform = 'none';

        document.body.appendChild(backdrop);
        document.body.appendChild(card);

        // Re-clamp after render using actual card height
        const actualH = card.offsetHeight;
        if (cardY + actualH + margin > window.innerHeight) {
            cardY = Math.max(margin, window.innerHeight - actualH - margin);
            card.style.top = cardY + 'px';
        }

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
    return String(s || '').trim().toLowerCase().replace(/[_-]/g, ' ');
}
