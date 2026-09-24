/**
 * White-balance cast estimation.
 *
 * Four classical illuminant estimators are computed in log-chroma space
 * (u = log(R/G), v = log(B/G), linear light) and fused:
 *
 *  1. Grey-world — mean of all well-exposed pixels.
 *  2. White-patch — mean of the brightest non-clipped 2 %.
 *  3. Grey-edge (1st order, van de Weijer et al.) — mean absolute gradient
 *     per channel; robust to large uniformly coloured areas.
 *  4. Achromatic cluster — the densest cluster of pixels near the
 *     Planckian-ish locus in a (u, v) histogram. Real grey/white surfaces
 *     all share the illuminant colour, so they pile up in one bin, whereas
 *     coloured surfaces spread out.
 *
 * The fused neutral is turned into slider values with
 * `tempTintFromNeutral` (color/math.ts), i.e. the correction that makes that
 * neutral grey through `wbGains`.
 */
import type { RGB } from '@/editor/types';
import { tempTintFromNeutral } from '@/editor/color/math';
import type { WorkImage } from './buffer';
import { clamp01, round1 } from './stats';

export interface WhiteBalanceEstimate {
  temperature: number;
  tint: number;
  confidence: number;
  castDescription: string;
  /** Estimated linear RGB of a neutral surface (G = 1). */
  neutral: RGB;
}

interface Chroma {
  u: number;
  v: number;
  w: number;
}

const HB = 64; // achromatic histogram bins per axis
const HR = 1.6; // histogram half-range in log units

function fromSums(r: number, g: number, b: number, w: number): Chroma | null {
  if (r <= 0 || g <= 0 || b <= 0) return null;
  return { u: Math.log(r / g), v: Math.log(b / g), w };
}

