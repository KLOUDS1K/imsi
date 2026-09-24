/**
 * Browser harness for engine-fx. Exposes `window.fx.<scenario>()` functions
 * that render with the real PassDefs through MiniRunner and return plain
 * numbers for fx.spec.ts to assert on.
 */
import { createDefaultParams } from '../../../src/editor/defaults';
import type { LensCorrection } from '../../../src/editor/contracts';
import type { EditParams, HealSpot } from '../../../src/editor/types';
import type { PassDef } from '../../../src/editor/engine/pass-types';
import { srgbToLinear } from '../../../src/editor/color/math';
import {
  DETAIL_STAGE,
  EFFECTS_STAGE,
  GEOMETRY_OVERLAY_PASS,
  GEOMETRY_PASS,
  HEAL_PASS,
  PATCH_COMPOSITE_PASS,
} from '../../../src/editor/engine/fx';
import { ZERO_LENS, ctxFor, download, geometry, params, runner, upload } from './common';
import { renderDetail, renderDetailParts, renderScene } from './renders';
import { blank, get, makeScene, maxAbsDiff, noisyFlat, randomImage, set, stats, type Img } from './scenes';

/* ------------------------------------------------------------------ */

function identityDefaults() {
  const img = makeScene(96, 64);
  const src = upload(img);
  const p = params();
  const ctx = ctxFor(96, 64);
  const result: Record<string, { identity: boolean; forcedDiff: number | null }> = {};
  const check = (pass: PassDef, extra?: { spots: HealSpot[] }, force = true) => {
    const identity = pass.isIdentity?.(p, ctx, extra) ?? false;
    let forcedDiff: number | null = null;
    if (force) forcedDiff = maxAbsDiff(runner.read(runner.run(pass, { uInput: src, uOverlay: src }, p, ctx, extra, true)), img.data);
    result[pass.name] = { identity, forcedDiff };
  };
  for (const pass of DETAIL_STAGE) check(pass, undefined, pass.name !== 'fx-detail-ai-denoise');
  for (const pass of EFFECTS_STAGE) check(pass);
  check(HEAL_PASS, { spots: [] });
  check(GEOMETRY_PASS);
  const raw = createDefaultParams(true);
  const rawActive = DETAIL_STAGE.filter((d) => !d.isIdentity?.(raw, ctx)).map((d) => d.name);
  return { result, rawActive };
}

function geometryIdentity() {
  const img = randomImage(97, 61, 11);
  const src = upload(img);
  const p = params();
  const full = runner.read(runner.run(GEOMETRY_PASS, { uInput: src }, p, ctxFor(97, 61), undefined, true));
  const draft = runner.read(runner.run(GEOMETRY_PASS, { uInput: src }, p, ctxFor(97, 61, { quality: 'draft' }), undefined, true));
  let minAlpha = 1;
  for (let i = 3; i < full.length; i += 4) minAlpha = Math.min(minAlpha, full[i]);
  return { diffFull: maxAbsDiff(full, img.data, 3), diffDraft: maxAbsDiff(draft, img.data, 3), minAlpha };
}

function findPeak(img: Img, channel: number): { x: number; y: number; v: number } {
  let best = { x: -1, y: -1, v: -Infinity };
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const v = img.data[(y * img.width + x) * 4 + channel];
      if (v > best.v) best = { x, y, v };
    }
  }
  return best;
}

/** Marker pixel mapped through GEOMETRY vs. where geometry.ts predicts it. */
function orientationMarker() {
  const W = 64;
  const H = 48;
  const img = blank(W, H);
  const mx = 5;
  const my = 3;
  set(img, mx, my, [1, 0, 0]);
  const src = upload(img);
  const cases: Record<string, (p: EditParams) => void> = {
    'orient90+flipH': (p) => {
      p.crop.orientation = 90;
      p.crop.flipH = true;
    },
    orient270: (p) => (p.crop.orientation = 270),
    'orient180+flipV': (p) => {
      p.crop.orientation = 180;
      p.crop.flipV = true;
    },
  };
  const out: Record<string, { found: [number, number]; predicted: [number, number]; size: [number, number]; value: number }> = {};
  for (const [name, mut] of Object.entries(cases)) {
    const p = params(mut);
    const ow = p.crop.orientation % 180 === 0 ? W : H;
    const oh = p.crop.orientation % 180 === 0 ? H : W;
    const res = download(runner.run(GEOMETRY_PASS, { uInput: src }, p, ctxFor(ow, oh, { srcWidth: W, srcHeight: H, outWidth: ow, outHeight: oh })));
    const peak = findPeak(res, 0);
    const pr = geometry.sourceToOutput((mx + 0.5) / W, (my + 0.5) / H, p, W, H);
    out[name] = { found: [peak.x, peak.y], predicted: [Math.floor(pr.x * ow), Math.floor(pr.y * oh)], size: [ow, oh], value: peak.v };
  }
  return { geometrySource: geometry.source, cases: out };
}

