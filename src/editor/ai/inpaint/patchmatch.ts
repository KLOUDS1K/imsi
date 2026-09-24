/**
 * Exemplar-based inpainting (Wexler et al. 2007 "Space-Time Completion" with
 * Barnes et al. 2009 PatchMatch as the nearest-neighbour search).
 *
 * Pipeline for one hole:
 *   1. Crop the hole's bounding box plus a context margin (sources come only
 *      from that region) and downscale it if it is very large.
 *   2. Build a Gaussian-like pyramid (2× box, averaging KNOWN pixels only). A
 *      coarse pixel is a hole if any of its children is one, so coarse sources
 *      never contain hole colours.
 *   3. Coarsest level: structure-aware initialisation by diffusion (push-pull
 *      then Jacobi smoothing), random nearest-neighbour field (NNF).
 *   4. Per level, EM iterations: PatchMatch passes (propagation + random
 *      search, alternating scan order) followed by a vote in which every hole
 *      pixel becomes the weighted mean of the source pixels proposed by all
 *      patches that cover it (weights: patch similarity × boundary confidence).
 *   5. The NNF is upsampled to the next finer level, which starts from a vote
 *      with it (so fine levels get real high-frequency detail from the source,
 *      not an interpolated coarse fill). Very large fine levels skip the search
 *      and only vote — the "detail from a higher-resolution pass".
 *
 * Source patches must not overlap the (dilated) hole: `excl` marks pixels that
 * may not be sampled. All buffers are flat typed arrays; the hot loops do not
 * allocate. This file has no DOM / worker dependencies so it runs in a Web
 * Worker, in Node tests, or on the main thread as a fallback.
 */
import { expandRect, maskBounds, downscaleMaskMax, downscaleRgba8, sampleBilinearRgba8, type PixelRect } from './pixels';

export interface PatchMatchOptions {
  /** Odd patch width in pixels (3..15). */
  patchSize: number;
  /** EM iterations at the coarsest level (finer levels use fewer, ≥ 2). */
  iterations: number;
  /** Random-search samples per search radius (1 = classic PatchMatch). */
  searchCandidates: number;
  /** Pixels around the hole that may not be used as source (halo / shadow of the removed object). */
  dilate: number;
  /** Levels with more target patches than this only upsample the NNF and vote (no search). */
  maxWorkPixels: number;
  /** A working region larger than this is downscaled before inpainting. */
  maxRegionPixels: number;
  /** Context margin around the hole as a multiple of the hole's larger extent. */
  contextScale: number;
  /** Final-vote sharpness: 1 = Wexler weights, > 1 favours the best patch (texture synthesis, less blur). */
  sharpness: number;
  /** RNG seed (results are deterministic for a given seed). */
  seed: number;
}

export const DEFAULT_PM_OPTIONS: PatchMatchOptions = {
  patchSize: 7,
  iterations: 6,
  searchCandidates: 1,
  dilate: 2,
  maxWorkPixels: 350_000,
  maxRegionPixels: 4_000_000,
  contextScale: 0.75,
  sharpness: 1,
  seed: 0x9e3779b9,
};

export interface PatchMatchHooks {
  onProgress?: (fraction: number) => void;
  isAborted?: () => boolean;
}

export class InpaintAbortError extends Error {
  constructor() {
    super('Inpainting aborted');
    this.name = 'AbortError';
  }
}

/* ------------------------------------------------------------------ */
/* Public entry                                                        */
/* ------------------------------------------------------------------ */

/**
 * Inpaint an RGBA8 image. `mask` (0..255, w×h) marks the pixels to fill; the
 * result equals the input where mask = 0 and blends fill/original by mask/255
 * elsewhere (255 = fully synthesized).
 */
