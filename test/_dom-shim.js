// test/_dom-shim.js
// Minimal DOM/DOMParser shim for running tei.js tests under Node.
// Only supports the subset of DOM APIs that lib/tei.js actually touches:
//   - Node.TEXT_NODE / Node.ELEMENT_NODE
//   - DOMParser().parseFromString(xml, 'application/xml')
//   - doc.getElementsByTagName(name)
//   - doc.getElementsByTagNameNS(ns, localName)
//   - element.localName, .nodeType, .childNodes, .nodeValue
//   - element.getAttribute(name), .getAttributeNS(ns, localName)
//   - element.textContent
// It's a hand-rolled tokenizer, sufficient for the small inline XML used in tests.

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

class DomNode {
    constructor(nodeType) {
        this.nodeType = nodeType;
        this.childNodes = [];
        this.parentNode = null;
    }
}

class TextNode extends DomNode {
    constructor(value) {
        super(TEXT_NODE);
        this.nodeValue = value;
    }
    get textContent() {
        return this.nodeValue;
    }
}

class ElementNode extends DomNode {
    constructor(localName, namespaceURI, attrs) {
        super(ELEMENT_NODE);
        this.localName = localName;
        this.namespaceURI = namespaceURI || null;
        // attrs: { "n": "0001a01", "xml:lang": "zh", ... }
        this._attrs = attrs || {};
    }

    getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this._attrs, name)
            ? this._attrs[name]
            : null;
    }

    getAttributeNS(ns, localName) {
        // We store attributes keyed by their source string (possibly with prefix
        // like "xml:lang"). For simplicity, look up both "xml:lang" and bare "lang".
        // The TEI parser also falls back to getAttribute('xml:lang'), so this path
        // is rarely hit — but we try the obvious prefixed form first.
        if (ns === 'http://www.w3.org/XML/1998/namespace' && localName === 'lang') {
            if (this._attrs['xml:lang'] != null) return this._attrs['xml:lang'];
        }
        return this._attrs[localName] != null ? this._attrs[localName] : null;
    }

    get textContent() {
        let out = '';
        for (const child of this.childNodes) {
            if (child.nodeType === TEXT_NODE) out += child.nodeValue;
            else if (child.nodeType === ELEMENT_NODE) out += child.textContent;
        }
        return out;
    }

    getElementsByTagName(name) {
        const out = [];
        const walk = (node) => {
            for (const child of node.childNodes) {
                if (child.nodeType === ELEMENT_NODE) {
                    if (child.localName === name || child._prefixedName === name) {
                        out.push(child);
                    }
                    walk(child);
                }
            }
        };
        walk(this);
        return out;
    }

    getElementsByTagNameNS(ns, localName) {
        const out = [];
        const wantAll = ns === '*';
        const walk = (node) => {
            for (const child of node.childNodes) {
                if (child.nodeType === ELEMENT_NODE) {
                    if (
                        (wantAll || child.namespaceURI === ns) &&
                        child.localName === localName
                    ) {
                        out.push(child);
                    }
                    walk(child);
                }
            }
        };
        walk(this);
        return out;
    }
}

class Document extends DomNode {
    constructor() {
        super(9); // DOCUMENT_NODE
    }
    getElementsByTagName(name) {
        return ElementNode.prototype.getElementsByTagName.call(this, name);
    }
    getElementsByTagNameNS(ns, localName) {
        return ElementNode.prototype.getElementsByTagNameNS.call(this, ns, localName);
    }
}

/** Decode the handful of XML entities we care about. */
function decodeEntities(s) {
    return s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
        .replace(/&amp;/g, '&');
}

/**
 * Tiny tokenizer-driven XML parser. Handles:
 *   - elements with attributes
 *   - self-closing tags
 *   - text nodes and entity decoding
 *   - xmlns / xmlns:prefix declarations (resolves namespaceURI on elements)
 *   - XML declaration `<?xml ... ?>` (skipped)
 *   - comments `<!-- ... -->` (skipped)
 *   - CDATA `<![CDATA[...]]>` (preserved as text)
 */
class SimpleDOMParser {
    parseFromString(xml, _mimeType) {
        const doc = new Document();
        try {
            parseInto(xml, doc);
        } catch (err) {
            // Mimic DOMParser's behaviour: inject a <parsererror> element.
            const errEl = new ElementNode('parsererror', null, {});
            errEl.childNodes.push(new TextNode(String(err && err.message || err)));
            doc.childNodes.push(errEl);
        }
        return doc;
    }
}

