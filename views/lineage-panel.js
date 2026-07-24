// views/lineage-panel.js
// The detail panel (desktop right rail / mobile bottom sheet) for masters AND
// book-source nodes. Pure DOM — the reward for every click. For masters:
// bio, the evidence line in words, the dispute card for contested edges, the
// stele as a rubbing block, the provenance ledger, and footer links. For
// books (renderBookPanel): bilingual title, author, description, and a link —
// into the corpus reader when in_corpus, out to CBETA online otherwise.

import { escapeHtml } from '../lib/format.js';

const ATT_SENTENCE = {
    A: 'Attested by his own words, or his stone.',
    B: 'Attested by a contemporary witness.',
    C: 'Listed in a lineage index.',
    D: 'Known only from the lamp records.',
};
const RUNG_LABEL = {
    'first-person': 'first-person', stele: 'stele', contemporary: 'contemporary',
    index: 'index', lamp: 'lamp', external: 'external',
};

/** Create the panel once; returns { show(node, ctx), hide(), el }. */
export function createPanel(root) {
    const el = document.createElement('aside');
    el.className = 'lin-panel';
    el.setAttribute('role', 'complementary');
    el.hidden = true;
    root.appendChild(el);

    let ctx = null;

    el.addEventListener('click', (ev) => {
        const link = ev.target.closest('[data-focus]');
        if (link) {
            ev.preventDefault();
            ctx && ctx.onFocus && ctx.onFocus(link.getAttribute('data-focus'));
            return;
        }
        if (ev.target.closest('.lin-panel-close')) { hide(); ctx && ctx.onClose && ctx.onClose(); }
    });

    function hide() { el.hidden = true; el.classList.remove('lin-panel--open'); }

    function show(node, context) {
        ctx = context || {};
        el.innerHTML = renderPanel(node, ctx);
        el.hidden = false;
        // force reflow so the slide-in transition runs
        void el.offsetWidth;
        el.classList.add('lin-panel--open');
        el.scrollTop = 0;
    }

    return { show, hide, el };
}

