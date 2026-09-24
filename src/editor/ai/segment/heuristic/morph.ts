/** Binary-mask morphology and connected components (Uint8 0/1 planes). */
import { boxBlur } from './image';

export interface Component {
  label: number;
  area: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Sum of x and y (centroid = sum / area). */
  sx: number;
  sy: number;
}

/** 4-connected labelling (iterative flood fill). labels: 0 = background, 1..n. */
export function components(bin: Uint8Array, w: number, h: number): { labels: Int32Array; comps: Component[] } {
  const labels = new Int32Array(w * h);
  const comps: Component[] = [];
  const stack = new Int32Array(w * h);
  let next = 0;
  for (let s = 0; s < w * h; s++) {
    if (!bin[s] || labels[s]) continue;
    const label = ++next;
    const c: Component = { label, area: 0, x0: w, y0: h, x1: -1, y1: -1, sx: 0, sy: 0 };
    let sp = 0;
    stack[sp++] = s;
    labels[s] = label;
    while (sp > 0) {
      const i = stack[--sp]!;
      const x = i % w, y = (i / w) | 0;
      c.area++;
      c.sx += x;
      c.sy += y;
      if (x < c.x0) c.x0 = x;
      if (x > c.x1) c.x1 = x;
      if (y < c.y0) c.y0 = y;
      if (y > c.y1) c.y1 = y;
      if (x > 0 && bin[i - 1] && !labels[i - 1]) { labels[i - 1] = label; stack[sp++] = i - 1; }
      if (x < w - 1 && bin[i + 1] && !labels[i + 1]) { labels[i + 1] = label; stack[sp++] = i + 1; }
      if (y > 0 && bin[i - w] && !labels[i - w]) { labels[i - w] = label; stack[sp++] = i - w; }
      if (y < h - 1 && bin[i + w] && !labels[i + w]) { labels[i + w] = label; stack[sp++] = i + w; }
    }
    comps.push(c);
  }
  return { labels, comps };
}

/** Keep components accepted by `keep`. */
export function filterComponents(bin: Uint8Array, w: number, h: number, keep: (c: Component) => boolean): Uint8Array {
  const { labels, comps } = components(bin, w, h);
  const ok = new Uint8Array(comps.length + 1);
  for (const c of comps) ok[c.label] = keep(c) ? 1 : 0;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = ok[labels[i]!]!;
  return out;
}

/** Keep the largest component plus any at least `ratio` × its size. */
export function keepLargest(bin: Uint8Array, w: number, h: number, ratio = 0.25, minArea = 0): Uint8Array {
  const { labels, comps } = components(bin, w, h);
  let big = 0;
  for (const c of comps) big = Math.max(big, c.area);
  const ok = new Uint8Array(comps.length + 1);
  for (const c of comps) ok[c.label] = c.area >= big * ratio && c.area >= minArea ? 1 : 0;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = ok[labels[i]!]!;
  return out;
}

/** Fill background holes that do not touch the border and are smaller than maxArea. */
export function fillHoles(bin: Uint8Array, w: number, h: number, maxArea = Infinity): Uint8Array {
  const inv = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) inv[i] = bin[i] ? 0 : 1;
  const { labels, comps } = components(inv, w, h);
  const fill = new Uint8Array(comps.length + 1);
  for (const c of comps) {
    const touches = c.x0 === 0 || c.y0 === 0 || c.x1 === w - 1 || c.y1 === h - 1;
    fill[c.label] = !touches && c.area <= maxArea ? 1 : 0;
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = bin[i] || fill[labels[i]!] ? 1 : 0;
  return out;
}

function toF(bin: Uint8Array): Float32Array {
  const f = new Float32Array(bin.length);
  for (let i = 0; i < bin.length; i++) f[i] = bin[i]!;
  return f;
}

/** Square-structuring-element dilation (radius r). */
export function dilate(bin: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return bin.slice();
  const m = boxBlur(toF(bin), w, h, r);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = m[i]! > 1e-4 ? 1 : 0;
  return out;
}

export function erode(bin: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return bin.slice();
  const m = boxBlur(toF(bin), w, h, r);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = m[i]! > 1 - 1e-4 ? 1 : 0;
  return out;
}

/** Morphological opening then closing (removes specks, bridges pinholes). */
export function openClose(bin: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const opened = dilate(erode(bin, w, h, r), w, h, r);
  return erode(dilate(opened, w, h, r), w, h, r);
}

export function threshold(a: Float32Array, t: number): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i]! > t ? 1 : 0;
  return out;
}

export function binToFloat(bin: Uint8Array): Float32Array {
  return toF(bin);
}

export function areaOf(bin: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < bin.length; i++) s += bin[i]!;
  return s;
}
