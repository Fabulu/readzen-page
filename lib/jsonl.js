// lib/jsonl.js
// Streaming JSONL reader. Fetches a JSONL file and yields parsed JSON
// objects as each newline-terminated row arrives, so views can render
// progressively instead of blocking on the full download.
//
// Uses fetch().body.getReader() + TextDecoder. Malformed lines are skipped
// silently — the caller gets only the rows that parsed cleanly.

/**
 * Stream a JSONL file row-by-row. Yields parsed JSON objects as they arrive.
 *
 * @param {string} url      The full URL of the JSONL file.
 * @param {AbortSignal=} signal Optional abort signal to cancel the fetch.
 * @returns {AsyncGenerator<any>}
 *
 * Throws on HTTP error (non-OK status) or on fetch/network failure.
 * Silently skips any line that fails JSON.parse.
 */
export async function* streamJsonl(url, signal) {
    const response = await fetch(url, { cache: 'default', signal });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
    }
    if (!response.body || !response.body.getReader) {
        // Environments without streaming support — fall back to full text.
        const text = await response.text();
        for (const row of splitAndParse(text)) yield row;
        return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            // Extract complete lines; keep the trailing partial line in buffer.
            let nlIdx;
            while ((nlIdx = buffer.indexOf('\n')) >= 0) {
                const line = buffer.substring(0, nlIdx);
                buffer = buffer.substring(nlIdx + 1);
                const trimmed = stripCr(line);
                if (!trimmed) continue;
                const parsed = safeParse(trimmed);
                if (parsed !== undefined) yield parsed;
            }
        }

        // Flush the decoder and any trailing line with no newline.
        buffer += decoder.decode();
        const tail = stripCr(buffer).trim();
        if (tail) {
            const parsed = safeParse(tail);
            if (parsed !== undefined) yield parsed;
        }
    } finally {
        try { reader.releaseLock(); } catch {}
    }
}

/**
 * Fetch a JSONL file and return all rows as an array. Convenience helper
 * over `streamJsonl` for views that don't need progressive rendering.
 *
 * @param {string} url
 * @param {AbortSignal=} signal
 * @returns {Promise<any[]>}
 */
export async function fetchJsonl(url, signal) {
    const out = [];
    for await (const row of streamJsonl(url, signal)) {
        out.push(row);
    }
    return out;
}

/** Parse a JSONL text blob into an array of rows, skipping malformed lines. */
function splitAndParse(text) {
    const out = [];
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
        if (!line) continue;
        const parsed = safeParse(line);
        if (parsed !== undefined) out.push(parsed);
    }
    return out;
}

function stripCr(line) {
    return line.charCodeAt(line.length - 1) === 13
        ? line.substring(0, line.length - 1)
        : line;
}

function safeParse(line) {
    try { return JSON.parse(line); }
    catch { return undefined; }
}