/** Blurred marker through a rotated/keystoned/lens-corrected crop: peak within a pixel of the prediction. */
function warpedMarker() {
  const W = 160;
  const H = 120;
  const img = blank(W, H);
  const cx = 110;
  const cy = 38;
  for (let y = -3; y <= 3; y++) for (let x = -3; x <= 3; x++) set(img, cx + x, cy + y, [Math.exp(-(x * x + y * y) / 4), 0, 0]);
  const src = upload(img);
  const lens: LensCorrection = { ...ZERO_LENS, k1: -0.06, k2: 0.01 };
  const p = params((q) => {
    q.crop.angle = 17;
    q.transform.vertical = 25;
    q.transform.scale = 105;
    Object.assign(q.crop, { x: 0.1, y: 0.05, w: 0.8, h: 0.85 });
  });
  const ow = Math.round(W * 0.8);
  const oh = Math.round(H * 0.85);
  const res = download(runner.run(GEOMETRY_PASS, { uInput: src }, p, ctxFor(ow, oh, { srcWidth: W, srcHeight: H, outWidth: ow, outHeight: oh, lens })));
  const peak = findPeak(res, 0);
  const pr = geometry.sourceToOutput((cx + 0.5) / W, (cy + 0.5) / H, p, W, H, false, lens);
  return { found: [peak.x + 0.5, peak.y + 0.5], predicted: [pr.x * ow, pr.y * oh] };
}

function cropSubRect() {
  const W = 64;
  const H = 48;
  const img = randomImage(W, H, 5);
  const src = upload(img);
  const p = params((q) => Object.assign(q.crop, { x: 0.25, y: 0.5, w: 0.5, h: 0.25 }));
  const ctx = ctxFor(32, 12, { srcWidth: W, srcHeight: H, outWidth: 32, outHeight: 12 });
  const res = download(runner.run(GEOMETRY_PASS, { uInput: src }, p, ctx));
  let maxDiff = 0;
  for (let y = 0; y < 12; y++) {
    for (let x = 0; x < 32; x++) {
      const a = get(res, x, y);
      const b = get(img, 16 + x, 24 + y);
      for (let c = 0; c < 3; c++) maxDiff = Math.max(maxDiff, Math.abs(a[c] - b[c]));
    }
  }
  // outRect tile: right half of the output rendered on its own.
  const tile = download(runner.run(GEOMETRY_PASS, { uInput: src }, p, { ...ctx, width: 16, height: 12, outRect: { x: 0.5, y: 0, w: 0.5, h: 1 } }));
  let tileDiff = 0;
  for (let y = 0; y < 12; y++) {
    for (let x = 0; x < 16; x++) {
      const a = get(tile, x, y);
      const b = get(res, 16 + x, y);
      for (let c = 0; c < 4; c++) tileDiff = Math.max(tileDiff, Math.abs(a[c] - b[c]));
    }
  }
  // Mask overlay mode warps coverage the same way.
  const cov = blank(W, H);
  for (let i = 0; i < W * H; i++) cov.data[i * 4] = img.data[i * 4 + 1];
  const ov = download(runner.run(GEOMETRY_OVERLAY_PASS, { uInput: src, uOverlay: upload(cov) }, p, ctx));
  let overlayDiff = 0;
  for (let y = 0; y < 12; y++) for (let x = 0; x < 32; x++) overlayDiff = Math.max(overlayDiff, Math.abs(get(ov, x, y)[0] - get(img, 16 + x, 24 + y)[1]));
  return { maxDiff, tileDiff, overlayDiff };
}

