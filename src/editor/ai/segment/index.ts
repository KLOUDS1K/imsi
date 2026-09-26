/**
 * AI segmentation entry point (contracts.SegmentModule).
 *
 * MediaPipe MagicTouch v2 runs on-device in a worker for subject/object-like
 * targets. The stronger 256 px classical pipeline remains as an offline and
 * unsupported-browser fallback, with edge-aware refinement at 768 px.
 */
import type { SegmentModule, SegmentOptions } from '../../contracts';
import type { AiMaskTarget, DetectedObject, MaskBitmap, PixelBuffer, Point } from '../../types';
import { grabCutLite } from './heuristic/grabcut';
import { crisp, guidedUpsample } from './heuristic/guided';
import { gaussBlur, normalize, prepare, toU8, type Img } from './heuristic/image';
import { binToFloat, components, fillHoles, openClose, threshold } from './heuristic/morph';
import { clothesCoarse, hairCoarse, personCoarse } from './heuristic/person';
import { saliency } from './heuristic/saliency';
import { detectFaces, ellipseMask, skinMask, skinProbability } from './heuristic/skin';
import { skyCoarse } from './heuristic/sky';
import { enableMl, mlStatus, segmentMl, type MlStroke } from './ml';

const COARSE = 256;
const FINE = 768;
let seq = 0;

interface Prepared {
  px: PixelBuffer;
  img: Img;
  fine: Img;
  skinBin?: Uint8Array;
  sal?: Float32Array;
  subject?: Float32Array;
}

const cache = new WeakMap<PixelBuffer, Prepared>();

function prep(px: PixelBuffer): Prepared {
  let p = cache.get(px);
  if (!p) {
    p = { px, img: prepare(px, COARSE), fine: prepare(px, FINE) };
    cache.set(px, p);
  }
  return p;
}

function skinOf(p: Prepared): Uint8Array {
  p.skinBin ??= skinMask(p.img, skinProbability(p.img));
  return p.skinBin;
}

function salOf(p: Prepared): Float32Array {
  p.sal ??= saliency(p.img, binToFloat(skinOf(p)));
  return p.sal;
}

function subjectOf(p: Prepared): Float32Array {
  if (p.subject) return p.subject;
  // Work on a copy: person/clothes detection reuses the original saliency map.
  const prior = normalize(salOf(p).slice(), 0.04, 0.985);
  const { w, h, n } = p.img;
  const hardFg = new Uint8Array(n);
  const hardBg = new Uint8Array(n);
  const border = Math.max(2, Math.round(Math.min(w, h) * 0.025));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const edge = x < border || y < border || x >= w - border || y >= h - border;
      if (prior[i]! >= 0.78) hardFg[i] = 1;
      if (edge && prior[i]! < 0.2) hardBg[i] = 1;
    }
  const q = grabCutLite(p.img, prior, { iterations: 7, priorWeight: 0.8, smooth: 2.7, hardFg, hardBg });
  const bin = openClose(threshold(q, 0.46), w, h, 1);
  const { labels, comps } = components(bin, w, h);
  if (!comps.length) return (p.subject = q);

  const ranked = comps.map((c) => {
    let sq = 0, sp = 0, borderPx = 0;
    for (let y = c.y0; y <= c.y1; y++)
      for (let x = c.x0; x <= c.x1; x++) {
        const i = y * w + x;
        if (labels[i] !== c.label) continue;
        sq += q[i]!;
        sp += prior[i]!;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) borderPx++;
      }
    const cx = c.sx / c.area / w - 0.5, cy = c.sy / c.area / h - 0.5;
    const centre = Math.max(0.25, 1 - Math.hypot(cx, cy) * 0.9);
    const edgePenalty = borderPx / Math.max(1, c.area) > 0.08 ? 0.7 : 1;
    return { c, score: c.area * (0.35 + sq / c.area + 0.45 * sp / c.area) * centre * edgePenalty };
  }).sort((a, b) => b.score - a.score);
  const best = ranked[0]!;
  const keep = new Set<number>();
  for (const r of ranked.slice(0, 6)) {
    if (r.c.area >= n * 0.002 && (r === best || (r.score >= best.score * 0.14 && r.c.area >= best.c.area * 0.08))) keep.add(r.c.label);
  }
  const selected = new Uint8Array(n);
  for (let i = 0; i < n; i++) selected[i] = keep.has(labels[i]!) || hardFg[i] ? 1 : 0;
  const filled = fillHoles(selected, w, h, n * 0.06);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = filled[i] ? Math.max(0.62, q[i]!) : 0;
  p.subject = gaussBlur(out, w, h, 0.7);
  return p.subject;
}

