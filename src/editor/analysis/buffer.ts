/**
 * Pixel access for the analysis module.
 *
 * Every analysis runs on small float planes built here from any PixelBuffer
 * (8-bit / 16-bit / float, sRGB-encoded or linear). Downscaling averages in
 * LINEAR light (that is what a lens/sensor would have recorded at the lower
 * resolution) and caps the work per output pixel at ~4×4 samples so a 24 MP
 * buffer costs about as much as a 2 MP one.
 *
 * DOM-free: safe to import from a Web Worker.
 */
import type { PixelBuffer } from '@/editor/types';
import { SRGB8_TO_LINEAR, linearToSrgb, srgbToLinear } from '@/editor/color/math';

/** Downscaled float image in linear light. */
export interface WorkImage {
  width: number;
  height: number;
  /** Size of the buffer this was built from. */
  srcWidth: number;
  srcHeight: number;
  /** Linear-light RGB (Rec.709 primaries), nominal 0..1, never negative. */
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
  /** Linear relative luminance (Rec.709). */
  lum: Float32Array;
  /** sRGB-encoded luminance ("perceptual lightness"), clamped to 0..1. */
  luma: Float32Array;
  /** Fraction of sampled source pixels with any channel clipped at white / at black. */
  clipHigh: number;
  clipLow: number;
}

/** Single perceptual (sRGB-encoded luminance) plane. */
export interface LumaPlane {
  width: number;
  height: number;
  data: Float32Array;
}

/* ------------------------------------------------------------------ */
/* Transfer helpers                                                    */
/* ------------------------------------------------------------------ */

const ENC_LUT_SIZE = 4096;
/**
 * linear → sRGB lookup indexed by sqrt(linear): the square-root spacing puts
 * most entries in the dark range where the sRGB curve is steepest, keeping the
 * interpolation error below 1e-4 everywhere.
 */
const ENC_LUT: Float32Array = (() => {
  const t = new Float32Array(ENC_LUT_SIZE + 1);
  for (let i = 0; i <= ENC_LUT_SIZE; i++) {
    const s = i / ENC_LUT_SIZE;
    t[i] = linearToSrgb(s * s);
  }
  return t;
})();

/** Fast linearToSrgb for v in [0, 1] (clamped); exact curve outside that range is not needed for stats. */
export function encodeSrgb(v: number): number {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  const f = Math.sqrt(v) * ENC_LUT_SIZE;
  const i = f | 0;
  const t = f - i;
  return ENC_LUT[i] + (ENC_LUT[i + 1] - ENC_LUT[i]) * t;
}

const DEC_LUT_SIZE = 4096;
const DEC_LUT: Float32Array = (() => {
  const t = new Float32Array(DEC_LUT_SIZE + 1);
  for (let i = 0; i <= DEC_LUT_SIZE; i++) t[i] = srgbToLinear(i / DEC_LUT_SIZE);
  return t;
})();

/** Fast srgbToLinear for floats (LUT + lerp inside 0..1, exact outside). */
export function decodeSrgb(v: number): number {
  if (v <= 0) return 0;
  if (v >= 1) return v === 1 ? 1 : srgbToLinear(v);
  const f = v * DEC_LUT_SIZE;
  const i = f | 0;
  const t = f - i;
  return DEC_LUT[i] + (DEC_LUT[i + 1] - DEC_LUT[i]) * t;
}

let U16_SRGB_LUT: Float32Array | null = null;
let U16_LIN_LUT: Float32Array | null = null;
let U8_LIN_LUT: Float32Array | null = null;

interface Decoder {
  /** Integer data: raw value → linear. Null for float data. */
  lut: Float32Array | null;
  /** Float data is sRGB-encoded (needs decoding). */
  floatSrgb: boolean;
  /** Raw-value thresholds for clipping detection. */
  hi: number;
  lo: number;
}

