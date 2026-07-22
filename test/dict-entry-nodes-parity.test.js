// test/dict-entry-nodes-parity.test.js
//
// SPA half of the cross-app parity check for the dictionary-entry term-node feature.
// It builds graph nodes/edges over the SAME hand-authored fixture the desktop xunit
// tests use (test/fixtures/dict-entry-nodes.jsonl is byte-identical to the desktop copy
// ReadZen.Tests/TestData/dictnodes/dict-entry-nodes.jsonl) and asserts the SHARED CONTRACT:
//
//   * a term node id is 'term:' + SourceTerm (raw CJK, never slugified), node.type === 3;
//   * a manual ref whose id is in SuppressedAutoNodeIds is NOT materialized, and its edge drops;
//   * typed term-endpoint edges (uses-term / defines-term) survive when both endpoints resolve;
//   * GraphLayout.NodePositions for a term node are honored;
//   * the JSONL carries only the ref snapshot (no dict body).
//
// buildGraphModel below is a faithful port of the node/edge-building block inside
// views/scholar-graph.js `render()` (which is DOM/fetch-coupled and not importable in
// isolation). It mirrors that code's camelCase||PascalCase field access and its
// suppression / edge-survival rules. If the view's algorithm changes, update both.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'dict-entry-nodes.jsonl');

function loadFixtureCollection() {
    const text = readFileSync(FIXTURE, 'utf8').trim();
    const lines = text.split('\n').filter(l => l.trim().length > 0);
    assert.equal(lines.length, 1, 'fixture is a single JSONL line');
    return JSON.parse(lines[0]);
}

// Faithful port of the scholar-graph.js node/edge build (term-node relevant subset + generic edges).
function buildGraphModel(collection, collections, user) {
    const passages = collection.passages || collection.Passages || [];
    const concepts = collection.concepts || collection.Concepts || [];
    const newEdges = collection.edges || collection.Edges || [];
    const links = collection.links || collection.Links || [];
    const schemaVersion = collection.schemaVersion || collection.SchemaVersion || 1;
    const suppressedNodes = new Set(collection.suppressedAutoNodeIds || collection.SuppressedAutoNodeIds || []);
    const suppressedEdges = new Set(collection.suppressedAutoEdgeIds || collection.SuppressedAutoEdgeIds || []);
    const graphLayout = collection.graphLayout || collection.GraphLayout || null;

    const nodeMap = new Map();

    // Passages -> type 0 (or 5 for books)
    for (const p of passages) {
        const pid = p.id || p.Id || '';
        if (!pid) continue;
        const isBook = (p.annotationType || p.AnnotationType || '').toLowerCase() === 'book';
        const label = p.summary || p.Summary
            || (p.zhText || p.ZhText || '').slice(0, 30)
            || (p.sourceRelPath || p.SourceRelPath || '').split('/').pop().replace(/\.xml$/i, '')
            || pid;
        nodeMap.set(pid, { id: pid, type: isBook ? 5 : 0, label, x: 0, y: 0 });
    }

    // Concepts -> type 1
    for (const c of concepts) {
        const cid = c.id || c.Id || '';
        if (!cid) continue;
        nodeMap.set(cid, { id: cid, type: 1, label: c.name || c.Name || '?', x: 0, y: 0 });
    }

    // Master nodes from passage MasterNames -> type 2 (skip suppressed)
    for (const p of passages) {
        const masters = p.masterNames || p.MasterNames || [];
        for (const masterName of masters) {
            const masterId = 'master:' + masterName;
            if (nodeMap.has(masterId) || suppressedNodes.has(masterId)) continue;
            nodeMap.set(masterId, { id: masterId, type: 2, label: masterName, x: 0, y: 0 });
        }
    }

    // ExtraMasters -> type 2
    for (const name of (collection.extraMasters || collection.ExtraMasters || [])) {
        const masterId = 'master:' + name;
        if (nodeMap.has(masterId) || suppressedNodes.has(masterId)) continue;
        nodeMap.set(masterId, { id: masterId, type: 2, label: name, x: 0, y: 0 });
    }

    // Dictionary-entry refs -> Termbase (type 3) nodes. Node id = 'term:' + raw SourceTerm.
    // Skip when suppressed; store only the ref snapshot (no dict body).
    for (const t of (collection.dictionaryEntries || collection.DictionaryEntries || [])) {
        const src = t.sourceTerm || t.SourceTerm || '';
        if (!src) continue;
        const termId = 'term:' + src;
        if (nodeMap.has(termId) || suppressedNodes.has(termId)) continue;
        nodeMap.set(termId, {
            id: termId, type: 3, label: src,
            definition: t.preferredTarget || t.PreferredTarget || '',
            x: 0, y: 0,
        });
    }

    // Edges: schema v2 typed edges (both endpoints must resolve to survive)
    const edges = [];
    if (schemaVersion >= 2 && newEdges.length > 0) {
        for (const edge of newEdges) {
            const fromId = edge.fromNodeId || edge.FromNodeId || '';
            const toId = edge.toNodeId || edge.ToNodeId || '';
            const relType = edge.relationType || edge.RelationType || '';
            const fromNode = nodeMap.get(fromId);
            const toNode = nodeMap.get(toId);
            if (fromNode && toNode) edges.push({ from: fromNode, to: toNode, relationType: relType, isAuto: false });
        }
    } else {
        for (const link of links) {
            const fromNode = nodeMap.get(link.fromPassageId || link.FromPassageId || '');
            const toNode = nodeMap.get(link.toPassageId || link.ToPassageId || '');
            const relType = link.relationType || link.RelationType || '';
            if (fromNode && toNode) edges.push({ from: fromNode, to: toNode, relationType: relType, isAuto: false });
        }
    }

    // Auto-edges: passages -> masters (not term edges, included for fidelity)
    const edgePairSet = new Set(edges.map(e => e.from.id + '|' + e.to.id));
    for (const p of passages) {
        const pid = p.id || p.Id || '';
        if ((p.annotationType || p.AnnotationType || '').toLowerCase() === 'book') continue;
        for (const mn of (p.masterNames || p.MasterNames || [])) {
            const masterId = 'master:' + mn;
            const autoEdgeId = `auto:attributed:${pid}→${masterId}`;
            if (suppressedEdges.has(autoEdgeId)) continue;
            const fromNode = nodeMap.get(pid);
            const toNode = nodeMap.get(masterId);
            if (fromNode && toNode
                && !edgePairSet.has(pid + '|' + masterId)
                && !edgePairSet.has(masterId + '|' + pid)) {
                edges.push({ from: fromNode, to: toNode, relationType: 'attributed-to', isAuto: true });
            }
        }
    }

    const nodes = [...nodeMap.values()];

    // Apply saved positions (mirrors scholar-graph.js: pos.x||pos.X)
    const savedPositions = graphLayout ? (graphLayout.NodePositions || graphLayout.nodePositions || null) : null;
    if (savedPositions && typeof savedPositions === 'object') {
        for (const n of nodes) {
            const pos = savedPositions[n.id];
            if (pos) { n.x = pos.x || pos.X || 0; n.y = pos.y || pos.Y || 0; }
        }
    }

    return { nodes, edges };
}