export function inpaintRgba8(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  mask: Uint8Array,
  options: Partial<PatchMatchOptions> = {},
  hooks: PatchMatchHooks = {},
): Uint8ClampedArray {
  const opts = normalizeOptions(options);
  const out = new Uint8ClampedArray(data);
  const bounds = maskBounds(mask, width, height);
  if (!bounds) {
    hooks.onProgress?.(1);
    return out;
  }
  const extent = Math.max(bounds.w, bounds.h);
  const margin = Math.max(4 * opts.patchSize, Math.round(opts.contextScale * extent)) + opts.dilate;
  const region = expandRect(bounds, margin, width, height);
  let rgba = cropRgba(data, width, region);
  let hole = cropMask(mask, width, region);
  let rw = region.w;
  let rh = region.h;

  // Very large regions: work on a downscaled copy, bilinearly upsample the fill.
  const area = rw * rh;
  const scale = area > opts.maxRegionPixels ? Math.sqrt(opts.maxRegionPixels / area) : 1;
  if (scale < 1) {
    const dw = Math.max(1, Math.round(rw * scale));
    const dh = Math.max(1, Math.round(rh * scale));
    rgba = downscaleRgba8(rgba, rw, rh, dw, dh);
    hole = downscaleMaskMax(hole, rw, rh, dw, dh);
    rw = dw;
    rh = dh;
  }

  const fill = fillRegion(rgba, rw, rh, hole, opts, hooks);

  // Composite the fill into the output (only where the ORIGINAL mask is set).
  const tmp = new Float32Array(4);
  for (let y = 0; y < region.h; y++) {
    for (let x = 0; x < region.w; x++) {
      const gi = (region.y + y) * width + region.x + x;
      const m = mask[gi];
      if (!m) continue;
      let r: number;
      let g: number;
      let b: number;
      if (scale < 1) {
        // fill → RGBA8 is not materialised; sample the float fill bilinearly.
        sampleFill(fill, rw, rh, (x + 0.5) * (rw / region.w), (y + 0.5) * (rh / region.h), tmp);
        r = tmp[0];
        g = tmp[1];
        b = tmp[2];
      } else {
        const fi = (y * rw + x) * 3;
        r = fill[fi];
        g = fill[fi + 1];
        b = fill[fi + 2];
      }
      const a = m / 255;
      const o = gi * 4;
      out[o] = out[o] + (r - out[o]) * a;
      out[o + 1] = out[o + 1] + (g - out[o + 1]) * a;
      out[o + 2] = out[o + 2] + (b - out[o + 2]) * a;
    }
  }
  hooks.onProgress?.(1);
  return out;
}

function normalizeOptions(o: Partial<PatchMatchOptions>): PatchMatchOptions {
  const opts = { ...DEFAULT_PM_OPTIONS };
  for (const [k, v] of Object.entries(o) as [keyof PatchMatchOptions, number | undefined][]) {
    if (typeof v === 'number' && Number.isFinite(v)) opts[k] = v;
  }
  let p = Math.round(Math.min(Math.max(opts.patchSize, 3), 15));
  if (p % 2 === 0) p += 1;
  opts.patchSize = p;
  opts.iterations = Math.round(Math.min(Math.max(opts.iterations, 1), 30));
  opts.searchCandidates = Math.round(Math.min(Math.max(opts.searchCandidates, 1), 8));
  opts.dilate = Math.round(Math.min(Math.max(opts.dilate, 0), 16));
  opts.sharpness = Math.min(Math.max(opts.sharpness, 0.25), 8);
  opts.seed = opts.seed >>> 0 || 1;
  return opts;
}

function cropRgba(data: Uint8ClampedArray, W: number, r: PixelRect): Uint8ClampedArray {
  const out = new Uint8ClampedArray(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++) {
    const s = ((r.y + y) * W + r.x) * 4;
    out.set(data.subarray(s, s + r.w * 4), y * r.w * 4);
  }
  return out;
}

function cropMask(mask: Uint8Array, W: number, r: PixelRect): Uint8Array {
  const out = new Uint8Array(r.w * r.h);
  for (let y = 0; y < r.h; y++) {
    const s = (r.y + y) * W + r.x;
    for (let x = 0; x < r.w; x++) out[y * r.w + x] = mask[s + x] ? 1 : 0;
  }
  return out;
}

