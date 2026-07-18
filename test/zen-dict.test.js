import test from 'node:test';
import assert from 'node:assert/strict';

import { buildZenCard } from '../lib/zen-dict.js';
import { parseRoute } from '../lib/route.js';

function cardHtml() {
    const entry = {
        id: 't_demo',
        sourceTerm: '是什麼',
        senses: [{
            preferredTarget: 'what is it?',
            explanation: 'Muzhou Daozong asks “what is this?” (這箇是什麼).',
            alternateTargets: [],
            validation: 'multi-source',
            status: 'preferred',
            note: '',
            occurrences: [{
                RelPath: 'C/C077/C077n1710.xml',
                FromLb: '0660b12',
                ToLb: '0660b13',
                Kwic: '拈起拄杖云這箇是什麼覺云拄杖',
                MasterName: 'Muzhou Daozong',
                AttributionNote: 'In the Sayings of the Ancient Worthies (古尊宿語錄), Muzhou raises his staff.',
                EvidenceRole: 'contrast',
            }, {
                RelPath: 'T/T47/T47n1985.xml',
                FromLb: '0498c18',
                ToLb: '0498c18',
                Kwic: '師云是什麼僧便喝',
                MasterName: 'Linji Yixuan',
                AttributionNote: 'Recorded Sayings of Chan Master Linji Huizhao of Zhenzhou (鎮州臨濟慧照禪師語錄), spoken by Linji Yixuan.',
            }],
            relatedMasters: [],
            relatedTerms: [],
        }],
    };
    return buildZenCard(entry).sections[0].content.html;
}

test('Zen card renders visible KWIC, linked speaker, attribution, and exact passage link', () => {
    const html = cardHtml();
    assert.match(html, /class="zen-evidence-kwic"[^>]*>拈起拄杖云這箇是什麼覺云拄杖/);
    assert.match(html, /href="#\/master\/Muzhou_Daozong"/);
    assert.match(html, />Exact actor:<\/span> <a class="zen-evidence-master"/);
    assert.match(html, /Sayings of the Ancient Worthies \(古尊宿語錄\)/);
    assert.match(html, />Attribution:<\/span>/);
    assert.match(html, />Source:<\/span> <a class="zen-evidence-source"/);
    assert.match(html, /href="#\/C077n1710\/0660b12-0660b13"/);
    assert.match(html, /contrast evidence/);
    const route = parseRoute('C077n1710/0660b12-0660b13');
    assert.equal(route.kind, 'passage');
    assert.equal(route.startLine, '0660b12');
    assert.equal(route.endLine, '0660b13');
});

test('Zen card distinguishes reviewed unnamed actors from linked named context', () => {
    const entry = {
        id: 't_anon', sourceTerm: '僧問', senses: [{
            preferredTarget: 'a monk asked', explanation: '', alternateTargets: [],
            validation: 'multi-source', status: 'preferred', note: '', relatedMasters: [], relatedTerms: [],
            occurrences: [{
                RelPath: 'T/T48/T48n2005.xml', FromLb: '0292c23', Kwic: '趙州和尚因僧問', MasterName: null,
                ActorAttribution: { Status: 'reviewed-unnamed', ActorLabel: 'unnamed monk' },
                ContextMasters: [{ MasterName: 'Zhaozhou Congshen', Roles: ['respondent'] }],
                AttributionNote: 'The record does not name the questioning monk.',
            }],
        }],
    };
    const html = buildZenCard(entry).sections[0].content.html;
    assert.match(html, />Exact actor:<\/span> <span[^>]*>unnamed monk<\/span> <span[^>]*>six-rung review<\/span>/);
    assert.match(html, />Named context:<\/span> <a[^>]*href="#\/master\/Zhaozhou_Congshen"[^>]*>Zhaozhou Congshen<\/a> <span[^>]*>\(respondent\)<\/span>/);
    assert.doesNotMatch(html, /Attribution incomplete/);
});

test('Zen card names unlinked context actors without creating broken master links', () => {
    const entry = {
        id: 't_context_actor', sourceTerm: '舊案', senses: [{
            preferredTarget: 'an old case', explanation: '', alternateTargets: [],
            validation: 'multi-source', status: 'preferred', note: '', relatedMasters: [], relatedTerms: [],
            occurrences: [{
                RelPath: 'T/T48/T48n2005.xml', FromLb: '0292c23', Kwic: '師舉舊案', MasterName: 'Zhaozhou Congshen',
                ContextActors: [{ Status: 'identified-unlinked-master', ActorLabel: 'Named Context Figure', Roles: ['case-figure'] }],
                AttributionNote: 'The case names Named Context Figure but no roster link exists.',
            }],
        }],
    };
    const html = buildZenCard(entry).sections[0].content.html;
    assert.match(html, />Named context:<\/span>.*Named Context Figure.*\(case figure\).*named · roster link unavailable/s);
    assert.doesNotMatch(html, /master\/Named_Context_Figure/);
});

