/** Visual renders of the engine-fx chain (PNG data URLs) for manual inspection. */
import type { EditParams, HealSpot } from '../../../src/editor/types';
import type { LensCorrection } from '../../../src/editor/contracts';
import { DETAIL_STAGE, EFFECTS_STAGE, GEOMETRY_PASS, HEAL_PASS } from '../../../src/editor/engine/fx';
import { ZERO_LENS, ctxFor, download, params, runner, upload } from './common';
import { get, makeScene, noisyFlat, set, toImageData, type Img } from './scenes';

/** Full chain on the synthetic scene → PNG data URL (before | after). */
export function renderScene(): string {
  const W = 480;
  const H = 320;
  const scene = makeScene(W, H);
  const lens: LensCorrection = { ...ZERO_LENS, k1: -0.05, caRed: 1.002, caBlue: 0.998 };
  const p = params((q) => {
    q.retouch.spots = [{ id: 'a', kind: 'heal', x: 0.64, y: 0.5, sx: 0.64, sy: 0.33, radius: 0.03, feather: 50, opacity: 100 }];
    q.detail.sharpenAmount = 60;
    q.noise.luminance = 20;
    q.noise.color = 25;
    q.crop.angle = 3;
    q.transform.vertical = 12;
    Object.assign(q.crop, { x: 0.04, y: 0.04, w: 0.92, h: 0.92 });
    q.lens.removeCA = true;
    q.effects.vignetteAmount = -45;
    q.effects.grainAmount = 30;
    q.effects.bloom = 35;
    q.effects.halation = 45;
    q.effects.glow = 15;
  });
  const src = upload(scene);
  const ctxSrc = ctxFor(W, H, { lens });
  const healed = runner.run(HEAL_PASS, { uInput: src }, p, ctxSrc, { spots: p.retouch.spots });
  const detailed = runner.runStage(DETAIL_STAGE, healed, p, ctxSrc);
  const ow = Math.round(W * 0.92);
  const oh = Math.round(H * 0.92);
  const ctxOut = ctxFor(ow, oh, { srcWidth: W, srcHeight: H, outWidth: ow, outHeight: oh, lens });
  const warped = runner.run(GEOMETRY_PASS, { uInput: detailed }, p, ctxOut);
  const final = download(runner.runStage(EFFECTS_STAGE, warped, p, ctxOut));
  const canvas = document.createElement('canvas');
  canvas.width = W + ow + 8;
  canvas.height = H;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#222';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.putImageData(toImageData(scene), 0, 0);
  g.putImageData(toImageData(final), W + 8, 0);
  return canvas.toDataURL('image/png');
}

