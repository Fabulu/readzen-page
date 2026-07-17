// test/lineage.test.js
// Acceptance invariants for the redesigned lineage chart (RUN-20260713-1030).
// The pure data + layout modules are headless-testable; this locks in the
// non-negotiables: NOTHING OVERLAPS, and the attestation fail-safe.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildLineage } from '../lib/lineage-data.js';
import { computeLayout, assertNoOverlaps } from '../lib/lineage-layout.js';

const DATA = JSON.parse(readFileSync(
    fileURLToPath(new URL('../data/lineage-masters.json', import.meta.url)), 'utf8'));

// Mirror of the renderer's fail-safe (views/lineage-graph.js).
const ATT_STYLES = {
    A: { w: 2.25, dash: [], op: 0.85 }, B: { w: 1.4, dash: [], op: 0.6 },
    C: { w: 1.2, dash: [7, 5], op: 0.5 }, D: { w: 1.0, dash: [1.5, 4.5], op: 0.4 },
};
const styleFor = (att) => ATT_STYLES[att] ?? ATT_STYLES.D;

function buildVisible(g, mode) {
    const { nodes, edges } = g;
    const visible = mode === 'all' ? null : new Set(nodes.filter(n => n.spine).map(n => n.id));
    const isVis = (n) => !visible || visible.has(n.id);
    const vnodes = [], vedges = [];
    for (const n of nodes) if (isVis(n)) vnodes.push(n);
    for (const e of edges) {
        if (isVis(e.from) && isVis(e.to)) { vedges.push(e); continue; }
        if (isVis(e.from) && !isVis(e.to) && !e.to.isSource) {
            const cap = { id: '__cap__' + e.to.id, capsule: true, capsuleRoot: e.to,
                schoolKey: e.to.schoolKey, korean: e.to.korean, year: e.to.year,
                isSource: false, childEdges: [], x: 0, y: 0, layer: -1, order: 0 };
            vnodes.push(cap);
            vedges.push({ from: e.from, to: cap, attestation: e.to.attestation,
                transmission: e.to.transmission, contested: null, kind: 'capsule' });
        }
    }
    return { vnodes, vedges };
}

test('fail-safe: unknown/missing attestation renders as the WEAKEST style (D)', () => {
    for (const bad of [undefined, null, '', 'X', 'a', 'E', 0, 'AA']) {
        assert.equal(styleFor(bad), ATT_STYLES.D, `att ${JSON.stringify(bad)} must be D`);
    }
    assert.equal(styleFor('A'), ATT_STYLES.A);
    assert.equal(styleFor('B'), ATT_STYLES.B);
    assert.equal(styleFor('C'), ATT_STYLES.C);
    // and the weakest style is never solid-confident: it is dotted + low opacity
    assert.deepEqual(ATT_STYLES.D.dash, [1.5, 4.5]);
    assert.ok(ATT_STYLES.D.op < ATT_STYLES.A.op);
});

test('data normalization: honest roots, stubs, and validated attestation', () => {
    const g = buildLineage(DATA);
    assert.ok(g.report.masters >= 600);
    // every edge has either a valid A/B/C/D or undefined — never a bogus string
    for (const e of g.edges) {
        if (e.attestation !== undefined) assert.match(e.attestation, /^[ABCD]$/);
    }
    assert.equal(g.report.badAttestation.length, 0, 'no invalid attestation leaked as a grade');
    // dangling teachers become stubs, not fake roots
    assert.ok(g.report.dangling > 0);
    for (const n of g.nodes) {
        if (n.stub) assert.ok(n.stubLabel, 'a stub must name its off-chart teacher');
    }
});

test('Jinul: book transmission, A-grade, three bilingual book nodes, no teacher stub', () => {
    const g = buildLineage(DATA);
    const jinul = g.nodes.find(n => n.primary === 'Jinul');
    assert.ok(jinul, 'Jinul present');
    assert.equal(jinul.transmission, 'book');
    assert.equal(jinul.attestation, 'A');
    assert.ok(!jinul.stub, 'Jinul is not a dangling stub');
    assert.ok(jinul.parentEdge && jinul.parentEdge.from.isSource, 'parent is a synthesized source node');
    assert.equal(jinul.parentEdge.kind, 'book');
    assert.equal(styleFor(jinul.parentEdge.attestation), ATT_STYLES.A, 'the book edge is full A-grade ink');
    // structured book_transmissions -> one first-class node per book
    assert.equal(jinul.bookEdges.length, 3, 'three books, three edges');
    for (const e of jinul.bookEdges) {
        const s = e.from;
        assert.ok(s.isSource);
        assert.ok(s.sourceTitleEn, `book ${s.id} has an English title`);
        assert.ok(s.sourceTitle, `book ${s.id} has a hanja title`);
        assert.ok(s.names.includes(s.sourceTitleEn) && s.names.includes(s.sourceTitle),
            'books are searchable by BOTH scripts');
        assert.equal(styleFor(e.attestation), ATT_STYLES.A, 'every book edge is A-grade');
        assert.ok(g.byId.get(s.id) === s, 'book nodes are addressable via byId (click/search)');
    }
    // in_corpus flags drive reader-vs-CBETA linking; both kinds must exist
    const flags = jinul.bookEdges.map(e => e.from.sourceInCorpus);
    assert.ok(flags.includes(true) && flags.includes(false),
        'corpus books deep-link internally, the Huayan exposition links out');
});