function decoderFor(px: PixelBuffer): Decoder {
  const d = px.data;
  const srgb = px.transfer === 'srgb';
  if (d instanceof Uint8Array || d instanceof Uint8ClampedArray) {
    if (!srgb && !U8_LIN_LUT) {
      U8_LIN_LUT = new Float32Array(256);
      for (let i = 0; i < 256; i++) U8_LIN_LUT[i] = i / 255;
    }
    return { lut: srgb ? SRGB8_TO_LINEAR : (U8_LIN_LUT as Float32Array), floatSrgb: false, hi: 255, lo: 0 };
  }
  if (d instanceof Uint16Array) {
    if (srgb && !U16_SRGB_LUT) {
      U16_SRGB_LUT = new Float32Array(65536);
      for (let i = 0; i < 65536; i++) U16_SRGB_LUT[i] = srgbToLinear(i / 65535);
    }
    if (!srgb && !U16_LIN_LUT) {
      U16_LIN_LUT = new Float32Array(65536);
      for (let i = 0; i < 65536; i++) U16_LIN_LUT[i] = i / 65535;
    }
    // Half an 8-bit code value in 16-bit units.
    return { lut: srgb ? (U16_SRGB_LUT as Float32Array) : (U16_LIN_LUT as Float32Array), floatSrgb: false, hi: 65535 - 128, lo: 128 };
  }
  return srgb
    ? { lut: null, floatSrgb: true, hi: 0.998, lo: 0.002 }
    : { lut: null, floatSrgb: false, hi: 0.995, lo: 0.00015 };
}

/** Linear value of one raw sample. */
function linearOf(dec: Decoder, raw: number): number {
  if (dec.lut) return dec.lut[raw];
  if (dec.floatSrgb) return decodeSrgb(raw);
  return raw > 0 ? raw : 0;
}

/* ------------------------------------------------------------------ */
/* Downscaling                                                         */
/* ------------------------------------------------------------------ */

/** Target size for a long edge of at most `maxSize` (never upscales). */
export function fitSize(w: number, h: number, maxSize: number): { width: number; height: number; scale: number } {
  const long = Math.max(w, h);
  const s = long > maxSize ? maxSize / long : 1;
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)), scale: s };
}

function boundaries(src: number, dst: number): Int32Array {
  const b = new Int32Array(dst + 1);
  for (let i = 0; i <= dst; i++) b[i] = Math.min(src, Math.floor((i * src) / dst));
  for (let i = 0; i < dst; i++) if (b[i + 1] <= b[i]) b[i + 1] = Math.min(src, b[i] + 1);
  return b;
}

/**
 * Box-downscale to at most `maxSize` on the long edge, averaging in linear light.
 * Also measures clipping on the sampled source pixels (before averaging hides it).
 */
export function buildWorkImage(px: PixelBuffer, maxSize = 512): WorkImage {
  const { width: w, height: h, data } = px;
  const { width: tw, height: th } = fitSize(w, h, maxSize);
  const n = tw * th;
  const r = new Float32Array(n);
  const g = new Float32Array(n);
  const b = new Float32Array(n);
  const dec = decoderFor(px);
  const xb = boundaries(w, tw);
  const yb = boundaries(h, th);
  // At most ~4 samples per axis per output pixel.
  const stepX = Math.max(1, Math.floor(w / tw / 4));
  const stepY = Math.max(1, Math.floor(h / th / 4));
  const accR = new Float64Array(tw);
  const accG = new Float64Array(tw);
  const accB = new Float64Array(tw);
  const cnt = new Float64Array(tw);
  let samples = 0;
  let clipHi = 0;
  let clipLo = 0;
  const { hi, lo } = dec;
  for (let ty = 0; ty < th; ty++) {
    accR.fill(0);
    accG.fill(0);
    accB.fill(0);
    cnt.fill(0);
    for (let sy = yb[ty]; sy < yb[ty + 1]; sy += stepY) {
      const row = sy * w * 4;
      for (let tx = 0; tx < tw; tx++) {
        let sr = 0;
        let sg = 0;
        let sb = 0;
        let c = 0;
        for (let sx = xb[tx]; sx < xb[tx + 1]; sx += stepX) {
          const i = row + sx * 4;
          const vr = data[i];
          const vg = data[i + 1];
          const vb = data[i + 2];
          if (vr >= hi || vg >= hi || vb >= hi) clipHi++;
          if (vr <= lo || vg <= lo || vb <= lo) clipLo++;
          sr += linearOf(dec, vr);
          sg += linearOf(dec, vg);
          sb += linearOf(dec, vb);
          c++;
        }
        accR[tx] += sr;
        accG[tx] += sg;
        accB[tx] += sb;
        cnt[tx] += c;
        samples += c;
      }
    }
    const o = ty * tw;
    for (let tx = 0; tx < tw; tx++) {
      const inv = cnt[tx] > 0 ? 1 / cnt[tx] : 0;
      r[o + tx] = accR[tx] * inv;
      g[o + tx] = accG[tx] * inv;
      b[o + tx] = accB[tx] * inv;
    }
  }
  const lum = new Float32Array(n);
  const luma = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const y = 0.2126 * r[i] + 0.7152 * g[i] + 0.0722 * b[i];
    lum[i] = y;
    luma[i] = encodeSrgb(y);
  }
  return {
    width: tw,
    height: th,
    srcWidth: w,
    srcHeight: h,
    r,
    g,
    b,
    lum,
    luma,
    clipHigh: samples > 0 ? clipHi / samples : 0,
    clipLow: samples > 0 ? clipLo / samples : 0,
  };
}

