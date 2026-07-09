// lib/bigram-codec.js
// Binary codec for the SPA bigram inverted index (mirrors the desktop IIDX
// shard layout from Services/InvertedSearchIndex.cs). See SYNTHESIS.md
// section 4 and IMPLEMENTATION_PLAN.md task W1.3.
//
// Wire format (little-endian, no padding):
//
//     'IIDX'                                 4 bytes ASCII magic
//     version            u32                 = 2
//     termCount          u32
//     docCount           u32
//     for each term:
//         termLen        u16                 length of utf-8 term bytes
//         termBytes      utf-8
//         postingByteLen u32                 length of varint-delta run
//         postingOffset  u32                 RELATIVE to start of postings section
//     [postings section: concatenated varint-delta byte runs]
//
// Posting lists are LEB128 unsigned varints over deltas (delta = current -
// previous, previous starts at 0). Doc IDs are uint16 (corpus capped at
// 65535) and inputs must be sorted-unique ascending.
//
// The decoder is lazy: readShardHeader returns metadata and term offsets
// only; postings are decoded on demand via decodePostingList. Hot-path code
// preallocates Uint16Array(count) and indexes Uint8Array directly (no
// DataView) for ~5-10 ns/posting throughput in V8.
//
// ---------------------------------------------------------------------------
// V3 wire format (little-endian, no padding) — adds per-posting term
// frequency so ranking is index-only (no text-shard fetches). Applies
// identically to bigram and unigram shards; per-shard header version is the
// authoritative format discriminator (manifest version is only a hint).
//
//     'IIDX'                                 4 bytes ASCII magic
//     version            u32                 = 3
//     termCount          u32
//     docCount           u32                 corpus doc count, informational
//     for each term (sorted lexicographically, UTF-16 code-unit order):
//         termLen        u16                 length of utf-8 term bytes
//         termBytes      utf-8               (1-char unigram terms are legal)
//         count          u32                 NEW: number of postings (> 0)
//         postingByteLen u32                 byte length of this term's run
//         postingOffset  u32                 RELATIVE to postings section start
//     [postings section: per term, exactly `count` LEB128 varint PAIRS:
//         (docIdGap, tf) — docIdGap = docId − prevDocId (prev starts 0),
//         docIds sorted ascending unique in [0, 65535]; tf ≥ 1]
//
// The explicit dictionary `count` replaces v2's terminator-bit recovery
// (_countVarints): interleaving two varints per posting breaks that
// invariant, and the explicit count makes v3 header decode strictly cheaper
// (no postings scan). readShardHeader accepts versions 2 and 3 and callers
// dispatch on the returned version (v2 → decodePostingList, v3 →
// decodePostingListV3).
// ---------------------------------------------------------------------------

const MAGIC_BYTES = new Uint8Array([0x49, 0x49, 0x44, 0x58]); // 'IIDX'
const VERSION = 2;
export const VERSION_V3 = 3;
const MAX_DOC_ID = 0xffff; // uint16 cap; docCount is bounded above

const _utf8Encoder = new TextEncoder();
const _utf8Decoder = new TextDecoder('utf-8');

/**
 * Encode a sorted-unique list of doc IDs as a varint-delta byte run.
 * @param {number[]|Uint16Array} sortedDocIds - Ascending, unique doc IDs.
 * @returns {Uint8Array} Encoded posting list (may be empty).
 * @throws {Error} when input is not sorted ascending unique or contains values outside [0, 65535].
 */
export function encodePostingList(sortedDocIds) {
    const out = [];
    let prev = 0;
    for (let i = 0; i < sortedDocIds.length; i++) {
        const v = sortedDocIds[i];
        if (v < 0 || v > MAX_DOC_ID || (v | 0) !== v) {
            throw new Error(`encodePostingList: doc id ${v} out of uint16 range [0, ${MAX_DOC_ID}]`);
        }
        if (i > 0 && v <= sortedDocIds[i - 1]) {
            throw new Error('encodePostingList: input must be sorted ascending and unique');
        }
        let delta = (v - prev) >>> 0;
        prev = v;
        while (delta >= 0x80) {
            out.push((delta & 0x7f) | 0x80);
            delta >>>= 7;
        }
        out.push(delta & 0x7f);
    }
    return Uint8Array.from(out);
}