function parseInto(xml, doc) {
    let i = 0;
    const len = xml.length;
    const stack = [doc];
    // Namespace stack: each entry is a map of prefix → uri. '' is the default ns.
    const nsStack = [{}];

    const currentNsMap = () => nsStack[nsStack.length - 1];
    const resolveNs = (prefix) => {
        for (let k = nsStack.length - 1; k >= 0; k -= 1) {
            if (Object.prototype.hasOwnProperty.call(nsStack[k], prefix)) {
                return nsStack[k][prefix];
            }
        }
        return null;
    };

    while (i < len) {
        if (xml[i] !== '<') {
            // Text node until next '<'.
            const start = i;
            while (i < len && xml[i] !== '<') i += 1;
            const raw = xml.substring(start, i);
            if (raw.length > 0) {
                const parent = stack[stack.length - 1];
                if (parent !== doc || raw.trim().length > 0) {
                    parent.childNodes.push(new TextNode(decodeEntities(raw)));
                }
            }
            continue;
        }

        // '<' something
        if (xml.startsWith('<!--', i)) {
            const end = xml.indexOf('-->', i + 4);
            i = end < 0 ? len : end + 3;
            continue;
        }
        if (xml.startsWith('<![CDATA[', i)) {
            const end = xml.indexOf(']]>', i + 9);
            const cdataEnd = end < 0 ? len : end;
            const text = xml.substring(i + 9, cdataEnd);
            stack[stack.length - 1].childNodes.push(new TextNode(text));
            i = end < 0 ? len : end + 3;
            continue;
        }
        if (xml.startsWith('<?', i)) {
            const end = xml.indexOf('?>', i + 2);
            i = end < 0 ? len : end + 2;
            continue;
        }
        if (xml.startsWith('<!', i)) {
            // DOCTYPE or similar — skip until matching '>'.
            const end = xml.indexOf('>', i + 2);
            i = end < 0 ? len : end + 1;
            continue;
        }

        // End tag: </name>
        if (xml[i + 1] === '/') {
            const end = xml.indexOf('>', i + 2);
            if (end < 0) throw new Error('Unterminated end tag');
            stack.pop();
            nsStack.pop();
            i = end + 1;
            continue;
        }

        // Start tag.
        const tagEnd = findTagEnd(xml, i + 1);
        if (tagEnd < 0) throw new Error('Unterminated start tag');
        const inner = xml.substring(i + 1, tagEnd);
        const selfClosing = inner.endsWith('/');
        const body = selfClosing ? inner.slice(0, -1) : inner;
        const { name, attrs } = parseTagHead(body);

        // Build a fresh namespace map inheriting from parent.
        const parentNs = currentNsMap();
        const newNs = Object.assign({}, parentNs);
        for (const [k, v] of Object.entries(attrs)) {
            if (k === 'xmlns') newNs[''] = v;
            else if (k.startsWith('xmlns:')) newNs[k.substring(6)] = v;
        }
        nsStack.push(newNs);

        const colon = name.indexOf(':');
        const prefix = colon >= 0 ? name.substring(0, colon) : '';
        const localName = colon >= 0 ? name.substring(colon + 1) : name;
        let namespaceURI = null;
        if (colon >= 0) {
            namespaceURI = resolveNs(prefix);
        } else {
            namespaceURI = resolveNs('');
        }

        const el = new ElementNode(localName, namespaceURI, attrs);
        el._prefixedName = name;
        stack[stack.length - 1].childNodes.push(el);

        if (selfClosing) {
            nsStack.pop(); // pop the scope we just pushed
            i = tagEnd + 1;
            continue;
        }

        stack.push(el);
        i = tagEnd + 1;
    }
}

/** Find the '>' that ends a start tag, respecting quoted attribute values. */
function findTagEnd(xml, start) {
    let i = start;
    const len = xml.length;
    let quote = null;
    while (i < len) {
        const ch = xml[i];
        if (quote) {
            if (ch === quote) quote = null;
        } else {
            if (ch === '"' || ch === "'") quote = ch;
            else if (ch === '>') return i;
        }
        i += 1;
    }
    return -1;
}

/** Parse `name attr1="v1" attr2='v2'` into { name, attrs }. */
function parseTagHead(body) {
    let i = 0;
    // Read name.
    while (i < body.length && !/\s/.test(body[i])) i += 1;
    const name = body.substring(0, i);
    const attrs = {};
    while (i < body.length) {
        // Skip whitespace.
        while (i < body.length && /\s/.test(body[i])) i += 1;
        if (i >= body.length) break;
        // Read attr name.
        const nameStart = i;
        while (i < body.length && body[i] !== '=' && !/\s/.test(body[i])) i += 1;
        const attrName = body.substring(nameStart, i);
        if (!attrName) break;
        // Skip whitespace and '='.
        while (i < body.length && /\s/.test(body[i])) i += 1;
        if (body[i] !== '=') {
            // Valueless attribute.
            attrs[attrName] = '';
            continue;
        }
        i += 1;
        while (i < body.length && /\s/.test(body[i])) i += 1;
        // Read quoted value.
        const q = body[i];
        if (q === '"' || q === "'") {
            i += 1;
            const valStart = i;
            while (i < body.length && body[i] !== q) i += 1;
            attrs[attrName] = decodeEntities(body.substring(valStart, i));
            i += 1;
        } else {
            // Unquoted value — read until whitespace.
            const valStart = i;
            while (i < body.length && !/\s/.test(body[i])) i += 1;
            attrs[attrName] = decodeEntities(body.substring(valStart, i));
        }
    }
    return { name, attrs };
}

/** Install the shim onto globalThis. Idempotent. */
export function installDomShim() {
    if (!globalThis.Node) {
        globalThis.Node = { TEXT_NODE, ELEMENT_NODE };
    }
    if (!globalThis.DOMParser) {
        globalThis.DOMParser = SimpleDOMParser;
    }
}
