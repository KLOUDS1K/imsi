/**
 * Image analysis for KLOUD Studio: scopes, auto tone / white balance, scene
 * analysis and the rule-based "AI Auto Edit" (see contracts.AnalysisModule).
 * Everything except draw* is DOM-free.
 */
import type { AnalysisModule } from '../contracts';
import { createDefaultLocalAdjustments, createMask } from '../defaults';
import type { EditParams, ImageAnalysis, Mask, PartialParams, PhotoMeta, PixelBuffer, SceneLabel } from '../types';
import { buildLumaPlane, buildWorkImage } from './buffer';
import { colorStats } from './color-stats';
import { exposureStats, solveExposure, solveTone, toneInputsFromAnalysis } from './exposure';
import { computeHistogram } from './histogram';
import { detectLevelAngle, detectPerspective } from './level';
import { BLURRY_BELOW, gradientPlanes, noiseLevel, noiseSigma, recommendNoiseReduction, sharpnessRatio, sharpnessScore } from './noise';
import { computeSaliency } from './saliency';
import { drawHistogram, drawParade, drawVectorscope, drawWaveform } from './scopes';
import { detectSkin } from './skin';
import { detectSky } from './sky';
import { clamp01, gaussianBlur, labelComponents } from './stats';
import { estimateWhiteBalance } from './white-balance';

export { computeHistogram, detectLevelAngle, detectPerspective, drawHistogram, drawParade, drawVectorscope, drawWaveform, recommendNoiseReduction };

export interface BloomRecommendationInput {
  /** Linear-light 99th percentile from ImageAnalysis.exposure.p99. */
  p99: number;
  clippedHighlights: number;
  scene: SceneLabel;
}

export interface BloomRecommendation {
  bloom: number;
  bloomThreshold: number;
  bloomRadius: number;
}

/**
 * Conservative highlight-aware bloom starting point. A frame without a real
 * highlight gets no bloom instead of becoming hazy; night/city lights get a
 * wider spread while portraits stay restrained.
 */
export function recommendBloom(input: BloomRecommendationInput): BloomRecommendation {
  const finite = (v: number, fallback = 0) => Number.isFinite(v) ? v : fallback;
  const p99 = clamp01(finite(input.p99));
  const clipped = clamp01(finite(input.clippedHighlights));
  if (p99 < 0.16) return { bloom: 0, bloomThreshold: 55, bloomRadius: 50 };

  const thresholdLinear = Math.max(0.28, Math.min(0.88, p99 * 0.78));
  const bloomThreshold = Math.round(clamp01((thresholdLinear - 0.15) / 0.8) * 100);
  const luminousScene = input.scene === 'night' || input.scene === 'cityscape' || input.scene === 'sunset';
  const portrait = input.scene === 'portrait' || input.scene === 'group';
  let bloom = portrait ? 12 : luminousScene ? 26 : 18;
  if (p99 < 0.3) bloom -= 5;
  if (clipped > 0.02) bloom += Math.min(8, Math.round(clipped * 80));
  return {
    bloom: Math.max(0, Math.min(40, bloom)),
    bloomThreshold,
    bloomRadius: luminousScene ? 64 : portrait ? 42 : 52,
  };
}

const WORK = 512;

export function estimateNoise(px: PixelBuffer): { level: number; sigma: number } {
  const sigma = noiseSigma(buildLumaPlane(px, 1024));
  return { sigma, level: noiseLevel(sigma) };
}

export function estimateSharpness(px: PixelBuffer): { score: number; blurry: boolean } {
  const plane = buildLumaPlane(px, 1024);
  const sigma = noiseSigma(plane);
  const score = sharpnessScore(sharpnessRatio(gradientPlanes(plane), sigma).ratio);
  return { score, blurry: score < BLURRY_BELOW };
}