function sampleFill(fill: Float32Array, w: number, h: number, x: number, y: number, out: Float32Array): void {
  const fx = Math.min(Math.max(x - 0.5, 0), w - 1);
  const fy = Math.min(Math.max(y - 0.5, 0), h - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  for (let c = 0; c < 3; c++) {
    const a = fill[(y0 * w + x0) * 3 + c] + (fill[(y0 * w + x1) * 3 + c] - fill[(y0 * w + x0) * 3 + c]) * tx;
    const b = fill[(y1 * w + x0) * 3 + c] + (fill[(y1 * w + x1) * 3 + c] - fill[(y1 * w + x0) * 3 + c]) * tx;
    out[c] = a + (b - a) * ty;
  }
}

/* ------------------------------------------------------------------ */
/* Levels                                                              */
/* ------------------------------------------------------------------ */

interface Level {
  w: number;
  h: number;
  /** RGB 0..255, 3 floats per pixel. Hole pixels hold the current estimate. */
  img: Float32Array;
  /** 1 = pixel to synthesize. */
  hole: Uint8Array;
  /** 1 = pixel may not be sampled as source (hole, dilated). */
  excl: Uint8Array;
}

interface LevelState extends Level {
  /** 1 = valid source patch centre. */
  valid: Uint8Array;
  validList: Int32Array;
  /** Target patch centres (patches overlapping the hole), raster order. */
  targets: Int32Array;
  /** Source centre index per target centre (-1 elsewhere). */
  nnf: Int32Array;
  /** Patch SSD per target centre. */
  dist: Float32Array;
  /** Boundary confidence per target centre (Wexler's γ^-distance). */
  conf: Float32Array;
}

function buildBaseLevel(rgba: Uint8ClampedArray, w: number, h: number, hole: Uint8Array, dilate: number): Level {
  const img = new Float32Array(w * h * 3);
  for (let i = 0, j = 0; i < w * h; i++, j += 3) {
    img[j] = rgba[i * 4];
    img[j + 1] = rgba[i * 4 + 1];
    img[j + 2] = rgba[i * 4 + 2];
  }
  return { w, h, img, hole, excl: dilateMask(hole, w, h, dilate) };
}

/** Square dilation by `r` px (separable max filter). */
function dilateMask(m: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return new Uint8Array(m);
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let last = -1e9;
    for (let x = 0; x < w; x++) {
      if (m[row + x]) last = x;
      if (x - last <= r) tmp[row + x] = 1;
    }
    last = 1e9;
    for (let x = w - 1; x >= 0; x--) {
      if (m[row + x]) last = x;
      if (last - x <= r) tmp[row + x] = 1;
    }
  }
  for (let x = 0; x < w; x++) {
    let last = -1e9;
    for (let y = 0; y < h; y++) {
      if (tmp[y * w + x]) last = y;
      if (y - last <= r) out[y * w + x] = 1;
    }
    last = 1e9;
    for (let y = h - 1; y >= 0; y--) {
      if (tmp[y * w + x]) last = y;
      if (last - y <= r) out[y * w + x] = 1;
    }
  }
  return out;
}

/** 2× downsample: colours average KNOWN children only; masks are max-pooled. */
function downLevel(l: Level): Level {
  const w = Math.ceil(l.w / 2);
  const h = Math.ceil(l.h / 2);
  const img = new Float32Array(w * h * 3);
  const hole = new Uint8Array(w * h);
  const excl = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0;
      let na = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      let ra = 0;
      let ga = 0;
      let ba = 0;
      let anyHole = 0;
      let anyExcl = 0;
      for (let dy = 0; dy < 2; dy++) {
        const sy = 2 * y + dy;
        if (sy >= l.h) continue;
        for (let dx = 0; dx < 2; dx++) {
          const sx = 2 * x + dx;
          if (sx >= l.w) continue;
          const si = sy * l.w + sx;
          const c = si * 3;
          ra += l.img[c];
          ga += l.img[c + 1];
          ba += l.img[c + 2];
          na++;
          if (l.hole[si]) anyHole = 1;
          else {
            r += l.img[c];
            g += l.img[c + 1];
            b += l.img[c + 2];
            n++;
          }
          if (l.excl[si]) anyExcl = 1;
        }
      }
      const di = y * w + x;
      if (n > 0) {
        img[di * 3] = r / n;
        img[di * 3 + 1] = g / n;
        img[di * 3 + 2] = b / n;
      } else {
        img[di * 3] = ra / na;
        img[di * 3 + 1] = ga / na;
        img[di * 3 + 2] = ba / na;
      }
      hole[di] = anyHole;
      excl[di] = anyExcl;
    }
  }
  return { w, h, img, hole, excl };
}

