/**
 * JPEG metadata injection by rewriting the marker stream in front of SOS:
 *
 *   SOI · APP0 JFIF (density = dpi) · APP1 Exif · APP1 XMP · APP2 ICC_PROFILE × n · <other headers> · SOS…EOI
 *
 * Existing Exif / XMP / ICC / JFIF segments from the canvas encoder are dropped
 * and replaced; everything else (DQT, SOF, DHT, DRI, …) and the entropy-coded
 * data are copied through byte for byte.
 */
import { concatBytes, putU16be, readAscii, u16be, utf8 } from './bytes';

export interface JpegSegment {
  marker: number;
  /** Offset of the 0xFF marker byte. */
  offset: number;
  /** Total bytes including marker and length field. */
  size: number;
}

export interface MetadataPayloads {
  /** TIFF structure (starting with II/MM) to wrap as Exif. */
  exif?: Uint8Array | null;
  xmp?: string | null;
  icc?: Uint8Array | null;
  dpi?: number;
}

const EXIF_ID = 'Exif\0\0';
const XMP_ID = 'http://ns.adobe.com/xap/1.0/\0';
const ICC_ID = 'ICC_PROFILE\0';
/** Max ICC bytes per APP2: 65535 − 2 (length) − 12 (id) − 2 (seq, count). */
export const ICC_CHUNK = 65519;

/** Header segments up to (not including) SOS; `scanStart` = offset of the SOS marker. */
export function parseJpegSegments(d: Uint8Array): { segments: JpegSegment[]; scanStart: number } {
  if (d.length < 4 || d[0] !== 0xff || d[1] !== 0xd8) throw new Error('not a JPEG (missing SOI)');
  const segments: JpegSegment[] = [];
  let p = 2;
  while (p < d.length) {
    if (d[p] !== 0xff) throw new Error(`corrupt JPEG: expected marker at ${p}`);
    let q = p;
    while (q < d.length && d[q] === 0xff) q++; // fill bytes
    const marker = d[q];
    const start = q - 1;
    if (marker === 0xda || marker === 0xd9) return { segments, scanStart: start };
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      segments.push({ marker, offset: start, size: 2 });
      p = q + 1;
      continue;
    }
    const len = u16be(d, q + 1);
    if (len < 2 || q + 1 + len > d.length) throw new Error('corrupt JPEG: bad segment length');
    segments.push({ marker, offset: start, size: 2 + len });
    p = q + 1 + len;
  }
  throw new Error('corrupt JPEG: no SOS');
}

function segment(marker: number, payload: Uint8Array): Uint8Array {
  if (payload.length + 2 > 0xffff) throw new Error('JPEG segment too large');
  const s = new Uint8Array(4 + payload.length);
  s[0] = 0xff;
  s[1] = marker;
  putU16be(s, 2, payload.length + 2);
  s.set(payload, 4);
  return s;
}

function withId(id: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(id.length + body.length);
  for (let i = 0; i < id.length; i++) out[i] = id.charCodeAt(i);
  out.set(body, id.length);
  return out;
}

/** JFIF APP0 payload: version 1.01, units = dots per inch, no thumbnail. */
export function jfifPayload(dpi: number, base?: Uint8Array): Uint8Array {
  const p = base && base.length >= 14 ? base.slice() : new Uint8Array([0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const v = Math.max(1, Math.min(65535, Math.round(dpi)));
  p[7] = 1; // units: dpi
  putU16be(p, 8, v);
  putU16be(p, 10, v);
  return p;
}

/** Split an ICC profile into APP2 segments (1-based sequence numbers, per ICC.1 Annex B). */
export function iccSegments(icc: Uint8Array): Uint8Array[] {
  const n = Math.ceil(icc.length / ICC_CHUNK);
  if (n > 255) throw new Error('ICC profile too large for JPEG');
  const out: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    const part = icc.subarray(i * ICC_CHUNK, Math.min(icc.length, (i + 1) * ICC_CHUNK));
    const body = new Uint8Array(2 + part.length);
    body[0] = i + 1;
    body[1] = n;
    body.set(part, 2);
    out.push(segment(0xe2, withId(ICC_ID, body)));
  }
  return out;
}

export function injectJpegMetadata(d: Uint8Array, m: MetadataPayloads): Uint8Array {
  const { segments, scanStart } = parseJpegSegments(d);
  let jfif: Uint8Array | undefined;
  const keep: Uint8Array[] = [];
  for (const s of segments) {
    const body = d.subarray(s.offset + 4, s.offset + s.size);
    if (s.marker === 0xe0 && readAscii(body, 0, 5) === 'JFIF\0') {
      jfif = body;
      continue;
    }
    if (s.marker === 0xe1 && (readAscii(body, 0, 6) === EXIF_ID || readAscii(body, 0, XMP_ID.length) === XMP_ID)) continue;
    if (s.marker === 0xe2 && readAscii(body, 0, 12) === ICC_ID) continue;
    keep.push(d.subarray(s.offset, s.offset + s.size));
  }
  const parts: Uint8Array[] = [new Uint8Array([0xff, 0xd8])];
  parts.push(segment(0xe0, jfifPayload(m.dpi ?? 72, jfif)));
  if (m.exif && m.exif.length + 6 + 2 <= 0xffff) parts.push(segment(0xe1, withId(EXIF_ID, m.exif)));
  if (m.xmp) {
    const x = utf8(m.xmp);
    if (x.length + XMP_ID.length + 2 <= 0xffff) parts.push(segment(0xe1, withId(XMP_ID, x)));
  }
  if (m.icc) parts.push(...iccSegments(m.icc));
  parts.push(...keep);
  parts.push(d.subarray(scanStart));
  return concatBytes(parts);
}