function vignette() {
  const W = 120;
  const H = 80;
  const grey = upload(blank(W, H, [0.5, 0.5, 0.5]));
  const run = (mut: (p: EditParams) => void, src = grey) => download(runner.runStage(EFFECTS_STAGE, src, params(mut), ctxFor(W, H)));
  const dark = run((p) => (p.effects.vignetteAmount = -60));
  const light = run((p) => (p.effects.vignetteAmount = 60));
  const bright = upload(blank(W, H, [0.95, 0.95, 0.95]));
  const noProtect = run((p) => (p.effects.vignetteAmount = -80), bright);
  const protect = run((p) => {
    p.effects.vignetteAmount = -80;
    p.effects.vignetteHighlights = 100;
  }, bright);
  const diag: number[] = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    diag.push(get(dark, Math.min(W - 1, Math.floor((0.5 + 0.5 * t) * W)), Math.min(H - 1, Math.floor((0.5 + 0.5 * t) * H)))[0]);
  }
  return {
    centerDark: get(dark, W / 2, H / 2)[0],
    cornerDark: get(dark, 0, 0)[0],
    edgeMidDark: get(dark, W / 2, 0)[0],
    cornerLight: get(light, W - 1, H - 1)[0],
    centerLight: get(light, W / 2, H / 2)[0],
    cornerNoProtect: get(noProtect, 0, 0)[0],
    cornerProtect: get(protect, 0, 0)[0],
    diag,
  };
}

function grain() {
  const N = 256;
  const src = upload(blank(N, N, [0.5, 0.5, 0.5]));
  const p = params((q) => {
    q.effects.grainAmount = 50;
    q.effects.grainSize = 25;
    q.effects.grainRoughness = 50;
  });
  const ctx = ctxFor(N, N);
  const a = runner.read(runner.runStage(EFFECTS_STAGE, src, p, ctx));
  const b = runner.read(runner.runStage(EFFECTS_STAGE, src, p, ctx));
  const s = stats(a, 1);
  let changed = 0;
  for (let i = 0; i < N * N; i++) if (Math.abs(a[i * 4 + 1] - 0.5) > 1e-4) changed++;
  // Tile = centre quarter of the output rendered alone at the same pixel scale.
  const tileSrc = upload(blank(128, 128, [0.5, 0.5, 0.5]));
  const tile = runner.read(runner.runStage(EFFECTS_STAGE, tileSrc, p, { ...ctx, width: 128, height: 128, outRect: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } }));
  let tileDiff = 0;
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) tileDiff = Math.max(tileDiff, Math.abs(tile[(y * 128 + x) * 4 + 1] - a[((y + 64) * N + x + 64) * 4 + 1]));
  // Normalization: zoomed far in (fp < 1) at amount 100, roughness 0 → std ≈ 0.1 at mid-grey.
  const pz = params((q) => {
    q.effects.grainAmount = 100;
    q.effects.grainRoughness = 0;
  });
  const z = runner.read(runner.runStage(EFFECTS_STAGE, src, pz, { ...ctx, outRect: { x: 0.2, y: 0.3, w: 0.1, h: 0.1 } }));
  const zs = stats(z, 1);
  return { mean: s.mean, std: s.std, changedFraction: changed / (N * N), deterministic: maxAbsDiff(a, b) === 0, tileDiff, zoomStd: zs.std, zoomMean: zs.mean };
}

function spots() {
  const N = 128;
  const tex = randomImage(N, N, 9);
  const src = upload(tex);
  const ctx = ctxFor(N, N);
  const base: HealSpot = { id: 's', kind: 'clone', x: 0.25, y: 0.5, sx: 0.75, sy: 0.5, radius: 0.1, feather: 0, opacity: 100 };
  const clone = download(runner.run(HEAL_PASS, { uInput: src }, params(), ctx, { spots: [base] }));
  let coreDiff = 0;
  let outsideDiff = 0;
  const R = 0.1 * N;
  const dx = Math.round(0.5 * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const d = Math.hypot(x + 0.5 - 0.25 * N, y + 0.5 - 0.5 * N);
      const o = get(clone, x, y);
      if (d < R - 1) {
        const s = get(tex, x + dx, y);
        for (let c = 0; c < 3; c++) coreDiff = Math.max(coreDiff, Math.abs(o[c] - s[c]));
      } else if (d > R + 1) {
        const s = get(tex, x, y);
        for (let c = 0; c < 3; c++) outsideDiff = Math.max(outsideDiff, Math.abs(o[c] - s[c]));
      }
    }
  }
  // Heal: same texture, dark left half / bright right half. Texture must come
  // from the source, tone from the destination surroundings.
  const two = blank(N, N);
  const tr = randomImage(N, N, 21);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const lvl = x < N / 2 ? 0.2 : 0.6;
      const t = (get(tr, x % 64, y)[0] - 0.5) * 0.1;
      set(two, x, y, [lvl + t, lvl + t, lvl + t]);
    }
  }
  const twoTex = upload(two);
  const core = (img: Img) => stats(img.data, 0, (i) => Math.hypot((i % N) + 0.5 - 0.25 * N, Math.floor(i / N) + 0.5 - 0.5 * N) < R * 0.8);
  const healed = download(runner.run(HEAL_PASS, { uInput: twoTex }, params(), ctx, { spots: [{ ...base, kind: 'heal' }] }));
  const cloned = download(runner.run(HEAL_PASS, { uInput: twoTex }, params(), ctx, { spots: [base] }));
  const texCore = core(two);
  // Texture correlation of the healed core with the source texture.
  let corr = 0;
  let na = 0;
  let nb = 0;
  const hs = core(healed);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (Math.hypot(x + 0.5 - 0.25 * N, y + 0.5 - 0.5 * N) >= R * 0.8) continue;
      const a = get(healed, x, y)[0] - hs.mean;
      const b = get(two, x + dx, y)[0] - 0.6;
      corr += a * b;
      na += a * a;
      nb += b * b;
    }
  }
  return {
    coreDiff,
    outsideDiff,
    healMean: hs.mean,
    healStd: hs.std,
    texStd: texCore.std,
    cloneMean: core(cloned).mean,
    healCorr: corr / Math.sqrt(na * nb),
  };
}

