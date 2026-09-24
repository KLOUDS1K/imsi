/**
 * Browser harness for the engine-color passes. Exposes `window.__kc` to
 * Playwright: run PRE → DEVELOP (→ LOCAL) on synthetic images and read back
 * float pixels, or get a PNG of the display-referred result.
 */
import { linearToSrgb, tempTintFromNeutral } from '../../../src/editor/color/math';
import type { LensCorrection } from '../../../src/editor/contracts';
import { createDefaultParams, createEmptyMeta, createMask } from '../../../src/editor/defaults';
import {
  DEVELOP_PASS,
  LOCAL_PASS,
  PRE_PASS,
  buildDevelopCurveLut,
  CURVE_LUT_SIZE,
} from '../../../src/editor/engine/color/index';
import type { PassContext } from '../../../src/editor/engine/pass-types';
import type { EditParams, LocalAdjustments, Mask, PartialParams } from '../../../src/editor/types';
import { MiniRunner, type Precision, type Tex } from './runner';
import { flat, photo, ramps, type Rgb } from './synthetic';

export type ImageSpec =
  | { kind: 'flat'; rgb: Rgb }
  | { kind: 'ramps' }
  | { kind: 'photo'; seed?: number }
  | { kind: 'data'; data: number[] };

export type Stage = 'pre' | 'develop' | 'local';

export interface MaskSpec {
  adjustments?: Partial<LocalAdjustments>;
  amount?: number;
  visible?: boolean;
  /** Coverage: full frame, left half only, or none. */
  coverage?: 'full' | 'left' | 'none';
}

export interface RunSpec {
  width: number;
  height: number;
  image: ImageSpec;
  params?: PartialParams;
  stages?: Stage[];
  mask?: MaskSpec;
  precision?: Precision;
  scale?: number;
  lens?: Partial<LensCorrection>;
  /** Run the LOCAL shader even when LOCAL_PASS.isIdentity() says it could be skipped. */
  forceLocal?: boolean;
}

export interface RunResult {
  width: number;
  height: number;
  data: number[];
  skipped: Stage[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (!isObject(patch) || !isObject(base)) return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) out[k] = isObject(v) && isObject(out[k]) ? deepMerge(out[k], v) : v;
  return out as T;
}

function makeImage(spec: RunSpec): Float32Array {
  const { width: w, height: h, image } = spec;
  switch (image.kind) {
    case 'flat':
      return flat(w, h, image.rgb);
    case 'ramps':
      return ramps(w, h);
    case 'photo':
      return photo(w, h, image.seed);
    case 'data':
      return new Float32Array(image.data);
  }
}

function makeCoverage(w: number, h: number, kind: MaskSpec['coverage']): Float32Array {
  const d = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = kind === 'none' ? 0 : kind === 'left' ? (x < w / 2 ? 1 : 0) : 1;
      d.set([v, v, v, 1], (y * w + x) * 4);
    }
  return d;
}

const canvas = document.createElement('canvas');
canvas.width = 4;
canvas.height = 4;
let runner: MiniRunner | null = null;

function getRunner(precision: Precision): MiniRunner {
  if (!runner || runner.precision !== precision) runner = new MiniRunner(canvas, precision);
  return runner;
}