// ── Shared-contract expectations (identical to the desktop DictionaryEntryNodesTests) ──
const EXPECTED_NODE_IDS = ['p1', 'c1', 'master:南泉普願', 'term:水牯牛', 'term:未收之詞'];
const EXPECTED_SURVIVING_TERM_EDGE_KEYS = [
    'p1|term:水牯牛|uses-term',
    'p1|term:未收之詞|defines-term',
];
const TERM_SUPPRESSED = '隱藏詞';

test('SPA builds the exact node-id set (incl. term: nodes), honoring SuppressedAutoNodeIds', () => {
    const collection = loadFixtureCollection();
    const { nodes } = buildGraphModel(collection, [collection], 'tester');

    const ids = new Set(nodes.map(n => n.id));
    assert.deepEqual([...ids].sort(), [...EXPECTED_NODE_IDS].sort());
    assert.equal(ids.has('term:' + TERM_SUPPRESSED), false, 'suppressed term node must be absent');
});

test('SPA term nodes have Termbase type 3 and raw-CJK labels', () => {
    const collection = loadFixtureCollection();
    const { nodes } = buildGraphModel(collection, [collection], 'tester');

    for (const term of ['水牯牛', '未收之詞']) {
        const node = nodes.find(n => n.id === 'term:' + term);
        assert.ok(node, 'expected node term:' + term);
        assert.equal(node.type, 3);
        assert.equal(node.label, term); // raw CJK, never slugified
    }
});

test('SPA surviving term-endpoint edges match the shared contract', () => {
    const collection = loadFixtureCollection();
    const { edges } = buildGraphModel(collection, [collection], 'tester');

    const survivingKeys = edges
        .filter(e => e.from.id.startsWith('term:') || e.to.id.startsWith('term:'))
        .map(e => `${e.from.id}|${e.to.id}|${e.relationType}`)
        .sort();

    assert.deepEqual(survivingKeys, [...EXPECTED_SURVIVING_TERM_EDGE_KEYS].sort());
    // The edge into the suppressed term node did not survive.
    assert.equal(edges.some(e => e.to.id === 'term:' + TERM_SUPPRESSED), false);
});

test('SPA honors the saved term-node position', () => {
    const collection = loadFixtureCollection();
    const { nodes } = buildGraphModel(collection, [collection], 'tester');

    const node = nodes.find(n => n.id === 'term:水牯牛');
    assert.equal(node.x, 123.5);
    assert.equal(node.y, 456.25);
});

test('fixture carries only the ref snapshot — no dict body in the JSONL', () => {
    const raw = readFileSync(FIXTURE, 'utf8');
    assert.equal(raw.includes('Senses'), false);
    assert.equal(raw.includes('senses'), false);
    assert.equal(raw.includes('Occurrences'), false);
    // ref fields ARE present
    assert.equal(raw.includes('SourceTerm'), true);
    assert.equal(raw.includes('PreferredTarget'), true);
});