function patch() {
  const N = 64;
  const src = upload(blank(N, N, [0.1, 0.1, 0.1]));
  const px = new Uint8Array(16 * 16 * 4);
  for (let i = 0; i < 256; i++) px.set([200, 100, 50, 255], i * 4);
  const pt = runner.createTextureU8(16, 16, px);
  const p = params((q) => {
    q.retouch.removals = [{ id: 'r', kind: 'ai-remove', bbox: { x: 0.25, y: 0.25, w: 0.25, h: 0.25 }, strokes: [], patchKey: 'k' }];
  });
  const out = download(runner.run(PATCH_COMPOSITE_PASS, { uInput: src, uPatch: pt }, p, ctxFor(N, N), { iteration: 0 }));
  return {
    inside: get(out, 24, 24).slice(0, 3),
    expected: [srgbToLinear(200 / 255), srgbToLinear(100 / 255), srgbToLinear(50 / 255)],
    outside: get(out, 5, 5).slice(0, 3),
    identityWithout: PATCH_COMPOSITE_PASS.isIdentity!(params(), ctxFor(N, N), { iteration: 0 }),
  };
}

/** chroma (rgb − luma) and luma std of a flat noisy patch. */
function noiseStats(img: Img) {
  const n = img.width * img.height;
  const y = new Float32Array(n * 4);
  const c = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const [r, g, b] = get(img, i % img.width, Math.floor(i / img.width));
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    y[i * 4] = l;
    c[i * 4] = r - l;
  }
  return { luma: stats(y, 0).std, chroma: stats(c, 0).std, mean: stats(y, 0).mean };
}

