// lib/lineage-data.js
// Normalization for the Zen lineage chart. DOM-free and Node-testable.
//
// Turns the raw master roster (943 records, rich provenance schema) into a
// clean { nodes, edges, sources, report } graph the renderer can draw without
// ever lying about the evidence.
//
// The governing rule of the whole chart: INK MUST BE EARNED. Missing data must
// render as the weakest thing, never as confident certainty. This module is the
// first line of that guarantee (validation + honest stubs); the renderer's
// `ATT_STYLES[att] ?? ATT_STYLES.D` fail-safe is the second.

// ── School hues (constants; family recipe switches by light/dark, not the hue) ──
export const SCHOOL_HUES = {
    linji: 8,
    caodong: 222,
    yunmen: 275,
    fayan: 168,
    guiyang: 45,
    hongzhou: 28,
    shitou: 195,
    niutou: 115,
    heze: 330,
    'korean-seon': 160,
    'early-chan': 38,
    'pre-chan': null,   // achromatic
    other: null,
};

export const SCHOOL_LABELS = {
    linji: 'Linji 臨濟',
    caodong: 'Caodong 曹洞',
    yunmen: 'Yunmen 雲門',
    fayan: 'Fayan 法眼',
    guiyang: 'Guiyang 溈仰',
    hongzhou: 'Hongzhou 洪州',
    shitou: 'Shitou 石頭',
    niutou: 'Niutou 牛頭',
    heze: 'Heze 荷澤',
    'korean-seon': 'Korean Seon 禪',
    'early-chan': 'Early Chan',
    'pre-chan': 'Pre-Chan',
    other: 'Other',
};

// Book cases whose teacher is null get synthesized source pseudo-nodes, one
// per entry in the master's structured `book_transmissions` array (title_en,
// title_hanja, author, description, path, in_corpus). A book master without
// that array falls back to one generic bilingual sutra node — never hanja-only.
const BOOK_FALLBACK = { id: 'book:unknown', title_en: 'Sutra', title_hanja: '經' };

// ~15 curated school-founders / pivots that anchor the cold "spine" view.
const SPINE_FOUNDERS = [
    'Bodhidharma', 'Huike', 'Sengcan', 'Daoxin', 'Hongren', 'Huineng',
    'Shenxiu', 'Qingyuan Xingsi', 'Nanyue Huairang', 'Mazu Daoyi',
    'Baizhang Huaihai', 'Shitou Xiqian', 'Linji Yixuan', 'Dongshan Liangjie',
    'Caoshan Benji', 'Yunmen Wenyan', 'Fayan Wenyi', 'Guishan Lingyou',
    'Deshan Xuanjian', 'Xuefeng Yicun', 'Huangbo Xiyun', 'Nanquan Puyuan',
    'Zhaozhou Congshen', 'Dahui Zonggao', 'Yangqi Fanghui', 'Huanglong Huinan',
    'Jinul', 'Taego Bou', 'Doui', 'Beomil',
];

/** Normalize the free-text `school` string to one of 12 canonical keys. */
export function normalizeSchool(raw) {
    const s = String(raw || '').toLowerCase();
    if (!s.trim()) return 'other';
    if (/not chan|scholar-monk|pre-chan|kum[aā]raj[iī]va|4th-century|4th century/.test(s)) return 'pre-chan';
    if (/yunmen|雲門|云门/.test(s)) return 'yunmen';
    if (/fayan|法眼/.test(s)) return 'fayan';
    if (/guiyang|gui-?yang|溈仰|潙仰|沩仰|仰宗/.test(s)) return 'guiyang';
    if (/caodong|曹洞/.test(s)) return 'caodong';
    if (/linji|臨濟|临济|yangqi|楊岐|huanglong|黃龍|sanfeng|三峰/.test(s)) return 'linji';
    if (/korean|seon|jogye|조계|海東|goryeo|joseon|silla/.test(s)) return 'korean-seon';
    if (/hongzhou|洪州/.test(s)) return 'hongzhou';
    if (/shitou|石頭|石头|qingyuan|青原/.test(s)) return 'shitou';
    if (/niutou|oxhead|牛頭|牛头/.test(s)) return 'niutou';
    if (/heze|荷澤|荷泽/.test(s)) return 'heze';
    if (/early chan|楞伽|東山|东山|lank[aā]vat[aā]ra|^chan$|禪宗|禅宗/.test(s)) return 'early-chan';
    return 'other';
}

function isKoreanNode(m, schoolKey) {
    if (schoolKey === 'korean-seon') return true;
    const region = String(m.region || '').toLowerCase();
    return /korea|goryeo|koryo|joseon|choson|silla|고려|조선|신라|海東|해동/.test(region);
}

