/**
 * Pixel-buffer utilities: area-average downscale (all data types, in linear
 * light with premultiplied alpha), conversions to 8-bit sRGB / linear float,
 * EXIF orientation and primaries handling. Pure and allocation-light: every
 * per-pixel loop works on typed arrays with lookup tables.
 */
import { MATRIX_TO_SRGB, SRGB8_TO_LINEAR, linearToSrgb, srgbToLinear } from '../color/math';
import type { ColorPrimaries, PixelBuffer, PixelBufferU8, PixelData } from '../types';

/* ------------------------------------------------------------------ */
/* Lookup tables (lazily built, shared)                                */
/* ------------------------------------------------------------------ */

let lut16ToLinear: Float32Array | null = null;
/** 16-bit sRGB-encoded value → linear float. */
function srgb16ToLinearLut(): Float32Array {
  if (!lut16ToLinear) {
    lut16ToLinear = new Float32Array(65536);
    for (let i = 0; i < 65536; i++) lut16ToLinear[i] = srgbToLinear(i / 65535);
  }
  return lut16ToLinear;
}

/** Linear value quantized to ENC_BITS → sRGB-encoded. 2^18 entries keep 16-bit shadows exact. */
const ENC_BITS = 18;
const ENC_MAX = (1 << ENC_BITS) - 1;
let encLut8: Uint8Array | null = null;
let encLut16: Uint16Array | null = null;
function linearToSrgb8Lut(): Uint8Array {
  if (!encLut8) {
    encLut8 = new Uint8Array(ENC_MAX + 1);
    for (let i = 0; i <= ENC_MAX; i++) encLut8[i] = Math.round(linearToSrgb(i / ENC_MAX) * 255);
  }
  return encLut8;
}
function linearToSrgb16Lut(): Uint16Array {
  if (!encLut16) {
    encLut16 = new Uint16Array(ENC_MAX + 1);
    for (let i = 0; i <= ENC_MAX; i++) encLut16[i] = Math.round(linearToSrgb(i / ENC_MAX) * 65535);
  }
  return encLut16;
}
const encIndex = (v: number): number => (v <= 0 ? 0 : v >= 1 ? ENC_MAX : (v * ENC_MAX + 0.5) | 0);

/** Max code value of a data array (alpha / full scale). */
export function fullScale(data: PixelData): number {
  return data instanceof Uint16Array ? 65535 : data instanceof Float32Array ? 1 : 255;
}

type Decoder = (v: number) => number;

/** Per-sample decoder to LINEAR light 0..1 for the buffer's type + transfer. */
function linearDecoder(data: PixelData, transfer: PixelBuffer['transfer']): Decoder {
  if (data instanceof Float32Array) return transfer === 'srgb' ? (v) => (v < 0 ? -srgbToLinear(-v) : srgbToLinear(v)) : (v) => v;
  if (data instanceof Uint16Array) {
    if (transfer === 'srgb') {
      const t = srgb16ToLinearLut();
      return (v) => t[v];
    }
    return (v) => v / 65535;
  }
  if (transfer === 'srgb') return (v) => SRGB8_TO_LINEAR[v];
  return (v) => v / 255;
}

/** Primaries of a buffer when it is a SourceImage (plain PixelBuffers are sRGB). */
export function primariesOf(px: PixelBuffer): ColorPrimaries {
  const p = (px as PixelBuffer & { primaries?: ColorPrimaries }).primaries;
  return p ?? 'srgb';
}

/* ------------------------------------------------------------------ */
/* Area-average resize                                                 */
/* ------------------------------------------------------------------ */

interface AxisWeights {
  start: Int32Array;
  count: Int32Array;
  offset: Int32Array;
  w: Float32Array;
}

/** Exact box-filter (area coverage) weights for resampling n → m (m ≤ n). */
function axisWeights(n: number, m: number): AxisWeights {
  const scale = n / m;
  const start = new Int32Array(m);
  const count = new Int32Array(m);
  const offset = new Int32Array(m);
  const ws: number[] = [];
  for (let i = 0; i < m; i++) {
    const a = i * scale;
    const b = Math.min(n, (i + 1) * scale);
    const s = Math.floor(a);
    const e = Math.min(n, Math.ceil(b - 1e-9));
    start[i] = s;
    count[i] = e - s;
    offset[i] = ws.length;
    for (let k = s; k < e; k++) {
      const cov = Math.min(b, k + 1) - Math.max(a, k);
      ws.push(cov / (b - a));
    }
  }
  return { start, count, offset, w: new Float32Array(ws) };
}