/**
 * Decode a varint-delta byte run into a Uint16Array of doc IDs.
 * @param {Uint8Array} bytes - Buffer holding the encoded run (may be a larger shard buffer).
 * @param {number} count - Number of doc IDs to decode.
 * @param {number} [offset=0] - Byte offset within `bytes` where the run starts.
 * @returns {Uint16Array} Decoded doc IDs (length === count).
 */
export function decodePostingList(bytes, count, offset = 0) {
    const out = new Uint16Array(count);
    const end = bytes.length;
    let p = offset;
    let prev = 0;
    for (let i = 0; i < count; i++) {
        let delta = 0;
        let shift = 0;
        let b;
        do {
            if (p >= end) {
                throw new Error(`decodePostingList: truncated buffer at byte ${p} while decoding entry ${i + 1}/${count}`);
            }
            b = bytes[p++];
            delta |= (b & 0x7f) << shift;
            shift += 7;
        } while ((b & 0x80) !== 0);
        prev = (prev + (delta >>> 0)) & 0xffff;
        out[i] = prev;
    }
    return out;
}

/**
 * Encode a sorted-unique list of doc IDs plus per-doc term frequencies as a
 * v3 varint pair run: exactly one (docIdGap, tf) varint pair per posting.
 * @param {number[]|Uint16Array} docIds - Ascending, unique doc IDs in [0, 65535].
 * @param {number[]|Uint32Array} tfs - Same-length term frequencies, integers ≥ 1.
 * @returns {Uint8Array} Encoded posting run (may be empty).
 * @throws {Error} when docIds is not sorted ascending unique, contains values
 *         outside [0, 65535], tfs length differs, or any tf is not an integer ≥ 1.
 */
export function encodePostingListWithTf(docIds, tfs) {
    if (docIds.length !== tfs.length) {
        throw new Error(`encodePostingListWithTf: docIds/tfs length mismatch (${docIds.length} vs ${tfs.length})`);
    }
    const out = [];
    let prev = 0;
    for (let i = 0; i < docIds.length; i++) {
        const v = docIds[i];
        if (v < 0 || v > MAX_DOC_ID || (v | 0) !== v) {
            throw new Error(`encodePostingListWithTf: doc id ${v} out of uint16 range [0, ${MAX_DOC_ID}]`);
        }
        if (i > 0 && v <= docIds[i - 1]) {
            throw new Error('encodePostingListWithTf: docIds must be sorted ascending and unique');
        }
        const tf = tfs[i];
        if (!Number.isInteger(tf) || tf < 1) {
            throw new Error(`encodePostingListWithTf: tf ${tf} at index ${i} must be an integer >= 1`);
        }
        _pushVarint(out, (v - prev) >>> 0);
        prev = v;
        _pushVarint(out, tf >>> 0);
    }
    return Uint8Array.from(out);
}

/**
 * Decode a v3 varint pair run into doc IDs and term frequencies.
 * @param {Uint8Array} bytes - Buffer holding the encoded run (may be a larger shard buffer).
 * @param {number} count - Number of postings (docId/tf pairs) to decode.
 * @param {number} [offset=0] - Byte offset within `bytes` where the run starts.
 * @returns {{docIds: Uint16Array, tfs: Uint32Array}} Both of length === count.
 * @throws {Error} when a varint is truncated / the run overflows the buffer.
 */
export function decodePostingListV3(bytes, count, offset = 0) {
    const docIds = new Uint16Array(count);
    const tfs = new Uint32Array(count);
    const end = bytes.length;
    let p = offset;
    let prev = 0;
    for (let i = 0; i < count; i++) {
        let delta = 0;
        let shift = 0;
        let b;
        do {
            if (p >= end) {
                throw new Error(`decodePostingListV3: truncated buffer at byte ${p} while decoding entry ${i + 1}/${count} (docIdGap)`);
            }
            b = bytes[p++];
            delta |= (b & 0x7f) << shift;
            shift += 7;
        } while ((b & 0x80) !== 0);
        prev = (prev + (delta >>> 0)) & 0xffff;
        docIds[i] = prev;

        let tf = 0;
        shift = 0;
        do {
            if (p >= end) {
                throw new Error(`decodePostingListV3: truncated buffer at byte ${p} while decoding entry ${i + 1}/${count} (tf)`);
            }
            b = bytes[p++];
            tf |= (b & 0x7f) << shift;
            shift += 7;
        } while ((b & 0x80) !== 0);
        tfs[i] = tf >>> 0;
    }
    return { docIds, tfs };
}

