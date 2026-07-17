// formatDates lives in THREE places that must agree, plus a fourth in the desktop
// app (LineageGraphBuilder.FormatDates):
//
//   lib/lineage-data.js        — the lineage chart
//   views/master.js            — the master profile
//   build/generate-seo-pages.js — the static/noscript pages
//
// They drifted, and the drift shipped. views/master.js took (floruit, death) and
// never saw `birth`, so it hid a birth year we hold on 252 masters (Songshan Puji
// rendered "d. 739" while his record says 651) and, worse, printed a floruit as
// the left side of a range on 286 masters: Daoan (fl. 312, b. 314, d. 385) came
// out "312–385", which reads as a birth year and is off by two. The generator had
// the identical defect.
//
// A floruit means "active around". It is not a birth year and never opens a range.
// These tests pin the contract against the source copies rather than a re-typed
// one, so a copy that drifts fails here instead of on a live page.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** Pull a formatDates(m) implementation straight out of a source file and eval it. */
function extractFormatDates(path) {
    const src = readFileSync(new URL(path, import.meta.url), 'utf8');
    const start = src.indexOf('function formatDates(m)');
    assert.notEqual(start, -1, `${path}: no formatDates(m) — signature changed?`);
    // walk braces to find the function body's end
    let depth = 0, i = src.indexOf('{', start), end = -1;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
    }
    assert.notEqual(end, -1, `${path}: unbalanced braces in formatDates`);
    return new Function(`${src.slice(start, end)}; return formatDates;`)();
}

const IMPLS = {
    'lib/lineage-data.js': extractFormatDates('../lib/lineage-data.js'),
    'views/master.js': extractFormatDates('../views/master.js'),
    'build/generate-seo-pages.js': extractFormatDates('../build/generate-seo-pages.js'),
};

const CASES = [
    // [record, expected, why]
    [{ birth: 651, death: 739 }, '651–739', 'Songshan Puji: birth+death is a range'],
    [{ floruit: 312, birth: 314, death: 385 }, '314–385', 'Daoan: birth wins over floruit; NEVER "312–385"'],
    [{ death: 739 }, 'd. 739', 'death alone'],
    [{ birth: 651 }, 'b. 651', 'birth alone'],
    [{ floruit: 312 }, 'fl. 312', 'floruit alone — the ONLY time a floruit renders'],
    [{ floruit: 312, death: 385 }, 'd. 385', 'floruit + death: floruit is not a birth year'],
    [{}, '', 'nothing known renders nothing — never a guess'],
    [{ birth: 651, death: 739, dates_conjectural: true }, 'c. 651–739', 'conjectural dates are marked'],
    [{ death: 739, dates_conjectural: true }, 'c. d. 739', 'conjectural applies to every branch'],
    [{ birth: 0, death: 0, floruit: 0 }, '', 'zero is missing, not a year (JS truthiness)'],
];

for (const [name, fn] of Object.entries(IMPLS)) {
    for (const [record, expected, why] of CASES) {
        test(`${name}: ${why}`, () => {
            assert.equal(fn(record), expected, `input ${JSON.stringify(record)}`);
        });
    }
}

test('all three implementations agree on every case', () => {
    for (const [record] of CASES) {
        const results = Object.entries(IMPLS).map(([n, fn]) => [n, fn(record)]);
        const distinct = new Set(results.map(([, v]) => v));
        assert.equal(distinct.size, 1,
            `drift on ${JSON.stringify(record)}: ${results.map(([n, v]) => `${n}="${v}"`).join(' vs ')}`);
    }
});

test('a floruit never opens a range, on any implementation', () => {
    // The exact shape of the shipped bug: floruit + death must not become "f–d".
    for (const [name, fn] of Object.entries(IMPLS)) {
        assert.notEqual(fn({ floruit: 312, death: 385 }), '312–385', `${name} regressed`);
        assert.notEqual(fn({ floruit: 312, birth: 314, death: 385 }), '312–385', `${name} regressed`);
    }
});