function firstCjk(names) {
    for (const n of names) if (/[㐀-鿿]/.test(n)) return n;
    return '';
}

function formatDates(m) {
    const b = m.birth || 0;
    const d = m.death || 0;
    const f = m.floruit || 0;
    const c = m.dates_conjectural ? 'c. ' : '';
    if (b && d) return `${c}${b}–${d}`;
    if (d) return `${c}d. ${d}`;
    if (b) return `${c}b. ${b}`;
    if (f) return `${c}fl. ${f}`;
    return '';
}

function repYear(m) {
    // Representative year for the chronological hint. Never invented.
    if (m.death) return m.death;
    if (m.birth) return m.birth + 65;
    if (m.floruit) return m.floruit;
    return null;
}

const VALID_ATT = /^[ABCD]$/;

/**
 * Build the lineage graph from the raw roster.
 * @returns {{nodes:Object[], edges:Object[], sources:Object[], report:Object, byId:Map}}
 */
export function buildLineage(masters) {
    const nodes = [];
    const byName = new Map();     // every name/alias -> node (first wins)
    const report = {
        masters: 0, edges: 0, roots: 0, dangling: 0, bookSources: 0,
        badAttestation: [], unknownSchool: [], unknownTransmission: [],
        unresolvedTeacherKey: [], contested: 0,
    };

    // Pass 1: nodes + name index.
    for (const m of masters) {
        const names = (m.names || []).filter(Boolean);
        if (names.length === 0) continue;
        const primary = names[0];
        const schoolKey = normalizeSchool(m.school);
        if (schoolKey === 'other') report.unknownSchool.push(primary);
        const att = VALID_ATT.test(m.attestation) ? m.attestation : undefined;
        if (m.attestation && !att) report.badAttestation.push(primary + ':' + m.attestation);
        const transmission = m.transmission || 'direct';
        if (!/^(direct|book|disputed|none|遙嗣|代囑)$/.test(transmission)) {
            report.unknownTransmission.push(primary + ':' + transmission);
        }

        const node = {
            id: primary,
            primary,
            names,
            cjk: firstCjk(names),
            aliases: names.slice(1),
            schoolRaw: m.school || '',
            schoolKey,
            korean: isKoreanNode(m, schoolKey),
            preChan: schoolKey === 'pre-chan',
            attestation: att,
            transmission,
            teacher: m.teacher || '',
            teacherKey: m.teacher_key || '',
            teacherDangling: !!m.teacher_dangling,
            bookTransmissions: Array.isArray(m.book_transmissions) ? m.book_transmissions : [],
            contested: !!m.contested,
            contestedBy: m.contested_by || null,
            edgeNote: m.edge_note || '',
            bio: m.bio || m.notes || '',
            steles: Array.isArray(m.steles) ? m.steles : [],
            provenance: m.provenance || {},
            links: Array.isArray(m.links) ? m.links : [],
            birth: m.birth || 0,
            death: m.death || 0,
            floruit: m.floruit || 0,
            region: m.region || '',
            datesConjectural: !!m.dates_conjectural,
            datesConflict: !!m.dates_conflict,
            dateNote: m.date_note || '',
            datesText: formatDates(m),
            year: repYear(m),
            isSource: false,
            // layout (filled by lineage-layout.js)
            layer: -1, x: 0, y: 0, order: 0,
            parentEdge: null, childEdges: [],
        };
        nodes.push(node);
        report.masters++;
        for (const nm of names) if (!byName.has(nm)) byName.set(nm, node);
    }

    const byId = new Map(nodes.map(n => [n.id, n]));

    // Pass 2: edges. teacher_key is the canonical parent-NODE name — use it.
    const edges = [];
    const sources = [];
    function addEdge(from, to, extra) {
        const e = Object.assign({
            from, to,
            attestation: to.attestation,
            transmission: to.transmission,
            contested: to.contested ? to.contestedBy : null,
            edgeNote: to.edgeNote,
            kind: 'tree',
        }, extra || {});
        edges.push(e);
        to.parentEdge = e;
        from.childEdges.push(e);
        return e;
    }

    for (const node of nodes) {
        if (node.isSource) continue;   // synthesized below; never re-classified
        // Book-with-no-teacher: synthesize first-class source pseudo-nodes,
        // one per book (the Jinul case: three books, three nodes). Each is
        // bilingual, searchable, and clickable — a real citizen of the chart.
        if (node.transmission === 'book' && !node.teacherKey && !node.teacher && !node.isSource) {
            const books = node.bookTransmissions.length ? node.bookTransmissions : [BOOK_FALLBACK];
            node.bookEdges = [];
            for (const b of books) {
                const titleEn = b.title_en || '';
                const titleCjk = b.title_hanja || '';
                const src = {
                    id: '__src__' + node.id + '__' + (b.id || titleCjk || titleEn),
                    primary: titleEn || titleCjk,
                    names: [titleEn, titleCjk].filter(Boolean),
                    cjk: titleCjk,
                    aliases: [],
                    schoolKey: 'source', korean: false, preChan: false,
                    attestation: undefined, transmission: 'source',
                    isSource: true,
                    sourceTitle: titleCjk, sourceTitleEn: titleEn,
                    sourceAuthor: b.author || '', sourceDesc: b.description || '',
                    sourcePath: b.path || '', sourceInCorpus: !!b.in_corpus,
                    bio: '', steles: [], provenance: {}, links: [],
                    datesText: '', year: node.year,
                    layer: -1, x: 0, y: 0, order: 0, parentEdge: null, childEdges: [],
                };
                nodes.push(src);
                sources.push(src);
                byId.set(src.id, src);
                for (const nm of src.names) if (!byName.has(nm)) byName.set(nm, src);
                report.bookSources++;
                node.bookEdges.push(
                    addEdge(src, node, { kind: 'book', attestation: node.attestation, transmission: 'book' }));
            }
            node.parentEdge = node.bookEdges[0];   // narrative parent: the first book
            continue;
        }

        if (node.teacherKey) {
            const parent = byName.get(node.teacherKey);
            if (parent && parent !== node) {
                addEdge(parent, node, {});
                if (node.contested && node.contestedBy) report.contested++;
                continue;
            }
            // Named a parent-key but it isn't in the corpus -> honest stub.
            report.unresolvedTeacherKey.push(node.primary + ' -> ' + node.teacherKey);
            node.stub = true;
            node.stubLabel = node.teacher || node.teacherKey;
            report.dangling++;
            continue;
        }

        if (node.teacherDangling && node.teacher) {
            // Teacher named in the record, not (yet) in this corpus.
            node.stub = true;
            node.stubLabel = node.teacher;
            report.dangling++;
            continue;
        }

        // Genuine root: nothing above it. (Bodhidharma simply begins.)
        node.isRoot = true;
        report.roots++;
    }

    // Pass 3: students back-edges — recover a few parents never overriding one.
    for (const m of masters) {
        const parent = byName.get((m.names || [])[0]);
        if (!parent || !Array.isArray(m.students)) continue;
        for (const sName of m.students) {
            const child = byName.get(sName);
            if (!child || child === parent) continue;
            if (child.parentEdge || child.stub) continue;  // never override
            // guard against a trivial cycle (parent already a descendant path)
            if (child.childEdges.some(e => e.to === parent)) continue;
            child.isRoot = false;
            report.roots--;
            addEdge(parent, child, {});
        }
    }

    report.edges = edges.length;

    // Spine set: descendants>=8 OR contested OR founder OR korean; + ancestor closure.
    computeSpine(nodes, edges, byName);

    return { nodes, edges, sources, report, byId, byName };
}

