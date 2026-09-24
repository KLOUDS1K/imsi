/**
 * Minimal ICC v2.1 display ('mntr') RGB profiles, written from scratch:
 *
 *   header(128) | tag count | tag table (12 B/entry) | tag data (4-byte aligned)
 *
 * Tags: desc, cprt, wtpt (D50, as ICC.1:2001-04 recommends for display profiles
 * that use a Bradford-adapted matrix), rXYZ/gXYZ/bXYZ (primaries adapted D65→D50
 * with Bradford — the columns of the RGB→XYZ(D50) matrix), rTRC/gTRC/bTRC
 * (one shared 'curv': a 1024-entry sampled sRGB curve for sRGB and Display P3,
 * a single u8Fixed8 gamma of 563/256 for Adobe RGB). ~4 KB for sRGB/P3, < 1 KB
 * for Adobe RGB, small enough to embed in every exported file.
 */
import type { ExportColorSpace } from '@/editor/types';
import { srgbToLinear } from '@/editor/color/math';
import { ByteWriter, readAscii, u32be } from './bytes';
import { ICC_D50, rgbToXyzD50Matrix } from './colorimetry';

const NAMES: Record<ExportColorSpace, string> = {
  srgb: 'sRGB IEC61966-2.1 (KLOUD Studio)',
  'display-p3': 'Display P3 (KLOUD Studio)',
  'adobe-rgb': 'Compatible with Adobe RGB (1998) (KLOUD Studio)',
};

/** Short identifier used where a profile name must be ≤ 79 Latin-1 chars (PNG iCCP). */
export const ICC_SHORT_NAME: Record<ExportColorSpace, string> = {
  srgb: 'sRGB',
  'display-p3': 'Display P3',
  'adobe-rgb': 'Adobe RGB (1998) compatible',
};

const COPYRIGHT = 'No copyright, use freely';

/** s15Fixed16Number */
const s15 = (v: number) => Math.round(v * 65536);

function xyzTag(x: number, y: number, z: number): Uint8Array {
  return new ByteWriter(20).ascii('XYZ ').u32(0).i32(s15(x)).i32(s15(y)).i32(s15(z)).toBytes();
}

function descTag(text: string): Uint8Array {
  // textDescriptionType (ICC v2): ASCII part with count incl. NUL, then empty
  // Unicode and ScriptCode parts (ScriptCode has a fixed 67-byte field).
  const w = new ByteWriter(128).ascii('desc').u32(0).u32(text.length + 1).ascii(text).u8(0);
  w.u32(0).u32(0); // unicode language code, unicode count
  w.u16(0).u8(0).zeros(67); // scriptcode code, count, data
  return w.toBytes();
}

function textTag(text: string): Uint8Array {
  return new ByteWriter(64).ascii('text').u32(0).ascii(text).u8(0).toBytes();
}

function curvTag(space: ExportColorSpace): Uint8Array {
  const w = new ByteWriter(2100).ascii('curv').u32(0);
  if (space === 'adobe-rgb') {
    // count = 1 → a single u8Fixed8Number gamma. 563/256 = 2.19921875 is exact in 8.8.
    w.u32(1).u16(563);
  } else {
    const n = 1024;
    w.u32(n);
    for (let i = 0; i < n; i++) w.u16(Math.round(srgbToLinear(i / (n - 1)) * 65535));
  }
  return w.toBytes();
}

const cache = new Map<ExportColorSpace, Uint8Array>();