export function estimateWhiteBalance(img: WorkImage): WhiteBalanceEstimate {
  const { r, g, b, lum, width, height } = img;
  const n = r.length;
  const valid = new Uint8Array(n);
  let nValid = 0;
  for (let i = 0; i < n; i++) {
    const mx = Math.max(r[i], g[i], b[i]);
    if (lum[i] > 0.008 && mx < 0.97 && Math.min(r[i], g[i], b[i]) > 1e-4) {
      valid[i] = 1;
      nValid++;
    }
  }
  if (nValid < 32) {
    return { temperature: 0, tint: 0, confidence: 0, castDescription: 'Not enough usable pixels', neutral: [1, 1, 1] };
  }

  const ests: Chroma[] = [];

  // 1. Grey-world.
  let sr = 0;
  let sg = 0;
  let sb = 0;
  for (let i = 0; i < n; i++) {
    if (!valid[i]) continue;
    sr += r[i];
    sg += g[i];
    sb += b[i];
  }
  const gw = fromSums(sr, sg, sb, 1);
  if (gw) ests.push(gw);

  // 2. White-patch: brightest 2 % of valid pixels (by luminance).
  const lumHist = new Float64Array(512);
  for (let i = 0; i < n; i++) if (valid[i]) lumHist[Math.min(511, (lum[i] * 511) | 0)]++;
  let acc = 0;
  let thrBin = 511;
  for (; thrBin > 0; thrBin--) {
    acc += lumHist[thrBin];
    if (acc >= nValid * 0.02) break;
  }
  const thr = thrBin / 511;
  sr = sg = sb = 0;
  for (let i = 0; i < n; i++) {
    if (!valid[i] || lum[i] < thr) continue;
    sr += r[i];
    sg += g[i];
    sb += b[i];
  }
  // Bright patches are only informative when they are reasonably bright.
  const wp = fromSums(sr, sg, sb, thr > 0.25 ? 0.8 : 0.3);
  if (wp) ests.push(wp);

  // 3. Grey-edge: mean |∇| per channel (forward differences).
  sr = sg = sb = 0;
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const i = y * width + x;
      if (!valid[i]) continue;
      const j = i + 1;
      const k = i + width;
      sr += Math.abs(r[j] - r[i]) + Math.abs(r[k] - r[i]);
      sg += Math.abs(g[j] - g[i]) + Math.abs(g[k] - g[i]);
      sb += Math.abs(b[j] - b[i]) + Math.abs(b[k] - b[i]);
    }
  }
  const ge = fromSums(sr, sg, sb, 1.1);
  if (ge) ests.push(ge);

  // 4. Achromatic cluster in (u, v).
  const hist = new Float32Array(HB * HB);
  const toBin = (t: number) => Math.round(((t + HR) / (2 * HR)) * (HB - 1));
  for (let i = 0; i < n; i++) {
    if (!valid[i]) continue;
    const u = Math.log(r[i] / g[i]);
    const v = Math.log(b[i] / g[i]);
    if (u < -HR || u > HR || v < -HR || v > HR) continue;
    // Brighter pixels have a better SNR and are more likely to be surfaces lit by the main light.
    hist[toBin(v) * HB + toBin(u)] += Math.sqrt(lum[i]);
  }
  let best = -1;
  let bestVal = 0;
  let total = 0;
  for (let i = 0; i < hist.length; i++) total += hist[i];
  const binW = (2 * HR) / (HB - 1);
  for (let by = 1; by < HB - 1; by++) {
    const v = -HR + by * binW;
    for (let bx = 1; bx < HB - 1; bx++) {
      const u = -HR + bx * binW;
      // Plausible illuminants lie roughly along u ≈ -v (warm ↔ cool) with a
      // limited green/magenta excursion; weight the search accordingly.
      const offLocus = Math.abs(u + v) / Math.SQRT2;
      const along = Math.abs(u - v) / Math.SQRT2;
      if (along > 1.3) continue;
      const prior = Math.exp(-(offLocus * offLocus) / (2 * 0.18 * 0.18));
      let s = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += hist[(by + dy) * HB + bx + dx];
      s *= prior;
      if (s > bestVal) {
        bestVal = s;
        best = by * HB + bx;
      }
    }
  }
  let support = 0;
  if (best >= 0 && total > 0) {
    const bx = best % HB;
    const by = (best - bx) / HB;
    let su = 0;
    let sv = 0;
    let sw = 0;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const yy = by + dy;
        const xx = bx + dx;
        if (yy < 0 || xx < 0 || yy >= HB || xx >= HB) continue;
        const wgt = hist[yy * HB + xx];
        su += wgt * (-HR + xx * binW);
        sv += wgt * (-HR + yy * binW);
        sw += wgt;
      }
    }
    support = sw / total;
    if (sw > 0) ests.push({ u: su / sw, v: sv / sw, w: 3 * clamp01(support / 0.15) });
  }

  // Fuse: weighted mean, then one re-weighting pass that down-weights
  // estimators far from the consensus.
  let fu = 0;
  let fv = 0;
  let fw = 0;
  for (const e of ests) {
    fu += e.u * e.w;
    fv += e.v * e.w;
    fw += e.w;
  }
  fu /= fw;
  fv /= fw;
  let u2 = 0;
  let v2 = 0;
  let w2 = 0;
  let spread = 0;
  for (const e of ests) {
    const d2 = (e.u - fu) ** 2 + (e.v - fv) ** 2;
    const w = e.w * Math.exp(-d2 / (2 * 0.2 * 0.2));
    u2 += e.u * w;
    v2 += e.v * w;
    w2 += w;
    spread += e.w * d2;
  }
  if (w2 > 0) {
    fu = u2 / w2;
    fv = v2 / w2;
  }
  spread = Math.sqrt(spread / fw);
  const neutral: RGB = [Math.exp(fu), 1, Math.exp(fv)];
  const tt = tempTintFromNeutral(neutral);
  const agreement = Math.exp(-(spread * spread) / (2 * 0.12 * 0.12));
  const confidence = clamp01(agreement * (0.55 + 0.45 * clamp01(support / 0.1)));
  const temperature = round1(tt.temperature);
  const tint = round1(tt.tint);
  return { temperature, tint, confidence: Math.round(confidence * 100) / 100, castDescription: describeCast(temperature, tint), neutral };
}

/**
 * Human description of the cast. `temperature/tint` are the CORRECTION
 * values: a negative temperature cools the image, i.e. it currently looks warm.
 */
export function describeCast(temperature: number, tint: number): string {
  let s: string;
  if (temperature <= -40) s = 'Strong warm cast (tungsten?)';
  else if (temperature <= -15) s = 'Warm cast (tungsten?)';
  else if (temperature <= -7) s = 'Slightly warm';
  else if (temperature >= 35) s = 'Strong cool cast (shade or overcast?)';
  else if (temperature >= 15) s = 'Cool cast (shade?)';
  else if (temperature >= 7) s = 'Slightly cool';
  else s = '';
  let t = '';
  if (tint >= 20) t = 'green tint (fluorescent?)';
  else if (tint >= 8) t = 'slight green tint';
  else if (tint <= -20) t = 'magenta tint';
  else if (tint <= -8) t = 'slight magenta tint';
  if (!s && !t) return 'Neutral';
  if (!s) return t[0].toUpperCase() + t.slice(1);
  return t ? `${s} with a ${t}` : s;
}