function fieldPoint(field: Float32Array, w: number, h: number, min = 0.3): Point | null {
  let sx = 0, sy = 0, sw = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = field[y * w + x]!;
      if (v < min) continue;
      const weight = (v - min) ** 2;
      sx += ((x + 0.5) / w) * weight;
      sy += ((y + 0.5) / h) * weight;
      sw += weight;
    }
  return sw > 1e-6 ? { x: sx / sw, y: sy / sw } : null;
}

const clampPoint = (p: Point): Point => ({ x: Math.max(0.002, Math.min(0.998, p.x)), y: Math.max(0.002, Math.min(0.998, p.y)) });

/** Generate model prompts from explicit selection or the improved local detector. */
function mlStrokesFor(target: AiMaskTarget, p: Prepared, opts: SegmentOptions): MlStroke[] | null {
  if (opts.box) {
    const x0 = opts.box.x, y0 = opts.box.y, x1 = x0 + opts.box.w, y1 = y0 + opts.box.h;
    return [
      { brushMode: 3, point: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }].map(clampPoint), isCompleted: true },
      { brushMode: 1, point: [clampPoint({ x: x0 + opts.box.w / 2, y: y0 + opts.box.h / 2 })], isCompleted: true },
    ];
  }
  let point = opts.point ? clampPoint(opts.point) : null;
  if (!point && target === 'sky') point = fieldPoint(skyCoarse(p.img), p.img.w, p.img.h, 0.5);
  if (!point && target === 'person') {
    const faces = detectFaces(p.img, skinOf(p)).sort((a, b) => b.a * b.b - a.a * a.b);
    if (faces[0]) point = clampPoint({ x: faces[0].cx / p.img.w, y: Math.min(0.98, (faces[0].cy + faces[0].a * 1.8) / p.img.h) });
  }
  if (!point && ['subject', 'background', 'person', 'object', 'motorcycle', 'car'].includes(target)) point = fieldPoint(subjectOf(p), p.img.w, p.img.h, 0.52);
  if (!point) return null;
  const strokes: MlStroke[] = [{ brushMode: 1, point: [point], isCompleted: true }];
  if (target !== 'sky') {
    const negatives = [{ x: 0.015, y: 0.015 }, { x: 0.985, y: 0.015 }, { x: 0.015, y: 0.985 }, { x: 0.985, y: 0.985 }]
      .filter((n) => Math.hypot(n.x - point!.x, n.y - point!.y) > 0.3);
    if (negatives.length) strokes.push({ brushMode: 2, point: negatives, isCompleted: true });
  } else {
    strokes.push({ brushMode: 2, point: [{ x: 0.5, y: 0.98 }], isCompleted: true });
  }
  return strokes;
}

function pointPrior(img: Img, opts: SegmentOptions): Float32Array {
  const { w, h } = img;
  const prior = new Float32Array(w * h);
  if (opts.box) {
    const { x, y, w: bw, h: bh } = opts.box;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const u = (i + 0.5) / w;
        const v = (j + 0.5) / h;
        const inside = u >= x && u <= x + bw && v >= y && v <= y + bh;
        // Centre-weighted inside the box, zero outside.
        prior[j * w + i] = inside ? 0.55 + 0.45 * (1 - Math.hypot((u - x - bw / 2) / (bw / 2 || 1), (v - y - bh / 2) / (bh / 2 || 1)) / 1.5) : 0;
      }
    }
  } else {
    const pt = opts.point ?? { x: 0.5, y: 0.5 };
    const s = 0.12;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const du = (i + 0.5) / w - pt.x;
        const dv = ((j + 0.5) / h - pt.y) * (h / w);
        prior[j * w + i] = Math.exp(-(du * du + dv * dv) / (2 * s * s));
      }
    }
  }
  return prior;
}

function coarseFor(target: AiMaskTarget, p: Prepared, opts: SegmentOptions): Float32Array {
  const { img } = p;
  const { w, h } = img;
  const faces = () => detectFaces(img, skinOf(p));
  switch (target) {
    case 'sky':
      return skyCoarse(img);
    case 'subject':
    case 'motorcycle':
    case 'car':
      return subjectOf(p);
    case 'background': {
      const s = subjectOf(p);
      const out = new Float32Array(s.length);
      for (let i = 0; i < s.length; i++) out[i] = 1 - s[i];
      return out;
    }
    case 'skin':
      return gaussBlur(binToFloat(skinOf(p)), w, h, 0.8);
    case 'face':
      return ellipseMask(w, h, faces());
    case 'person':
      return personCoarse(img, faces(), salOf(p), () => subjectOf(p));
    case 'hair': {
      const f = faces();
      return hairCoarse(img, f, skinOf(p), personCoarse(img, f, salOf(p), () => subjectOf(p)));
    }
    case 'clothes': {
      const f = faces();
      const person = personCoarse(img, f, salOf(p), () => subjectOf(p));
      const hair = hairCoarse(img, f, skinOf(p), person);
      return clothesCoarse(img, f, person, skinOf(p), hair);
    }
    case 'object': {
      const prior = pointPrior(img, opts);
      let hardBg: Uint8Array | undefined;
      if (opts.box) {
        hardBg = new Uint8Array(w * h);
        for (let i = 0; i < prior.length; i++) hardBg[i] = prior[i] > 0 ? 0 : 1;
      }
      return grabCutLite(img, prior, { hardBg, priorWeight: 0.7 });
    }
  }
}

