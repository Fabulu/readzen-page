// lib/english-normalize.js
// English match-normalization + word tokenization — the DELIBERATE OPPOSITE of
// lib/cjk-normalize.js. CJK normalization strips whitespace (word boundaries
// are meaningless between ideographs); English normalization PRESERVES them,
// because whitespace is English's only tokenization signal.
//
// One shared module so every path that touches English text — the bigram index
// build (build/build-bigram-index.js), the english.jsonl build
// (build/build-english-jsonl.js), and the Devvit engine port — normalizes
// identically. A single skew surface: if emission and verification ever used
// different normalizations they would produce phantom or missing hits with no
// error (RUN-20260717-1507 risk #2).
//
// Browser + Node compatible ES module. No external dependencies.

/**
 * Normalize English body text for case-insensitive substring / word matching.
 * Lowercase → collapse every whitespace run to a single ASCII space → trim.
 *
 * Byte-for-byte the former `normalizeForSearch` from build-english-jsonl.js
 * (promoted here so index emission and the english.jsonl fallback agree).
 * NON-space, NON-latin content (e.g. inline CJK) is preserved verbatim so the
 * CJK bigram walk can still index it.
 */
export function englishNormalize(raw) {
    if (!raw) return '';
    return raw.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Maximal `[a-z0-9']+` runs. Operates on already-normalized (lowercased) text —
 * callers pass the output of `englishNormalize`. No stemming, no stopwords, no
 * minimum length: at this corpus scale the postings are trivially small and
 * honesty beats cleverness (RUN-20260717-1507 CONTRACT §2).
 *
 * An emitted token is pure ASCII `[a-z0-9']`, so it can never collide with a
 * two-CJK-character bigram — English word terms and CJK bigrams therefore share
 * one shard set with no namespace prefix.
 */
export const ENGLISH_WORD_RE = /[a-z0-9']+/g;

export function englishWordTerms(normalizedText) {
    if (!normalizedText) return [];
    return normalizedText.match(ENGLISH_WORD_RE) || [];
}