/** Summed-area table of a 0/1 mask, (w+1)×(h+1). */
function sat(m: Uint8Array, w: number, h: number): Int32Array {
  const s = new Int32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += m[y * w + x];
      s[(y + 1) * (w + 1) + x + 1] = s[y * (w + 1) + x + 1] + row;
    }
  }
  return s;
}

function windowSum(s: Int32Array, w: number, x0: number, y0: number, x1: number, y1: number): number {
  const W = w + 1;
  return s[(y1 + 1) * W + x1 + 1] - s[y0 * W + x1 + 1] - s[(y1 + 1) * W + x0] + s[y0 * W + x0];
}

/** Valid source centres, target centres, NNF storage and boundary confidence for one level. */
function prepareLevel(l: Level, r: number): LevelState {
  const { w, h } = l;
  const n = w * h;
  const valid = new Uint8Array(n);
  const nnf = new Int32Array(n).fill(-1);
  const dist = new Float32Array(n);
  const conf = new Float32Array(n);
  const holeSat = sat(l.hole, w, h);
  let exclSat = sat(l.excl, w, h);
  const collect = (): number => {
    let count = 0;
    for (let y = r; y < h - r; y++) {
      for (let x = r; x < w - r; x++) {
        const ok = windowSum(exclSat, w, x - r, y - r, x + r, y + r) === 0 ? 1 : 0;
        valid[y * w + x] = ok;
        count += ok;
      }
    }
    return count;
  };
  let count = collect();
  if (count === 0) {
    // The dilated hole leaves no clean patch: fall back to the undilated hole.
    exclSat = holeSat;
    count = collect();
  }
  const validList = new Int32Array(count);
  let k = 0;
  for (let i = 0; i < n; i++) if (valid[i]) validList[k++] = i;

  const tl: number[] = [];
  for (let y = r; y < h - r; y++) {
    for (let x = r; x < w - r; x++) {
      if (windowSum(holeSat, w, x - r, y - r, x + r, y + r) > 0) tl.push(y * w + x);
    }
  }
  const targets = Int32Array.from(tl);

  // Chamfer distance of each pixel to the nearest known pixel → confidence.
  const dt = chamfer(l.hole, w, h);
  for (let i = 0; i < targets.length; i++) {
    const p = targets[i];
    conf[p] = Math.pow(1.3, -Math.min(dt[p], 40));
  }
  return { ...l, valid, validList, targets, nnf, dist, conf };
}

/** Two-pass 3-4 chamfer distance (in px) from hole pixels to the nearest known pixel. */
function chamfer(hole: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = hole[i] ? INF : 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!d[i]) continue;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + 1);
      if (y > 0) {
        v = Math.min(v, d[i - w] + 1);
        if (x > 0) v = Math.min(v, d[i - w - 1] + 1.414);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + 1.414);
      }
      d[i] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!d[i]) continue;
      let v = d[i];
      if (x < w - 1) v = Math.min(v, d[i + 1] + 1);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + 1);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + 1.414);
        if (x > 0) v = Math.min(v, d[i + w - 1] + 1.414);
      }
      d[i] = v;
    }
  }
  return d;
}

/* ------------------------------------------------------------------ */
/* Diffusion initialisation                                            */
/* ------------------------------------------------------------------ */