test('Zen card exposes impersonal and unresolved actor states', () => {
    const baseSense = { preferredTarget: 'a good while', explanation: '', alternateTargets: [], validation: 'multi-source', status: 'preferred', note: '', relatedMasters: [], relatedTerms: [] };
    const impersonal = buildZenCard({ id: 't_time', sourceTerm: '良久', senses: [{ ...baseSense, occurrences: [{
        Kwic: '良久無人問', MasterName: null,
        ActorAttribution: { Status: 'impersonal', ActorLabel: 'assembly nonresponse' },
    }] }] }).sections[0].content.html;
    assert.match(impersonal, /Exact actor:.*assembly nonresponse/s);
    assert.doesNotMatch(impersonal, /Attribution incomplete/);

    const unresolved = buildZenCard({ id: 't_bad', sourceTerm: '某', senses: [{ ...baseSense, occurrences: [{ Kwic: '某' }] }] }).sections[0].content.html;
    assert.match(unresolved, /Attribution incomplete/);
});

test('Zen card exposes identified non-master and narrated actor states', () => {
    const baseSense = { preferredTarget: 'an indication', explanation: '', alternateTargets: [], validation: 'multi-source', status: 'preferred', note: '', relatedMasters: [], relatedTerms: [] };
    const identified = buildZenCard({ id: 't_named_layman', sourceTerm: '開示', senses: [{ ...baseSense, occurrences: [{
        Kwic: '何長白問今日福山大眾請和尚開示', MasterName: null,
        ActorAttribution: { Status: 'identified-non-master', ActorLabel: 'lay questioner He Changbai' },
    }] }] }).sections[0].content.html;
    assert.match(identified, /Exact actor:.*lay questioner He Changbai/s);
    assert.doesNotMatch(identified, /Attribution incomplete|six-rung review/);

    const narrated = buildZenCard({ id: 't_narrated', sourceTerm: '開示', senses: [{ ...baseSense, occurrences: [{
        Kwic: '常以啐啄之機開示後學', MasterName: null,
        ActorAttribution: { Status: 'narrated', ActorLabel: 'compiler describing Jingqing Daofu' },
    }] }] }).sections[0].content.html;
    assert.match(narrated, /Exact actor:.*compiler describing Jingqing Daofu/s);
    assert.doesNotMatch(narrated, /Attribution incomplete|six-rung review/);
});

test('matching Chinese quotation gets an unambiguous numbered evidence control', () => {
    const html = cardHtml();
    assert.match(html, /這箇是什麼\).*data-evidence-target="zen-evidence-t_demo-1-1"/s);
    assert.doesNotMatch(html, /這箇是什麼\).*data-evidence-target="zen-evidence-t_demo-1-2"/s);
    assert.match(html, /id="zen-evidence-t_demo-1-1"/);
    assert.match(html, /id="zen-evidence-t_demo-1-2"/);
    assert.match(html, /aria-label="Show evidence 1:/);
    assert.match(html, /title="Show evidence 1: Muzhou Daozong — C077n1710 0660b12–0660b13"/);
});

test('claim anchors link quoted evidence without masquerading as headword occurrences', () => {
    const entry = {
        id: 't_claim', sourceTerm: '本來無一物', senses: [{
            preferredTarget: 'originally not a single thing',
            explanation: 'The Dunhuang witness instead reads “Buddha-nature is always pure” (佛性常清淨).',
            alternateTargets: [], validation: 'multi-source', status: 'preferred', note: '',
            occurrences: [{ Kwic: '本來無一物', MasterName: 'Huineng' }],
            claimAnchors: [{
                ClaimText: '佛性常清淨', Kwic: '惠能偈曰佛性常清淨何處有塵埃',
                RelPath: 'T/T48/T48n2007.xml', FromLb: '0338a05', ToLb: '0338a08',
                MasterName: 'Huineng', AttributionNote: 'The Dunhuang Platform Sutra attributes the verse to Huineng.',
            }], relatedMasters: [], relatedTerms: [],
        }],
    };
    const html = buildZenCard(entry).sections[0].content.html;
    assert.match(html, /佛性常清淨\).*data-evidence-target="zen-evidence-t_claim-1-2"/s);
    assert.match(html, /Claim evidence/);
    assert.match(html, /Evidence 2/);
    assert.match(html, /href="#\/T48n2007\/0338a05-0338a08"/);
});

test('master names in explanatory prose link inline to roster pages', () => {
    const html = cardHtml();
    assert.match(html, /<p class="zen-sense-expl">.*<a class="zen-evidence-master" href="#\/master\/Muzhou_Daozong">Muzhou Daozong<\/a> asks/s);
});
