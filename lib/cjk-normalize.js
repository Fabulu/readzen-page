// lib/cjk-normalize.js
// CJK match-normalization: strips whitespace, editorial punctuation, and
// supplementary PUA surrogates while preserving a normalized->raw index map.
// Mirrors Services/CjkMatchNormalizer.cs (desktop) byte-for-byte where it can.
//
// Browser + Node compatible ES module. No external dependencies.

// Build the frozen strip set once at module load.
const STRIP_SET = (() => {
    const s = new Set();

    // Whitespace (ASCII + Unicode)
    s.add(0x20); s.add(0x09); s.add(0x0A); s.add(0x0B); s.add(0x0C); s.add(0x0D);
    s.add(0xA0); s.add(0x1680); s.add(0x2028); s.add(0x2029);
    s.add(0x202F); s.add(0x205F); s.add(0x3000);
    for (let cp = 0x2000; cp <= 0x200A; cp++) s.add(cp);

    // CJK editorial punctuation
    s.add(0x3001); s.add(0x3002);
    s.add(0xFF01); s.add(0xFF0C); s.add(0xFF1A); s.add(0xFF1B); s.add(0xFF1F);
    s.add(0xFF08); s.add(0xFF09);
    s.add(0x300A); s.add(0x300B); s.add(0x3008); s.add(0x3009);
    s.add(0x300C); s.add(0x300D); s.add(0x300E); s.add(0x300F);
    s.add(0x3010); s.add(0x3011);

    // Western typography
    s.add(0x2014); s.add(0x2026);

    // Middle dots
    s.add(0x00B7); s.add(0x30FB);

    // Superscript annotation digits (annotation markers ⁰¹²³⁴⁵⁶⁷⁸⁹)
    s.add(0x2070); s.add(0x00B9); s.add(0x00B2); s.add(0x00B3);
    for (let cp = 0x2074; cp <= 0x2079; cp++) s.add(cp);

    // Supplementary PUA surrogates (U+DB00..U+DFFF). Mirrors the C# bug where
    // the high-surrogate test catches everything >= 0xDB00 including the
    // Ext-B low-surrogate range (0xDC00..0xDFFF). Preserved for parity.
    for (let cp = 0xDB00; cp <= 0xDFFF; cp++) s.add(cp);

    return Object.freeze(s);
})();

/** True if the BMP code unit is a stripped match-noise character. */
function isStripped(cu) {
    return STRIP_SET.has(cu);
}

/**
 * BMP CJK Unified Ideographs only: U+4E00..U+9FFF.
 * Matches C# ContainsCjk (CjkMatchNormalizer.cs lines 29-32).
 */
export function isCjk(cp) {
    return cp >= 0x4E00 && cp <= 0x9FFF;
}

/** True if string contains at least one BMP CJK Unified Ideograph. */
export function containsCjk(s) {
    if (s == null) return false;
    const str = String(s);
    for (let i = 0; i < str.length; i++) {
        const cu = str.charCodeAt(i);
        if (cu >= 0x4E00 && cu <= 0x9FFF) return true;
    }
    return false;
}

/**
 * Normalize raw text and return { raw, normalized, rawIndexByNormalizedIndex }.
 * The map's i-th entry is the index in `raw` of the i-th character in `normalized`.
 *
 * Iteration walks UTF-16 code units (charCodeAt), not code points: required for
 * surrogate-strip parity with the C# implementation.
 */
export function normalize(raw) {
    const input = raw == null ? '' : String(raw);

    // Pre-pass: U+3000 -> U+0020 (mirrors C# line 40). The replaced space is
    // then itself stripped during iteration, but doing the replace first keeps
    // surrogate offsets and parity with the desktop reference.
    const pre = input.indexOf('　') === -1 ? input : input.replace(/　/g, ' ');

    const len = pre.length;
    const map = new Int32Array(len);
    let outChars = '';
    let n = 0;

    // Build normalized string. For tiny strings concat is fine; for longer,
    // an array buffer + join is cheaper. Threshold ~64 chars empirically.
    if (len <= 64) {
        for (let i = 0; i < len; i++) {
            const cu = pre.charCodeAt(i);
            if (STRIP_SET.has(cu)) continue;
            outChars += pre[i];
            map[n++] = i;
        }
    } else {
        const buf = new Array(len);
        for (let i = 0; i < len; i++) {
            const cu = pre.charCodeAt(i);
            if (STRIP_SET.has(cu)) continue;
            buf[n] = pre[i];
            map[n++] = i;
        }
        buf.length = n;
        outChars = buf.join('');
    }

    return {
        raw: pre,
        normalized: outChars,
        rawIndexByNormalizedIndex: map.slice(0, n)
    };
}

/** Convenience: just the normalized string. */
export function normalizeString(raw) {
    return normalize(raw).normalized;
}

/**
 * Map a position in the normalized string back to its raw-text index.
 * Out-of-range positions clamp to 0 / raw.length, matching the C# helper.
 */
export function rawIndexFromNormalizedPos(nt, pos) {
    if (nt == null) return 0;
    if (pos <= 0) return 0;
    const map = nt.rawIndexByNormalizedIndex;
    if (pos >= map.length) return nt.raw.length;
    return map[pos];
}