/**
 * Membrane fill of the hole: push-pull interpolation (unless `hasInit`, i.e.
 * the hole already holds an upsampled estimate) followed by Jacobi smoothing
 * restricted to the hole's bounding box.
 */
function diffusionFill(l: Level, hasInit = false): void {
  const { w, h, img, hole } = l;
  const b = maskBounds(hole, w, h);
  if (!b) return;
  if (!hasInit) {
    const wgt = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) wgt[i] = hole[i] ? 0 : 1;
    pushPull(img, wgt, w, h);
  }
  const iters = Math.min(hasInit ? 40 : 200, 2 * Math.max(b.w, b.h));
  for (let it = 0; it < iters; it++) {
    for (let y = b.y; y < b.y + b.h; y++) {
      for (let x = b.x; x < b.x + b.w; x++) {
        const i = y * w + x;
        if (!hole[i]) continue;
        let n = 0;
        let r = 0;
        let g = 0;
        let b = 0;
        if (x > 0) {
          r += img[(i - 1) * 3];
          g += img[(i - 1) * 3 + 1];
          b += img[(i - 1) * 3 + 2];
          n++;
        }
        if (x < w - 1) {
          r += img[(i + 1) * 3];
          g += img[(i + 1) * 3 + 1];
          b += img[(i + 1) * 3 + 2];
          n++;
        }
        if (y > 0) {
          r += img[(i - w) * 3];
          g += img[(i - w) * 3 + 1];
          b += img[(i - w) * 3 + 2];
          n++;
        }
        if (y < h - 1) {
          r += img[(i + w) * 3];
          g += img[(i + w) * 3 + 1];
          b += img[(i + w) * 3 + 2];
          n++;
        }
        img[i * 3] = r / n;
        img[i * 3 + 1] = g / n;
        img[i * 3 + 2] = b / n;
      }
    }
  }
}

function pushPull(val: Float32Array, wgt: Float32Array, w: number, h: number): void {
  if (w <= 1 && h <= 1) return;
  const cw = Math.ceil(w / 2);
  const ch = Math.ceil(h / 2);
  const cval = new Float32Array(cw * ch * 3);
  const cwgt = new Float32Array(cw * ch);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const k = wgt[i];
      if (!k) continue;
      const c = (y >> 1) * cw + (x >> 1);
      cval[c * 3] += val[i * 3] * k;
      cval[c * 3 + 1] += val[i * 3 + 1] * k;
      cval[c * 3 + 2] += val[i * 3 + 2] * k;
      cwgt[c] += k;
    }
  }
  for (let c = 0; c < cw * ch; c++) {
    if (cwgt[c] > 0) {
      cval[c * 3] /= cwgt[c];
      cval[c * 3 + 1] /= cwgt[c];
      cval[c * 3 + 2] /= cwgt[c];
      cwgt[c] = Math.min(1, cwgt[c]);
    }
  }
  pushPull(cval, cwgt, cw, ch);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const k = wgt[i];
      if (k >= 1) continue;
      const c = (y >> 1) * cw + (x >> 1);
      for (let j = 0; j < 3; j++) val[i * 3 + j] = val[i * 3 + j] * k + cval[c * 3 + j] * (1 - k);
    }
  }
}

/* ------------------------------------------------------------------ */
/* PatchMatch                                                          */
/* ------------------------------------------------------------------ */

class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }
  /** Uniform integer in [0, n). */
  int(n: number): number {
    let x = this.s;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.s = x >>> 0;
    return this.s % n;
  }
}

/** SSD between the patches centred at p and q (3 channels), with early exit above `cutoff`. */
function patchDist(img: Float32Array, w: number, r: number, p: number, q: number, cutoff: number): number {
  const rowLen = (2 * r + 1) * 3;
  const stride = w * 3;
  let ip = (p - r * w - r) * 3;
  let iq = (q - r * w - r) * 3;
  let s = 0;
  for (let dy = -r; dy <= r; dy++, ip += stride, iq += stride) {
    for (let k = 0; k < rowLen; k++) {
      const d = img[ip + k] - img[iq + k];
      s += d * d;
    }
    if (s >= cutoff) return s;
  }
  return s;
}