/**
 * Area-average downscale so the long edge is ≤ maxSize. Keeps the data type
 * and transfer; averaging happens in linear light with premultiplied alpha
 * (no dark fringes at high-contrast edges or transparent borders). Returns
 * `src` itself when no reduction is needed.
 */
export function downscale<T extends PixelBuffer>(src: T, maxSize: number): T {
  const long = Math.max(src.width, src.height);
  if (!(maxSize > 0) || long <= maxSize) return src;
  const s = maxSize / long;
  const dw = Math.max(1, Math.round(src.width * s));
  const dh = Math.max(1, Math.round(src.height * s));
  return { ...src, ...resizeArea(src, dw, dh) } as T;
}

export function resizeArea(src: PixelBuffer, dw: number, dh: number): PixelBuffer {
  const { width: sw, height: sh, data, transfer } = src;
  const dec = linearDecoder(data, transfer);
  const amax = fullScale(data);
  const xw = axisWeights(sw, Math.min(dw, sw));
  const yw = axisWeights(sh, Math.min(dh, sh));
  const tw = xw.start.length;
  const th = yw.start.length;
  const acc = new Float32Array(tw * 4);
  let rowA = new Float32Array(tw * 4);
  let rowB = new Float32Array(tw * 4);
  let rowAIndex = -1;
  let rowBIndex = -1;
  const out = allocLike(data, tw * th * 4);

  // Horizontal pass of one source row into `dst` (premultiplied linear).
  const hpass = (r: number, dst: Float32Array): void => {
    const base = r * sw * 4;
    for (let x = 0; x < tw; x++) {
      let cr = 0, cg = 0, cb = 0, ca = 0;
      const s0 = xw.start[x];
      const n = xw.count[x];
      const wo = xw.offset[x];
      for (let k = 0; k < n; k++) {
        const w = xw.w[wo + k];
        const i = base + (s0 + k) * 4;
        const a = (data[i + 3] / amax) * w;
        cr += dec(data[i]) * a;
        cg += dec(data[i + 1]) * a;
        cb += dec(data[i + 2]) * a;
        ca += a;
      }
      const o = x * 4;
      dst[o] = cr;
      dst[o + 1] = cg;
      dst[o + 2] = cb;
      dst[o + 3] = ca;
    }
  };

  const encode = encoderFor(out, transfer);
  for (let y = 0; y < th; y++) {
    acc.fill(0);
    const s0 = yw.start[y];
    const n = yw.count[y];
    const wo = yw.offset[y];
    for (let k = 0; k < n; k++) {
      const r = s0 + k;
      let row: Float32Array;
      // Consecutive output rows share at most one boundary source row: keep the last two.
      if (r === rowAIndex) row = rowA;
      else if (r === rowBIndex) row = rowB;
      else {
        const t = rowA;
        rowA = rowB;
        rowAIndex = rowBIndex;
        rowB = t;
        rowBIndex = r;
        hpass(r, rowB);
        row = rowB;
      }
      const w = yw.w[wo + k];
      for (let i = 0; i < acc.length; i++) acc[i] += row[i] * w;
    }
    let o = y * tw * 4;
    for (let x = 0; x < tw; x++, o += 4) {
      const i = x * 4;
      const a = acc[i + 3];
      const inv = a > 1e-12 ? 1 / a : 0;
      encode(o, acc[i] * inv, acc[i + 1] * inv, acc[i + 2] * inv, a);
    }
  }
  return { width: tw, height: th, data: out, transfer };
}

function allocLike(data: PixelData, n: number): PixelData {
  if (data instanceof Uint16Array) return new Uint16Array(n);
  if (data instanceof Float32Array) return new Float32Array(n);
  if (data instanceof Uint8ClampedArray) return new Uint8ClampedArray(n);
  return new Uint8Array(n);
}

