/**
 * WebP metadata injection: whatever the canvas encoder produced (simple lossy
 * 'VP8 ', lossless 'VP8L' or extended 'VP8X'), rebuild the RIFF container in
 * the extended layout required for metadata:
 *
 *   RIFF · WEBP · VP8X(flags, canvas size) · ICCP · [ALPH] · VP8/VP8L · EXIF · XMP
 *
 * (chunk order per the WebP container spec). Existing ICCP/EXIF/XMP chunks are
 * replaced; image chunks are copied verbatim.
 */
import { concatBytes, latin1, putU32le, readAscii, u32le, utf8 } from './bytes';
import type { MetadataPayloads } from './jpeg';

interface RiffChunk {
  id: string;
  data: Uint8Array;
}

export function parseWebpChunks(d: Uint8Array): RiffChunk[] {
  if (readAscii(d, 0, 4) !== 'RIFF' || readAscii(d, 8, 4) !== 'WEBP') throw new Error('not a WebP file');
  const end = Math.min(d.length, 8 + u32le(d, 4));
  const out: RiffChunk[] = [];
  let p = 12;
  while (p + 8 <= end) {
    const id = readAscii(d, p, 4);
    const size = u32le(d, p + 4);
    if (p + 8 + size > end) throw new Error('corrupt WebP chunk');
    out.push({ id, data: d.subarray(p + 8, p + 8 + size) });
    p += 8 + size + (size & 1);
  }
  return out;
}

function chunk(id: string, data: Uint8Array): Uint8Array {
  const pad = data.length & 1;
  const c = new Uint8Array(8 + data.length + pad);
  c.set(latin1(id), 0);
  putU32le(c, 4, data.length);
  c.set(data, 8);
  return c;
}

const put24 = (d: Uint8Array, o: number, v: number) => {
  d[o] = v & 0xff;
  d[o + 1] = (v >>> 8) & 0xff;
  d[o + 2] = (v >>> 16) & 0xff;
};

export function injectWebpMetadata(d: Uint8Array, width: number, height: number, m: MetadataPayloads): Uint8Array {
  const chunks = parseWebpChunks(d);
  const image = chunks.filter((c) => c.id === 'VP8 ' || c.id === 'VP8L' || c.id === 'ALPH');
  if (!image.some((c) => c.id === 'VP8 ' || c.id === 'VP8L')) throw new Error('WebP has no image data');
  if (chunks.some((c) => c.id === 'ANIM')) throw new Error('animated WebP not supported');
  const vp8l = image.find((c) => c.id === 'VP8L');
  // VP8L header: signature 0x2f, then 14+14 bits of size, then the alpha_is_used bit (bit 28).
  const vp8lAlpha = !!vp8l && vp8l.data.length >= 5 && ((u32le(vp8l.data, 1) >>> 28) & 1) === 1;
  const alpha = image.some((c) => c.id === 'ALPH') || vp8lAlpha;

  const x = new Uint8Array(10);
  x[0] = (m.icc ? 0x20 : 0) | (alpha ? 0x10 : 0) | (m.exif ? 0x08 : 0) | (m.xmp ? 0x04 : 0);
  put24(x, 4, width - 1);
  put24(x, 7, height - 1);

  const body: Uint8Array[] = [chunk('VP8X', x)];
  if (m.icc) body.push(chunk('ICCP', m.icc));
  for (const c of image.filter((c) => c.id === 'ALPH')) body.push(chunk(c.id, c.data));
  for (const c of image.filter((c) => c.id !== 'ALPH')) body.push(chunk(c.id, c.data));
  if (m.exif) body.push(chunk('EXIF', m.exif));
  if (m.xmp) body.push(chunk('XMP ', utf8(m.xmp)));

  const payload = concatBytes(body);
  const head = new Uint8Array(12);
  head.set(latin1('RIFF'), 0);
  putU32le(head, 4, payload.length + 4);
  head.set(latin1('WEBP'), 8);
  return concatBytes([head, payload]);
}