function renderPanel(n, ctx) {
    if (n.isSource) return renderBookPanel(n);
    const h = [];
    h.push('<button class="lin-panel-close" aria-label="Close">×</button>');

    // ── Header ──
    h.push('<header class="lin-ph">');
    if (n.cjk) h.push(`<div class="lin-ph-cjk">${escapeHtml(n.cjk)}</div>`);
    h.push(`<div class="lin-ph-rom">${escapeHtml(n.primary)}</div>`);
    if (n.aliases && n.aliases.length) {
        const alt = n.aliases.filter(a => a !== n.cjk);
        if (alt.length) h.push(`<div class="lin-ph-alt">${escapeHtml(alt.join(' · '))}</div>`);
    }
    const dline = [];
    if (n.datesText) dline.push(escapeHtml(n.datesText));
    if (n.region) dline.push(escapeHtml(n.region));
    if (dline.length) h.push(`<div class="lin-ph-dates">${dline.join(' · ')}${n.datesConjectural ? ' <span class="lin-chip lin-chip--quiet">dates uncertain</span>' : ''}${n.datesConflict ? ' <span class="lin-chip lin-chip--quiet">two-witness conflict</span>' : ''}</div>`);
    if (n.schoolKey && !n.isSource) {
        h.push(`<div class="lin-ph-school"><span class="lin-school-chip" data-school="${escapeHtml(n.schoolKey)}">${escapeHtml(schoolLabel(n))}</span>`);
        const sub = subBranch(n.schoolRaw);
        if (sub) h.push(` <span class="lin-ph-sub">${escapeHtml(sub)}</span>`);
        h.push('</div>');
    }
    h.push('</header>');

    // ── Evidence line (attestation in words) + transmission ──
    const att = /^[ABCD]$/.test(n.attestation) ? n.attestation : null;
    if (att || n.parentEdge) {
        h.push('<p class="lin-evidence">');
        if (att) {
            h.push(`<span class="lin-ev-att lin-ev-att--${att}">${escapeHtml(ATT_SENTENCE[att])}</span>`);
            if (att === 'D') h.push(' <span class="lin-ev-warn">Treat this link as tradition, not fact.</span>');
        }
        h.push('</p>');
        h.push(`<p class="lin-transmit">${transmissionSentence(n)}</p>`);
    }

    // ── Dispute card (contested edges) ──
    if (n.contested && n.contestedBy) h.push(renderDispute(n.contestedBy));

    // ── Bio ──
    if (n.bio) {
        const bio = n.bio;
        if (bio.length > 1200) {
            h.push(`<div class="lin-bio"><p>${escapeHtml(bio.slice(0, 1200))}…</p><details><summary>Read more</summary><p>${escapeHtml(bio.slice(1200))}</p></details></div>`);
        } else {
            h.push(`<div class="lin-bio"><p>${escapeHtml(bio)}</p></div>`);
        }
    }

    // ── Stele (the crown jewel) ──
    if (n.steles && n.steles.length) {
        for (const s of n.steles.slice(0, 3)) h.push(renderStele(s));
    }

    // ── Edge note (per-edge scholarly note) ──
    if (n.edgeNote) h.push(`<p class="lin-edgenote"><span class="lin-edgenote-k">On this link:</span> ${escapeHtml(n.edgeNote)}</p>`);

    // ── Provenance ledger ──
    const provSections = provRows(n.provenance);
    if (provSections.length) {
        h.push(`<details class="lin-prov"><summary>Sources (${provSections.length})</summary>`);
        for (const r of provSections) h.push(r);
        h.push('</details>');
    }

    // ── Footer ──
    h.push('<footer class="lin-foot">');
    if (n.parentEdge && !n.parentEdge.from.isSource) {
        const t = n.parentEdge.from;
        h.push(`<div class="lin-foot-row"><span class="lin-foot-k">Teacher</span> <a href="#" data-focus="${escapeHtml(t.id)}">${escapeHtml(t.primary || t.cjk)}</a></div>`);
    } else if (n.stub) {
        h.push(`<div class="lin-foot-row"><span class="lin-foot-k">Teacher</span> <span class="lin-stub-name">${escapeHtml(n.stubLabel || '')}</span> <span class="lin-chip lin-chip--quiet">named, not in corpus</span></div>`);
    }
    if (n.childEdges && n.childEdges.length) {
        const heirs = n.childEdges.map(e => {
            const a = /^[ABCD]$/.test(e.to.attestation) ? e.to.attestation : 'D';
            return `<a href="#" data-focus="${escapeHtml(e.to.id)}" class="lin-heir"><span class="lin-heir-dot lin-heir-dot--${a}"></span>${escapeHtml(e.to.primary || e.to.cjk)}</a>`;
        }).join('');
        h.push(`<div class="lin-foot-row lin-foot-heirs"><span class="lin-foot-k">Heirs (${n.childEdges.length})</span> ${heirs}</div>`);
    }
    if (n.links && n.links.length) {
        const links = n.links.map(l =>
            `<a href="${escapeHtml(l.url)}" target="_blank" rel="noopener" class="lin-extlink">${escapeHtml(l.label || l.url)}</a>`
        ).join('');
        h.push(`<div class="lin-foot-row lin-foot-links"><span class="lin-foot-k">Links</span> ${links}</div>`);
    }
    if (!n.isSource) {
        const slug = n.primary.replace(/ /g, '_');
        h.push('<div class="lin-foot-actions">');
        h.push(`<a class="lin-btn" href="#/master/${encodeURIComponent(slug)}">Open full profile</a>`);
        h.push(`<a class="lin-btn lin-btn--outline" href="#/search?master=${encodeURIComponent(slug)}">Search texts by him</a>`);
        h.push('</div>');
    }
    h.push('</footer>');

    return h.join('');
}