/**
 * Perceptual luma plane at up to `maxSize`. When `nearest` is true the plane is
 * point-sampled instead of averaged, which keeps the per-pixel noise of the
 * source intact (used by the noise estimator).
 */
export function buildLumaPlane(px: PixelBuffer, maxSize = 1024, nearest = false): LumaPlane {
  const { width: w, height: h, data } = px;
  const { width: tw, height: th } = fitSize(w, h, maxSize);
  const out = new Float32Array(tw * th);
  const dec = decoderFor(px);
  if (nearest || (tw === w && th === h)) {
    for (let ty = 0; ty < th; ty++) {
      const sy = tw === w && th === h ? ty : Math.min(h - 1, Math.floor(((ty + 0.5) * h) / th));
      for (let tx = 0; tx < tw; tx++) {
        const sx = tw === w && th === h ? tx : Math.min(w - 1, Math.floor(((tx + 0.5) * w) / tw));
        const i = (sy * w + sx) * 4;
        const y = 0.2126 * linearOf(dec, data[i]) + 0.7152 * linearOf(dec, data[i + 1]) + 0.0722 * linearOf(dec, data[i + 2]);
        out[ty * tw + tx] = encodeSrgb(y);
      }
    }
    return { width: tw, height: th, data: out };
  }
  const wi = buildWorkImage(px, maxSize);
  return { width: wi.width, height: wi.height, data: wi.luma };
}

/** Box-downscale a float plane by an arbitrary factor (area average). */
export function downscalePlane(src: Float32Array, w: number, h: number, tw: number, th: number): Float32Array {
  const out = new Float32Array(tw * th);
  if (tw === w && th === h) {
    out.set(src);
    return out;
  }
  const xb = boundaries(w, tw);
  const yb = boundaries(h, th);
  for (let ty = 0; ty < th; ty++) {
    for (let tx = 0; tx < tw; tx++) {
      let s = 0;
      let c = 0;
      for (let y = yb[ty]; y < yb[ty + 1]; y++) {
        const row = y * w;
        for (let x = xb[tx]; x < xb[tx + 1]; x++) {
          s += src[row + x];
          c++;
        }
      }
      out[ty * tw + tx] = c > 0 ? s / c : 0;
    }
  }
  return out;
}

/** Downscale all planes of a WorkImage (used to derive the tiny saliency/sky grids). */
export function shrinkWorkImage(img: WorkImage, maxSize: number): WorkImage {
  const { width: tw, height: th } = fitSize(img.width, img.height, maxSize);
  if (tw === img.width && th === img.height) return img;
  const r = downscalePlane(img.r, img.width, img.height, tw, th);
  const g = downscalePlane(img.g, img.width, img.height, tw, th);
  const b = downscalePlane(img.b, img.width, img.height, tw, th);
  const n = tw * th;
  const lum = new Float32Array(n);
  const luma = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const y = 0.2126 * r[i] + 0.7152 * g[i] + 0.0722 * b[i];
    lum[i] = y;
    luma[i] = encodeSrgb(y);
  }
  return { ...img, width: tw, height: th, r, g, b, lum, luma };
}