test('contested edges carry both sides and sit on the spine', () => {
    const g = buildLineage(DATA);
    const contested = g.nodes.filter(n => n.contested && n.contestedBy);
    assert.ok(contested.length >= 1);
    for (const c of contested) {
        assert.ok(c.spine, `${c.primary} contested edge must be visible in the cold spine`);
        const cb = c.contestedBy;
        assert.ok(cb.keep_teacher && cb.rival, 'both teachers named');
        assert.ok(cb.kept_evidence && cb.rival_evidence, 'both evidences present');
        assert.ok(cb.stake, 'the stake is stated');
    }
});

test('NOTHING OVERLAPS — spine view (opt-in key-masters mode)', () => {
    const g = buildLineage(DATA);
    const { vnodes, vedges } = buildVisible(g, 'spine');
    computeLayout(vnodes, vedges);
    const a = assertNoOverlaps(vnodes, vedges);
    assert.ok(a.ok, `overlaps in spine: ${a.nodeNode} node·node, ${a.edgeNode} edge·node\n${a.samples.join('\n')}`);
});

test('NOTHING OVERLAPS — full expansion (all 943, the default view)', () => {
    const g = buildLineage(DATA);
    const { vnodes, vedges } = buildVisible(g, 'all');
    computeLayout(vnodes, vedges);
    const a = assertNoOverlaps(vnodes, vedges);
    assert.ok(a.ok, `overlaps at full expansion: ${a.nodeNode} node·node, ${a.edgeNode} edge·node\n${a.samples.join('\n')}`);
});

test('the scroll HANGS — compact width, mostly-vertical descent', () => {
    // Ratchet against the horizontal-sprawl regression (user feedback
    // 2026-07-15: 26,000px-wide world, teacher and heir joined by long
    // horizontal wires). The tidy-forest layout must keep the world compact
    // and edges reading as downward descent.
    //
    // WIDTH BAR — calibrated per roster, not a constant of nature:
    //   609 masters (2026-07-15): laid out at 12,163px; bar set at 14,000.
    //   943 masters (2026-07-17): bar recalibrated 14,000 -> 18,000. After
    //   generalized chain-stacking folded 374 pure chains (596 nodes), the
    //   honest floor is ~17,050px, and that residue is STRUCTURAL: per-layer
    //   breadth holds at 15-17k continuously from layer ~15 to ~44 (the max
    //   layer is only ~12% above the plateau median — no slack layer to
    //   reclaim). That plateau IS the Five Houses diverging in the Tang and
    //   running laterally separate for thirty generations; the un-foldable
    //   items are real named sub-lineages (e.g. the 456-node Linji main line)
    //   that cannot share columns without overlapping or misrepresenting
    //   distinct schools. Measured-and-rejected alternatives: gap-squeeze to
    //   visual minimum bought only ~1,700px; hitting 14,000 via NODE_W needs
    //   132 -> 96px, a 27% cut to every name box. The shape invariants below
    //   (h/w ratio, horizontal-edge share) sit at 0.502 and 15.2% at 943 —
    //   as good as or better than at 609 — so what the user actually rejected
    //   (drift-wire sprawl) stays locked out. 18,000 still fails the pre-fix
    //   botched pack (21,912) and the rejected chart (26,000) decisively; for
    //   scale, the desktop's independent layout needs 21,912px for this same
    //   roster. If the roster grows materially again, recalibrate against a
    //   fresh per-layer breadth profile — do not just bump the number to
    //   whatever makes the suite green.
    const g = buildLineage(DATA);
    const { vnodes, vedges } = buildVisible(g, 'all');
    const res = computeLayout(vnodes, vedges);
    assert.ok(res.width < 18000, `world width ${Math.round(res.width)}px — must stay under 18,000 (943-roster calibration; see comment above before changing)`);
    assert.ok(res.height > res.width / 2.5, 'the chart is a scroll, not a pancake');
    let horiz = 0;
    for (const e of vedges) {
        const dx = Math.abs(e.to.x - e.from.x), dy = Math.abs(e.to.y - e.from.y);
        if (dx > 2 * dy) horiz++;
    }
    assert.ok(horiz / vedges.length < 0.2,
        `${horiz}/${vedges.length} edges run more than 2:1 horizontal — fan-out only, no drift wires`);
});
