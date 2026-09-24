/**
 * Skin-tone blobs (a classical stand-in for face detection). DOM-free.
 *
 * Pixels are classified with the Chai & Ngan YCbCr skin box plus a
 * red-dominance check, on a ≤ 128 px grid. Connected blobs that are compact,
 * roughly face-shaped (taller than wide, but not a strip) and smooth are
 * flagged `faceLike`. This is a heuristic — it has no idea what a face looks
 * like beyond colour, shape and texture.
 */
import type { Rect } from '@/editor/types';
import { downscalePlane, fitSize } from './buffer';
import { labelComponents, round2 } from './stats';

export interface SkinBlob {
  box: Rect;
  /** Fraction of the frame. */
  area: number;
  /** Area / bounding-box area. */
  fill: number;
  faceLike: boolean;
}

export interface SkinResult {
  blobs: SkinBlob[];
  /** Fraction of the frame classified as skin. */
  fraction: number;
}

export function detectSkin(er: Float32Array, eg: Float32Array, eb: Float32Array, w0: number, h0: number): SkinResult {
  const { width: w, height: h } = fitSize(w0, h0, 128);
  const R = downscalePlane(er, w0, h0, w, h);
  const G = downscalePlane(eg, w0, h0, w, h);
  const B = downscalePlane(eb, w0, h0, w, h);
  const n = w * h;
  const mask = new Uint8Array(n);
  const luma = new Float32Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const r = R[i] * 255;
    const g = G[i] * 255;
    const b = B[i] * 255;
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    luma[i] = y / 255;
    if (y > 45 && y < 245 && cb >= 77 && cb <= 127 && cr >= 135 && cr <= 173 && r > g && g >= b * 0.85 && r - b > 18) {
      mask[i] = 1;
      count++;
    }
  }
  // Close 1-px holes (eyes, specular highlights) with a 3×3 majority vote.
  const closed = new Uint8Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (mask[i]) {
        closed[i] = 1;
        continue;
      }
      let s = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += mask[i + dy * w + dx];
      closed[i] = s >= 6 ? 1 : 0;
    }
  }
  const { labels, comps } = labelComponents(closed, w, h);
  // Mean absolute luma gradient per blob (skin is smooth).
  const grad = new Float64Array(comps.length + 1);
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const i = y * w + x;
      const l = labels[i];
      if (l) grad[l] += Math.abs(luma[i + 1] - luma[i]) + Math.abs(luma[i + w] - luma[i]);
    }
  }
  const blobs: SkinBlob[] = [];
  for (const c of comps) {
    const area = c.area / n;
    if (area < 0.0015) continue;
    const bw = c.x1 - c.x0 + 1;
    const bh = c.y1 - c.y0 + 1;
    const fill = c.area / (bw * bh);
    // Aspect in true proportions (grid pixels are square).
    const aspect = bh / bw;
    const smooth = grad[c.label] / c.area < 0.07;
    const touchesSides = c.x0 === 0 && c.x1 === w - 1;
    const faceLike = area >= 0.002 && area <= 0.3 && fill >= 0.45 && aspect >= 0.75 && aspect <= 2.2 && smooth && !touchesSides;
    blobs.push({
      box: { x: round2(c.x0 / w), y: round2(c.y0 / h), w: round2(bw / w), h: round2(bh / h) },
      area,
      fill,
      faceLike,
    });
  }
  blobs.sort((a, b) => b.area - a.area);
  return { blobs: blobs.slice(0, 12), fraction: count / n };
}