function run(spec: RunSpec): { out: Tex; runner: MiniRunner; skipped: Stage[]; lastStage: Stage } {
  const r = getRunner(spec.precision ?? '16f');
  r.releaseTemps();
  const { width: w, height: h } = spec;
  const params: EditParams = deepMerge(createDefaultParams(), spec.params ?? {});
  let mask: Mask | undefined;
  if (spec.mask) {
    mask = createMask('test', 'm1');
    mask.adjustments = { ...mask.adjustments, ...(spec.mask.adjustments ?? {}) };
    if (spec.mask.amount !== undefined) mask.amount = spec.mask.amount;
    if (spec.mask.visible !== undefined) mask.visible = spec.mask.visible;
    params.masks = [mask];
  }
  const lens: LensCorrection = { profile: null, k1: 0, k2: 0, k3: 0, v1: 0, v2: 0, v3: 0, caRed: 1, caBlue: 1, ...(spec.lens ?? {}) };
  const ctx: PassContext = {
    width: w,
    height: h,
    srcWidth: w,
    srcHeight: h,
    fullWidth: w,
    fullHeight: h,
    scale: spec.scale ?? Math.max(w, h) / 2560,
    quality: 'full',
    isRaw: false,
    meta: createEmptyMeta('synthetic'),
    lens,
    ignoreCrop: false,
    outRect: { x: 0, y: 0, w: 1, h: 1 },
    outWidth: w,
    outHeight: h,
  };
  const stages = spec.stages ?? ['pre', 'develop'];
  let cur = r.upload(makeImage(spec), w, h, { fullFloat: true });
  const skipped: Stage[] = [];
  for (const stage of stages) {
    if (stage === 'pre') {
      if (PRE_PASS.isIdentity?.(params, ctx)) skipped.push('pre');
      else cur = r.runPass(PRE_PASS, { uInput: cur }, params, ctx);
    } else if (stage === 'develop') {
      const lut = r.upload(buildDevelopCurveLut(params), CURVE_LUT_SIZE, 1, { nearest: true, fullFloat: true });
      cur = r.runPass(DEVELOP_PASS, { uInput: cur, uCurveLut: lut }, params, ctx);
    } else {
      const extra = { mask };
      if (!spec.forceLocal && LOCAL_PASS.isIdentity?.(params, ctx, extra)) {
        skipped.push('local');
        continue;
      }
      const cov = r.upload(makeCoverage(w, h, spec.mask?.coverage ?? 'full'), w, h);
      cur = r.runPass(LOCAL_PASS, { uInput: cur, uMask: cov }, params, ctx, extra);
    }
  }
  return { out: cur, runner: r, skipped, lastStage: stages[stages.length - 1] };
}

function runFloat(spec: RunSpec): RunResult {
  const { out, runner: r, skipped } = run(spec);
  return { width: out.width, height: out.height, data: Array.from(r.read(out)), skipped };
}

/** PNG (data URL) of the result; a linear result (last stage PRE) is sRGB-encoded first. */
function runPng(spec: RunSpec): string {
  const { out, runner: r, lastStage } = run(spec);
  const px = r.read(out);
  const img = new ImageData(out.width, out.height);
  for (let i = 0; i < out.width * out.height; i++) {
    for (let k = 0; k < 3; k++) {
      const v = px[i * 4 + k];
      img.data[i * 4 + k] = Math.round(Math.min(Math.max(lastStage === 'pre' ? linearToSrgb(v) : v, 0), 1) * 255);
    }
    img.data[i * 4 + 3] = 255;
  }
  const c = document.createElement('canvas');
  c.width = out.width;
  c.height = out.height;
  c.getContext('2d')!.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

/** Compile every pass (and prepass) once; returns the list of program names. */
function compileAll(): string[] {
  const r = getRunner('16f');
  const names: string[] = [];
  for (const p of [PRE_PASS, DEVELOP_PASS, LOCAL_PASS]) {
    r.program(p.name, p.fragment);
    names.push(p.name);
    for (const b of p.blurs ?? []) {
      if (b.prepass && !names.includes(b.prepass.name)) {
        r.program(b.prepass.name, b.prepass.fragment);
        names.push(b.prepass.name);
      }
    }
  }
  return names;
}

declare global {
  interface Window {
    __kc: {
      ready: boolean;
      run: typeof runFloat;
      png: typeof runPng;
      compileAll: typeof compileAll;
      tempTintFromNeutral: typeof tempTintFromNeutral;
      linearToSrgb: typeof linearToSrgb;
      error?: string;
    };
  }
}

window.__kc = { ready: false, run: runFloat, png: runPng, compileAll, tempTintFromNeutral, linearToSrgb };
try {
  getRunner('16f');
  window.__kc.ready = true;
} catch (e) {
  window.__kc.error = String(e);
}