// ── Book source panel — a text is a teacher here; give it a teacher's card ──
function renderBookPanel(n) {
    const h = [];
    h.push('<button class="lin-panel-close" aria-label="Close">×</button>');
    h.push('<header class="lin-ph">');
    if (n.sourceTitle) h.push(`<div class="lin-ph-cjk">${escapeHtml(n.sourceTitle)}</div>`);
    if (n.sourceTitleEn) h.push(`<div class="lin-ph-rom">${escapeHtml(n.sourceTitleEn)}</div>`);
    if (n.sourceAuthor) h.push(`<div class="lin-ph-dates">${escapeHtml(n.sourceAuthor)}</div>`);
    h.push('<div class="lin-ph-school"><span class="lin-school-chip">Book transmission</span></div>');
    h.push('</header>');
    if (n.sourceDesc) h.push(`<div class="lin-bio"><p>${escapeHtml(n.sourceDesc)}</p></div>`);
    h.push('<footer class="lin-foot">');
    if (n.childEdges && n.childEdges.length) {
        const heirs = n.childEdges.map(e =>
            `<a href="#" data-focus="${escapeHtml(e.to.id)}" class="lin-heir">${escapeHtml(e.to.primary || e.to.cjk)}</a>`).join('');
        h.push(`<div class="lin-foot-row lin-foot-heirs"><span class="lin-foot-k">Awakened</span> ${heirs}</div>`);
    }
    const link = bookLink(n);
    if (link) {
        h.push('<div class="lin-foot-actions">');
        h.push(link);
        h.push('</div>');
    }
    h.push('</footer>');
    return h.join('');
}

/** In-corpus books deep-link into the reader; the rest link out to CBETA. */
function bookLink(n) {
    const m = String(n.sourcePath || '').match(/([A-Z]{1,2}\d+n\d+[A-Za-z]?)/);
    if (!m) return '';
    if (n.sourceInCorpus) {
        return `<a class="lin-btn" href="#/${encodeURIComponent(m[1])}">Read in context →</a>`;
    }
    return `<a class="lin-btn" href="https://cbetaonline.dila.edu.tw/zh/${encodeURIComponent(m[1])}" target="_blank" rel="noopener">Read on CBETA →</a>`;
}

function schoolLabel(n) {
    return { linji: 'Linji 臨濟', caodong: 'Caodong 曹洞', yunmen: 'Yunmen 雲門',
        fayan: 'Fayan 法眼', guiyang: 'Guiyang 溈仰', hongzhou: 'Hongzhou 洪州',
        shitou: 'Shitou 石頭', niutou: 'Niutou 牛頭', heze: 'Heze 荷澤',
        'korean-seon': 'Korean Seon', 'early-chan': 'Early Chan', 'pre-chan': 'Pre-Chan',
        other: n.schoolRaw ? n.schoolRaw.slice(0, 24) : 'Other' }[n.schoolKey] || 'Other';
}

function subBranch(raw) {
    const s = String(raw || '');
    const m = s.match(/Yangqi|楊岐|Huanglong|黃龍|Sanfeng|三峰|Songyuan|聚雲|Juyun|Jogye|Shouchang|壽昌/i);
    return m ? m[0] : '';
}

function transmissionSentence(n) {
    if (n.transmission === 'book' && n.bookEdges && n.bookEdges.length) {
        const books = n.bookEdges.map(e => {
            const s = e.from;
            const label = [s.sourceTitleEn, s.sourceTitle].filter(Boolean).join(' ');
            return `<a href="#" data-focus="${escapeHtml(s.id)}" class="lin-em">${escapeHtml(label)}</a>`;
        }).join(', ');
        return `No living teacher: awakened through ${books}. His record says so.`;
    }
    if (n.transmission === 'book' && n.parentEdge && n.parentEdge.from.isSource) {
        const s = n.parentEdge.from;
        const label = [s.sourceTitleEn, s.sourceTitle].filter(Boolean).join(' ');
        return `No living teacher: awakened through <span class="lin-em">${escapeHtml(label)}</span>. His record says so.`;
    }
    if (n.stub) return `Dharma heir of <span class="lin-stub-name">${escapeHtml(n.stubLabel || '')}</span>, named in the record, not yet in this corpus.`;
    if (!n.parentEdge) return 'A root of the tradition: nothing stands above him on this chart.';
    const t = n.parentEdge.from;
    const who = `<a href="#" data-focus="${escapeHtml(t.id)}">${escapeHtml(t.primary || t.cjk)}</a>`;
    if (n.transmission === '遙嗣') return `Posthumous (遙嗣) heir of ${who}, a transmission acknowledged across a gap.`;
    if (n.transmission === '代囑') return `Heir of ${who} by proxy (代囑), an intermediary hand.`;
    if (n.transmission === 'disputed') return `Disputed heir of ${who}.`;
    if (n.transmission === 'book') return `Awakened through the writings of ${who}, a transmission by book, not by meeting.`;
    return `Dharma heir of ${who}.`;
}

