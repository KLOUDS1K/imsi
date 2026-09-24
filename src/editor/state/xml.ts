/**
 * Minimal, forgiving XML reader for XMP (works in workers and Node where
 * DOMParser is unavailable). Handles declarations/PIs, comments, CDATA,
 * DOCTYPE, entities, single/double/unquoted attributes, self-closing tags and
 * mismatched close tags (recovers instead of throwing). Namespace prefixes are
 * resolved from xmlns declarations, with well-known fallbacks for undeclared
 * `rdf:`, `crs:`, `x:` prefixes (hand-written presets often omit them).
 */

export interface XmlAttr {
  /** Qualified name as written, e.g. "crs:Exposure2012". */
  name: string;
  ns: string;
  local: string;
  value: string;
}

export interface XmlElement {
  name: string;
  ns: string;
  local: string;
  attrs: XmlAttr[];
  children: XmlElement[];
  parent: XmlElement | null;
  /** Concatenated character data directly inside this element. */
  text: string;
  /** prefix → namespace URI in scope. */
  scope: Map<string, string>;
}

export const NS = {
  x: 'adobe:ns:meta/',
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  crs: 'http://ns.adobe.com/camera-raw-settings/1.0/',
  xml: 'http://www.w3.org/XML/1998/namespace',
  tiff: 'http://ns.adobe.com/tiff/1.0/',
  exif: 'http://ns.adobe.com/exif/1.0/',
  aux: 'http://ns.adobe.com/exif/1.0/aux/',
  xmp: 'http://ns.adobe.com/xap/1.0/',
  kloud: 'https://kloud.photography/ns/studio/1.0/',
} as const;

const DEFAULT_SCOPE = new Map<string, string>([
  ['x', NS.x],
  ['rdf', NS.rdf],
  ['crs', NS.crs],
  ['xml', NS.xml],
  ['kloud', NS.kloud],
]);

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[body] ?? m;
  });
}

export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] as string);
}

function makeElement(name: string, parent: XmlElement | null, rawAttrs: [string, string][]): XmlElement {
  const scope = new Map(parent ? parent.scope : DEFAULT_SCOPE);
  for (const [n, v] of rawAttrs) {
    if (n === 'xmlns') scope.set('', v);
    else if (n.startsWith('xmlns:')) scope.set(n.slice(6), v);
  }
  const resolve = (qname: string, isAttr: boolean): { ns: string; local: string } => {
    const i = qname.indexOf(':');
    if (i < 0) return { ns: isAttr ? '' : (scope.get('') ?? ''), local: qname };
    const prefix = qname.slice(0, i);
    return { ns: scope.get(prefix) ?? prefix, local: qname.slice(i + 1) };
  };
  const q = resolve(name, false);
  const attrs: XmlAttr[] = [];
  for (const [n, v] of rawAttrs) {
    if (n === 'xmlns' || n.startsWith('xmlns:')) continue;
    const r = resolve(n, true);
    attrs.push({ name: n, ns: r.ns, local: r.local, value: v });
  }
  return { name, ns: q.ns, local: q.local, attrs, children: [], parent, text: '', scope };
}

const NAME_CHAR = /[^\s=/>"'<]/;

/** Parse XML text into a synthetic document root whose children are the top-level elements. */
export function parseXml(src: string): XmlElement {
  const root: XmlElement = { name: '#document', ns: '', local: '#document', attrs: [], children: [], parent: null, text: '', scope: DEFAULT_SCOPE };
  let cur = root;
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      cur.text += decodeEntities(src.slice(i));
      break;
    }
    if (lt > i) cur.text += decodeEntities(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
    } else if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      cur.text += src.slice(lt + 9, end < 0 ? n : end);
      i = end < 0 ? n : end + 3;
    } else if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      i = end < 0 ? n : end + 2;
    } else if (src.startsWith('<!', lt)) {
      // DOCTYPE (possibly with an internal subset in [...]).
      let j = lt + 2;
      let depth = 0;
      while (j < n) {
        const c = src[j];
        if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
        j++;
      }
      i = j + 1;
    } else if (src[lt + 1] === '/') {
      const end = src.indexOf('>', lt);
      const name = src.slice(lt + 2, end < 0 ? n : end).trim();
      i = end < 0 ? n : end + 1;
      // Pop to the matching open element; ignore stray close tags.
      let e: XmlElement | null = cur;
      while (e && e !== root && e.name !== name) e = e.parent;
      if (e && e !== root) cur = e.parent ?? root;
    } else {
      const parsed = parseTag(src, lt + 1);
      if (!parsed) {
        cur.text += '<';
        i = lt + 1;
        continue;
      }
      const el = makeElement(parsed.name, cur === root ? null : cur, parsed.attrs);
      el.parent = cur;
      cur.children.push(el);
      if (!parsed.selfClosing) cur = el;
      i = parsed.end;
    }
  }
  return root;
}

function parseTag(src: string, start: number): { name: string; attrs: [string, string][]; selfClosing: boolean; end: number } | null {
  let i = start;
  const n = src.length;
  while (i < n && NAME_CHAR.test(src[i])) i++;
  const name = src.slice(start, i);
  if (!name) return null;
  const attrs: [string, string][] = [];
  while (i < n) {
    while (i < n && /\s/.test(src[i])) i++;
    if (src[i] === '>') return { name, attrs, selfClosing: false, end: i + 1 };
    if (src[i] === '/' && src[i + 1] === '>') return { name, attrs, selfClosing: true, end: i + 2 };
    if (i >= n) break;
    const aStart = i;
    while (i < n && NAME_CHAR.test(src[i])) i++;
    const aName = src.slice(aStart, i);
    if (!aName) {
      i++; // skip junk character
      continue;
    }
    while (i < n && /\s/.test(src[i])) i++;
    if (src[i] !== '=') {
      attrs.push([aName, '']);
      continue;
    }
    i++;
    while (i < n && /\s/.test(src[i])) i++;
    const q = src[i];
    let value: string;
    if (q === '"' || q === "'") {
      const end = src.indexOf(q, i + 1);
      value = src.slice(i + 1, end < 0 ? n : end);
      i = end < 0 ? n : end + 1;
    } else {
      const vStart = i;
      while (i < n && !/[\s>]/.test(src[i]) && !(src[i] === '/' && src[i + 1] === '>')) i++;
      value = src.slice(vStart, i);
    }
    attrs.push([aName, decodeEntities(value)]);
  }
  return { name, attrs, selfClosing: false, end: n };
}

/** Depth-first search for elements matching ns + local name. */
export function findAll(root: XmlElement, ns: string, local: string, out: XmlElement[] = []): XmlElement[] {
  for (const c of root.children) {
    if (c.ns === ns && c.local === local) out.push(c);
    findAll(c, ns, local, out);
  }
  return out;
}

export function childrenByName(el: XmlElement, ns: string, local: string): XmlElement[] {
  return el.children.filter((c) => c.ns === ns && c.local === local);
}
