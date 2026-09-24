/**
 * Generic TIFF IFD serializer, used for EXIF blocks (JPEG APP1, PNG eXIf,
 * WebP EXIF) and for the TIFF / DNG writers.
 *
 * An IFD is 2 B entry count + 12 B per entry + 4 B next-IFD offset, followed
 * here by its out-of-line values (anything > 4 bytes), each starting on a word
 * (even) boundary as TIFF 6.0 requires. Child IFDs (ExifIFD, GPS, SubIFDs) are
 * laid out right after their parent; pointer entries are generated from
 * `IfdNode.children`. All offsets are absolute from the TIFF header, so the
 * caller passes the offset at which the returned bytes will be placed.
 */
import { utf8 } from './bytes';

export const BYTE = 1;
export const ASCII = 2;
export const SHORT = 3;
export const LONG = 4;
export const RATIONAL = 5;
export const UNDEFINED = 7;
export const SLONG = 9;
export const SRATIONAL = 10;
export type TiffType = 1 | 2 | 3 | 4 | 5 | 7 | 9 | 10;

const TYPE_SIZE: Record<TiffType, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

export interface TiffTag {
  tag: number;
  type: TiffType;
  /** BYTE/ASCII/UNDEFINED: raw bytes. SHORT/LONG/SLONG: values. (S)RATIONAL: [num, den, num, den, …]. */
  data: Uint8Array | number[];
}

export interface IfdNode {
  tags: TiffTag[];
  /** Pointer tags (34665 ExifIFD, 34853 GPS, 330 SubIFDs) → child IFDs written after this one. */
  children?: { tag: number; nodes: IfdNode[] }[];
}

/* ---------------- tag constructors ---------------- */

export const ascii = (tag: number, s: string): TiffTag => {
  const b = utf8(s); // EXIF says 7-bit ASCII; UTF-8 is what exiftool/Lightroom/exifr read back.
  const d = new Uint8Array(b.length + 1);
  d.set(b);
  return { tag, type: ASCII, data: d };
};
export const bytes = (tag: number, d: Uint8Array | number[], type: 1 | 7 = BYTE): TiffTag => ({
  tag,
  type,
  data: d instanceof Uint8Array ? d : Uint8Array.from(d),
});
export const short = (tag: number, ...v: number[]): TiffTag => ({ tag, type: SHORT, data: v });
export const long = (tag: number, ...v: number[]): TiffTag => ({ tag, type: LONG, data: v });

/** Best rational approximation of a non-negative (or signed) float with a bounded denominator. */
export function toRational(v: number, signed = false, maxDen = 1_000_000): [number, number] {
  if (!Number.isFinite(v)) return [0, 1];
  const neg = v < 0;
  if (neg && !signed) v = 0;
  let x = Math.abs(v);
  // Exact reciprocals (exposure times 1/250, 1/8000) read best as 1/n.
  if (x > 0 && x < 1) {
    const inv = 1 / x;
    if (Math.abs(inv - Math.round(inv)) < 1e-6 * inv) return [neg ? -1 : 1, Math.round(inv)];
  }
  const limit = signed ? 0x7fffffff : 0xffffffff;
  if (x >= limit) return [neg ? -limit : limit, 1];
  // Continued fraction convergents.
  let h0 = 0, h1 = 1, k0 = 1, k1 = 0;
  const x0 = x;
  for (let i = 0; i < 32; i++) {
    const a = Math.floor(x);
    const h2 = a * h1 + h0;
    const k2 = a * k1 + k0;
    if (k2 > maxDen || h2 > limit) break;
    h0 = h1; h1 = h2; k0 = k1; k1 = k2;
    if (Math.abs(x0 - h1 / k1) < 1e-12 || x - a < 1e-12) break;
    x = 1 / (x - a);
  }
  if (k1 === 0) return [neg ? -Math.round(x0) : Math.round(x0), 1];
  return [neg ? -h1 : h1, k1];
}

export const rational = (tag: number, ...v: number[]): TiffTag => ({
  tag,
  type: RATIONAL,
  data: v.flatMap((x) => toRational(x)),
});
export const srational = (tag: number, ...v: number[]): TiffTag => ({
  tag,
  type: SRATIONAL,
  data: v.flatMap((x) => toRational(x, true)),
});
/** Explicit numerator/denominator pairs (e.g. DNG matrices with a fixed 10000 denominator). */
export const srationalRaw = (tag: number, pairs: number[]): TiffTag => ({ tag, type: SRATIONAL, data: pairs });
export const rationalRaw = (tag: number, pairs: number[]): TiffTag => ({ tag, type: RATIONAL, data: pairs });

/* ---------------- serialization ---------------- */

function count(t: TiffTag): number {
  if (t.data instanceof Uint8Array) return t.data.length;
  return t.type === RATIONAL || t.type === SRATIONAL ? t.data.length / 2 : t.data.length;
}

const byteSize = (t: TiffTag) => count(t) * TYPE_SIZE[t.type];