function renderDispute(cb) {
    const h = [];
    h.push('<div class="lin-dispute"><div class="lin-dispute-q">Who was his teacher?</div>');
    h.push('<div class="lin-dispute-cols">');
    h.push('<div class="lin-dispute-col"><div class="lin-dispute-head">The tradition says</div>');
    if (cb.keep_teacher) h.push(`<div class="lin-dispute-who">${escapeHtml(cb.keep_teacher)}</div>`);
    if (cb.kept_rung) h.push(`<span class="lin-chip lin-chip--rung">${escapeHtml(cb.kept_rung)}</span>`);
    if (cb.kept_evidence) h.push(`<blockquote class="lin-dispute-ev">${escapeHtml(cb.kept_evidence)}</blockquote>`);
    h.push('</div>');
    h.push('<div class="lin-dispute-col"><div class="lin-dispute-head">The stone says</div>');
    if (cb.rival) h.push(`<div class="lin-dispute-who">${escapeHtml(cb.rival)}</div>`);
    if (cb.rival_rung) h.push(`<span class="lin-chip lin-chip--rung">${escapeHtml(cb.rival_rung)}</span>`);
    if (cb.rival_evidence) h.push(`<blockquote class="lin-dispute-ev">${escapeHtml(cb.rival_evidence)}</blockquote>`);
    h.push('</div>');
    h.push('</div>');
    if (cb.stake) h.push(`<div class="lin-dispute-stake">${escapeHtml(cb.stake)}</div>`);
    h.push('</div>');
    return h.join('');
}

function renderStele(s) {
    const h = [];
    h.push('<div class="lin-stele">');
    if (s.kind) h.push(`<div class="lin-stele-kind">${escapeHtml(s.kind)}</div>`);
    if (s.title) h.push(`<div class="lin-stele-title">${escapeHtml(s.title)}</div>`);
    if (s.author) h.push(`<div class="lin-stele-author"><span class="lin-stele-auth-name">${escapeHtml(s.author)}</span></div>`);
    if (s.quote) h.push(`<blockquote class="lin-stele-quote">${escapeHtml(s.quote)}</blockquote>`);
    const link = corpusLink(s.path, s.lb);
    if (link) h.push(`<a class="lin-stele-read" href="${link}">Read in context →</a>`);
    if (s.note) h.push(`<div class="lin-stele-note">${escapeHtml(s.note)}</div>`);
    h.push('</div>');
    return h.join('');
}

function corpusLink(path, lb) {
    if (!path) return '';
    const m = String(path).match(/([A-Z]{1,2}\d+n\d+[A-Za-z]?)/);
    if (!m) return '';
    const fileId = m[1];
    const pos = lb && lb !== '—' ? '?pos=' + encodeURIComponent(lb) : '';
    return '#/' + encodeURIComponent(fileId) + pos;
}

function provRows(prov) {
    const rows = [];
    for (const claim of ['teacher', 'dates', 'school', 'bio']) {
        const arr = prov && prov[claim];
        if (!Array.isArray(arr)) continue;
        for (const p of arr) {
            const rung = RUNG_LABEL[p.rung] || p.rung || '';
            rows.push(
                '<div class="lin-prov-row">' +
                `<div class="lin-prov-top"><span class="lin-chip lin-chip--rung">${escapeHtml(rung)}</span> ` +
                `<span class="lin-prov-claim">${escapeHtml(claim)}</span> ` +
                `<span class="lin-prov-src">${escapeHtml(p.source || '')}</span></div>` +
                (p.quote ? `<blockquote class="lin-prov-quote">${escapeHtml(p.quote)}</blockquote>` : '') +
                (p.note ? `<div class="lin-prov-note">${escapeHtml(p.note)}</div>` : '') +
                '</div>'
            );
        }
    }
    return rows;
}
