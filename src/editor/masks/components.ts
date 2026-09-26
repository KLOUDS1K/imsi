/**
 * Coverage generators for the non-brush mask components. Every function
 * writes coverage 0..255 for a width×height SOURCE-space grid into `out`.
 */
import type {
  ColorRangeParams,
  DepthRangeParams,
  LinearGradientParams,
  LuminanceRangeParams,
  AiMaskParams,
  MaskBitmap,
  RadialGradientParams,
} from '@/editor/types';
import { bilinearAxis, resamplePlane, srgbToOklab, type SourceFeatures } from './source';

const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** Linear gradient: 1 at (x0,y0) → 0 at (x1,y1) with a smoothstep ramp, constant beyond the ends. */
export function fillLinear(p: LinearGradientParams, w: number, h: number, out: Uint8Array): void {
  const ax = p.x0 * w, ay = p.y0 * h;
  const dx = (p.x1 - p.x0) * w, dy = (p.y1 - p.y0) * h;
  const len2 = dx * dx + dy * dy;
  if (!(len2 > 1e-9)) {
    out.fill(255);
    return;
  }
  // t(x, y) = ((x+.5-ax)·dx + (y+.5-ay)·dy) / len² is affine: step it along the row.
  const kx = dx / len2, ky = dy / len2;
  // Coverage LUT over t ∈ [0,1] (4096 steps) avoids per-pixel smoothstep.
  const N = 4096;
  const lut = new Uint8Array(N + 1);
  for (let i = 0; i <= N; i++) lut[i] = Math.round(255 * (1 - smooth(i / N)));
  for (let y = 0; y < h; y++) {
    let t = (0.5 - ax) * kx + (y + 0.5 - ay) * ky;
    let o = y * w;
    for (let x = 0; x < w; x++, o++, t += kx) out[o] = t <= 0 ? 255 : t >= 1 ? 0 : lut[(t * N + 0.5) | 0]!;
  }
}

/**
 * Radial gradient: rotated ellipse, rx as a fraction of the width, ry of the
 * height. Inside the inner (1 − feather) fraction of the radius coverage is 1;
 * it falls to 0 at the ellipse edge with a smoothstep. feather 0 = hard edge
 * with ~1 px anti-aliasing.
 */
export function fillRadial(p: RadialGradientParams, w: number, h: number, out: Uint8Array): void {
  out.fill(0);
  const rx = Math.abs(p.rx) * w;
  const ry = Math.abs(p.ry) * h;
  if (!(rx > 1e-6) || !(ry > 1e-6)) return;
  const cx = p.cx * w, cy = p.cy * h;
  const th = (p.angle * Math.PI) / 180;
  const c = Math.cos(th), s = Math.sin(th);
  const f = Math.max(0, Math.min(1, p.feather / 100));
  const inner = 1 - f;
  // Width of the falloff in normalized-radius units; at least ~1 px for AA.
  const aa = 1 / Math.min(rx, ry);
  const e0 = Math.min(inner, 1 - aa);
  const e1 = f > 0 ? 1 : 1 + aa * 0.5;
  const e0b = f > 0 ? e0 : 1 - aa * 0.5;
  // Bounding box of the rotated ellipse (y down; positive angle = clockwise on screen).
  const hw = Math.sqrt(rx * rx * c * c + ry * ry * s * s) * e1 + 1;
  const hh = Math.sqrt(rx * rx * s * s + ry * ry * c * c) * e1 + 1;
  const x0 = Math.max(0, Math.floor(cx - hw)), x1 = Math.min(w, Math.ceil(cx + hw));
  const y0 = Math.max(0, Math.floor(cy - hh)), y1 = Math.min(h, Math.ceil(cy + hh));
  const inv = 1 / (e1 - e0b);
  const irx = 1 / rx, iry = 1 / ry;
  for (let y = y0; y < y1; y++) {
    const py = y + 0.5 - cy;
    let o = y * w + x0;
    for (let x = x0; x < x1; x++, o++) {
      const px = x + 0.5 - cx;
      // Rotate the offset by −angle into the ellipse frame.
      const u = (px * c + py * s) * irx;
      const v = (-px * s + py * c) * iry;
      const r = Math.sqrt(u * u + v * v);
      if (r >= e1) continue;
      out[o] = r <= e0b ? 255 : Math.round(255 * (1 - smooth((r - e0b) * inv)));
    }
  }
}

/** Range coverage of a scalar with independent feathers (all in the same units). */
export function rangeValue(v: number, min: number, max: number, fLow: number, fHigh: number): number {
  const lo = Math.min(min, max), hi = Math.max(min, max);
  if (v >= lo && v <= hi) return 1;
  if (v < lo) return fLow > 1e-6 ? smooth(1 - (lo - v) / fLow) : 0;
  return fHigh > 1e-6 ? smooth(1 - (v - hi) / fHigh) : 0;
}