function detail() {
  const N = 128;
  const noisy = noisyFlat(N, N, 0.5, 0.04, 0.03);
  const src = upload(noisy);
  const ctx = ctxFor(N, N);
  const run = (mut: (p: EditParams) => void) => noiseStats(download(runner.runStage(DETAIL_STAGE, src, params(mut), ctx)));
  const before = noiseStats(noisy);
  const lumaNr = run((p) => (p.noise.luminance = 60));
  const colorNr = run((p) => (p.noise.color = 50));
  const ai = run((p) => {
    p.noise.aiDenoise = true;
    p.noise.aiDenoiseStrength = 70;
    p.noise.detailPreservation = 20;
  });
  // Sharpening a hard step edge (0.3 | 0.7 at x = 32).
  const edge = blank(64, 16);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 64; x++) {
    const v = x < 32 ? 0.3 : 0.7;
    set(edge, x, y, [v, v, v]);
  }
  const edgeTex = upload(edge);
  const sharpRow = (mut: (p: EditParams) => void) => {
    const o = download(runner.runStage(DETAIL_STAGE, edgeTex, params(mut), ctxFor(64, 16)));
    return Array.from({ length: 64 }, (_, x) => get(o, x, 8)[1]);
  };
  const sharpHalo = sharpRow((p) => {
    p.detail.sharpenAmount = 150;
    p.detail.sharpenDetail = 100;
  });
  const sharpSuppressed = sharpRow((p) => {
    p.detail.sharpenAmount = 150;
    p.detail.sharpenDetail = 0;
  });
  const orig = Array.from({ length: 64 }, (_, x) => get(edge, x, 8)[1]);
  // Masking: noise in flat areas stays untouched at masking 100.
  const maskedNoise = run((p) => {
    p.detail.sharpenAmount = 100;
    p.detail.sharpenMasking = 100;
  });
  const unmaskedNoise = run((p) => (p.detail.sharpenAmount = 100));
  // Luminance contrast restore: mid-frequency sine under noise.
  const sine = noisyFlat(N, N, 0, 0.04, 0, 13);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = (y * N + x) * 4;
    const s = 0.5 + 0.04 * Math.sin((2 * Math.PI * x) / 16);
    for (let c = 0; c < 3; c++) sine.data[i + c] += s;
  }
  const sineTex = upload(sine);
  const amp = (mut: (p: EditParams) => void) => {
    const o = download(runner.runStage(DETAIL_STAGE, sineTex, params(mut), ctx));
    let acc = 0;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) acc += get(o, x, y)[1] * Math.sin((2 * Math.PI * x) / 16);
    return (2 * acc) / (N * N);
  };
  return {
    before,
    lumaNr,
    colorNr,
    ai,
    orig,
    sharpHalo,
    sharpSuppressed,
    maskedNoise,
    unmaskedNoise,
    sineAmp: { none: amp(() => {}), nr: amp((p) => (p.noise.luminance = 100)), nrContrast: amp((p) => {
      p.noise.luminance = 100;
      p.noise.luminanceContrast = 100;
    }) },
  };
}

function glowEffects() {
  const W = 128;
  const H = 96;
  const img = blank(W, H, [0.05, 0.05, 0.05]);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (Math.hypot(x - 64, y - 48) < 6) set(img, x, y, [1, 1, 1]);
  const src = upload(img);
  const run = (mut: (p: EditParams) => void) => download(runner.runStage(EFFECTS_STAGE, src, params(mut), ctxFor(W, H)));
  const bloom = run((p) => (p.effects.bloom = 80));
  const hal = run((p) => (p.effects.halation = 80));
  const glow = run((p) => (p.effects.glow = 80));
  return {
    base: { near: get(img, 64 + 14, 48), far: get(img, 2, 2) },
    bloom: { near: get(bloom, 64 + 14, 48), far: get(bloom, 2, 2), core: get(bloom, 64, 48) },
    halation: { ring: get(hal, 64 + 9, 48), far: get(hal, 2, 2), core: get(hal, 64, 48) },
    glow: { near: get(glow, 64 + 10, 48), far: get(glow, 2, 2) },
  };
}

/** Mean colour of the (neutral) checker patch of the scene under each effect alone. */
function neutralTint() {
  const W = 480;
  const H = 320;
  const src = upload(makeScene(W, H));
  const inChecker = (i: number) => {
    const x = i % W;
    const y = Math.floor(i / W);
    return x > 0.08 * W && x < 0.28 * W && y > 0.72 * H && y < 0.92 * H;
  };
  const mean = (img: Img) => [0, 1, 2].map((c) => stats(img.data, c, inChecker).mean);
  const variants: Record<string, (p: EditParams) => void> = {
    none: () => {},
    bloom: (p) => (p.effects.bloom = 35),
    glow: (p) => (p.effects.glow = 15),
    halation: (p) => (p.effects.halation = 45),
    vignette: (p) => (p.effects.vignetteAmount = -45),
    grain: (p) => (p.effects.grainAmount = 30),
  };
  const out: Record<string, number[]> = {};
  for (const [k, mut] of Object.entries(variants)) out[k] = mean(download(runner.runStage(EFFECTS_STAGE, src, params(mut), ctxFor(W, H))));
  return out;
}

const api = {
  neutralTint, renderDetailParts, renderDetail, identityDefaults, geometryIdentity, orientationMarker, warpedMarker, cropSubRect, vignette, grain, spots, patch, detail, glowEffects, renderScene };
declare global {
  interface Window {
    fx: typeof api;
    fxReady: boolean;
    fxError?: string;
  }
}
window.fx = api;

import('../../../src/editor/engine/geometry')
  .then((m) => {
    geometry.sourceToOutput = m.sourceToOutput;
    geometry.source = 'engine/geometry';
  })
  .catch(() => undefined)
  .finally(() => {
    window.fxReady = true;
  });
