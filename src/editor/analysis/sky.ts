/**
 * Sky detection. DOM-free.
 *
 * Sky = a region connected to the top edge, made of smooth (low-texture)
 * pixels that are bright and blue-ish, overcast white, or (near the top half)
 * warm sunset colours, grown from the top row while neighbouring colours
 * stay close. Works on a ≤ 128 px grid.
 */
import type { Rect } from '@/editor/types';
import { downscalePlane, fitSize } from './buffer';
import { boxBlur, round2 } from './stats';

export interface SkyResult {
  fraction: number;
  present: boolean;
  box: Rect | null;
  /** Dominant kind of the detected sky. */
  kind: 'blue' | 'overcast' | 'sunset' | 'none';
  /** Fraction of the sky region that is warm/saturated (sunset colours). */
  warm: number;
  /** Mean perceptual brightness of the sky region. */
  brightness: number;
}

const CLASS_BLUE = 1;
const CLASS_WHITE = 2;
const CLASS_WARM = 3;

export function detectSky(er: Float32Array, eg: Float32Array, eb: Float32Array, w0: number, h0: number): SkyResult {
  const { width: w, height: h } = fitSize(w0, h0, 128);
  const R = downscalePlane(er, w0, h0, w, h);
  const G = downscalePlane(eg, w0, h0, w, h);
  const B = downscalePlane(eb, w0, h0, w, h);
  const n = w * h;
  const luma = new Float32Array(n);
  for (let i = 0; i < n; i++) luma[i] = 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i];
  // Texture: local mean of |∇luma|.
  const grad = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const dx = x < w - 1 ? luma[i + 1] - luma[i] : 0;
      const dy = y < h - 1 ? luma[i + w] - luma[i] : 0;
      grad[i] = Math.abs(dx) + Math.abs(dy);
    }
  }
  const tex = boxBlur(grad, w, h, 1);
  const cls = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (tex[i] > 0.045) continue;
      const r = R[i];
      const g = G[i];
      const b = B[i];
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      const s = mx > 0 ? (mx - mn) / mx : 0;
      let hue = 0;
      const d = mx - mn;
      if (d > 1e-6) {
        if (mx === r) hue = ((g - b) / d) % 6;
        else if (mx === g) hue = (b - r) / d + 2;
        else hue = (r - g) / d + 4;
        hue *= 60;
        if (hue < 0) hue += 360;
      }
      if (hue >= 175 && hue <= 260 && s >= 0.08 && mx > 0.3 && b >= r) cls[i] = CLASS_BLUE;
      else if (s < 0.13 && mx > 0.6) cls[i] = CLASS_WHITE;
      else if ((hue < 55 || hue > 320) && s > 0.22 && mx > 0.35 && y < h * 0.6) cls[i] = CLASS_WARM;
    }
  }
  // Grow from the top rows.
  const region = new Uint8Array(n);
  const stack = new Int32Array(n);
  let sp = 0;
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < Math.min(2, h); y++) {
      const i = y * w + x;
      if (cls[i] && !region[i]) {
        region[i] = 1;
        stack[sp++] = i;
      }
    }
  }
  const close = (i: number, j: number) => Math.abs(R[i] - R[j]) + Math.abs(G[i] - G[j]) + Math.abs(B[i] - B[j]) < 0.11;
  while (sp > 0) {
    const i = stack[--sp];
    const x = i % w;
    const y = (i - x) / w;
    const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
    for (const j of nb) {
      if (j < 0 || region[j] || !cls[j] || !close(i, j)) continue;
      region[j] = 1;
      stack[sp++] = j;
    }
  }
  let count = 0;
  let topRow = 0;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  const kinds = [0, 0, 0, 0];
  let bright = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!region[i]) continue;
      count++;
      if (y === 0) topRow++;
      kinds[cls[i]]++;
      bright += luma[i];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  const fraction = count / n;
  const present = fraction >= 0.05 && topRow / w >= 0.15;
  if (!count) return { fraction: 0, present: false, box: null, kind: 'none', warm: 0, brightness: 0 };
  let kind: SkyResult['kind'] = 'blue';
  const kb = kinds[CLASS_BLUE];
  const kw = kinds[CLASS_WHITE];
  const kr = kinds[CLASS_WARM];
  if (kr >= kb && kr >= kw) kind = 'sunset';
  else if (kw > kb) kind = 'overcast';
  return {
    fraction: round2(fraction),
    present,
    box: { x: round2(x0 / w), y: round2(y0 / h), w: round2((x1 - x0 + 1) / w), h: round2((y1 - y0 + 1) / h) },
    kind: present ? kind : 'none',
    warm: kr / count,
    brightness: bright / count,
  };
}