/**
 * Encode a full shard.
 * @param {Array<{term:string, postings:Uint8Array, count:number}>} termList
 *        Term entries. `postings` must already be varint-delta encoded
 *        (see encodePostingList). `count` is the number of doc IDs.
 * @param {number} docCount - Total docs in the corpus this shard belongs to.
 * @returns {Uint8Array} Full shard bytes (header + dictionary + postings).
 * @throws {Error} when any term exceeds 65535 UTF-8 bytes.
 */
export function encodeShard(termList, docCount) {
    // Pre-encode terms to count exact byte sizes.
    const termBytesArr = new Array(termList.length);
    let dictBytes = 0;
    let postingsBytes = 0;
    for (let i = 0; i < termList.length; i++) {
        const tb = _utf8Encoder.encode(termList[i].term);
        if (tb.length > 0xffff) {
            throw new Error(`encodeShard: term too long (${tb.length} bytes, max 65535)`);
        }
        termBytesArr[i] = tb;
        // termLen u16 + termBytes + postingByteLen u32 + postingOffset u32
        dictBytes += 2 + tb.length + 4 + 4;
        postingsBytes += termList[i].postings.length;
    }

    // Header: 4 (magic) + 4 (version) + 4 (termCount) + 4 (docCount) = 16
    const headerBytes = 16;
    const total = headerBytes + dictBytes + postingsBytes;
    const buf = new Uint8Array(total);

    let p = 0;
    // Magic
    buf[p++] = MAGIC_BYTES[0];
    buf[p++] = MAGIC_BYTES[1];
    buf[p++] = MAGIC_BYTES[2];
    buf[p++] = MAGIC_BYTES[3];
    // version u32 LE
    p = _writeU32LE(buf, p, VERSION);
    // termCount u32 LE
    p = _writeU32LE(buf, p, termList.length);
    // docCount u32 LE
    p = _writeU32LE(buf, p, docCount);

    // Dictionary section. postingOffset is relative to start of postings section.
    let postingOffset = 0;
    for (let i = 0; i < termList.length; i++) {
        const tb = termBytesArr[i];
        const postLen = termList[i].postings.length;
        // termLen u16 LE
        buf[p++] = tb.length & 0xff;
        buf[p++] = (tb.length >>> 8) & 0xff;
        // termBytes
        buf.set(tb, p);
        p += tb.length;
        // postingByteLen u32 LE
        p = _writeU32LE(buf, p, postLen);
        // postingOffset u32 LE
        p = _writeU32LE(buf, p, postingOffset);
        postingOffset += postLen;
    }

    // Postings section: concatenate. Also stash count in the term entries for
    // the caller's benefit (not part of the wire format on this layer).
    let postP = p;
    for (let i = 0; i < termList.length; i++) {
        buf.set(termList[i].postings, postP);
        postP += termList[i].postings.length;
    }

    return buf;
}

/**
 * Encode a full v3 shard (tf-carrying postings + explicit dictionary count).
 *
 * Closest analog to v2 encodeShard's signature: an ARRAY of term entries plus
 * docCount — except each entry carries raw {docIds, tfs} instead of a
 * pre-encoded posting run (encoding happens here via encodePostingListWithTf).
 * Unlike v2 (which trusts the caller to pre-sort), terms are sorted internally
 * in UTF-16 code-unit order so identical input always yields byte-identical
 * output regardless of input order. The input array is not mutated.
 *
 * @param {Array<{term:string, docIds:(number[]|Uint16Array), tfs:(number[]|Uint32Array)}>} termList
 *        Term entries. `docIds` must be sorted ascending unique in [0, 65535];
 *        `tfs` same-length integers ≥ 1.
 * @param {number} docCount - Total docs in the corpus this shard belongs to.
 * @returns {Uint8Array} Full v3 shard bytes (header + dictionary + postings).
 * @throws {Error} when a term exceeds 65535 UTF-8 bytes, a term has zero
 *         postings (count must be > 0), terms are duplicated, or a posting
 *         list fails encodePostingListWithTf validation.
 */