/** LUT over 0..1 in 1024 steps for rangeValue (luminance & depth). */
function rangeLut(min: number, max: number, fLow: number, fHigh: number): Uint8Array {
  const N = 1024;
  const lut = new Uint8Array(N + 1);
  // A zero-width range with no feather still covers the exact value ± half a step.
  const eps = 0.5 / N;
  for (let i = 0; i <= N; i++) lut[i] = Math.round(255 * rangeValue(i / N, min - eps, max + eps, fLow, fHigh));
  return lut;
}

/** Luminance range on CIE L* ÷ 100 of the source (bilinear sampled). */
export function fillLuminanceRange(p: LuminanceRangeParams, f: SourceFeatures, w: number, h: number, out: Uint8Array): void {
  const lut = rangeLut(p.min, p.max, Math.max(0, p.featherLow), Math.max(0, p.featherHigh));
  const { width: sw, height: sh, lstar } = f;
  const ax = bilinearAxis(w, sw);
  const ay = bilinearAxis(h, sh);
  for (let y = 0; y < h; y++) {
    const r0 = ay.i0[y]! * sw, r1 = ay.i1[y]! * sw, ty = ay.t[y]!;
    let o = y * w;
    for (let x = 0; x < w; x++, o++) {
      const x0 = ax.i0[x]!, x1 = ax.i1[x]!, tx = ax.t[x]!;
      const top = lstar[r0 + x0]! + (lstar[r0 + x1]! - lstar[r0 + x0]!) * tx;
      const bot = lstar[r1 + x0]! + (lstar[r1 + x1]! - lstar[r1 + x0]!) * tx;
      const v = top + (bot - top) * ty;
      out[o] = lut[(v * 1024 + 0.5) | 0]!;
    }
  }
}

/** Depth range on the depth map (0 near .. 255 far); missing depth → empty. */
export function fillDepthRange(p: DepthRangeParams, depth: MaskBitmap | null | undefined, w: number, h: number, out: Uint8Array): void {
  if (!depth || depth.width < 1 || depth.height < 1) {
    out.fill(0);
    return;
  }
  resamplePlane(depth.data, depth.width, depth.height, w, h, out);
  const fe = Math.max(0, p.feather);
  const lut = rangeLut(p.min, p.max, fe, fe);
  const l8 = new Uint8Array(256);
  for (let i = 0; i < 256; i++) l8[i] = lut[Math.round((i / 255) * 1024)]!;
  for (let i = 0; i < out.length; i++) out[i] = l8[out[i]!]!;
}

/**
 * Colour-range threshold (OKLab ΔE with lightness weighted down) for range
 * 0..100: 0 = only near-identical colours, 50 ≈ one hue family, 100 = broad.
 */
export function colorRangeThreshold(range: number): number {
  const r = Math.max(0, Math.min(100, range)) / 100;
  return 0.02 + 0.28 * Math.pow(r, 1.5);
}

/** Lightness weight in the colour-range distance (hue/chroma matter more). */
export const COLOR_RANGE_L_WEIGHT = 0.35;

/** Colour range: distance in OKLab to the nearest sampled colour with a soft threshold. */
export function fillColorRange(p: ColorRangeParams, f: SourceFeatures, w: number, h: number, out: Uint8Array): void {
  const samples = p.samples.map(srgbToOklab);
  if (samples.length === 0) {
    out.fill(0);
    return;
  }
  const T = colorRangeThreshold(p.range);
  const inner = T * 0.5;
  const inv = 1 / (T - inner);
  const T2 = T * T;
  const sL = new Float64Array(samples.length), sA = new Float64Array(samples.length), sB = new Float64Array(samples.length);
  samples.forEach((s, i) => {
    sL[i] = s[0];
    sA[i] = s[1];
    sB[i] = s[2];
  });
  const ns = samples.length;
  const wl = COLOR_RANGE_L_WEIGHT;
  const { width: sw, height: sh, lab } = f;
  const cover = (L: number, A: number, B: number): number => {
    let best = Infinity;
    for (let k = 0; k < ns; k++) {
      const dl = L - sL[k]!, da = A - sA[k]!, db = B - sB[k]!;
      const d2 = wl * dl * dl + da * da + db * db;
      if (d2 < best) best = d2;
    }
    if (best >= T2) return 0;
    const d = Math.sqrt(best);
    if (d <= inner) return 255;
    const t = 1 - (d - inner) * inv;
    return (255 * t * t * (3 - 2 * t) + 0.5) | 0;
  };
  if (w > sw || h > sh) {
    // Upsampling: evaluate at feature resolution, then resample the coverage.
    const small = new Uint8Array(sw * sh);
    for (let i = 0; i < sw * sh; i++) small[i] = cover(lab[i * 3]!, lab[i * 3 + 1]!, lab[i * 3 + 2]!);
    resamplePlane(small, sw, sh, w, h, out);
    return;
  }
  // Same size or downsampling: interpolate OKLab at each output pixel centre.
  const ax = bilinearAxis(w, sw);
  const ay = bilinearAxis(h, sh);
  for (let y = 0; y < h; y++) {
    const r0 = ay.i0[y]! * sw, r1 = ay.i1[y]! * sw, ty = ay.t[y]!;
    let o = y * w;
    for (let x = 0; x < w; x++, o++) {
      const x0 = ax.i0[x]!, x1 = ax.i1[x]!, tx = ax.t[x]!;
      const a = (r0 + x0) * 3, b = (r0 + x1) * 3, c = (r1 + x0) * 3, d = (r1 + x1) * 3;
      const w00 = (1 - tx) * (1 - ty), w01 = tx * (1 - ty), w10 = (1 - tx) * ty, w11 = tx * ty;
      out[o] = cover(
        lab[a]! * w00 + lab[b]! * w01 + lab[c]! * w10 + lab[d]! * w11,
        lab[a + 1]! * w00 + lab[b + 1]! * w01 + lab[c + 1]! * w10 + lab[d + 1]! * w11,
        lab[a + 2]! * w00 + lab[b + 2]! * w01 + lab[c + 2]! * w10 + lab[d + 2]! * w11,
      );
    }
  }
}

