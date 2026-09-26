/**
 * Sky (heuristic): top-connected region of bright, smooth, blue-ish or
 * overcast/cloud pixels.
 *
 * 1. Per-pixel sky likelihood from OKLab lightness/chroma/hue and local
 *    texture (clear blue, overcast white, clouds, weak warm sunset term).
 * 2. Flood fill from the top edge; a step is allowed only across small colour
 *    differences and into low-texture pixels close to the running sky colour
 *    model — this stops at mountain/tree/building outlines.
 * 3. Horizon reasoning: estimate the horizon as a high percentile of the
 *    columns' contiguous-from-top sky extents; sky-like pixels far below it
 *    that are separated from their column's sky by a gap (lake reflections,
 *    white walls reached around a corner) are removed.
 * 4. Small enclosed holes (birds, cloud detail, wires) are filled.
 */
import { boxBlur, smoothstep, type Img } from './image';
import { fillHoles, openClose } from './morph';

export function skyLikelihood(img: Img, texture: Float32Array): Float32Array {
  const { n, L, A, B, C } = img;
  const P = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const l = L[i]!, c = C[i]!, t = texture[i]!;
    // Keep saturated twilight blue and dim overcast skies eligible; the old
    // lightness gates discarded both before connectivity could inspect them.
    const blue = smoothstep(-0.002, -0.045, B[i]!) * smoothstep(0.28, 0.57, l) * (1 - smoothstep(0.025, 0.09, A[i]!));
    const overcast = (1 - smoothstep(0.035, 0.09, c)) * smoothstep(0.48, 0.76, l);
    const warm = 0.55 * smoothstep(0.55, 0.75, l) * smoothstep(0.0, 0.03, A[i]! + B[i]!);
    const smooth = 1 - smoothstep(0.012, 0.05, t);
    const cloud = smoothstep(0.66, 0.85, l) * (1 - smoothstep(0.04, 0.09, c)) * (1 - smoothstep(0.05, 0.12, t));
    P[i] = Math.max(Math.max(blue, overcast, warm) * smooth, cloud);
  }
  return P;
}

export function skyCoarse(img: Img): Float32Array {
  const { w, h, n, L, A, B } = img;
  const texture = boxBlur(img.grad, w, h, 2);
  const P = skyLikelihood(img, texture);
  const sky = new Uint8Array(n);
  const queue = new Int32Array(n);
  let qh = 0, qt = 0;
  let sL = 0, sA = 0, sB = 0, cnt = 0;
  // Seed the very top permissively, then accept only high-confidence pockets
  // slightly lower down. This recovers sky behind thin branches and letterbox
  // crops without turning a smooth wall into sky as readily.
  const topRows = Math.max(1, Math.round(h * 0.025));
  const seedRows = Math.max(topRows, Math.round(h * 0.08));
  for (let y = 0; y < seedRows; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const threshold = y < topRows ? 0.27 : 0.52;
      if (P[i]! > threshold && texture[i]! < (y < topRows ? 0.11 : 0.065)) {
        sky[i] = 1;
        queue[qt++] = i;
        sL += L[i]!;
        sA += A[i]!;
        sB += B[i]!;
        cnt++;
      }
    }
  if (cnt < Math.max(3, w * topRows * 0.035)) return new Float32Array(n);

  const STEP = 0.055; // max OKLab step between neighbours
  const MODEL = 0.32; // max OKLab distance to the running sky mean
  const tryAdd = (from: number, to: number) => {
    if (sky[to] || P[to]! < 0.16 || texture[to]! > 0.11) return;
    const dl = L[to]! - L[from]!, da = A[to]! - A[from]!, db = B[to]! - B[from]!;
    if (dl * dl + da * da + db * db > STEP * STEP) return;
    const ml = L[to]! - sL / cnt, ma = A[to]! - sA / cnt, mb = B[to]! - sB / cnt;
    if (ml * ml + ma * ma + mb * mb > MODEL * MODEL) return;
    sky[to] = 1;
    queue[qt++] = to;
    sL += L[to]!;
    sA += A[to]!;
    sB += B[to]!;
    cnt++;
  };
  while (qh < qt) {
    const i = queue[qh++]!;
    const x = i % w, y = (i / w) | 0;
    if (x > 0) tryAdd(i, i - 1);
    if (x < w - 1) tryAdd(i, i + 1);
    if (y > 0) tryAdd(i, i - w);
    if (y < h - 1) tryAdd(i, i + w);
  }

  // Horizon reasoning.
  const gapMax = Math.max(2, Math.round(h * 0.03));
  const runEnd = new Int32Array(w); // last row of the (gap-tolerant) contiguous-from-top sky run
  for (let x = 0; x < w; x++) {
    let last = -1, gap = 0;
    for (let y = 0; y < h; y++) {
      if (sky[y * w + x]) {
        last = y;
        gap = 0;
      } else if (last >= 0 && ++gap > gapMax) break;
      else if (last < 0 && y > gapMax) break;
    }
    runEnd[x] = last;
  }
  const ends = Array.from(runEnd).filter((v) => v >= 0).sort((a, b) => a - b);
  const horizon = ends.length ? ends[Math.min(ends.length - 1, Math.floor(ends.length * 0.9))]! : -1;
  const margin = Math.round(h * 0.04);
  for (let x = 0; x < w; x++)
    for (let y = Math.max(runEnd[x]! + 1, horizon + margin); y < h; y++) sky[y * w + x] = 0;

  const cleaned = fillHoles(openClose(sky, w, h, 1), w, h, n * 0.02);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = cleaned[i]!;
  return out;
}
