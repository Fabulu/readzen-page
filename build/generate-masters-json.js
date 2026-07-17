#!/usr/bin/env node
// build/generate-masters-json.js
//
// Regenerates CbetaZenTranslations/masters.json — the profile dataset the SPA and
// the Reddit app fetch AT RUNTIME from raw.githubusercontent.com — by merging:
//
//   1. the lineage roster (943 records, rich provenance schema) — the source of
//      truth for WHO EXISTS. This is what the lineage chart renders, so every
//      node it draws must have a profile here or the chart links 404.
//   2. the existing hand-curated masters.json (301 records) — the source of truth
//      for data the roster lacks (notably `floruit`, which is null in 339 of the
//      341 roster records that carry the key at all).
//
// Merge rule: field-level union. The curated 301 win on conflict (they are live
// today; this file must not silently rewrite production), the roster fills gaps.
// Nothing is invented: a master with no bio gets no bio.
//
// Usage:
//   node build/generate-masters-json.js            # writes masters.json
//   node build/generate-masters-json.js --dry-run  # report only, write nothing
//
// Env:
//   LINEAGE_ROSTER   path to lineage-masters.json (the 943-record roster)
//   CURATED_MASTERS  path to the frozen hand-curated baseline
//   MASTERS_JSON     path to the OUTPUT masters.json
//
// The curated baseline is a FROZEN INPUT (data/masters-curated-301.json), never the
// output file. Reading the output back in would be self-feeding: the previous run's
// *derived* values (resolved teachers, derived schools) would return disguised as
// hand-curation and outrank a fresh derivation, and `curated wins` would quietly
// freeze them forever. Keeping the baseline separate makes this a pure function of
// (roster, baseline) — idempotent, and re-runnable as the roster changes.
//
// NOTE: the output changes production the moment it is pushed. There is no build or
// deploy step in between. Review the printed report before pushing, and re-run this
// immediately before pushing — the roster is edited by other agents.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeSchool } from '../lib/lineage-data.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ROSTER = process.env.LINEAGE_ROSTER
    || resolve(__dirname, '../../MergeWorkCbeta/CBETA-Translator/Assets/Data/lineage-masters.json');
const CURATED = process.env.CURATED_MASTERS
    || resolve(__dirname, '../data/masters-curated-301.json');
const MASTERS = process.env.MASTERS_JSON
    || resolve(__dirname, '../../CbetaZenTranslations/masters.json');

// Short English badge labels, matching the convention the curated 301 already use
// ("Linji", "Korean Seon", "Early Chan") rather than lineage-data.js's bilingual
// SCHOOL_LABELS ("Linji 臨濟"), so old and new records read alike.
const SCHOOL_BADGE = {
    linji: 'Linji',
    caodong: 'Caodong',
    yunmen: 'Yunmen',
    fayan: 'Fayan',
    guiyang: 'Guiyang',
    hongzhou: 'Hongzhou',
    shitou: 'Shitou',
    niutou: 'Niutou',
    heze: 'Heze',
    'korean-seon': 'Korean Seon',
    'early-chan': 'Early Chan',
    'pre-chan': 'Pre-Chan',
};

const BADGE_MAX = 40;

/**
 * Derive a badge-sized school label from the roster's free-text `school`.
 * 70 roster values are scholarly prose ("Chan — Northern School (北宗), Shenxiu's
 * chief successor and the school's second patriarch") which would overflow the
 * badge. Known schools normalize to a short label; unknown ones keep their raw
 * text when it already fits, else fall back to the leading clause. Anything still
 * too long yields '' — the badge is dropped rather than filled with a guess.
 */
export function deriveSchool(raw) {
    const key = normalizeSchool(raw);
    if (key !== 'other') return SCHOOL_BADGE[key] || '';
    const s = String(raw || '').trim();
    if (!s) return '';
    if (s.length <= BADGE_MAX) return s;
    const clause = s.split(/[,;]/)[0].trim();
    return clause && clause.length <= BADGE_MAX ? clause : '';
}

const load = (p) => {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return Array.isArray(j) ? j : (j.masters || []);
};

/** First non-empty value, treating null/''/[] as absent. Never returns null. */
function pick(...vals) {
    for (const v of vals) {
        if (v === null || v === undefined || v === '') continue;
        if (Array.isArray(v) && v.length === 0) continue;
        return v;
    }
    return undefined;
}

