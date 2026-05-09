// kwic.js — passage-level KWIC search within a parsed TEI document
// Takes output of parseTei() (linesById Map, lineOrder Array) and a search term.

import { normalize, normalizeString, rawIndexFromNormalizedPos } from './cjk-normalize.js';

/**
 * Returns true if the term contains CJK characters, meaning we should
 * use exact (case-sensitive) matching instead of case-insensitive.
 */
function isCjk(term) {
  return /[\u3000-\u9fff\uf900-\ufaff]/.test(term);
}

/**
 * Returns true if a line ID is synthetic (internal break marker).
 */
function isSynthetic(id) {
  return id.startsWith('__');
}

/**
 * Escape regex special characters in a string.
 */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Walk backwards from `idx` in lineOrder, skipping synthetic IDs,
 * and return the real ID found `count` steps back (or the earliest real ID).
 */
function walkBack(lineOrder, idx, count) {
  let steps = 0;
  let result = idx;
  for (let i = idx - 1; i >= 0; i--) {
    if (isSynthetic(lineOrder[i])) continue;
    steps++;
    result = i;
    if (steps >= count) break;
  }
  return lineOrder[result];
}

/**
 * Walk forwards from `idx` in lineOrder, skipping synthetic IDs,
 * and return the real ID found `count` steps forward (or the latest real ID).
 */
function walkForward(lineOrder, idx, count) {
  let steps = 0;
  let result = idx;
  for (let i = idx + 1; i < lineOrder.length; i++) {
    if (isSynthetic(lineOrder[i])) continue;
    steps++;
    result = i;
    if (steps >= count) break;
  }
  return lineOrder[result];
}

/**
 * Search a parsed TEI document for occurrences of `term` and return
 * structured KWIC (keyword-in-context) hits with lb ranges.
 *
 * @param {Map<string,{text:string}>} linesById - Map from line ID to line object (must have .text)
 * @param {string[]} lineOrder - Ordered array of line IDs
 * @param {string} term - The search term
 * @param {number} [contextChars=40] - Max characters of context on each side
 * @returns {Array<{startLb:string, endLb:string, left:string, match:string, right:string, lineId:string}>}
 */
export function findPassages(linesById, lineOrder, term, contextChars = 40) {
  if (!term || !lineOrder.length) return [];

  const cjk = isCjk(term);

  // Normalize the query once (CJK branch only). If normalization collapses
  // the query to empty (e.g. punctuation-only), fall through to "no match".
  const normTerm = cjk ? normalizeString(term) : '';
  if (cjk && normTerm.length === 0) return [];

  // Build flat arrays of real (non-synthetic) line texts and their indices
  const realIndices = [];   // index into lineOrder
  const realIds = [];       // line IDs
  const realTexts = [];     // line texts
  for (let i = 0; i < lineOrder.length; i++) {
    const id = lineOrder[i];
    if (isSynthetic(id)) continue;
    const entry = linesById.get(id);
    if (!entry) continue;
    const text = typeof entry === 'string' ? entry : (entry.text ?? '');
    realIndices.push(i);
    realIds.push(id);
    realTexts.push(text);
  }

  const hits = [];

  for (let ri = 0; ri < realIds.length; ri++) {
    const lineText = realTexts[ri];
    const lineId = realIds[ri];
    const lineIdx = realIndices[ri]; // position in lineOrder

    // Find all occurrences of term in this line.
    // For CJK we collect raw [start, end) ranges (after normalize→raw map).
    // For Latin we collect plain positions and use term.length as the span.
    const ranges = [];
    if (cjk) {
      // Normalize line text once; match on normalized; map back to raw indices
      // so display strings preserve original punctuation.
      const nl = normalize(lineText);
      const normLine = nl.normalized;
      if (normLine.length >= normTerm.length) {
        let pos = -1;
        while (true) {
          const found = normLine.indexOf(normTerm, pos + 1);
          if (found === -1) break;
          const rawStart = rawIndexFromNormalizedPos(nl, found);
          const rawEnd = rawIndexFromNormalizedPos(nl, found + normTerm.length);
          ranges.push([rawStart, rawEnd]);
          pos = found;
        }
      }
    } else {
      // Case-insensitive match via regex
      const pattern = new RegExp(escapeRegex(term), 'gi');
      let m;
      while ((m = pattern.exec(lineText)) !== null) {
        ranges.push([m.index, m.index + term.length]);
        // Prevent infinite loop on zero-length matches
        if (m[0].length === 0) pattern.lastIndex++;
      }
    }

    for (const [matchStart, matchEnd] of ranges) {
      const matchedText = lineText.slice(matchStart, matchEnd);

      // --- Left context ---
      let leftBuf = lineText.slice(0, matchStart);
      if (leftBuf.length < contextChars) {
        // Prepend text from preceding real lines (add space for Latin text)
        for (let pi = ri - 1; pi >= 0 && leftBuf.length < contextChars; pi--) {
          leftBuf = realTexts[pi] + (cjk ? '' : ' ') + leftBuf;
        }
      }
      let left = leftBuf.slice(-contextChars);
      // Trim to character/word boundary: for Latin text, drop partial leading word
      if (left.length === contextChars && !cjk) {
        const spaceIdx = left.indexOf(' ');
        if (spaceIdx > 0 && spaceIdx < left.length - 1) {
          left = left.slice(spaceIdx + 1);
        }
      }

      // --- Right context ---
      let rightBuf = lineText.slice(matchEnd);
      if (rightBuf.length < contextChars) {
        // Append text from following real lines (add space for Latin text)
        for (let ni = ri + 1; ni < realTexts.length && rightBuf.length < contextChars; ni++) {
          rightBuf = rightBuf + (cjk ? '' : ' ') + realTexts[ni];
        }
      }
      let right = rightBuf.slice(0, contextChars);
      // Trim to character/word boundary: for Latin text, drop partial trailing word
      if (right.length === contextChars && !cjk) {
        const spaceIdx = right.lastIndexOf(' ');
        if (spaceIdx > 0) {
          right = right.slice(0, spaceIdx);
        }
      }

      // --- lb range: 2 real lines back / forward from match line ---
      const startLb = walkBack(lineOrder, lineIdx, 2);
      const endLb = walkForward(lineOrder, lineIdx, 2);

      hits.push({
        startLb,
        endLb,
        left,
        match: matchedText,
        right,
        lineId,
      });
    }
  }

  // Already in lineOrder position order since we iterated in order.
  return hits;
}