function computeAllDist(L: LevelState, r: number): void {
  const { targets, nnf, dist, img, w } = L;
  for (let i = 0; i < targets.length; i++) {
    const p = targets[i];
    dist[p] = patchDist(img, w, r, p, nnf[p], Infinity);
  }
}

function randomInit(L: LevelState, rng: Rng): void {
  const { targets, nnf, validList } = L;
  for (let i = 0; i < targets.length; i++) nnf[targets[i]] = validList[rng.int(validList.length)];
}

/** One PatchMatch sweep: propagation from already-visited neighbours, then random search. */
function patchMatchPass(L: LevelState, r: number, forward: boolean, rng: Rng, candidates: number): void {
  const { w, h, img, nnf, dist, valid, validList, targets } = L;
  const n = w * h;
  const step = forward ? 1 : -1;
  const maxR = Math.max(w, h);
  const start = forward ? 0 : targets.length - 1;
  const end = forward ? targets.length : -1;
  for (let i = start; i !== end; i += step) {
    const p = targets[i];
    let bq = nnf[p];
    let best = dist[p];
    // Propagation: the neighbour's match shifted by one pixel.
    const nh = p - step;
    if (nnf[nh] >= 0) {
      const q = nnf[nh] + step;
      if (q >= 0 && q < n && valid[q] && q !== bq) {
        const d = patchDist(img, w, r, p, q, best);
        if (d < best) {
          best = d;
          bq = q;
        }
      }
    }
    const nv = p - step * w;
    if (nv >= 0 && nv < n && nnf[nv] >= 0) {
      const q = nnf[nv] + step * w;
      if (q >= 0 && q < n && valid[q] && q !== bq) {
        const d = patchDist(img, w, r, p, q, best);
        if (d < best) {
          best = d;
          bq = q;
        }
      }
    }
    // Random search: one global sample, then exponentially shrinking windows around the best match.
    {
      const q = validList[rng.int(validList.length)];
      if (q !== bq) {
        const d = patchDist(img, w, r, p, q, best);
        if (d < best) {
          best = d;
          bq = q;
        }
      }
    }
    for (let R = maxR >> 1; R >= 1; R >>= 1) {
      const cx = bq % w;
      const cy = (bq / w) | 0;
      for (let k = 0; k < candidates; k++) {
        let qx = cx + rng.int(2 * R + 1) - R;
        let qy = cy + rng.int(2 * R + 1) - R;
        qx = qx < r ? r : qx > w - 1 - r ? w - 1 - r : qx;
        qy = qy < r ? r : qy > h - 1 - r ? h - 1 - r : qy;
        const q = qy * w + qx;
        if (q === bq || !valid[q]) continue;
        const d = patchDist(img, w, r, p, q, best);
        if (d < best) {
          best = d;
          bq = q;
        }
      }
    }
    nnf[p] = bq;
    dist[p] = best;
  }
}

/**
 * EM "M-step": every hole pixel = weighted mean of the source pixels that the
 * covering patches propose. Weight = exp(-d / 2σ²) · confidence, σ² = 75th
 * percentile of the patch distances (divided by sharpness²).
 */
