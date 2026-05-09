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

const MAGIC = [0x49, 0x44, 0x58, 0x49]; // 'IDXI' on disk... actually 'IIDX' written byte 0..3
// NOTE: ASCII bytes for 'I','I','D','X' are 0x49,0x49,0x44,0x58. Define as constants
// to avoid TextEncoder calls in tight paths.
const MAGIC_BYTES = new Uint8Array([0x49, 0x49, 0x44, 0x58]); // 'IIDX'
const VERSION = 2;

const _utf8Encoder = new TextEncoder();
const _utf8Decoder = new TextDecoder('utf-8');

/**
 * Encode a sorted-unique list of doc IDs as a varint-delta byte run.
 * @param {number[]|Uint16Array} sortedDocIds - Ascending, unique doc IDs.
 * @returns {Uint8Array} Encoded posting list (may be empty).
 */
export function encodePostingList(sortedDocIds) {
    const out = [];
    let prev = 0;
    for (let i = 0; i < sortedDocIds.length; i++) {
        const v = sortedDocIds[i];
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
    let p = offset;
    let prev = 0;
    for (let i = 0; i < count; i++) {
        let delta = 0;
        let shift = 0;
        let b;
        do {
            b = bytes[p++];
            delta |= (b & 0x7f) << shift;
            shift += 7;
        } while ((b & 0x80) !== 0);
        // delta is treated as uint32; force unsigned via >>> 0 then add.
        prev = (prev + (delta >>> 0)) & 0xffff;
        out[i] = prev;
    }
    return out;
}

/**
 * Encode a full shard.
 * @param {Array<{term:string, postings:Uint8Array, count:number}>} termList
 *        Term entries. `postings` must already be varint-delta encoded
 *        (see encodePostingList). `count` is the number of doc IDs.
 * @param {number} docCount - Total docs in the corpus this shard belongs to.
 * @returns {Uint8Array} Full shard bytes (header + dictionary + postings).
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
 * Read just the shard header + dictionary, leaving postings undecoded.
 * @param {Uint8Array} bytes - Full shard buffer.
 * @returns {{version:number, docCount:number, postingsStart:number,
 *            terms: Map<string,{offset:number, length:number, count:number}>}}
 *          `offset` is absolute (already added to postingsStart);
 *          `length` is byte length of the varint run; `count` mirrors the
 *          caller-supplied term count for that posting (decoded from the
 *          length field by interpreting count = entries provided at encode
 *          time — but we don't store count in the wire format under this
 *          spec, so it's recovered by the caller from the manifest. See
 *          note below.)
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

    if (version !== VERSION) {
        throw new Error(`readShardHeader: unsupported version ${version} (expected ${VERSION})`);
    }

    // First pass: read dictionary entries. We need postingsStart to compute
    // absolute offsets, which we know after the dictionary is fully read.
    const rawEntries = new Array(termCount);
    for (let i = 0; i < termCount; i++) {
        const termLen = bytes[p] | (bytes[p + 1] << 8);
        p += 2;
        const term = _utf8Decoder.decode(bytes.subarray(p, p + termLen));
        p += termLen;
        const postingByteLen = _readU32LE(bytes, p); p += 4;
        const postingOffset = _readU32LE(bytes, p); p += 4;
        rawEntries[i] = { term, postingByteLen, postingOffset };
    }

    const postingsStart = p;
    const terms = new Map();
    for (let i = 0; i < termCount; i++) {
        const e = rawEntries[i];
        terms.set(e.term, {
            offset: postingsStart + e.postingOffset,
            length: e.postingByteLen,
            count: _countVarints(bytes, postingsStart + e.postingOffset, e.postingByteLen),
        });
    }

    return { version, docCount, postingsStart, terms };
}

// --- internals ---

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