function main() {
    const dryRun = process.argv.includes('--dry-run');
    const roster = load(ROSTER);
    const curated = load(CURATED);

    // Guard the self-feeding mistake: the baseline is the hand-curated set, so it
    // must be far smaller than the roster. If someone points CURATED_MASTERS at a
    // generated file, stop rather than silently laundering derived values into
    // curation.
    if (curated.length > roster.length * 0.5) {
        console.error(`REFUSING: curated baseline has ${curated.length} records against a ${roster.length}-record roster.`);
        console.error(`${CURATED}\nlooks like a generated masters.json, not the hand-curated baseline. Point CURATED_MASTERS at the frozen baseline.`);
        process.exitCode = 1;
        return;
    }

    // Index the roster by every name/alias (first wins), mirroring how
    // lineage-data.js builds its byName map and how master.js#findMaster searches.
    const byName = new Map();
    for (const m of roster) for (const n of (m.names || [])) if (!byName.has(n)) byName.set(n, m);

    // ── Identity fixes: curated records whose person IS in the roster under a
    // different name-form, which alias matching alone cannot see. Each is asserted
    // only where teacher AND student AND school independently agree. ──
    const IDENTITY = {
        // 玉山師體 vs roster 王山體 — a 玉/王 graphic variant. Both have teacher
        // Lingyan/Cizhou Bao (= roster Daming Sengbao) and the single student
        // Xueyan Huiman, both Caodong. The roster record is attestation A, dated
        // from a stupa inscription; the curated note says outright "Specific dates
        // not preserved", so the roster's dates win here (see DATE_OVERRIDE).
        'Yushan Shiti': 'Wangshan Ti',
    };
    // The one place the roster's dates deliberately beat the curated 301's, because
    // the curated record self-declares its dates unpreserved.
    const DATE_OVERRIDE = new Set(['Yushan Shiti']);

    const findRoster = (c) => {
        const forced = IDENTITY[c.names[0]];
        if (forced) return byName.get(forced) || null;
        for (const n of (c.names || [])) if (byName.has(n)) return byName.get(n);
        return null;
    };

    // Map roster record -> curated record. Two curated records resolving to the
    // same roster record would silently drop the first (Map.set overwrites) and it
    // would not surface as an orphan either, so refuse instead of losing curation.
    // None collide today, but the roster gains aliases as other agents edit it.
    const curatedFor = new Map();
    const orphans = [];
    const collisions = [];
    for (const c of curated) {
        const r = findRoster(c);
        if (!r) { orphans.push(c); continue; }
        const prev = curatedFor.get(r);
        if (prev) collisions.push(`${prev.names[0]} + ${c.names[0]} -> ${r.names[0]}`);
        curatedFor.set(r, c);
    }
    if (collisions.length) {
        console.error('REFUSING: curated records collide onto one roster record; merging would drop curation:');
        for (const c of collisions) console.error(`  ${c}`);
        console.error('Resolve by adding an IDENTITY entry or by disambiguating the roster aliases.');
        process.exitCode = 1;
        return;
    }

    // ── Pass A: merged name arrays, then an index over the NAMES WE WILL EMIT ──
    // Resolution must run against the output's names, not the roster's: the merge
    // adds curated aliases (e.g. "Lingyan Sengbao" onto Daming Sengbao), so refs
    // that are dead against the bare roster become live against the output.
    const mergedNames = new Map(); // roster record -> merged names array
    for (const r of roster) {
        const c = curatedFor.get(r);
        const names = [...r.names];
        if (c) for (const n of c.names) if (!names.includes(n)) names.push(n);
        mergedNames.set(r, names);
    }
    const outByName = new Map();
    for (const r of roster) for (const n of mergedNames.get(r)) if (!outByName.has(n)) outByName.set(n, r);
    for (const c of orphans) for (const n of (c.names || [])) if (!outByName.has(n)) outByName.set(n, c);

    /**
     * Resolve a teacher/student reference to a linkable canonical primary name,
     * or null when the referenced person has no record in the output at all.
     */
    const toPrimary = (name) => {
        const hit = outByName.get(name);
        if (!hit) return null;
        return (mergedNames.get(hit) || hit.names)[0];
    };

    // ── Heirs, derived by inverting teacher_key ──
    // The roster's own `students` array is unvalidated free text: 766 of its 1,139
    // refs name people who have no record, so emitting it verbatim would mint 766
    // fresh dead links — the exact bug this change exists to kill. teacher_key is
    // the validated edge (all 876 resolve) and is what the chart actually draws,
    // so heirs are derived from it instead.
    const derivedHeirs = new Map();
    for (const m of roster) {
        if (!m.teacher_key) continue;
        const t = outByName.get(m.teacher_key);
        if (!t) continue;
        const key = (mergedNames.get(t) || t.names)[0];
        if (!derivedHeirs.has(key)) derivedHeirs.set(key, []);
        derivedHeirs.get(key).push(mergedNames.get(m)[0]);
    }

    const report = {
        fromRoster: 0, merged: 0, orphansKept: 0,
        schoolDropped: [], teacherUnresolved: 0, studentsDropped: 0,
        dateConflicts: [], schoolConflicts: 0, aliasesPreserved: [],
        noDates: 0, birthOnlyRendered: 0,
    };

    const out = [];

    for (const r of roster) {
        const c = curatedFor.get(r) || null;
        if (c) report.merged++; else report.fromRoster++;

        // names (from Pass A): roster primary FIRST — the chart builds its link from
        // names[0] — then any curated name not already present, so live URLs built
        // from the old primary (e.g. #/master/Lingyan_Sengbao) still resolve.
        const names = mergedNames.get(r);
        if (c && c.names[0] !== r.names[0]) {
            report.aliasesPreserved.push(`${c.names[0]} -> ${r.names[0]}`);
        }

        // Dates. floruit+death are taken from the SAME source when the curated
        // record has them, so master.js#formatDates never renders a range that
        // straddles two datasets (e.g. curated floruit + roster death).
        const useRosterDates = c ? DATE_OVERRIDE.has(c.names[0]) : true;
        let floruit, death;
        if (c && !useRosterDates) {
            floruit = pick(c.floruit, r.floruit);
            death = pick(c.death, r.death);
            if (c.death && r.death && c.death !== r.death) {
                report.dateConflicts.push(`${names[0]}: curated d.${c.death} vs roster d.${r.death} (kept curated)`);
            }
        } else {
            floruit = pick(r.floruit);
            death = pick(r.death);
            if (c && c.death && r.death && c.death !== r.death) {
                report.dateConflicts.push(`${names[0]}: curated d.${c.death} vs roster d.${r.death} (kept ROSTER — curated dates self-declared unpreserved)`);
            }
        }
        const birth = pick(r.birth);
        if (!floruit && !death) report.noDates++;
        else if (!floruit && death && birth) report.birthOnlyRendered++;

        // school: curated badge verbatim (it is live and already badge-shaped);
        // otherwise derive one from the roster's free text.
        let school;
        if (c && c.school) {
            school = c.school;
            const derived = deriveSchool(r.school);
            if (derived && derived !== c.school) report.schoolConflicts++;
        } else {
            school = deriveSchool(r.school) || undefined;
            if (!school && r.school) report.schoolDropped.push(`${names[0]}: ${String(r.school).slice(0, 60)}`);
        }

        // teacher: teacher_key is the canonical parent-NODE name (all 876 resolve).
        // Resolve it to that node's primary so buildMasterLink produces a live link
        // instead of a CJK-encoded URL. The 49 roster masters with no teacher_key
        // are exactly the 49 flagged teacher_dangling — their teacher genuinely is
        // not in the database, so the raw string is kept and its link will 404.
        //
        // The ROSTER WINS here, unlike floruit/notes where curation wins. This is the
        // one field where the two datasets disagree on substance rather than coverage:
        // on 26 masters the curated string names the teacher-in-fact or the ordination
        // master, while teacher_key names the DHARMA heir (Touzi Yiqing was taught by
        // Fushan Fayuan but holds Dayang Jingxuan's lineage; Gyeongheo was ordained by
        // Manhwa Boseon but claimed Yongam Hyeeon's transmission). Tonsure is not
        // transmission — the rule this whole roster was built on.
        //
        // Consistency forces it regardless of which reading you prefer: the lineage
        // chart draws its edges from teacher_key, so a profile that named a different
        // teacher would contradict, on the same screen, the line the chart just drew.
        // Curated is the fallback, not the override. (User decision, 2026-07-17.)
        let teacher;
        if (r.teacher_key) {
            teacher = toPrimary(r.teacher_key) || (c && c.teacher) || r.teacher || undefined;
        } else if (c && c.teacher) {
            teacher = c.teacher;
        } else if (r.teacher) {
            teacher = r.teacher;
            report.teacherUnresolved++;
        }

        // students: union of the validated heirs (teacher_key inverse) with the
        // curated list, which is kept verbatim because it is live today — including
        // its 11 already-dead refs, which this merge must not silently delete.
        // Roster `students` entries are added only when they resolve; the rest are
        // dropped rather than shipped as links that 404 (they survive in the roster
        // and in the bio prose, and are unaffected by this file).
        const students = [];
        const seenStudent = new Set();
        const addStudent = (name) => {
            if (!name || seenStudent.has(name)) return;
            seenStudent.add(name);
            students.push(name);
        };
        for (const s of (c && c.students) || []) addStudent(toPrimary(s) || s);
        for (const s of derivedHeirs.get(names[0]) || []) addStudent(s);
        for (const s of r.students || []) {
            const p = toPrimary(s);
            if (p) addStudent(p);
            else report.studentsDropped++;
        }

        // notes: the field master.js renders as Biography and the SEO generator
        // truncates for its description. Curated notes win outright — those 300
        // pages are live and this merge leaves their text byte-identical. Everyone
        // else gets the roster's rich `bio` (943/943 coverage, ~520 chars of real
        // scholarship), falling back to the roster's short `notes`. Emitting the
        // bio *as* notes is what lets all 944 profiles carry a biography with no
        // change to any consumer; a separate `bio` field would only be dead weight
        // on a payload every visitor downloads.
        const notes = pick(c && c.notes, r.bio, r.notes);

        // links: project to the {label, url} master.js/SEO actually render, dropping
        // the roster's provenance fields (confirms/verified) — 1,512 strings that
        // would ride along on every runtime fetch for no rendered benefit.
        let links;
        const rawLinks = pick(c && c.links, r.links);
        if (rawLinks) {
            const seen = new Set();
            links = [];
            for (const l of rawLinks) {
                if (!l || !l.url || seen.has(l.url)) continue;
                seen.add(l.url);
                links.push({ label: l.label || l.url, url: l.url });
            }
            if (links.length === 0) links = undefined;
        }

        const rec = { names };
        if (floruit) rec.floruit = floruit;
        if (birth) rec.birth = birth;
        if (death) rec.death = death;
        if (school) rec.school = school;
        if (teacher) rec.teacher = teacher;
        if (notes) rec.notes = notes;
        if (links) rec.links = links;
        if (students.length) rec.students = students;
        const region = pick(c && c.region, r.region);
        if (region) rec.region = region;
        const attestation = pick(c && c.attestation, r.attestation);
        if (attestation) rec.attestation = attestation;
        out.push(rec);
    }

    // Curated masters with no roster counterpart are kept verbatim — dropping one
    // would 404 a page that is live right now.
    for (const c of orphans) {
        out.push(c);
        report.orphansKept++;
    }

    const payload = { masters: out, count: out.length };
    const json = JSON.stringify(payload, null, 1) + '\n';

    console.log('=== masters.json generation ===');
    console.log(`roster:          ${roster.length}`);
    console.log(`curated (input): ${curated.length}`);
    console.log(`  merged with roster: ${report.merged}`);
    console.log(`  kept as orphans:    ${report.orphansKept} -> ${orphans.map((o) => o.names[0]).join(', ') || '(none)'}`);
    console.log(`roster-only (new profiles): ${report.fromRoster}`);
    console.log(`OUTPUT RECORDS:  ${out.length}`);
    console.log('');
    console.log(`primary-name shifts (old URL preserved as alias): ${report.aliasesPreserved.length}`);
    for (const a of report.aliasesPreserved) console.log(`  ${a}`);
    console.log('');
    console.log(`school badge dropped (prose too long): ${report.schoolDropped.length}`);
    for (const s of report.schoolDropped.slice(0, 10)) console.log(`  ${s}`);
    console.log(`school differs curated-vs-derived (kept curated): ${report.schoolConflicts}`);
    console.log(`teacher kept raw / unresolvable (dangling -> link will 404): ${report.teacherUnresolved}`);
    console.log(`roster student refs dropped (no record -> would have 404'd): ${report.studentsDropped}`);
    console.log('');
    console.log(`date conflicts: ${report.dateConflicts.length}`);
    for (const d of report.dateConflicts) console.log(`  ${d}`);
    console.log(`records that will render NO dates: ${report.noDates}`);
    console.log(`records with birth+death but no floruit (birth unrendered by master.js): ${report.birthOnlyRendered}`);
    console.log('');
    console.log(`size: ${json.length.toLocaleString()} bytes`);

    if (dryRun) {
        console.log('\n--dry-run: nothing written.');
        return;
    }
    writeFileSync(MASTERS, json, 'utf8');
    console.log(`\nWROTE ${MASTERS}`);
    console.log('This file is fetched at RUNTIME by the live SPA. Review before pushing.');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