/** Rule-based scene label (exported for tests). */
export function classifyScene(
  meta: PhotoMeta | undefined,
  exp: ReturnType<typeof exposureStats>,
  sky: ReturnType<typeof detectSky>,
  skin: ReturnType<typeof detectSkin>,
  col: ReturnType<typeof colorStats>,
  sharp: number,
): { label: SceneLabel; confidence: number; tags: string[] } {
  const tags: string[] = [];
  const faceBlobs = skin.blobs.filter((b) => b.faceLike);
  const faces = faceBlobs.length;
  // A portrait needs a face that is a real part of the frame; tiny skin-toned
  // blobs are usually lamps, windows or distant people (tagged, not labelled).
  const portraitFace = faceBlobs.some((b) => b.area >= 0.008);
  const groupFaces = faceBlobs.filter((b) => b.area >= 0.003).length;
  const night = exp.medianLum < 0.035 && ((meta?.shutter ?? 0) >= 1 / 30 || (meta?.iso ?? 0) >= 1600 || exp.meanLum < 0.03);
  if (night) tags.push('low light');
  if (sky.present) tags.push(`${sky.kind} sky`);
  if (faces) tags.push(faces > 1 ? `${faces} people` : 'person');
  if (col.all.green > 0.2) tags.push('foliage');
  if (col.all.white > 0.35 && exp.medianLum > 0.35) tags.push('snow/bright');
  let label: SceneLabel = 'general';
  let confidence = 0.4;
  if (groupFaces >= 2) [label, confidence] = ['group', 0.7];
  else if (portraitFace || skin.fraction > 0.12) [label, confidence] = ['portrait', 0.65];
  else if (night) [label, confidence] = ['night', 0.75];
  else if (sky.present && sky.kind === 'sunset') [label, confidence] = ['sunset', 0.7];
  else if (col.all.white > 0.35 && exp.medianLum > 0.35) [label, confidence] = ['snow', 0.55];
  else if (sky.present && col.all.sand > 0.15) [label, confidence] = ['beach', 0.55];
  else if (sky.present && col.all.green > 0.12) [label, confidence] = ['landscape', 0.7];
  else if (sky.present) [label, confidence] = ['cityscape', 0.45];
  else if (sharp > 55 && col.all.warm > 0.35) [label, confidence] = ['food', 0.35];
  else if (!sky.present && exp.medianLum < 0.2) [label, confidence] = ['indoor', 0.4];
  return { label, confidence, tags };
}

export function analyzeImage(px: PixelBuffer, meta?: PhotoMeta): ImageAnalysis {
  const img = buildWorkImage(px, WORK);
  const exp = exposureStats(img);
  const col = colorStats(img);
  const wb = estimateWhiteBalance(img);
  const sky = detectSky(col.er, col.eg, col.eb, img.width, img.height);
  const skin = detectSkin(col.er, col.eg, col.eb, img.width, img.height);
  const sal = computeSaliency(img, col.er, col.eg, col.eb, skin.blobs);
  const plane = buildLumaPlane(px, 1024);
  const sigma = noiseSigma(plane);
  const nLevel = noiseLevel(sigma, meta?.iso);
  const sharp = sharpnessScore(sharpnessRatio(gradientPlanes(plane), sigma).ratio);
  const scene = classifyScene(meta, exp, sky, skin, col, sharp);
  const notes: string[] = [];
  // Night / low-key scenes are dark on purpose: don't call them underexposed.
  const lowKey = scene.label === 'night' && exp.verdict === 'under';
  if (lowKey) notes.push('Low-key night scene: kept dark, only shadows and noise are handled.');
  else if (exp.verdict === 'under') notes.push(`Underexposed by about ${Math.abs(exp.evOffset).toFixed(1)} EV.`);
  if (exp.verdict === 'over') notes.push(`Overexposed by about ${Math.abs(exp.evOffset).toFixed(1)} EV.`);
  if (exp.clipHigh > 0.01) notes.push(`${(exp.clipHigh * 100).toFixed(1)}% of pixels are clipped highlights.`);
  if (exp.clipLow > 0.02) notes.push(`${(exp.clipLow * 100).toFixed(1)}% of pixels are crushed blacks.`);
  if (wb.confidence > 0.4 && (Math.abs(wb.temperature) > 12 || Math.abs(wb.tint) > 12)) notes.push(wb.castDescription);
  if (nLevel > 45) notes.push('Visible noise: noise reduction recommended.');
  if (sharp < BLURRY_BELOW) notes.push('The image looks soft or out of focus.');
  if (sky.present) notes.push(`Sky covers ${Math.round(sky.fraction * 100)}% of the frame.`);
  return {
    exposure: { meanLum: exp.meanLum, medianLum: exp.medianLum, p01: exp.p01, p99: exp.p99, evOffset: exp.evOffset, verdict: lowKey ? 'ok' : exp.verdict },
    dynamicRange: { stops: exp.stops, clippedHighlights: exp.clipHigh, clippedShadows: exp.clipLow, contrast: exp.rmsContrast },
    whiteBalance: { temperature: wb.temperature, tint: wb.tint, confidence: wb.confidence, castDescription: wb.castDescription },
    color: { colorfulness: col.colorfulness, meanSaturation: col.meanSaturation, dominantHues: col.dominantHues },
    noise: { level: nLevel, sigma },
    sharpness: { score: sharp, blurry: sharp < BLURRY_BELOW },
    subject: { box: sal.box, confidence: sal.confidence },
    background: { clutter: clamp01(sal.outside), brightnessDelta: sal.inside - sal.outside },
    sky: { fraction: sky.fraction, present: sky.present, box: sky.box },
    scene,
    notes,
  };
}