export function buildIccProfile(space: ExportColorSpace): Uint8Array {
  const hit = cache.get(space);
  if (hit) return hit.slice();

  const m = rgbToXyzD50Matrix(space);
  const trc = curvTag(space);
  // Tag list; entries that share data (the three TRCs) point at the same bytes.
  const blobs: { sig: string; data: Uint8Array }[] = [
    { sig: 'desc', data: descTag(NAMES[space]) },
    { sig: 'cprt', data: textTag(COPYRIGHT) },
    { sig: 'wtpt', data: xyzTag(ICC_D50[0], ICC_D50[1], ICC_D50[2]) },
    { sig: 'rXYZ', data: xyzTag(m[0], m[3], m[6]) },
    { sig: 'gXYZ', data: xyzTag(m[1], m[4], m[7]) },
    { sig: 'bXYZ', data: xyzTag(m[2], m[5], m[8]) },
    { sig: 'rTRC', data: trc },
    { sig: 'gTRC', data: trc },
    { sig: 'bTRC', data: trc },
  ];

  const tableEnd = 128 + 4 + 12 * blobs.length;
  const offsets = new Map<Uint8Array, number>();
  let off = tableEnd;
  for (const b of blobs) {
    if (offsets.has(b.data)) continue;
    offsets.set(b.data, off);
    off += b.data.length;
    off = (off + 3) & ~3; // every tag element starts on a 4-byte boundary
  }
  const total = off;

  const w = new ByteWriter(total);
  // ---- header ----
  w.u32(total); // profile size
  w.u32(0); // preferred CMM
  w.u32(0x02100000); // version 2.1.0
  w.ascii('mntr').ascii('RGB ').ascii('XYZ ');
  // Fixed creation date keeps the bytes deterministic (cacheable, testable).
  w.u16(2026).u16(1).u16(1).u16(0).u16(0).u16(0);
  w.ascii('acsp');
  w.u32(0); // primary platform
  w.u32(0); // flags
  w.u32(0).u32(0); // manufacturer, model
  w.u32(0).u32(0); // attributes
  w.u32(0); // rendering intent: perceptual
  w.i32(s15(ICC_D50[0])).i32(s15(ICC_D50[1])).i32(s15(ICC_D50[2]));
  w.ascii('KLOD'); // creator
  w.zeros(16); // profile ID (MD5, v4 only)
  w.zeros(28); // reserved
  // ---- tag table ----
  w.u32(blobs.length);
  for (const b of blobs) w.ascii(b.sig).u32(offsets.get(b.data) ?? 0).u32(b.data.length);
  // ---- tag data ----
  const written = new Set<Uint8Array>();
  for (const b of blobs) {
    if (written.has(b.data)) continue;
    written.add(b.data);
    w.bytes(b.data).align(4);
  }
  const bytes = w.toBytes();
  if (bytes.length !== total) throw new Error(`ICC layout mismatch: ${bytes.length} != ${total}`);
  cache.set(space, bytes);
  return bytes.slice();
}

/**
 * Structural validation (used by the unit tests and as a debug aid): header
 * size/signature, tag table bounds, 4-byte alignment, per-type sizes.
 * Returns a list of problems (empty = valid).
 */
export function validateIccProfile(p: Uint8Array): string[] {
  const errs: string[] = [];
  if (p.length < 132) return ['profile shorter than header + tag count'];
  if (u32be(p, 0) !== p.length) errs.push(`header size ${u32be(p, 0)} != byte length ${p.length}`);
  if (p.length % 4) errs.push('profile length not a multiple of 4');
  if (readAscii(p, 36, 4) !== 'acsp') errs.push("missing 'acsp' signature");
  const n = u32be(p, 128);
  const tableEnd = 132 + 12 * n;
  if (tableEnd > p.length) return [...errs, 'tag table overruns profile'];
  const seen = new Set<string>();
  for (let i = 0; i < n; i++) {
    const e = 132 + 12 * i;
    const sig = readAscii(p, e, 4);
    const off = u32be(p, e + 4);
    const size = u32be(p, e + 8);
    seen.add(sig);
    if (off % 4) errs.push(`${sig}: offset ${off} not 4-byte aligned`);
    if (off < tableEnd) errs.push(`${sig}: data overlaps the tag table`);
    if (off + size > p.length) errs.push(`${sig}: data overruns profile`);
    const type = readAscii(p, off, 4);
    if (type === 'XYZ ' && size !== 20) errs.push(`${sig}: XYZ size ${size}`);
    if (type === 'curv' && size !== 12 + 2 * u32be(p, off + 8)) errs.push(`${sig}: curv size ${size}`);
    if (type === 'desc' && size < 90 + u32be(p, off + 8)) errs.push(`${sig}: desc size ${size}`);
    if (type === 'text' && p[off + size - 1] !== 0) errs.push(`${sig}: text not NUL-terminated`);
  }
  for (const req of ['desc', 'cprt', 'wtpt', 'rXYZ', 'gXYZ', 'bXYZ', 'rTRC', 'gTRC', 'bTRC'])
    if (!seen.has(req)) errs.push(`missing required tag ${req}`);
  return errs;
}