function refine(coarse: Float32Array, p: Prepared, soft = false): MaskBitmap {
  const q = guidedUpsample(coarse, p.img, p.fine, 2, 1e-3);
  const out = soft ? q : crisp(q, 0.3, 0.7);
  return { width: p.fine.w, height: p.fine.h, data: toU8(out), key: `seg-${++seq}` };
}

export async function segmentHeuristic(target: AiMaskTarget, px: PixelBuffer, opts: SegmentOptions = {}): Promise<MaskBitmap> {
  // Yield once so a click handler can paint its "working" state first.
  await new Promise((r) => setTimeout(r, 0));
  if (opts.signal?.aborted) throw new DOMException('Segmentation cancelled', 'AbortError');
  const p = prep(px);
  return refine(coarseFor(target, p, opts), p, target === 'skin');
}

const ML_TARGETS = new Set<AiMaskTarget>(['subject', 'background', 'sky', 'person', 'object', 'motorcycle', 'car']);

export async function segment(target: AiMaskTarget, px: PixelBuffer, opts: SegmentOptions = {}): Promise<MaskBitmap> {
  const p = prep(px);
  if (ML_TARGETS.has(target)) {
    const strokes = mlStrokesFor(target, p, opts);
    if (strokes) {
      try {
        const ml = await segmentMl(px, strokes, opts.signal);
        if (ml) {
          let selected = 0;
          for (let i = 0; i < ml.data.length; i++) {
            let v = ml.data[i]! / 255;
            v = v * v * (3 - 2 * v);
            ml.data[i] = Math.round((target === 'background' ? 1 - v : v) * 255);
            if (ml.data[i]! >= 128) selected++;
          }
          const fraction = selected / Math.max(1, ml.data.length);
          if (fraction >= 0.001 && fraction <= 0.985) return ml;
          console.warn('[kloud] MediaPipe returned an implausible mask; using local fallback', { target, fraction });
        }
      } catch (error) {
        if (opts.signal?.aborted) throw error;
        console.warn('[kloud] MediaPipe segmentation unavailable; using local fallback', error);
      }
    }
  }
  return segmentHeuristic(target, px, opts);
}

/** Heuristic depth: vertical position prior, sky far, salient subject near. 0 = near … 255 = far. */
export async function estimateDepth(px: PixelBuffer): Promise<MaskBitmap> {
  const p = prep(px);
  const { w, h } = p.img;
  const sky = skyCoarse(p.img);
  const subj = subjectOf(p);
  const d = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    const vertical = 1 - j / Math.max(1, h - 1); // top of frame = far
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      let v = 0.15 + 0.7 * Math.pow(vertical, 1.2);
      v = v * (1 - sky[k]) + sky[k];
      v = v * (1 - 0.8 * subj[k]);
      d[k] = v;
    }
  }
  return refine(gaussBlur(d, w, h, 1.5), p, true);
}

export async function detectObjects(px: PixelBuffer): Promise<DetectedObject[]> {
  const p = prep(px);
  const { w, h } = p.img;
  const bin = threshold(subjectOf(p), 0.5);
  const { comps } = components(bin, w, h);
  return comps
    .filter((c) => c.area > w * h * 0.01)
    .sort((a, b) => b.area - a.area)
    .slice(0, 8)
    .map((c) => ({
      label: 'object',
      score: Math.min(1, c.area / (w * h * 0.2)),
      box: { x: c.x0 / w, y: c.y0 / h, w: (c.x1 - c.x0 + 1) / w, h: (c.y1 - c.y0 + 1) / h },
    }));
}

export async function enableMlBackend(): Promise<boolean> {
  return enableMl();
}

export function getSegmentationStatus(): { backend: string; ml: 'unavailable' | 'loading' | 'ready' | 'failed'; message?: string } {
  const status = mlStatus();
  return { backend: status.state === 'ready' ? 'MediaPipe MagicTouch v2' : 'enhanced local fallback', ml: status.state, message: status.message };
}

export const segmentModule = {
  segment,
  estimateDepth,
  detectObjects,
  enableMlBackend,
  getSegmentationStatus,
} satisfies SegmentModule;