function extremePass(src: Uint8Array, dst: Uint8Array, w: number, h: number, radius: number, horizontal: boolean, dilate: boolean): void {
  const lines = horizontal ? h : w;
  const length = horizontal ? w : h;
  const stride = horizontal ? 1 : w;
  const queue = new Int32Array(length);
  for (let line = 0; line < lines; line++) {
    const base = horizontal ? line * w : line;
    let head = 0, tail = 0, right = -1;
    for (let pos = 0; pos < length; pos++) {
      const end = Math.min(length - 1, pos + radius);
      while (right < end) {
        right++;
        const value = src[base + right * stride]!;
        while (tail > head) {
          const previous = src[base + queue[tail - 1]! * stride]!;
          if (dilate ? previous > value : previous < value) break;
          tail--;
        }
        queue[tail++] = right;
      }
      const start = pos - radius;
      while (head < tail && queue[head]! < start) head++;
      dst[base + pos * stride] = src[base + queue[head]! * stride]!;
    }
  }
}

function shiftEdge(data: Uint8Array, w: number, h: number, amount: number): void {
  const radius = Math.min(32, Math.round((Math.abs(amount) / 100) * Math.min(w, h) * 0.018));
  if (!radius) return;
  const tmp = new Uint8Array(data.length);
  const src = data.slice();
  const dilate = amount > 0;
  extremePass(src, tmp, w, h, radius, true, dilate);
  extremePass(tmp, data, w, h, radius, false, dilate);
}

function featherEdge(data: Uint8Array, w: number, h: number, amount: number): void {
  const radius = Math.min(28, Math.round((amount / 100) * Math.min(w, h) * 0.014));
  if (!radius) return;
  const tmp = new Uint8Array(data.length);
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = 0; x <= Math.min(w - 1, radius); x++) sum += data[y * w + x]!;
    for (let x = 0; x < w; x++) {
      const count = Math.min(w - 1, x + radius) - Math.max(0, x - radius) + 1;
      tmp[y * w + x] = Math.round(sum / count);
      const remove = x - radius;
      const add = x + radius + 1;
      if (remove >= 0) sum -= data[y * w + remove]!;
      if (add < w) sum += data[y * w + add]!;
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = 0; y <= Math.min(h - 1, radius); y++) sum += tmp[y * w + x]!;
    for (let y = 0; y < h; y++) {
      const count = Math.min(h - 1, y + radius) - Math.max(0, y - radius) + 1;
      data[y * w + x] = Math.round(sum / count);
      const remove = y - radius;
      const add = y + radius + 1;
      if (remove >= 0) sum -= tmp[remove * w + x]!;
      if (add < h) sum += tmp[add * w + x]!;
    }
  }
}

/** AI bitmap resampled to w×h, with non-destructive edge refinement. */
export function fillAi(bmp: MaskBitmap, w: number, h: number, out: Uint8Array, params?: Pick<AiMaskParams, 'edgeShift' | 'feather'>): void {
  resamplePlane(bmp.data, bmp.width, bmp.height, w, h, out);
  if (!params) return;
  shiftEdge(out, w, h, params.edgeShift ?? 0);
  featherEdge(out, w, h, params.feather ?? 0);
}