interface Laid {
  node: IfdNode;
  offset: number;
  entries: TiffTag[];
  childOffsets: Map<number, number[]>;
}

function blockSize(entries: TiffTag[]): number {
  let n = 2 + 12 * entries.length + 4;
  for (const e of entries) {
    const s = byteSize(e);
    if (s > 4) n += s + (s & 1);
  }
  return n;
}

/** Pointer entries have fixed sizes, so they can be sized before their values are known. */
function pointerPlaceholder(tag: number, n: number): TiffTag {
  return { tag, type: LONG, data: new Array<number>(n).fill(0) };
}

/**
 * Serialize a chain of IFDs (linked through next-IFD offsets) placed at
 * absolute offset `start` (must be even). Returns bytes and each node's offset.
 */
export function serializeIfds(
  chain: IfdNode[],
  start: number,
  littleEndian: boolean,
): { bytes: Uint8Array; offsets: Map<IfdNode, number> } {
  if (start & 1) throw new Error('IFD must start on a word boundary');
  const laid: Laid[] = [];
  const offsets = new Map<IfdNode, number>();

  const place = (node: IfdNode, at: number): number => {
    const entries = [...node.tags];
    for (const c of node.children ?? []) if (c.nodes.length) entries.push(pointerPlaceholder(c.tag, c.nodes.length));
    entries.sort((a, b) => a.tag - b.tag);
    for (let i = 1; i < entries.length; i++)
      if (entries[i].tag === entries[i - 1].tag) throw new Error(`duplicate TIFF tag ${entries[i].tag}`);
    const l: Laid = { node, offset: at, entries, childOffsets: new Map() };
    laid.push(l);
    offsets.set(node, at);
    let end = at + blockSize(entries);
    for (const c of node.children ?? []) {
      const offs: number[] = [];
      for (const child of c.nodes) {
        offs.push(end);
        end = place(child, end);
      }
      if (offs.length) l.childOffsets.set(c.tag, offs);
    }
    return end;
  };

  let end = start;
  const roots: Laid[] = [];
  for (const n of chain) {
    const idx = laid.length;
    end = place(n, end);
    roots.push(laid[idx]);
  }

  const out = new Uint8Array(end - start);
  const dv = new DataView(out.buffer);
  const le = littleEndian;

  const writeValues = (t: TiffTag, at: number) => {
    const rel = at - start;
    if (t.data instanceof Uint8Array) {
      out.set(t.data, rel);
      return;
    }
    const d = t.data;
    for (let i = 0; i < d.length; i++) {
      switch (t.type) {
        case SHORT:
          dv.setUint16(rel + 2 * i, d[i], le);
          break;
        case LONG:
        case RATIONAL:
          dv.setUint32(rel + 4 * i, d[i] >>> 0, le);
          break;
        case SLONG:
        case SRATIONAL:
          dv.setInt32(rel + 4 * i, d[i] | 0, le);
          break;
        default:
          out[rel + i] = d[i] & 0xff;
      }
    }
  };

  for (const l of laid) {
    const rel = l.offset - start;
    dv.setUint16(rel, l.entries.length, le);
    let data = l.offset + 2 + 12 * l.entries.length + 4;
    for (let i = 0; i < l.entries.length; i++) {
      let e = l.entries[i];
      const ptr = l.childOffsets.get(e.tag);
      if (ptr) e = { ...e, data: ptr }; // pointer placeholder → real child offsets
      const eo = rel + 2 + 12 * i;
      dv.setUint16(eo, e.tag, le);
      dv.setUint16(eo + 2, e.type, le);
      dv.setUint32(eo + 4, count(e), le);
      const size = byteSize(e);
      if (size <= 4) {
        writeValues(e, l.offset + 2 + 12 * i + 8);
      } else {
        dv.setUint32(eo + 8, data, le);
        writeValues(e, data);
        data += size + (size & 1);
      }
    }
  }
  // next-IFD links for the top-level chain
  for (let i = 0; i < roots.length; i++) {
    const r = roots[i];
    const at = r.offset - start + 2 + 12 * r.entries.length;
    dv.setUint32(at, i + 1 < roots.length ? roots[i + 1].offset : 0, le);
  }
  return { bytes: out, offsets };
}

/** TIFF header: byte order mark, 42, offset of the first IFD. */
export function tiffHeader(littleEndian: boolean, firstIfd: number): Uint8Array {
  const h = new Uint8Array(8);
  const dv = new DataView(h.buffer);
  h[0] = h[1] = littleEndian ? 0x49 : 0x4d;
  dv.setUint16(2, 42, littleEndian);
  dv.setUint32(4, firstIfd, littleEndian);
  return h;
}

/** A self-contained TIFF structure (header + IFD chain at offset 8), as embedded in EXIF blocks. */
export function buildTiffStructure(chain: IfdNode[], littleEndian = false): Uint8Array {
  const { bytes } = serializeIfds(chain, 8, littleEndian);
  const out = new Uint8Array(8 + bytes.length);
  out.set(tiffHeader(littleEndian, 8));
  out.set(bytes, 8);
  return out;
}