/** Writes a LINEAR rgb + alpha(0..1) sample into `out` using the target type/transfer. */
function encoderFor(out: PixelData, transfer: PixelBuffer['transfer']): (o: number, r: number, g: number, b: number, a: number) => void {
  if (out instanceof Float32Array) {
    const enc = transfer === 'srgb' ? (v: number) => (v < 0 ? -linearToSrgb(-v) : linearToSrgb(v)) : (v: number) => v;
    return (o, r, g, b, a) => {
      out[o] = enc(r);
      out[o + 1] = enc(g);
      out[o + 2] = enc(b);
      out[o + 3] = a;
    };
  }
  if (out instanceof Uint16Array) {
    if (transfer === 'srgb') {
      const t = linearToSrgb16Lut();
      return (o, r, g, b, a) => {
        out[o] = t[encIndex(r)];
        out[o + 1] = t[encIndex(g)];
        out[o + 2] = t[encIndex(b)];
        out[o + 3] = Math.round(Math.min(1, a) * 65535);
      };
    }
    const q = (v: number): number => (v <= 0 ? 0 : v >= 1 ? 65535 : Math.round(v * 65535));
    return (o, r, g, b, a) => {
      out[o] = q(r);
      out[o + 1] = q(g);
      out[o + 2] = q(b);
      out[o + 3] = q(a);
    };
  }
  if (transfer === 'srgb') {
    const t = linearToSrgb8Lut();
    return (o, r, g, b, a) => {
      out[o] = t[encIndex(r)];
      out[o + 1] = t[encIndex(g)];
      out[o + 2] = t[encIndex(b)];
      out[o + 3] = Math.round(Math.min(1, a) * 255);
    };
  }
  const q8 = (v: number): number => (v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255));
  return (o, r, g, b, a) => {
    out[o] = q8(r);
    out[o + 1] = q8(g);
    out[o + 2] = q8(b);
    out[o + 3] = q8(a);
  };
}

/* ------------------------------------------------------------------ */
/* Conversions                                                         */
/* ------------------------------------------------------------------ */

/**
 * Any PixelBuffer → 8-bit sRGB RGBA. SourceImages in other primaries
 * (ProPhoto RAW, Display P3) are gamut-mapped to sRGB (clipped). An 8-bit
 * sRGB input is returned as a zero-copy view.
 */
export function toSrgb8(src: PixelBuffer): PixelBufferU8 {
  const { width, height, data, transfer } = src;
  const prim = primariesOf(src);
  const n = width * height * 4;
  if (prim === 'srgb' && transfer === 'srgb' && (data instanceof Uint8Array || data instanceof Uint8ClampedArray)) {
    const view = data instanceof Uint8ClampedArray ? data : new Uint8ClampedArray(data.buffer, data.byteOffset, data.length);
    return { width, height, data: view, transfer: 'srgb' };
  }
  const out = new Uint8ClampedArray(n);
  const amax = fullScale(data);
  if (prim === 'srgb' && transfer === 'srgb' && data instanceof Uint16Array) {
    for (let i = 0; i < n; i++) out[i] = (data[i] + 128) / 257;
    return { width, height, data: out, transfer: 'srgb' };
  }
  const dec = linearDecoder(data, transfer);
  const enc = linearToSrgb8Lut();
  const m = prim === 'srgb' ? null : MATRIX_TO_SRGB[prim];
  for (let i = 0; i < n; i += 4) {
    let r = dec(data[i]);
    let g = dec(data[i + 1]);
    let b = dec(data[i + 2]);
    if (m) {
      const rr = m[0] * r + m[1] * g + m[2] * b;
      const gg = m[3] * r + m[4] * g + m[5] * b;
      const bb = m[6] * r + m[7] * g + m[8] * b;
      r = rr;
      g = gg;
      b = bb;
    }
    out[i] = enc[encIndex(r)];
    out[i + 1] = enc[encIndex(g)];
    out[i + 2] = enc[encIndex(b)];
    out[i + 3] = (data[i + 3] / amax) * 255 + 0.5;
  }
  return { width, height, data: out, transfer: 'srgb' };
}

/**
 * Any PixelBuffer → Float32 LINEAR RGBA (alpha 0..1). SourceImages in other
 * primaries are converted to linear sRGB (Rec.709) primaries, unclamped.
 */
