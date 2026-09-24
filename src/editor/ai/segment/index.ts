/**
 * AI segmentation entry point (contracts.SegmentModule).
 *
 * This prototype ships the classical (heuristic) backend: coarse masks at
 * ~160 px from colour / saliency / skin / sky cues, refined to crisp edges by
 * guided upsampling against a 512 px guide image. Masks are honest
 * approximations — no trained model is bundled.
 */
import type { SegmentModule, SegmentOptions } from '../../contracts';
import type { AiMaskTarget, DetectedObject, MaskBitmap, PixelBuffer } from '../../types';
import { grabCutLite } from './heuristic/grabcut';
import { crisp, guidedUpsample } from './heuristic/guided';
import { gaussBlur, normalize, prepare, toU8, type Img } from './heuristic/image';
import { binToFloat, components, threshold } from './heuristic/morph';
import { clothesCoarse, hairCoarse, personCoarse } from './heuristic/person';
import { saliency } from './heuristic/saliency';
import { detectFaces, ellipseMask, skinMask, skinProbability } from './heuristic/skin';
import { skyCoarse } from './heuristic/sky';

const COARSE = 160;
const FINE = 512;
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
  if (!p.subject) p.subject = grabCutLite(p.img, normalize(salOf(p), 0.05, 0.98));
  return p.subject;
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

export async function segment(target: AiMaskTarget, px: PixelBuffer, opts: SegmentOptions = {}): Promise<MaskBitmap> {
  // Yield once so a click handler can paint its "working" state first.
  await new Promise((r) => setTimeout(r, 0));
  if (opts.signal?.aborted) throw new DOMException('Segmentation cancelled', 'AbortError');
  const p = prep(px);
  return refine(coarseFor(target, p, opts), p, target === 'skin');
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

let mlState: 'unavailable' | 'loading' | 'ready' | 'failed' = 'unavailable';
let mlMessage = 'Using on-device heuristic segmentation (no ML model bundled).';

export async function enableMlBackend(): Promise<boolean> {
  mlState = 'failed';
  mlMessage = 'ML models are not bundled in this prototype; heuristic segmentation stays active.';
  return false;
}

export function getSegmentationStatus(): { backend: string; ml: 'unavailable' | 'loading' | 'ready' | 'failed'; message?: string } {
  return { backend: 'heuristic', ml: mlState, message: mlMessage };
}

export const segmentModule = {
  segment,
  estimateDepth,
  detectObjects,
  enableMlBackend,
  getSegmentationStatus,
} satisfies SegmentModule;
