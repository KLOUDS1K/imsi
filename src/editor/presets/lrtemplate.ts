/**
 * Reader for legacy Lightroom develop presets (.lrtemplate, Lightroom ≤ 7.2).
 * They are Lua table literals:
 *
 *   s = { id = "…", title = "Night", value = { settings = { Exposure2012 = 0.35,
 *         ToneCurvePV2012 = { 0, 0, 255, 255 }, WhiteBalance = "As Shot" } } }
 *
 * The settings use the same names as crs: XMP attributes, so they are turned
 * into CrsValues and share the XMP mapping.
 */
import type { CrsValues, XmpValue } from '@/editor/state';

type LuaValue = string | number | boolean | null | LuaTable;
interface LuaTable {
  hash: Map<string, LuaValue>;
  list: LuaValue[];
}

type Tok = { t: 'str'; v: string } | { t: 'num'; v: number } | { t: 'id'; v: string } | { t: 'p'; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === '-' && src[i + 1] === '-') {
      // Comment: --[[ block ]] or -- line
      if (src.startsWith('[[', i + 2)) {
        const end = src.indexOf(']]', i + 4);
        i = end < 0 ? n : end + 2;
      } else {
        const end = src.indexOf('\n', i);
        i = end < 0 ? n : end + 1;
      }
    } else if (c === '"' || c === "'") {
      let s = '';
      i++;
      while (i < n && src[i] !== c) {
        if (src[i] === '\\' && i + 1 < n) {
          const e = src[i + 1];
          s += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
          i += 2;
        } else s += src[i++];
      }
      i++;
      out.push({ t: 'str', v: s });
    } else if (c === '[' && src[i + 1] === '[') {
      const end = src.indexOf(']]', i + 2);
      out.push({ t: 'str', v: src.slice(i + 2, end < 0 ? n : end) });
      i = end < 0 ? n : end + 2;
    } else if (/[0-9.]/.test(c) || (c === '-' && /[0-9.]/.test(src[i + 1] ?? ''))) {
      const m = /^-?(?:0x[0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/.exec(src.slice(i, i + 64));
      if (!m) {
        i++;
        continue;
      }
      out.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i, i + 256)) as RegExpExecArray;
      out.push({ t: 'id', v: m[0] });
      i += m[0].length;
    } else {
      out.push({ t: 'p', v: c });
      i++;
    }
  }
  return out;
}

class Parser {
  private i = 0;
  constructor(private toks: Tok[]) {}

  private peek(o = 0): Tok | undefined {
    return this.toks[this.i + o];
  }

  private isP(v: string, o = 0): boolean {
    const t = this.peek(o);
    return !!t && t.t === 'p' && t.v === v;
  }

  value(): LuaValue {
    const t = this.toks[this.i++];
    if (!t) return null;
    if (t.t === 'str' || t.t === 'num') return t.v;
    if (t.t === 'id') {
      // Call syntax `ZSTR "$$$/Key=Default"` (localized strings): keep the default text.
      const next = this.peek();
      if (next && next.t === 'str' && t.v !== 'true' && t.v !== 'false' && t.v !== 'nil') {
        this.i++;
        const eq = next.v.startsWith('$$$/') ? next.v.indexOf('=') : -1;
        return eq >= 0 ? next.v.slice(eq + 1) : next.v;
      }
      return t.v === 'true' ? true : t.v === 'false' ? false : null;
    }
    if (t.v === '{') return this.table();
    return null;
  }

  private table(): LuaTable {
    const tbl: LuaTable = { hash: new Map(), list: [] };
    while (this.i < this.toks.length && !this.isP('}')) {
      const t = this.peek();
      if (t && t.t === 'id' && this.isP('=', 1)) {
        this.i += 2;
        tbl.hash.set(t.v, this.value());
      } else if (this.isP('[')) {
        this.i++;
        const key = this.value();
        if (this.isP(']')) this.i++;
        if (this.isP('=')) this.i++;
        const v = this.value();
        if (typeof key === 'string' || typeof key === 'number') tbl.hash.set(String(key), v);
      } else {
        tbl.list.push(this.value());
      }
      if (this.isP(',') || this.isP(';')) this.i++;
    }
    this.i++; // '}'
    return tbl;
  }
}

function asTable(v: LuaValue | undefined): LuaTable | null {
  return v !== null && typeof v === 'object' ? v : null;
}

export interface LrTemplate {
  title?: string;
  values: CrsValues;
}

/** Parse an .lrtemplate file. Returns null when it is not a develop preset. */
export function parseLrTemplate(text: string): LrTemplate | null {
  const brace = text.indexOf('{');
  if (brace < 0) return null;
  const root = asTable(new Parser(tokenize(text.slice(brace))).value());
  if (!root) return null;
  const settings = asTable(asTable(root.hash.get('value') ?? null)?.hash.get('settings') ?? null);
  if (!settings) return null;
  const crs = new Map<string, XmpValue>();
  for (const [k, v] of settings.hash) {
    if (typeof v === 'number') crs.set(k, String(v));
    else if (typeof v === 'boolean') crs.set(k, v ? 'True' : 'False');
    else if (typeof v === 'string') crs.set(k, v);
    else if (v && typeof v === 'object') {
      // Curves are flat number lists {x0, y0, x1, y1, …}
      const nums = v.list.filter((x): x is number => typeof x === 'number');
      const pairs: string[] = [];
      for (let i = 0; i + 1 < nums.length; i += 2) pairs.push(`${nums[i]}, ${nums[i + 1]}`);
      if (pairs.length) crs.set(k, pairs);
    }
  }
  const titleV = root.hash.get('title') ?? root.hash.get('internalName');
  return { title: typeof titleV === 'string' ? titleV : undefined, values: { crs, kloud: new Map() } };
}