export function encodeShardV3(termList, docCount) {
    // Deterministic order: sort a copy by term, UTF-16 code-unit order (same
    // comparator the v2 builder uses before calling encodeShard).
    const sorted = termList.slice().sort((a, b) => (a.term < b.term ? -1 : a.term > b.term ? 1 : 0));

    const termBytesArr = new Array(sorted.length);
    const postingsArr = new Array(sorted.length);
    let dictBytes = 0;
    let postingsBytes = 0;
    for (let i = 0; i < sorted.length; i++) {
        const e = sorted[i];
        if (i > 0 && e.term === sorted[i - 1].term) {
            throw new Error(`encodeShardV3: duplicate term "${e.term}"`);
        }
        const tb = _utf8Encoder.encode(e.term);
        if (tb.length > 0xffff) {
            throw new Error(`encodeShardV3: term too long (${tb.length} bytes, max 65535)`);
        }
        if (e.docIds.length === 0) {
            throw new Error(`encodeShardV3: term "${e.term}" has zero postings (count must be > 0)`);
        }
        termBytesArr[i] = tb;
        postingsArr[i] = encodePostingListWithTf(e.docIds, e.tfs);
        // termLen u16 + termBytes + count u32 + postingByteLen u32 + postingOffset u32
        dictBytes += 2 + tb.length + 4 + 4 + 4;
        postingsBytes += postingsArr[i].length;
    }

    // Header: 4 (magic) + 4 (version) + 4 (termCount) + 4 (docCount) = 16
    const headerBytes = 16;
    const total = headerBytes + dictBytes + postingsBytes;
    const buf = new Uint8Array(total);

    let p = 0;
    buf[p++] = MAGIC_BYTES[0];
    buf[p++] = MAGIC_BYTES[1];
    buf[p++] = MAGIC_BYTES[2];
    buf[p++] = MAGIC_BYTES[3];
    p = _writeU32LE(buf, p, VERSION_V3);
    p = _writeU32LE(buf, p, sorted.length);
    p = _writeU32LE(buf, p, docCount);

    // Dictionary section. postingOffset is relative to start of postings section.
    let postingOffset = 0;
    for (let i = 0; i < sorted.length; i++) {
        const tb = termBytesArr[i];
        const postLen = postingsArr[i].length;
        // termLen u16 LE
        buf[p++] = tb.length & 0xff;
        buf[p++] = (tb.length >>> 8) & 0xff;
        // termBytes
        buf.set(tb, p);
        p += tb.length;
        // count u32 LE (explicit posting count — NEW in v3)
        p = _writeU32LE(buf, p, sorted[i].docIds.length);
        // postingByteLen u32 LE
        p = _writeU32LE(buf, p, postLen);
        // postingOffset u32 LE
        p = _writeU32LE(buf, p, postingOffset);
        postingOffset += postLen;
    }

    // Postings section: concatenate.
    let postP = p;
    for (let i = 0; i < sorted.length; i++) {
        buf.set(postingsArr[i], postP);
        postP += postingsArr[i].length;
    }

    return buf;
}

/**
 * Read just the shard header + dictionary, leaving postings undecoded.
 * Accepts version 2 AND version 3 shards; the per-shard version field is the
 * authoritative format discriminator and callers dispatch decoding on the
 * returned `version` (2 → decodePostingList, 3 → decodePostingListV3).
 * @param {Uint8Array} bytes - Full shard buffer.
 * @returns {{version:number, docCount:number, postingsStart:number,
 *            terms: Map<string,{offset:number, length:number, count:number}>}}
 *          `offset` is absolute (already added to postingsStart);
 *          `length` is byte length of the varint run; `count` is the number
 *          of postings — for v2 recovered by counting varint terminator bytes
 *          (high-bit-clear) via _countVarints; for v3 read directly from the
 *          explicit dictionary field (no postings scan).
 * @throws {Error} when buffer < 16 bytes, magic ≠ "IIDX", or version ∉ {2, 3}.
 */