function vote(L: LevelState, r: number, sharpness: number, uniform: boolean, acc: Float32Array, wsum: Float32Array): void {
  const { w, img, hole, nnf, dist, conf, targets } = L;
  const pw = 2 * r + 1;
  const elems = pw * pw * 3;
  let inv2s2 = 0;
  if (!uniform) {
    const s2 = percentile(dist, targets, 0.75) / elems;
    inv2s2 = (sharpness * sharpness) / (2 * Math.max(s2, 1));
  }
  acc.fill(0);
  wsum.fill(0);
  for (let i = 0; i < targets.length; i++) {
    const p = targets[i];
    const q = nnf[p];
    const wt = uniform ? 1 : Math.max(Math.exp(-(dist[p] / elems) * inv2s2) * conf[p], 1e-30);
    for (let dy = -r; dy <= r; dy++) {
      const rowP = p + dy * w;
      const rowQ = q + dy * w;
      for (let dx = -r; dx <= r; dx++) {
        const x = rowP + dx;
        if (!hole[x]) continue;
        const s = (rowQ + dx) * 3;
        acc[x * 3] += wt * img[s];
        acc[x * 3 + 1] += wt * img[s + 1];
        acc[x * 3 + 2] += wt * img[s + 2];
        wsum[x] += wt;
      }
    }
  }
  for (let x = 0; x < hole.length; x++) {
    const ws = wsum[x];
    if (!hole[x] || ws <= 0) continue;
    img[x * 3] = acc[x * 3] / ws;
    img[x * 3 + 1] = acc[x * 3 + 1] / ws;
    img[x * 3 + 2] = acc[x * 3 + 2] / ws;
  }
}

/** Approximate percentile of dist over the targets (sampled, ≤ 4096 values). */
function percentile(dist: Float32Array, targets: Int32Array, q: number): number {
  const n = targets.length;
  if (!n) return 0;
  const m = Math.min(n, 4096);
  const s = new Float32Array(m);
  const stepF = n / m;
  for (let i = 0; i < m; i++) s[i] = dist[targets[Math.floor(i * stepF)]];
  s.sort();
  return s[Math.min(m - 1, Math.floor(q * m))];
}

/** Map the coarse NNF onto the finer level (offsets doubled, sub-pixel phase kept). */
function upsampleNnf(coarse: LevelState, fine: LevelState, r: number, rng: Rng): void {
  const { w, h, targets, nnf, valid, validList } = fine;
  const cw = coarse.w;
  const ch = coarse.h;
  for (let i = 0; i < targets.length; i++) {
    const p = targets[i];
    const x = p % w;
    const y = (p / w) | 0;
    const cx = Math.min(x >> 1, cw - 1);
    const cy = Math.min(y >> 1, ch - 1);
    let qc = coarse.nnf[cy * cw + cx];
    if (qc < 0) {
      // Nearest coarse target in a small neighbourhood (border clamping can drop some).
      for (let d = 1; d <= 2 && qc < 0; d++) {
        for (let oy = -d; oy <= d && qc < 0; oy++) {
          for (let ox = -d; ox <= d && qc < 0; ox++) {
            const sx = cx + ox;
            const sy = cy + oy;
            if (sx < 0 || sy < 0 || sx >= cw || sy >= ch) continue;
            const v = coarse.nnf[sy * cw + sx];
            if (v >= 0) qc = v - oy * cw - ox;
          }
        }
      }
    }
    let q = -1;
    if (qc >= 0) {
      let qx = 2 * (qc % cw) + (x - 2 * cx);
      let qy = 2 * ((qc / cw) | 0) + (y - 2 * cy);
      qx = qx < r ? r : qx > w - 1 - r ? w - 1 - r : qx;
      qy = qy < r ? r : qy > h - 1 - r ? h - 1 - r : qy;
      q = qy * w + qx;
    }
    nnf[p] = q >= 0 && valid[q] ? q : validList[rng.int(validList.length)];
  }
}

/* ------------------------------------------------------------------ */
/* Multi-scale driver                                                  */
/* ------------------------------------------------------------------ */

/**
 * Fill the hole of an RGBA8 region. Returns RGB floats (0..255, 3 per pixel)
 * for the whole region; only hole pixels differ from the input.
 */
