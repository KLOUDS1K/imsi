/**
 * Just enough ICC parsing to tell which RGB space an embedded profile
 * describes: the profile description ('desc', v2 text or v4 'mluc') and the
 * red/green colorant XYZ values (PCS D50), which are matched against the
 * known primaries when the description is not conclusive.
 */
import { ascii, u16be, u32be } from './binary';
import type { ColorPrimaries } from '../types';

export interface IccInfo {
  description: string;
  colorSpace: string;
  primaries: ColorPrimaries | 'other';
}

/** D50-adapted red and green colorants of the known spaces (ICC rXYZ / gXYZ). */
const KNOWN: { id: ColorPrimaries; r: [number, number, number]; g: [number, number, number] }[] = [
  { id: 'srgb', r: [0.4361, 0.2225, 0.0139], g: [0.3851, 0.7169, 0.0971] },
  { id: 'display-p3', r: [0.5151, 0.2412, -0.0011], g: [0.292, 0.6922, 0.0419] },
  { id: 'adobe-rgb', r: [0.6097, 0.3111, 0.0195], g: [0.2053, 0.6257, 0.0609] },
  { id: 'prophoto', r: [0.7977, 0.2880, 0.0], g: [0.1352, 0.7119, 0.0] },
];

export function parseIcc(p: Uint8Array): IccInfo | null {
  if (p.length < 132 || ascii(p, 36, 4) !== 'acsp') return null;
  const colorSpace = ascii(p, 16, 4).trim();
  const count = u32be(p, 128);
  let description = '';
  let r: number[] | null = null;
  let g: number[] | null = null;
  for (let i = 0; i < count && 132 + i * 12 + 12 <= p.length; i++) {
    const e = 132 + i * 12;
    const sig = ascii(p, e, 4);
    const off = u32be(p, e + 4);
    const len = u32be(p, e + 8);
    if (off + len > p.length || len < 8) continue;
    if (sig === 'desc') description = readText(p, off, len);
    else if (sig === 'rXYZ') r = readXyz(p, off);
    else if (sig === 'gXYZ') g = readXyz(p, off);
  }
  return { description, colorSpace, primaries: classify(description, r, g) };
}

function readXyz(p: Uint8Array, off: number): number[] | null {
  if (ascii(p, off, 4) !== 'XYZ ' || off + 20 > p.length) return null;
  const s15 = (o: number): number => (u32be(p, o) | 0) / 65536;
  return [s15(off + 8), s15(off + 12), s15(off + 16)];
}

function readText(p: Uint8Array, off: number, len: number): string {
  const type = ascii(p, off, 4);
  if (type === 'desc') {
    const n = u32be(p, off + 8);
    return ascii(p, off + 12, Math.min(n, len - 12)).replace(/\0+$/, '').trim();
  }
  if (type === 'mluc') {
    const records = u32be(p, off + 8);
    if (records < 1) return '';
    const sl = u32be(p, off + 20);
    const so = u32be(p, off + 24);
    let s = '';
    for (let i = 0; i + 1 < sl && off + so + i + 1 < p.length; i += 2) s += String.fromCharCode(u16be(p, off + so + i));
    return s.replace(/\0+$/, '').trim();
  }
  return '';
}

function classify(desc: string, r: number[] | null, g: number[] | null): ColorPrimaries | 'other' {
  const d = desc.toLowerCase();
  if (/p3|dci/.test(d)) return 'display-p3';
  if (/adobe ?rgb|compatible with adobe/.test(d)) return 'adobe-rgb';
  if (/prophoto|romm/.test(d)) return 'prophoto';
  if (/srgb|iec ?61966|sycc/.test(d)) return 'srgb';
  if (!r || !g) return 'other';
  let best: ColorPrimaries | 'other' = 'other';
  let bestD = 0.02; // tolerance on the colorant XYZ distance
  for (const k of KNOWN) {
    const dist = Math.hypot(r[0] - k.r[0], r[1] - k.r[1], r[2] - k.r[2]) + Math.hypot(g[0] - k.g[0], g[1] - k.g[1], g[2] - k.g[2]);
    if (dist < bestD) {
      bestD = dist;
      best = k.id;
    }
  }
  return best;
}

/** Whether decoding into a Display-P3 canvas keeps more of the file's colours than sRGB. */
export function isWideGamut(info: IccInfo | null): boolean {
  return !!info && (info.primaries === 'display-p3' || info.primaries === 'adobe-rgb' || info.primaries === 'prophoto');
}

/** ICCP chunk of an extended (VP8X) WebP. */
export function webpIccProfile(b: Uint8Array): Uint8Array | null {
  if (ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WEBP') return null;
  let p = 12;
  while (p + 8 <= b.length) {
    const id = ascii(b, p, 4);
    const size = b[p + 4] | (b[p + 5] << 8) | (b[p + 6] << 16) | (b[p + 7] << 24);
    if (id === 'ICCP') return b.subarray(p + 8, Math.min(b.length, p + 8 + size));
    if (id === 'VP8 ' || id === 'VP8L') return null;
    p += 8 + size + (size & 1);
  }
  return null;
}