/** Mark node.spine=true for the cold default view (§3.1). */
function computeSpine(nodes, edges, byName) {
    // descendant counts
    const desc = new Map();
    function countDesc(n) {
        if (desc.has(n)) return desc.get(n);
        desc.set(n, 0); // guard
        let c = 0;
        for (const e of n.childEdges) c += 1 + countDesc(e.to);
        desc.set(n, c);
        return c;
    }
    for (const n of nodes) if (!n.isSource) n.descendants = countDesc(n);

    const founder = new Set(SPINE_FOUNDERS);
    const qualifies = (n) =>
        !n.isSource && (
            (n.descendants || 0) >= 8 ||
            n.contested ||
            founder.has(n.primary) ||
            (n.korean && (n.descendants || 0) >= 2)
        );

    // ancestor closure so the spine is always connected
    const spine = new Set();
    for (const n of nodes) {
        if (!qualifies(n)) continue;
        let cur = n;
        let guard = 0;
        while (cur && !spine.has(cur) && guard++ < 200) {
            spine.add(cur);
            cur = cur.parentEdge ? cur.parentEdge.from : null;
        }
    }
    // book sources ride with their (spine) child
    for (const e of edges) {
        if (e.kind === 'book' && spine.has(e.to)) spine.add(e.from);
    }
    for (const n of nodes) n.spine = spine.has(n);
}

// ── Data loading ──

const LINEAGE_URL = new URL('../data/lineage-masters.json', import.meta.url).href;
let _cache = null;

/** Load the bundled lineage roster (943 rich records). */
export async function loadLineageMasters() {
    if (_cache) return _cache;
    const resp = await fetch(LINEAGE_URL);
    if (!resp.ok) throw new Error('HTTP ' + resp.status + ' loading lineage data');
    const data = await resp.json();
    _cache = Array.isArray(data) ? data : (data.masters || []);
    return _cache;
}