export function autoExposure(px: PixelBuffer): number {
  return solveExposure(toneInputsFromAnalysis(analyzeImage(px)));
}

export function autoTone(px: PixelBuffer) {
  return solveTone(toneInputsFromAnalysis(analyzeImage(px)));
}

export function autoWhiteBalance(px: PixelBuffer): { temperature: number; tint: number } {
  const wb = estimateWhiteBalance(buildWorkImage(px, WORK));
  return { temperature: wb.temperature, tint: wb.tint };
}

const r0 = (v: number) => Math.round(v);
const r2 = (v: number) => Math.round(v * 100) / 100;

export function generateAutoEdit(
  a: ImageAnalysis,
  meta?: PhotoMeta,
  opts: { strength?: number; idFactory?: () => string } = {},
): PartialParams {
  const k = (opts.strength ?? 100) / 100;
  let n = 0;
  const id = opts.idFactory ?? (() => `auto-${Date.now().toString(36)}-${n++}`);
  const tone = solveTone(toneInputsFromAnalysis(a));
  const scene = a.scene.label;
  if (scene === 'night') {
    // Keep the mood: a modest lift instead of normalising the histogram to daylight.
    tone.exposure = Math.min(tone.exposure, 0.8);
    tone.shadows = Math.min(tone.shadows, 25);
    tone.blacks = Math.min(tone.blacks, 0);
  }
  const out: PartialParams = {
    basic: {
      exposure: r2(tone.exposure * k),
      contrast: r0(tone.contrast * k),
      highlights: r0(tone.highlights * k),
      shadows: r0(tone.shadows * k),
      whites: r0(tone.whites * k),
      blacks: r0(tone.blacks * k),
    },
    color: { vibrance: r0(tone.vibrance * k), saturation: r0(tone.saturation * k) },
  };
  if (a.whiteBalance.confidence > 0.3) {
    const w = Math.min(1, a.whiteBalance.confidence) * k;
    out.whiteBalance = { mode: 'auto', temperature: r0(a.whiteBalance.temperature * w), tint: r0(a.whiteBalance.tint * w) };
  }
  const presence = { texture: 0, clarity: 0, dehaze: 0 };
  const hsl: NonNullable<PartialParams['hsl']> = {};
  if (scene === 'landscape' || scene === 'beach' || scene === 'cityscape') {
    presence.clarity = 12;
    presence.texture = 8;
    hsl.blue = { saturation: 8, luminance: -10 };
    hsl.green = { hue: 6, saturation: -5 };
    hsl.aqua = { saturation: 6 };
  } else if (scene === 'portrait' || scene === 'group') {
    presence.texture = -10;
    presence.clarity = -4;
    hsl.orange = { saturation: -6, luminance: 8 };
    hsl.red = { saturation: -4 };
  } else if (scene === 'sunset') {
    hsl.orange = { saturation: 12 };
    hsl.red = { saturation: 8 };
    hsl.yellow = { saturation: 6 };
  } else if (scene === 'night') {
    presence.clarity = 8;
    presence.dehaze = 6;
  }
  if (a.dynamicRange.contrast < 0.14 && a.sky.present) presence.dehaze = Math.max(presence.dehaze, 10);
  out.presence = { texture: r0(presence.texture * k), clarity: r0(presence.clarity * k), dehaze: r0(presence.dehaze * k) };
  if (Object.keys(hsl).length) {
    const scaled: NonNullable<PartialParams['hsl']> = {};
    for (const [ch, v] of Object.entries(hsl)) {
      scaled[ch as keyof typeof hsl] = Object.fromEntries(Object.entries(v ?? {}).map(([kk, vv]) => [kk, r0((vv as number) * k)]));
    }
    out.hsl = scaled;
  }
  if (a.dynamicRange.contrast < 0.16) {
    const s = 0.035 * k;
    out.toneCurve = { rgb: [{ x: 0, y: 0 }, { x: 0.25, y: 0.25 - s }, { x: 0.75, y: 0.75 + s }, { x: 1, y: 1 }] };
  }
  const nl = a.noise.level;
  out.noise = { luminance: r0(Math.max(0, nl - 25) * 0.6 * k), color: r0(Math.min(40, 10 + nl * 0.3) * k) };
  if (nl > 65) out.noise = { ...out.noise, aiDenoise: true, aiDenoiseStrength: r0(Math.min(80, nl) * k) };
  out.detail = { sharpenAmount: r0((a.sharpness.blurry ? 55 : 35) * k), sharpenMasking: nl > 40 ? 40 : 15 };

  const masks: Mask[] = [];
  if (a.subject.confidence > 0.35 && scene !== 'landscape') {
    const m = createMask('Subject', id());
    m.components = [{ id: id(), kind: 'ai', mode: 'add', invert: false, ai: { target: 'subject' } }];
    m.adjustments = { ...createDefaultLocalAdjustments(), exposure: r2(0.15 * k), clarity: r0(8 * k) };
    masks.push(m);
    if (scene === 'portrait' || scene === 'group' || scene === 'general') {
      const b = createMask('Background', id());
      b.components = [{ id: id(), kind: 'ai', mode: 'add', invert: false, ai: { target: 'background' } }];
      b.adjustments = { ...createDefaultLocalAdjustments(), exposure: r2(-0.15 * k), texture: r0(-10 * k) };
      masks.push(b);
    }
  }
  if (a.sky.present && a.sky.fraction > 0.08) {
    const s = createMask('Sky', id());
    s.components = [{ id: id(), kind: 'ai', mode: 'add', invert: false, ai: { target: 'sky' } }];
    s.adjustments = { ...createDefaultLocalAdjustments(), highlights: r0(-25 * k), dehaze: r0(12 * k), saturation: r0(10 * k) };
    masks.push(s);
  }
  if (masks.length) out.masks = masks;
  void meta;
  return out;
}

