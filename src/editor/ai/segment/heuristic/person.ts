/**
 * Person / hair / clothes (heuristic, face-anchored).
 *
 * Person: a body prior hangs below every detected face (head ellipse +
 * widening torso trapezoid to the bottom edge), blended with subject
 * saliency, then refined with GrabCut-lite; only components touching a face
 * are kept. Without faces the subject mask is used.
 * Hair: colour model sampled just above the forehead (non-skin pixels),
 * region-grown inside a band around the head.
 * Clothes: person − skin − hair − face.
 */
import { smoothstep, type Img } from './image';
import { grabCutLite } from './grabcut';
import { components, dilate, fillHoles, filterComponents, openClose } from './morph';
import { ellipseMask, type Face } from './skin';

export function bodyPrior(w: number, h: number, faces: Face[]): Float32Array {
  const p = ellipseMask(w, h, faces, 1.55, 1.6, -0.12);
  for (const f of faces) {
    const top = f.cy + 0.75 * f.a;
    for (let y = Math.max(0, Math.floor(top)); y < h; y++) {
      const t = Math.min(1, (y - top) / (4 * f.a));
      const hw = f.b * (1.5 + 2.4 * t);
      for (let x = Math.max(0, Math.floor(f.cx - hw * 1.4)); x < Math.min(w, Math.ceil(f.cx + hw * 1.4)); x++) {
        const d = Math.abs(x + 0.5 - f.cx) / hw;
        const v = 0.9 * (1 - smoothstep(0.8, 1.35, d)) * (1 - 0.3 * t);
        const i = y * w + x;
        if (v > p[i]!) p[i] = v;
      }
    }
  }
  return p;
}

export function personCoarse(img: Img, faces: Face[], sal: Float32Array, subject: () => Float32Array): Float32Array {
  const { w, h, n } = img;
  if (!faces.length) return subject();
  const body = bodyPrior(w, h, faces);
  const prior = new Float32Array(n);
  for (let i = 0; i < n; i++) prior[i] = Math.max(0.04, Math.min(0.92, 0.75 * body[i]! + 0.25 * sal[i]! * (body[i]! > 0.05 ? 1 : 0.4)));
  const core = ellipseMask(w, h, faces, 0.75, 0.75);
  const hardFg = new Uint8Array(n);
  for (let i = 0; i < n; i++) hardFg[i] = core[i]! > 0.5 ? 1 : 0;
  const q = grabCutLite(img, prior, { iterations: 4, priorWeight: 1, hardFg });
  const reach = new Uint8Array(n);
  for (let i = 0; i < n; i++) reach[i] = body[i]! > 0.08 ? 1 : 0;
  const allowed = dilate(reach, w, h, Math.max(2, Math.round(Math.min(w, h) * 0.02)));
  const bin = new Uint8Array(n);
  for (let i = 0; i < n; i++) bin[i] = q[i]! > 0.5 && allowed[i] ? 1 : 0;
  const clean = openClose(bin, w, h, 1);
  // Keep components that contain a face centre.
  const { labels } = components(clean, w, h);
  const keep = new Set<number>();
  for (const f of faces) {
    const i = Math.min(h - 1, Math.max(0, Math.round(f.cy))) * w + Math.min(w - 1, Math.max(0, Math.round(f.cx)));
    if (labels[i]) keep.add(labels[i]!);
  }
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = keep.has(labels[i]!) || hardFg[i] ? 1 : 0;
  const filled = fillHoles(out, w, h, n * 0.03);
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = filled[i]!;
  return f;
}

export function hairCoarse(img: Img, faces: Face[], skin: Uint8Array, person: Float32Array): Float32Array {
  const { w, h, n, L, A, B, C } = img;
  const out = new Uint8Array(n);
  const personReach = new Uint8Array(n);
  let personArea = 0;
  for (let i = 0; i < n; i++) { personReach[i] = person[i]! > 0.5 ? 1 : 0; personArea += personReach[i]!; }
  const reach = personArea > 0 ? dilate(personReach, w, h, 2) : null;
  for (const f of faces) {
    const bandOuter = ellipseMask(w, h, [f], 1.6, 1.55, -0.2);
    const faceIn = ellipseMask(w, h, [f], 0.95, 0.95);
    // Colour samples just above the forehead.
    let sL = 0, sA = 0, sB = 0, qL = 0, qA = 0, qB = 0, cnt = 0;
    const seeds: number[] = [];
    for (let y = Math.max(0, Math.floor(f.cy - 1.3 * f.a)); y <= Math.min(h - 1, f.cy - 0.88 * f.a); y++)
      for (let x = Math.max(0, Math.floor(f.cx - 0.6 * f.b)); x <= Math.min(w - 1, f.cx + 0.6 * f.b); x++) {
        const i = y * w + x;
        if (skin[i] || faceIn[i]! > 0.5) continue;
        sL += L[i]!; sA += A[i]!; sB += B[i]!;
        qL += L[i]! ** 2; qA += A[i]! ** 2; qB += B[i]! ** 2;
        cnt++;
        seeds.push(i);
      }
    if (cnt < 5) continue;
    const mL = sL / cnt, mA = sA / cnt, mB = sB / cnt;
    const spread = Math.sqrt(Math.max(0, qL / cnt - mL * mL) + Math.max(0, qA / cnt - mA * mA) + Math.max(0, qB / cnt - mB * mB));
    const thr = 0.07 + 1.8 * spread;
    const cand = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (bandOuter[i]! < 0.5 || faceIn[i]! > 0.5 || skin[i] || (reach && !reach[i])) continue;
      const d = Math.hypot(L[i]! - mL, A[i]! - mA, B[i]! - mB);
      const darkNeutral = L[i]! < 0.32 && C[i]! < 0.05 && mL < 0.4;
      if (d < thr || (darkNeutral && d < thr * 1.6)) cand[i] = 1;
    }
    // Region-grow from the seeds through candidate pixels.
    const stack = seeds.filter((i) => cand[i]);
    for (const i of stack) out[i] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w, y = (i / w) | 0;
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
      for (const j of nb) if (j >= 0 && cand[j] && !out[j]) { out[j] = 1; stack.push(j); }
    }
  }
  const clean = fillHoles(openClose(out, w, h, 1), w, h, n * 0.005);
  const res = new Float32Array(n);
  for (let i = 0; i < n; i++) res[i] = clean[i]!;
  return res;
}

export function clothesCoarse(img: Img, faces: Face[], person: Float32Array, skin: Uint8Array, hair: Float32Array): Float32Array {
  const { w, h, n } = img;
  const skinD = dilate(skin, w, h, 1);
  const face = ellipseMask(w, h, faces, 1.05, 1.05);
  const bin = new Uint8Array(n);
  for (let i = 0; i < n; i++) bin[i] = person[i]! > 0.5 && !skinD[i] && hair[i]! < 0.5 && face[i]! < 0.5 ? 1 : 0;
  const clean = filterComponents(openClose(bin, w, h, 1), w, h, (c) => c.area >= n * 0.003);
  const res = new Float32Array(n);
  for (let i = 0; i < n; i++) res[i] = clean[i]!;
  return res;
}
