/**
 * Baseline TIFF 6.0 writer (little-endian "II"): 8/16-bit RGB(A), chunky,
 * strips of ~256 KB, optional Adobe Deflate (compression 8, zlib stream per
 * strip) with horizontal differencing (Predictor 2, applied to whole samples —
 * 16-bit values are differenced before byte serialization, as the spec says).
 *
 * File layout: header · strip data · IFD0 (+ its out-of-line values: ICC,
 * XMP, strip tables) · ExifIFD · GPS IFD. Strips come first so their offsets
 * are known when the IFDs are serialized.
 */
import { zlibSync } from 'fflate';
import { concatBytes } from './bytes';
import type { MetadataBlocks } from './metadata';
import { metadataIfd } from './metadata';
import { bytes, long, serializeIfds, short, tiffHeader, type IfdNode, type TiffTag } from './tiff-ifd';
import { isOpaque } from './png';

const HOST_LE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

export interface StripOptions {
  width: number;
  height: number;
  /** Samples per pixel written (3 = RGB, 4 = RGBA). Input is always RGBA. */
  spp: 3 | 4;
  bits: 8 | 16;
  compression: 1 | 8;
  predictor: boolean;
  /** Optional per-sample transfer LUT (input code value → output 16-bit value), used by DNG. */
  lut?: Uint16Array;
}

export interface Strips {
  strips: Uint8Array[];
  rowsPerStrip: number;
}

/**
 * Pack RGBA input into (optionally predicted and deflated) little-endian strips.
 * Memory stays bounded to one strip of samples at a time plus the output.
 */
export function buildStrips(src: Uint8ClampedArray | Uint16Array | Uint8Array, o: StripOptions): Strips {
  const { width, height, spp, bits } = o;
  const rowSamples = width * spp;
  const rowBytes = rowSamples * (bits / 8);
  const rowsPerStrip = Math.max(1, Math.min(height, Math.floor(262144 / rowBytes)));
  const strips: Uint8Array[] = [];
  const buf = bits === 16 ? new Uint16Array(rowSamples * rowsPerStrip) : new Uint8Array(rowSamples * rowsPerStrip);
  const lut = o.lut;
  for (let y0 = 0; y0 < height; y0 += rowsPerStrip) {
    const rows = Math.min(rowsPerStrip, height - y0);
    let d = 0;
    for (let y = y0; y < y0 + rows; y++) {
      let s = y * width * 4;
      for (let x = 0; x < width; x++, s += 4) {
        if (lut) {
          buf[d++] = lut[src[s]];
          buf[d++] = lut[src[s + 1]];
          buf[d++] = lut[src[s + 2]];
          if (spp === 4) buf[d++] = src[s + 3]; // alpha is never linearized
        } else {
          buf[d++] = src[s];
          buf[d++] = src[s + 1];
          buf[d++] = src[s + 2];
          if (spp === 4) buf[d++] = src[s + 3];
        }
      }
    }
    if (o.predictor) {
      // Horizontal differencing, right to left so each sample uses its original left neighbour.
      const mask = bits === 16 ? 0xffff : 0xff;
      for (let r = 0; r < rows; r++) {
        const base = r * rowSamples;
        for (let i = rowSamples - 1; i >= spp; i--) buf[base + i] = (buf[base + i] - buf[base + i - spp]) & mask;
      }
    }
    const n = rows * rowSamples;
    let raw: Uint8Array;
    if (bits === 16) {
      const view = buf.subarray(0, n) as Uint16Array;
      raw = new Uint8Array(view.buffer, view.byteOffset, n * 2);
      if (!HOST_LE) {
        raw = raw.slice();
        for (let i = 0; i < raw.length; i += 2) {
          const t = raw[i];
          raw[i] = raw[i + 1];
          raw[i + 1] = t;
        }
      }
    } else {
      raw = (buf as Uint8Array).subarray(0, n);
    }
    strips.push(o.compression === 8 ? zlibSync(raw, { level: 6 }) : raw.slice());
  }
  return { strips, rowsPerStrip };
}

/** Tags describing an image stored in strips (offsets filled in by `assembleTiff`). */
export function imageTags(o: StripOptions, s: Strips, photometric: number, subfileType: number): TiffTag[] {
  const tags: TiffTag[] = [
    long(254, subfileType),
    long(256, o.width),
    long(257, o.height),
    short(258, ...new Array<number>(o.spp).fill(o.bits)),
    short(259, o.compression),
    short(262, photometric),
    long(273, ...new Array<number>(s.strips.length).fill(0)),
    short(277, o.spp),
    long(278, s.rowsPerStrip),
    long(279, ...s.strips.map((b) => b.length)),
    short(284, 1),
  ];
  if (o.predictor && o.compression === 8) tags.push(short(317, 2));
  if (o.spp === 4) tags.push(short(338, 2)); // unassociated alpha
  return tags;
}

/**
 * Lay out header + all strip data + IFD chain. `images` lists, for each IFD
 * that owns strips, its node and strips (the node's StripOffsets tag is patched).
 */
export function assembleTiff(chain: IfdNode[], images: { node: IfdNode; strips: Uint8Array[] }[]): Uint8Array {
  let off = 8;
  for (const img of images) {
    const offsets: number[] = [];
    for (const s of img.strips) {
      offsets.push(off);
      off += s.length;
    }
    const t = img.node.tags.find((t) => t.tag === 273);
    if (!t) throw new Error('image IFD without StripOffsets');
    t.data = offsets;
  }
  const pad = off & 1;
  const ifdStart = off + pad;
  const { bytes: ifds } = serializeIfds(chain, ifdStart, true);
  const parts: Uint8Array[] = [tiffHeader(true, ifdStart)];
  for (const img of images) parts.push(...img.strips);
  if (pad) parts.push(new Uint8Array(1));
  parts.push(ifds);
  return concatBytes(parts);
}

export interface TiffEncodeOptions {
  compression: 'none' | 'deflate';
  predictor: boolean;
  metadata: MetadataBlocks;
  icc: Uint8Array | null;
}

export function encodeTiff(
  data: Uint8ClampedArray | Uint16Array | Uint8Array,
  width: number,
  height: number,
  bitDepth: 8 | 16,
  opts: TiffEncodeOptions,
): Uint8Array {
  if (data.length !== width * height * 4) throw new Error('TIFF: data length does not match RGBA size');
  const so: StripOptions = {
    width,
    height,
    spp: isOpaque(data, bitDepth === 16 ? 65535 : 255) ? 3 : 4,
    bits: bitDepth,
    compression: opts.compression === 'deflate' ? 8 : 1,
    predictor: opts.predictor && opts.compression === 'deflate',
  };
  const strips = buildStrips(data, so);
  const extra: TiffTag[] = imageTags(so, strips, 2, 0);
  if (opts.metadata.xmp) extra.push(bytes(700, new TextEncoder().encode(opts.metadata.xmp)));
  if (opts.icc) extra.push(bytes(34675, opts.icc, 7));
  const ifd0 = metadataIfd(opts.metadata, extra);
  return assembleTiff([ifd0], [{ node: ifd0, strips: strips.strips }]);
}
