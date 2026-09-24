/**
 * Colour statistics: Hasler–Süsstrunk colourfulness, mean saturation,
 * dominant hues and a few colour-class fractions (per image band) that the
 * scene classifier uses. Works on sRGB-encoded values like a viewer would
 * judge them. DOM-free.
 */
import type { WorkImage } from './buffer';
import { encodeSrgb } from './buffer';

export interface ClassFractions {
  /** foliage greens */
  green: number;
  /** sky/water blues */
  blue: number;
  /** saturated reds/oranges/yellows */
  warm: number;
  /** bright, nearly neutral (snow, white walls, overcast sky) */
  white: number;
  /** beige/sand */
  sand: number;
  /** skin-like hue & saturation (loose) */
  skin: number;
  /** very dark */
  dark: number;
}

export interface ColorStats {
  colorfulness: number;
  meanSaturation: number;
  dominantHues: { hue: number; weight: number }[];
  all: ClassFractions;
  /** top / middle / bottom thirds of the frame */
  bands: [ClassFractions, ClassFractions, ClassFractions];
  /** Encoded RGB planes (0..1) at the work resolution, reused by other analyses. */
  er: Float32Array;
  eg: Float32Array;
  eb: Float32Array;
}

const HUE_BINS = 36;

const emptyFractions = (): ClassFractions => ({ green: 0, blue: 0, warm: 0, white: 0, sand: 0, skin: 0, dark: 0 });

export function colorStats(img: WorkImage): ColorStats {
  const { r, g, b, width, height } = img;
  const n = r.length;
  const er = new Float32Array(n);
  const eg = new Float32Array(n);
  const eb = new Float32Array(n);
  let sRg = 0;
  let sYb = 0;
  let sRg2 = 0;
  let sYb2 = 0;
  let satSum = 0;
  let satCount = 0;
  const hueHist = new Float64Array(HUE_BINS);
  const hueVecX = new Float64Array(HUE_BINS);
  const hueVecY = new Float64Array(HUE_BINS);
  let chromaTotal = 0;
  const all = emptyFractions();
  const bands: [ClassFractions, ClassFractions, ClassFractions] = [emptyFractions(), emptyFractions(), emptyFractions()];
  const bandCount = [0, 0, 0];
  for (let y = 0; y < height; y++) {
    const band = Math.min(2, ((y * 3) / height) | 0);
    const bf = bands[band];
    bandCount[band] += width;
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const R = encodeSrgb(r[i]);
      const G = encodeSrgb(g[i]);
      const B = encodeSrgb(b[i]);
      er[i] = R;
      eg[i] = G;
      eb[i] = B;
      // Hasler & Süsstrunk (2003) on 0..255 values.
      const rg = (R - G) * 255;
      const yb = (0.5 * (R + G) - B) * 255;
      sRg += rg;
      sYb += yb;
      sRg2 += rg * rg;
      sYb2 += yb * yb;
      const mx = R > G ? (R > B ? R : B) : G > B ? G : B;
      const mn = R < G ? (R < B ? R : B) : G < B ? G : B;
      const d = mx - mn;
      const s = mx > 0 ? d / mx : 0;
      if (mx > 0.05) {
        satSum += s;
        satCount++;
      }
      let h = 0;
      if (d > 1e-6) {
        if (mx === R) h = ((G - B) / d) % 6;
        else if (mx === G) h = (B - R) / d + 2;
        else h = (R - G) / d + 4;
        h *= 60;
        if (h < 0) h += 360;
        const bin = Math.min(HUE_BINS - 1, (h / (360 / HUE_BINS)) | 0);
        hueHist[bin] += d;
        const a = (h * Math.PI) / 180;
        hueVecX[bin] += Math.cos(a) * d;
        hueVecY[bin] += Math.sin(a) * d;
        chromaTotal += d;
      }
      // Colour classes.
      let cls: keyof ClassFractions | null = null;
      if (mx < 0.12) cls = 'dark';
      else if (s < 0.1 && mx > 0.78) cls = 'white';
      else if (s > 0.18 && h >= 65 && h < 170 && mx > 0.12) cls = 'green';
      else if (s > 0.15 && h >= 180 && h < 255) cls = 'blue';
      else if (s > 0.14 && s < 0.5 && h >= 22 && h < 55 && mx > 0.5) cls = 'sand';
      else if (s > 0.4 && (h < 50 || h >= 340) && mx > 0.3) cls = 'warm';
      if (cls) {
        all[cls]++;
        bf[cls]++;
      }
      // Loose skin range overlaps with sand/warm on purpose (counted separately).
      if (h >= 5 && h <= 45 && s >= 0.2 && s <= 0.65 && mx > 0.3) {
        all.skin++;
        bf.skin++;
      }
    }
  }
  const norm = (f: ClassFractions, c: number) => {
    const inv = c > 0 ? 1 / c : 0;
    for (const k of Object.keys(f) as (keyof ClassFractions)[]) f[k] *= inv;
  };
  norm(all, n);
  bands.forEach((f, i) => norm(f, bandCount[i]));

  const mRg = sRg / n;
  const mYb = sYb / n;
  const vRg = Math.max(0, sRg2 / n - mRg * mRg);
  const vYb = Math.max(0, sYb2 / n - mYb * mYb);
  const colorfulness = Math.sqrt(vRg + vYb) + 0.3 * Math.sqrt(mRg * mRg + mYb * mYb);

  return {
    colorfulness: Math.round(colorfulness * 10) / 10,
    meanSaturation: satCount ? Math.round((satSum / satCount) * 1000) / 1000 : 0,
    dominantHues: dominantHues(hueHist, hueVecX, hueVecY, chromaTotal),
    all,
    bands,
    er,
    eg,
    eb,
  };
}

/** Peaks of the chroma-weighted hue histogram (circular), strongest first. */
function dominantHues(hist: Float64Array, vx: Float64Array, vy: Float64Array, total: number): { hue: number; weight: number }[] {
  if (total <= 0) return [];
  const sm = new Float64Array(HUE_BINS);
  for (let i = 0; i < HUE_BINS; i++) {
    const a = hist[(i + HUE_BINS - 1) % HUE_BINS];
    const c = hist[(i + 1) % HUE_BINS];
    sm[i] = 0.25 * a + 0.5 * hist[i] + 0.25 * c;
  }
  const peaks: { hue: number; weight: number }[] = [];
  for (let i = 0; i < HUE_BINS; i++) {
    const prev = sm[(i + HUE_BINS - 1) % HUE_BINS];
    const next = sm[(i + 1) % HUE_BINS];
    if (!(sm[i] > prev && sm[i] >= next)) continue;
    // Mass within ±2 bins (±20°) of the peak, and its circular mean hue.
    let mass = 0;
    let x = 0;
    let y = 0;
    for (let d = -2; d <= 2; d++) {
      const j = (i + d + HUE_BINS) % HUE_BINS;
      mass += hist[j];
      x += vx[j];
      y += vy[j];
    }
    const weight = mass / total;
    if (weight < 0.06) continue;
    let hue = (Math.atan2(y, x) * 180) / Math.PI;
    if (hue < 0) hue += 360;
    peaks.push({ hue: Math.round(hue), weight: Math.round(weight * 1000) / 1000 });
  }
  peaks.sort((a, b) => b.weight - a.weight);
  return peaks.slice(0, 4);
}