/**
 * Sensor dust: small, dark, roughly round blobs on smooth areas
 * (difference of Gaussians on luminance + local flatness + size/shape tests).
 */
export function detectDust(px: PixelBuffer, sensitivity = 50): { x: number; y: number; radius: number; score: number }[] {
  const plane = buildLumaPlane(px, 1024);
  const { width: w, height: h, data } = plane;
  const fine = gaussianBlur(data, w, h, 1.2);
  const coarse = gaussianBlur(data, w, h, 6);
  const wide = gaussianBlur(data, w, h, 14);
  const sq = new Float32Array(w * h);
  for (let i = 0; i < sq.length; i++) {
    const d = data[i] - wide[i];
    sq[i] = d * d;
  }
  const localVar = gaussianBlur(sq, w, h, 10);
  const thr = 0.018 * (1.5 - Math.min(100, Math.max(0, sensitivity)) / 100);
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) {
    const dog = coarse[i] - fine[i]; // positive when the pixel is darker than its surroundings
    if (dog > thr && localVar[i] < 0.0025 && coarse[i] > 0.12) mask[i] = 1;
  }
  const { comps } = labelComponents(mask, w, h);
  const long = Math.max(w, h);
  const out: { x: number; y: number; radius: number; score: number }[] = [];
  for (const c of comps) {
    const bw = c.x1 - c.x0 + 1;
    const bh = c.y1 - c.y0 + 1;
    if (c.area < 3 || c.area > long * long * 0.0008) continue;
    const aspect = Math.max(bw, bh) / Math.max(1, Math.min(bw, bh));
    const fill = c.area / (bw * bh);
    if (aspect > 2.2 || fill < 0.45) continue;
    const cx = c.cx + 0.5;
    const cy = c.cy + 0.5;
    const i = Math.min(h - 1, Math.round(cy)) * w + Math.min(w - 1, Math.round(cx));
    const score = Math.min(1, (coarse[i] - fine[i]) / (thr * 3)) * fill;
    out.push({ x: cx / w, y: cy / h, radius: (Math.max(bw, bh) / 2 + 1) / long, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 60);
}

export const analysisModule = {
  computeHistogram,
  drawHistogram,
  drawWaveform,
  drawParade,
  drawVectorscope,
  analyzeImage,
  autoExposure,
  autoTone,
  autoWhiteBalance,
  generateAutoEdit,
  detectLevelAngle,
  detectPerspective,
  detectDust,
  estimateNoise,
  estimateSharpness,
} satisfies AnalysisModule;

export type { EditParams };