export function fillRegion(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  hole: Uint8Array,
  opts: PatchMatchOptions,
  hooks: PatchMatchHooks = {},
): Float32Array {
  const r = opts.patchSize >> 1;
  const base = buildBaseLevel(rgba, w, h, hole, opts.dilate);
  const bounds = maskBounds(hole, w, h);
  if (!bounds) return base.img;
  if (w < opts.patchSize + 2 || h < opts.patchSize + 2) {
    diffusionFill(base);
    return base.img;
  }

  // Pyramid depth: down until the hole is about one patch wide (keeping enough image around it).
  const extent = Math.max(bounds.w, bounds.h);
  const levels: Level[] = [base];
  while (
    extent / 2 ** (levels.length - 1) > opts.patchSize &&
    Math.min(w, h) / 2 ** levels.length >= 3 * opts.patchSize + 2
  ) {
    levels.push(downLevel(levels[levels.length - 1]));
  }

  const rng = new Rng(opts.seed);
  const L = levels.length;
  // Progress weights ∝ work (area × iterations).
  const work = levels.map((l, li) => l.w * l.h * emIterations(opts, li, L));
  const totalWork = work.reduce((a, b) => a + b, 0) || 1;
  let done = 0;

  let prev: LevelState | null = null;
  for (let li = L - 1; li >= 0; li--) {
    abortCheck(hooks);
    const level = prepareLevel(levels[li], r);
    const acc = new Float32Array(level.w * level.h * 3);
    const wsum = new Float32Array(level.w * level.h);
    const isFinest = li === 0;
    const noSource = level.validList.length === 0 || level.targets.length === 0;

    if (noSource) {
      // Nothing to copy from: keep a smooth membrane fill (upsampled from the coarser level if any).
      if (prev) upsampleImage(prev, level);
      diffusionFill(level, !!prev);
    } else {
      if (!prev || prev.validList.length === 0 || prev.targets.length === 0) {
        if (prev) upsampleImage(prev, level);
        diffusionFill(level, !!prev);
        randomInit(level, rng);
        computeAllDist(level, r);
      } else {
        upsampleNnf(prev, level, r, rng);
        vote(level, r, 1, true, acc, wsum);
        computeAllDist(level, r);
      }
      const heavy = level.targets.length > opts.maxWorkPixels;
      const em = heavy ? 0 : emIterations(opts, li, L);
      const passes = li === L - 1 ? 2 : level.targets.length > opts.maxWorkPixels / 3 ? 1 : 2;
      for (let it = 0; it < em; it++) {
        for (let pass = 0; pass < passes; pass++) {
          abortCheck(hooks);
          patchMatchPass(level, r, (it * passes + pass) % 2 === 0, rng, opts.searchCandidates);
        }
        const last = it === em - 1;
        vote(level, r, isFinest && last ? opts.sharpness : 1, false, acc, wsum);
        computeAllDist(level, r);
        hooks.onProgress?.(Math.min(0.99, (done + (work[li] * (it + 1)) / Math.max(em, 1)) / totalWork));
      }
      if (em === 0) vote(level, r, isFinest ? opts.sharpness : 1, false, acc, wsum);
    }
    done += work[li];
    hooks.onProgress?.(Math.min(0.99, done / totalWork));
    // Free the coarser level's buffers early (big regions).
    prev = level;
  }
  return (prev as LevelState).img;
}

function emIterations(opts: PatchMatchOptions, li: number, L: number): number {
  if (L <= 1) return opts.iterations;
  // Coarsest (li = L-1) gets `iterations`, finest about half (≥ 2).
  const t = li / (L - 1);
  return Math.max(2, Math.round(opts.iterations * (0.5 + 0.5 * t)));
}

/** Nearest-neighbour upsample of the coarse estimate into the fine level's hole (before diffusion). */
function upsampleImage(coarse: Level, fine: Level): void {
  const { w, h, img, hole } = fine;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!hole[i]) continue;
      const c = (Math.min(y >> 1, coarse.h - 1) * coarse.w + Math.min(x >> 1, coarse.w - 1)) * 3;
      img[i * 3] = coarse.img[c];
      img[i * 3 + 1] = coarse.img[c + 1];
      img[i * 3 + 2] = coarse.img[c + 2];
    }
  }
}

function abortCheck(hooks: PatchMatchHooks): void {
  if (hooks.isAborted?.()) throw new InpaintAbortError();
}

/** Re-exported for the worker-less fallback / tests. */
export { sampleBilinearRgba8 };