export function readShardHeader(bytes) {
    if (bytes.length < 16) {
        throw new Error('readShardHeader: buffer too small for header');
    }
    if (bytes[0] !== MAGIC_BYTES[0] || bytes[1] !== MAGIC_BYTES[1] ||
        bytes[2] !== MAGIC_BYTES[2] || bytes[3] !== MAGIC_BYTES[3]) {
        throw new Error('readShardHeader: bad magic (expected IIDX)');
    }
    let p = 4;
    const version = _readU32LE(bytes, p); p += 4;
    const termCount = _readU32LE(bytes, p); p += 4;
    const docCount = _readU32LE(bytes, p); p += 4;

    if (version !== VERSION && version !== VERSION_V3) {
        throw new Error(`readShardHeader: unsupported version ${version} (expected ${VERSION} or ${VERSION_V3})`);
    }
    const isV3 = version === VERSION_V3;
    // v3 dictionary entries carry an extra explicit count u32 before
    // postingByteLen; fixed trailer after termBytes is 12 bytes vs v2's 8.
    const fixedTail = isV3 ? 12 : 8;

    // First pass: read dictionary entries. We need postingsStart to compute
    // absolute offsets, which we know after the dictionary is fully read.
    const rawEntries = new Array(termCount);
    for (let i = 0; i < termCount; i++) {
        if (p + 2 > bytes.length) {
            throw new Error(`readShardHeader: truncated dictionary at term ${i}/${termCount} (no termLen)`);
        }
        const termLen = bytes[p] | (bytes[p + 1] << 8);
        p += 2;
        if (p + termLen + fixedTail > bytes.length) {
            throw new Error(`readShardHeader: truncated dictionary at term ${i}/${termCount} (term bytes + offsets exceed buffer)`);
        }
        const term = _utf8Decoder.decode(bytes.subarray(p, p + termLen));
        p += termLen;
        let count = 0;
        if (isV3) {
            count = _readU32LE(bytes, p); p += 4;
        }
        const postingByteLen = _readU32LE(bytes, p); p += 4;
        const postingOffset = _readU32LE(bytes, p); p += 4;
        rawEntries[i] = { term, count, postingByteLen, postingOffset };
    }

    const postingsStart = p;
    const terms = new Map();
    for (let i = 0; i < termCount; i++) {
        const e = rawEntries[i];
        const absOffset = postingsStart + e.postingOffset;
        if (absOffset + e.postingByteLen > bytes.length) {
            throw new Error(`readShardHeader: posting run for term "${e.term}" exceeds buffer (offset=${absOffset}, len=${e.postingByteLen}, buffer=${bytes.length})`);
        }
        terms.set(e.term, {
            offset: absOffset,
            length: e.postingByteLen,
            count: isV3 ? e.count : _countVarints(bytes, absOffset, e.postingByteLen),
        });
    }

    return { version, docCount, postingsStart, terms };
}

// --- internals ---

// Append one LEB128 unsigned varint to a plain byte array.
function _pushVarint(out, v) {
    while (v >= 0x80) {
        out.push((v & 0x7f) | 0x80);
        v >>>= 7;
    }
    out.push(v & 0x7f);
}

function _writeU32LE(buf, p, v) {
    buf[p] = v & 0xff;
    buf[p + 1] = (v >>> 8) & 0xff;
    buf[p + 2] = (v >>> 16) & 0xff;
    buf[p + 3] = (v >>> 24) & 0xff;
    return p + 4;
}

function _readU32LE(buf, p) {
    return (buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16) | (buf[p + 3] << 24)) >>> 0;
}

// Count varint-encoded values in a byte run by counting bytes whose high bit
// is clear (each varint terminates on the first such byte).
function _countVarints(bytes, offset, length) {
    let n = 0;
    const end = offset + length;
    for (let i = offset; i < end; i++) {
        if ((bytes[i] & 0x80) === 0) n++;
    }
    return n;
}