export function toLinearFloat(src: PixelBuffer): PixelBuffer {
  const { width, height, data, transfer } = src;
  const n = width * height * 4;
  const out = new Float32Array(n);
  const dec = linearDecoder(data, transfer);
  const amax = fullScale(data);
  const prim = primariesOf(src);
  const m = prim === 'srgb' ? null : MATRIX_TO_SRGB[prim];
  for (let i = 0; i < n; i += 4) {
    const r = dec(data[i]);
    const g = dec(data[i + 1]);
    const b = dec(data[i + 2]);
    if (m) {
      out[i] = m[0] * r + m[1] * g + m[2] * b;
      out[i + 1] = m[3] * r + m[4] * g + m[5] * b;
      out[i + 2] = m[6] * r + m[7] * g + m[8] * b;
    } else {
      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
    }
    out[i + 3] = data[i + 3] / amax;
  }
  return { width, height, data: out, transfer: 'linear' };
}

/* ------------------------------------------------------------------ */
/* EXIF orientation                                                    */
/* ------------------------------------------------------------------ */

export function orientedSize(w: number, h: number, orientation: number): { width: number; height: number } {
  return orientation >= 5 && orientation <= 8 ? { width: h, height: w } : { width: w, height: h };
}

/**
 * Apply EXIF orientation (1..8) so the result displays upright. For output
 * pixel (x, y) the source pixel is (ax·x + bx·y + cx, ay·x + by·y + cy); the
 * table below is the standard EXIF definition (6 = rotate 90° CW, 8 = 90° CCW,
 * 5/7 = transpose/transverse). Copies whole pixels through a Uint32 view.
 */
export function applyOrientation<T extends PixelBuffer>(px: T, orientation: number): T {
  const o = orientation | 0;
  if (o < 2 || o > 8) return px;
  const { width: W, height: H, data } = px;
  const bytesPP = data.BYTES_PER_ELEMENT * 4;
  const words = bytesPP / 4;
  const dst = allocLike(data, data.length);
  const aligned = data.byteOffset % 4 === 0;
  const s32 = aligned ? new Uint32Array(data.buffer, data.byteOffset, (W * H * bytesPP) / 4) : new Uint32Array(data.slice().buffer);
  const d32 = new Uint32Array(dst.buffer);
  const T: Record<number, [number, number, number, number, number, number]> = {
    2: [-1, 0, W - 1, 0, 1, 0],
    3: [-1, 0, W - 1, 0, -1, H - 1],
    4: [1, 0, 0, 0, -1, H - 1],
    5: [0, 1, 0, 1, 0, 0],
    6: [0, 1, 0, -1, 0, H - 1],
    7: [0, -1, W - 1, -1, 0, H - 1],
    8: [0, -1, W - 1, 1, 0, 0],
  };
  const [ax, bx, cx, ay, by, cy] = T[o];
  const { width: OW, height: OH } = orientedSize(W, H, o);
  const dx = ay * W + ax;
  const dy = by * W + bx;
  let rowBase = cy * W + cx;
  let di = 0;
  for (let y = 0; y < OH; y++, rowBase += dy) {
    let si = rowBase;
    for (let x = 0; x < OW; x++, si += dx) {
      const s = si * words;
      for (let k = 0; k < words; k++) d32[di++] = s32[s + k];
    }
  }
  return { ...px, width: OW, height: OH, data: dst };
}

/* ------------------------------------------------------------------ */
/* Packing helpers                                                     */
/* ------------------------------------------------------------------ */

/** Interleaved RGB (3 channels) → RGBA with opaque alpha, optionally mapping values through a LUT. */
export function rgbToRgba16(rgb: Uint16Array, w: number, h: number, lut?: Uint16Array): Uint16Array {
  const n = w * h;
  const out = new Uint16Array(n * 4);
  if (lut) {
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      const o = i * 4;
      out[o] = lut[rgb[j]];
      out[o + 1] = lut[rgb[j + 1]];
      out[o + 2] = lut[rgb[j + 2]];
      out[o + 3] = 65535;
    }
  } else {
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      const o = i * 4;
      out[o] = rgb[j];
      out[o + 1] = rgb[j + 1];
      out[o + 2] = rgb[j + 2];
      out[o + 3] = 65535;
    }
  }
  return out;
}