/** Zoomed panels: noisy | NR+sharpen | AI denoise+sharpen | dusty sky | healed sky. */
export function renderDetail(): string {
  const W = 480;
  const H = 320;
  const clean = makeScene(W, H);
  const noisy = makeScene(W, H);
  const gn = noisyFlat(W, H, 0, 0.05, 0.04, 99);
  for (let i = 0; i < noisy.data.length; i++) if (i % 4 !== 3) noisy.data[i] += gn.data[i];
  const src = upload(noisy);
  const ctx = ctxFor(W, H);
  const nr = download(runner.runStage(DETAIL_STAGE, src, params((p) => {
    p.noise.luminance = 50;
    p.noise.color = 50;
    p.detail.sharpenAmount = 40;
    p.detail.sharpenMasking = 30;
  }), ctx));
  const ai = download(runner.runStage(DETAIL_STAGE, src, params((p) => {
    p.noise.aiDenoise = true;
    p.noise.aiDenoiseStrength = 60;
    p.detail.sharpenAmount = 40;
  }), ctx));
  // Dust on the sky gradient, healed from nearby sky.
  const dusty = makeScene(W, H);
  const dust: [number, number, number][] = [[0.4, 0.3, 5], [0.47, 0.12, 7], [0.33, 0.45, 4]];
  for (const [u, v, r] of dust) {
    for (let y = -r - 2; y <= r + 2; y++) for (let x = -r - 2; x <= r + 2; x++) {
      const d = Math.hypot(x, y);
      if (d > r) continue;
      const px = Math.round(u * W) + x;
      const py = Math.round(v * H) + y;
      const c = get(dusty, px, py);
      const k = 0.55 + 0.2 * (d / r);
      set(dusty, px, py, [c[0] * k, c[1] * k, c[2] * k]);
    }
  }
  const spotsP: HealSpot[] = dust.map(([u, v, r], i) => ({
    id: `d${i}`, kind: 'heal', x: u, y: v, sx: u + 0.06, sy: v + 0.02, radius: (r + 3) / W, feather: 40, opacity: 100,
  }));
  const healed = download(runner.run(HEAL_PASS, { uInput: upload(dusty) }, params(), ctx, { spots: spotsP }));
  const crop = (img: Img, x0: number, y0: number, w: number, h: number, zoom: number): ImageData => {
    const out: Img = { width: w * zoom, height: h * zoom, data: new Float32Array(w * zoom * h * zoom * 4) };
    for (let y = 0; y < h * zoom; y++) for (let x = 0; x < w * zoom; x++) {
      const s = get(img, x0 + Math.floor(x / zoom), y0 + Math.floor(y / zoom));
      out.data.set(s, (y * w * zoom + x) * 4);
    }
    return toImageData(out);
  };
  const canvas = document.createElement('canvas');
  canvas.width = 3 * 240 + 16;
  canvas.height = 240 + 8 + 160;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#222';
  g.fillRect(0, 0, canvas.width, canvas.height);
  [noisy, nr, ai].forEach((img, i) => g.putImageData(crop(img, 250, 90, 120, 120, 2), i * 248, 0));
  g.putImageData(crop(dusty, 140, 20, 120, 80, 2), 0, 248);
  g.putImageData(crop(healed, 140, 20, 120, 80, 2), 248, 248);
  g.putImageData(crop(clean, 140, 20, 120, 80, 2), 496, 248);
  return canvas.toDataURL('image/png');
}

/** Diagnostics: each detail pass alone, 3× zoom on the building edge. */
export function renderDetailParts(): string {
  const W = 480;
  const H = 320;
  const noisy = makeScene(W, H);
  const gn = noisyFlat(W, H, 0, 0.05, 0.04, 99);
  for (let i = 0; i < noisy.data.length; i++) if (i % 4 !== 3) noisy.data[i] += gn.data[i];
  const src = upload(noisy);
  const ctx = ctxFor(W, H);
  const variants: ((p: EditParams) => void)[] = [
    () => {},
    (p) => (p.noise.luminance = 50),
    (p) => (p.noise.color = 50),
    (p) => (p.detail.sharpenAmount = 80),
    (p) => {
      p.noise.aiDenoise = true;
      p.noise.aiDenoiseStrength = 60;
    },
  ];
  const Z = 3;
  const cw = 64;
  const canvas = document.createElement('canvas');
  canvas.width = variants.length * (cw * Z + 6);
  canvas.height = cw * Z;
  const g = canvas.getContext('2d')!;
  variants.forEach((mut, k) => {
    const img = download(runner.runStage(DETAIL_STAGE, src, params(mut), ctx));
    const out: Img = { width: cw * Z, height: cw * Z, data: new Float32Array(cw * Z * cw * Z * 4) };
    for (let y = 0; y < cw * Z; y++) for (let x = 0; x < cw * Z; x++) out.data.set(get(img, 240 + Math.floor(x / Z), 150 + Math.floor(y / Z)), (y * cw * Z + x) * 4);
    g.putImageData(toImageData(out), k * (cw * Z + 6), 0);
  });
  return canvas.toDataURL('image/png');
}

