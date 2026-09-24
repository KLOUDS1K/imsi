/**
 * Output sharpening (Lightroom-style "Sharpen for Screen / Matte / Glossy",
 * amount Low / Standard / High): an unsharp mask on luminance only.
 *
 *   Y      = Rec.709-weighted luma of the ENCODED values (perceptual space — the
 *            same space the viewer judges edges in)
 *   detail = Y − Gaussian(Y, σ)
 *   delta  = amount · detail · coring(|detail|)
 *   R,G,B += delta            (same offset on all channels ⇒ chroma is untouched)
 *
 * σ grows with the output size: print targets need a larger radius because the
 * paper (matte ink spread > glossy) and the viewing distance both soften detail,
 * and a larger print is made of more pixels. Screen output stays near 0.5 px.
 *
 * Runs in horizontal bands with a (2k)-row halo so memory stays at a few MB even
 * for 24 MP+ images; the halo rows that the previous band already sharpened are
 * taken from that band's (pre-sharpening) luma buffer.
 */
import type { ExportSettings, RenderedImage } from '@/editor/types';

type Sharpening = ExportSettings['outputSharpening'];

interface Tuning {
  /** σ in px at the reference long edge. */
  radius: number;
  amount: Record<Sharpening['amount'], number>;
  /** Reference long edge and the clamp range for the size-proportional radius scale. */
  refEdge: number;
  scaleMin: number;
  scaleMax: number;
  /** Coring threshold (normalized luma) below which detail is attenuated (keeps noise/grain quiet). */
  threshold: number;
}

export const SHARPEN_TUNING: Record<Sharpening['target'], Tuning> = {
  screen: { radius: 0.6, amount: { low: 0.35, standard: 0.6, high: 0.95 }, refEdge: 2048, scaleMin: 0.75, scaleMax: 1.5, threshold: 0.004 },
  glossy: { radius: 0.9, amount: { low: 0.5, standard: 0.8, high: 1.2 }, refEdge: 3600, scaleMin: 0.6, scaleMax: 2.2, threshold: 0.003 },
  matte: { radius: 1.2, amount: { low: 0.7, standard: 1.1, high: 1.6 }, refEdge: 3600, scaleMin: 0.6, scaleMax: 2.2, threshold: 0.003 },
};

/** Effective σ (px) and amount for an output of the given size. */
export function sharpenParams(s: Sharpening, width: number, height: number): { sigma: number; amount: number; threshold: number } {
  const t = SHARPEN_TUNING[s.target] ?? SHARPEN_TUNING.screen;
  const scale = Math.min(t.scaleMax, Math.max(t.scaleMin, Math.max(width, height) / t.refEdge));
  return { sigma: t.radius * scale, amount: t.amount[s.amount] ?? t.amount.standard, threshold: t.threshold };
}

function gaussianKernel(sigma: number): Float32Array {
  const k = Math.max(1, Math.ceil(3 * sigma));
  const w = new Float32Array(2 * k + 1);
  let sum = 0;
  for (let i = -k; i <= k; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    w[i + k] = v;
    sum += v;
  }
  for (let i = 0; i < w.length; i++) w[i] /= sum;
  return w;
}

const BAND = 128;

export function applyOutputSharpening(img: RenderedImage, s: Sharpening): void {
  if (!s?.enabled) return;
  const { width: w, height: h, data } = img;
  if (w < 3 || h < 3 || data.length < w * h * 4) return;
  const { sigma, amount, threshold } = sharpenParams(s, w, h);
  if (amount <= 0 || sigma <= 0) return;

  const max = img.bitDepth === 16 ? 65535 : 255;
  const inv = 1 / max;
  const kernel = gaussianKernel(sigma);
  const k = (kernel.length - 1) >> 1;
  const cap = (BAND + 2 * k) * w;
  let luma = new Float32Array(cap);
  let prevLuma = new Float32Array(cap);
  const tmp = new Float32Array(cap);
  let prevYs = 0;
  const t2 = threshold * 2;
  // Uint16Array truncates on store (add 0.5 to round); Uint8ClampedArray already rounds.
  const bias = img.bitDepth === 16 ? 0.5 : 0;

  for (let y0 = 0; y0 < h; y0 += BAND) {
    const y1 = Math.min(h, y0 + BAND);
    const ys = Math.max(0, y0 - k);
    const ye = Math.min(h, y1 + k);

    // 1. luma rows [ys, ye): rows above y0 were already sharpened → reuse the previous buffer.
    for (let y = ys; y < ye; y++) {
      const lo = (y - ys) * w;
      if (y < y0) {
        luma.set(prevLuma.subarray((y - prevYs) * w, (y - prevYs + 1) * w), lo);
        continue;
      }
      let p = y * w * 4;
      for (let x = 0; x < w; x++, p += 4) luma[lo + x] = (0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]) * inv;
    }

    // 2. horizontal blur (edge-clamped)
    for (let y = ys; y < ye; y++) {
      const lo = (y - ys) * w;
      for (let x = 0; x < w; x++) {
        let acc = 0;
        for (let i = -k; i <= k; i++) {
          let xx = x + i;
          xx = xx < 0 ? 0 : xx >= w ? w - 1 : xx;
          acc += kernel[i + k] * luma[lo + xx];
        }
        tmp[lo + x] = acc;
      }
    }

    // 3. vertical blur + apply to rows [y0, y1)
    for (let y = y0; y < y1; y++) {
      const lo = (y - ys) * w;
      let p = y * w * 4;
      for (let x = 0; x < w; x++, p += 4) {
        let acc = 0;
        for (let i = -k; i <= k; i++) {
          let yy = y + i;
          yy = yy < 0 ? 0 : yy >= h ? h - 1 : yy;
          acc += kernel[i + k] * tmp[(yy - ys) * w + x];
        }
        const d = luma[lo + x] - acc;
        const ad = d < 0 ? -d : d;
        // Quadratic coring below 2·threshold: tiny (noise) detail is left almost alone.
        const core = ad >= t2 ? 1 : (ad / t2) * (ad / t2);
        let delta = amount * d * core;
        // Cap the halo overshoot so high amounts never produce hard clipped outlines.
        delta = delta > 0.2 ? 0.2 : delta < -0.2 ? -0.2 : delta;
        const dv = delta * max;
        for (let c = 0; c < 3; c++) {
          const v = data[p + c] + dv;
          // Uint8ClampedArray clamps itself; Uint16Array wraps, so clamp explicitly.
          data[p + c] = v < 0 ? 0 : v > max ? max : v + bias;
        }
      }
    }

    const t = prevLuma;
    prevLuma = luma;
    luma = t;
    prevYs = ys;
  }
}
