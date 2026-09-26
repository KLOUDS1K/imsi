/**
 * normalizeParams: turn anything (old saves, imported JSON, garbage) into a
 * valid EditParams — defaults filled in, every number finite and inside its
 * range, curves sorted/deduplicated, enums valid, unknown keys dropped, masks
 * and retouch sanitized. Idempotent on valid input.
 */
import { createDefaultParams, createMask, LOCAL_SPECS } from '@/editor/defaults';
import { normalizeCurve } from '@/editor/color/curves';
import type {
  AiMaskParams,
  BrushPoint,
  BrushStroke,
  CurvePoint,
  EditParams,
  HealSpot,
  LocalAdjustments,
  Mask,
  MaskComponent,
  Point,
  Rect,
  RemovalPatch,
  RGB,
} from '@/editor/types';
import { AI_MASK_TARGETS, HSL_CHANNELS } from '@/editor/types';
import { getPath, isPlainObject, joinPath, setPath, type PlainObject } from './paths';
import { clampToSpec, ENUMS, MIN_CROP } from './specs';

/* ------------------------------------------------------------------ */
/* Primitive coercion                                                  */
/* ------------------------------------------------------------------ */

/** Finite number from a number or numeric string, else undefined. */
export function toNum(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

const clampN = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

function num(v: unknown, def: number, lo = -Infinity, hi = Infinity): number {
  const n = toNum(v);
  return n === undefined ? def : clampN(n, lo, hi);
}

function bool(v: unknown, def: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 'True') return true;
  if (v === 'false' || v === 'False') return false;
  return def;
}

function str(v: unknown, def: string): string {
  return typeof v === 'string' ? v : def;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], def: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : def;
}

function uniqueId(base: string, used: Set<string>): string {
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  used.add(id);
  return id;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export function cloneParams(p: EditParams): EditParams {
  return structuredClone(p);
}

export function normalizeParams(input: unknown, isRaw = false): EditParams {
  const def = createDefaultParams(isRaw);
  const src = isPlainObject(input) ? migrate(input) : {};
  const out = normNode(def, src, '') as EditParams;
  out.version = 1;
  fixConsistency(out);
  return out;
}

/**
 * Repair cross-field invariants in place: ordered parametric splits, crop rect
 * inside the frame, defringe hue ranges ordered. Cheap; used after lerp/merge.
 */
export function fixConsistency(p: EditParams): EditParams {
  const pc = p.toneCurve.parametric;
  const splits = [pc.split1, pc.split2, pc.split3].sort((a, b) => a - b);
  [pc.split1, pc.split2, pc.split3] = splits;
  const c = p.crop;
  c.w = clampN(c.w, MIN_CROP, 1);
  c.h = clampN(c.h, MIN_CROP, 1);
  // Tolerate float noise (0.8 + 0.2 may exceed 1 by an ulp) instead of nudging valid rects.
  c.x = clampN(c.x, 0, 1);
  c.y = clampN(c.y, 0, 1);
  if (c.x + c.w > 1 + 1e-9) c.x = 1 - c.w;
  if (c.y + c.h > 1 + 1e-9) c.y = 1 - c.h;
  const d = p.lens.defringe;
  if (d.purpleHueMin > d.purpleHueMax) [d.purpleHueMin, d.purpleHueMax] = [d.purpleHueMax, d.purpleHueMin];
  if (d.greenHueMin > d.greenHueMax) [d.greenHueMin, d.greenHueMax] = [d.greenHueMax, d.greenHueMin];
  return p;
}

/* ------------------------------------------------------------------ */
/* Schema walk                                                         */
/* ------------------------------------------------------------------ */

type Special = (v: unknown, def: unknown) => unknown;

const SPECIAL: Record<string, Special> = {
  version: () => 1,
  'toneCurve.rgb': (v) => normCurvePoints(v),
  'toneCurve.red': (v) => normCurvePoints(v),
  'toneCurve.green': (v) => normCurvePoints(v),
  'toneCurve.blue': (v) => normCurvePoints(v),
  'crop.orientation': (v) => {
    const n = toNum(v);
    if (n === undefined) return 0;
    return ((((Math.round(n / 90) * 90) % 360) + 360) % 360) as 0 | 90 | 180 | 270;
  },
  'crop.customAspect': (v) => {
    if (Array.isArray(v) && v.length === 2) {
      const a = toNum(v[0]);
      const b = toNum(v[1]);
      if (a !== undefined && b !== undefined && a > 0 && b > 0) return [clampN(a, 0.01, 1000), clampN(b, 0.01, 1000)];
    }
    return [5, 7];
  },
  'lens.profileId': (v) => (typeof v === 'string' && v.length > 0 ? v : null),
  masks: (v) => normMasks(v),
  'retouch.spots': (v) => normSpots(v),
  'retouch.removals': (v) => normRemovals(v),
};

function normNode(def: unknown, v: unknown, path: string): unknown {
  const special = SPECIAL[path];
  if (special) return special(v, def);
  if (typeof def === 'number') {
    const n = toNum(v);
    return n === undefined ? def : clampToSpec(path, n);
  }
  if (typeof def === 'boolean') return bool(v, def);
  if (typeof def === 'string') {
    const allowed = ENUMS[path];
    if (typeof v !== 'string') return def;
    return !allowed || allowed.includes(v) ? v : def;
  }
  if (isPlainObject(def)) {
    const src = isPlainObject(v) ? v : {};
    const out: PlainObject = {};
    for (const k of Object.keys(def)) out[k] = normNode(def[k], src[k], joinPath(path, k));
    return out;
  }
  // Arrays / null without a special handler: keep the default.
  return structuredClone(def);
}

/* ------------------------------------------------------------------ */
/* Curves                                                              */
/* ------------------------------------------------------------------ */

export function normCurvePoints(v: unknown): CurvePoint[] {
  const pts: CurvePoint[] = [];
  if (Array.isArray(v)) {
    for (const p of v) {
      let x: number | undefined;
      let y: number | undefined;
      if (Array.isArray(p)) {
        x = toNum(p[0]);
        y = toNum(p[1]);
      } else if (isPlainObject(p)) {
        x = toNum(p.x);
        y = toNum(p.y);
      }
      if (x !== undefined && y !== undefined) pts.push({ x, y });
    }
  }
  return normalizeCurve(pts);
}

/* ------------------------------------------------------------------ */
/* Masks                                                               */
/* ------------------------------------------------------------------ */

const MASK_KINDS = ['brush', 'linear', 'radial', 'color-range', 'luminance-range', 'depth-range', 'ai'] as const;
const MASK_MODES = ['add', 'subtract', 'intersect'] as const;
/** Source-normalized coordinates may legitimately sit a little outside the image (gradients, strokes). */
const COORD_LO = -4;
const COORD_HI = 5;

function normMasks(v: unknown): Mask[] {
  if (!Array.isArray(v)) return [];
  const used = new Set<string>();
  const out: Mask[] = [];
  for (const raw of v) {
    if (!isPlainObject(raw)) continue;
    const n = out.length + 1;
    const id = uniqueId(typeof raw.id === 'string' && raw.id ? raw.id : `mask-${n}`, used);
    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name : `Mask ${n}`;
    const mask = createMask(name, id);
    mask.visible = bool(raw.visible, true);
    mask.invert = bool(raw.invert, false);
    mask.amount = num(raw.amount, 100, 0, 100);
    const adj = isPlainObject(raw.adjustments) ? raw.adjustments : {};
    for (const key of Object.keys(LOCAL_SPECS) as (keyof LocalAdjustments)[]) {
      const spec = LOCAL_SPECS[key];
      mask.adjustments[key] = num(adj[key], spec.def, spec.min, spec.max);
    }
    const compIds = new Set<string>();
    if (Array.isArray(raw.components)) {
      for (const c of raw.components) {
        const comp = normComponent(c, `${id}-c${mask.components.length + 1}`, compIds);
        if (comp) mask.components.push(comp);
      }
    }
    out.push(mask);
  }
  return out;
}

function normComponent(raw: unknown, fallbackId: string, used: Set<string>): MaskComponent | null {
  if (!isPlainObject(raw)) return null;
  const kind = oneOf(raw.kind, MASK_KINDS, 'brush');
  if (raw.kind !== kind) return null;
  const c: MaskComponent = {
    id: uniqueId(typeof raw.id === 'string' && raw.id ? raw.id : fallbackId, used),
    kind,
    mode: oneOf(raw.mode, MASK_MODES, 'add'),
    invert: bool(raw.invert, false),
  };
  switch (kind) {
    case 'brush': {
      const b = isPlainObject(raw.brush) ? raw.brush : {};
      c.brush = { strokes: normStrokes(b.strokes) };
      break;
    }
    case 'linear': {
      const l = isPlainObject(raw.linear) ? raw.linear : {};
      c.linear = {
        x0: num(l.x0, 0.5, COORD_LO, COORD_HI),
        y0: num(l.y0, 0.25, COORD_LO, COORD_HI),
        x1: num(l.x1, 0.5, COORD_LO, COORD_HI),
        y1: num(l.y1, 0.75, COORD_LO, COORD_HI),
      };
      break;
    }
    case 'radial': {
      const r = isPlainObject(raw.radial) ? raw.radial : {};
      c.radial = {
        cx: num(r.cx, 0.5, COORD_LO, COORD_HI),
        cy: num(r.cy, 0.5, COORD_LO, COORD_HI),
        rx: num(r.rx, 0.25, 0.001, 4),
        ry: num(r.ry, 0.25, 0.001, 4),
        angle: num(r.angle, 0, -360, 360),
        feather: num(r.feather, 50, 0, 100),
      };
      break;
    }
    case 'color-range': {
      const r = isPlainObject(raw.colorRange) ? raw.colorRange : {};
      const samples: RGB[] = [];
      if (Array.isArray(r.samples)) {
        for (const s of r.samples) {
          if (!Array.isArray(s) || s.length < 3) continue;
          const rgb = [toNum(s[0]), toNum(s[1]), toNum(s[2])];
          if (rgb.every((x) => x !== undefined)) samples.push(rgb.map((x) => clampN(x as number, 0, 1)) as RGB);
        }
      }
      c.colorRange = { samples, range: num(r.range, 50, 0, 100) };
      break;
    }
    case 'luminance-range': {
      const r = isPlainObject(raw.luminanceRange) ? raw.luminanceRange : {};
      const [min, max] = ordered(num(r.min, 0.5, 0, 1), num(r.max, 1, 0, 1));
      c.luminanceRange = { min, max, featherLow: num(r.featherLow, 0.1, 0, 1), featherHigh: num(r.featherHigh, 0, 0, 1) };
      break;
    }
    case 'depth-range': {
      const r = isPlainObject(raw.depthRange) ? raw.depthRange : {};
      const [min, max] = ordered(num(r.min, 0, 0, 1), num(r.max, 0.5, 0, 1));
      c.depthRange = { min, max, feather: num(r.feather, 0.1, 0, 1) };
      break;
    }
    case 'ai':
      c.ai = normAi(raw.ai);
      break;
  }
  return c;
}

const ordered = (a: number, b: number): [number, number] => (a <= b ? [a, b] : [b, a]);

function normAi(v: unknown): AiMaskParams {
  const a = isPlainObject(v) ? v : {};
  const out: AiMaskParams = {
    target: oneOf(a.target, AI_MASK_TARGETS, 'subject'),
    edgeShift: num(a.edgeShift, 0, -100, 100),
    feather: num(a.feather, 0, 0, 100),
  };
  const point = normPoint(a.point);
  if (point) out.point = point;
  const box = normRect(a.box);
  if (box) out.box = box;
  if (typeof a.bitmapKey === 'string' && a.bitmapKey) out.bitmapKey = a.bitmapKey;
  return out;
}

function normPoint(v: unknown): Point | null {
  if (!isPlainObject(v)) return null;
  const x = toNum(v.x);
  const y = toNum(v.y);
  return x === undefined || y === undefined ? null : { x: clampN(x, 0, 1), y: clampN(y, 0, 1) };
}

function normRect(v: unknown): Rect | null {
  if (!isPlainObject(v)) return null;
  const x = toNum(v.x);
  const y = toNum(v.y);
  const w = toNum(v.w);
  const h = toNum(v.h);
  if (x === undefined || y === undefined || w === undefined || h === undefined) return null;
  const cx = clampN(x, 0, 1);
  const cy = clampN(y, 0, 1);
  return { x: cx, y: cy, w: clampN(w, 0, 1 - cx), h: clampN(h, 0, 1 - cy) };
}

function normStrokes(v: unknown): BrushStroke[] {
  if (!Array.isArray(v)) return [];
  const out: BrushStroke[] = [];
  for (const s of v) {
    const st = normStroke(s);
    if (st) out.push(st);
  }
  return out;
}

function normStroke(v: unknown): BrushStroke | null {
  if (!isPlainObject(v) || !Array.isArray(v.points)) return null;
  const points: BrushPoint[] = [];
  for (const p of v.points) {
    if (!isPlainObject(p)) continue;
    const x = toNum(p.x);
    const y = toNum(p.y);
    if (x === undefined || y === undefined) continue;
    const bp: BrushPoint = { x: clampN(x, COORD_LO, COORD_HI), y: clampN(y, COORD_LO, COORD_HI) };
    const pr = toNum(p.pressure);
    if (pr !== undefined) bp.pressure = clampN(pr, 0, 1);
    points.push(bp);
  }
  if (points.length === 0) return null;
  return {
    points,
    size: num(v.size, 0.02, 0.0005, 1),
    feather: num(v.feather, 50, 0, 100),
    flow: num(v.flow, 100, 0, 100),
    density: num(v.density, 100, 0, 100),
    erase: bool(v.erase, false),
  };
}

/* ------------------------------------------------------------------ */
/* Retouch                                                             */
/* ------------------------------------------------------------------ */

function normSpots(v: unknown): HealSpot[] {
  if (!Array.isArray(v)) return [];
  const used = new Set<string>();
  const out: HealSpot[] = [];
  for (const s of v) {
    if (!isPlainObject(s)) continue;
    const x = toNum(s.x);
    const y = toNum(s.y);
    if (x === undefined || y === undefined) continue;
    const cx = clampN(x, 0, 1);
    const cy = clampN(y, 0, 1);
    out.push({
      id: uniqueId(typeof s.id === 'string' && s.id ? s.id : `spot-${out.length + 1}`, used),
      kind: oneOf(s.kind, ['heal', 'clone', 'content-aware'] as const, 'heal'),
      x: cx,
      y: cy,
      sx: num(s.sx, cx, 0, 1),
      sy: num(s.sy, cy, 0, 1),
      radius: num(s.radius, 0.02, 0.0005, 0.5),
      feather: num(s.feather, 50, 0, 100),
      opacity: num(s.opacity, 100, 0, 100),
    });
  }
  return out;
}

function normRemovals(v: unknown): RemovalPatch[] {
  if (!Array.isArray(v)) return [];
  const used = new Set<string>();
  const out: RemovalPatch[] = [];
  for (const r of v) {
    if (!isPlainObject(r) || typeof r.patchKey !== 'string' || !r.patchKey) continue;
    const bbox = normRect(r.bbox);
    if (!bbox) continue;
    out.push({
      id: uniqueId(typeof r.id === 'string' && r.id ? r.id : `removal-${out.length + 1}`, used),
      kind: oneOf(r.kind, ['ai-remove', 'generative', 'dust'] as const, 'ai-remove'),
      bbox,
      strokes: normStrokes(r.strokes),
      patchKey: r.patchKey,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Migration                                                           */
/* ------------------------------------------------------------------ */

/** Flat / legacy key → current path (version 0 and hand-written JSON). */
const LEGACY_KEYS: Record<string, string> = {
  exposure: 'basic.exposure',
  contrast: 'basic.contrast',
  highlights: 'basic.highlights',
  shadows: 'basic.shadows',
  whites: 'basic.whites',
  blacks: 'basic.blacks',
  temperature: 'whiteBalance.temperature',
  tint: 'whiteBalance.tint',
  vibrance: 'color.vibrance',
  saturation: 'color.saturation',
  texture: 'presence.texture',
  clarity: 'presence.clarity',
  dehaze: 'presence.dehaze',
  sharpness: 'detail.sharpenAmount',
  vignette: 'effects.vignetteAmount',
  grain: 'effects.grainAmount',
  'basic.temperature': 'whiteBalance.temperature',
  'basic.tint': 'whiteBalance.tint',
  'basic.vibrance': 'color.vibrance',
  'basic.saturation': 'color.saturation',
  'basic.texture': 'presence.texture',
  'basic.clarity': 'presence.clarity',
  'basic.dehaze': 'presence.dehaze',
};

/**
 * Upgrade older layouts to version 1. Version 1 input passes through
 * untouched; unversioned/0 input gets flat keys moved into their groups,
 * array-shaped tone curves / HSL tables and edge-based crops converted.
 */
function migrate(input: PlainObject): PlainObject {
  const version = toNum(input.version);
  if (version !== undefined && version >= 1) return input;
  const src = structuredClone(input) as PlainObject;
  for (const [from, to] of Object.entries(LEGACY_KEYS)) {
    const v = getPath(src, from);
    if (v === undefined || getPath(src, to) !== undefined) continue;
    if (!isPlainObject(src[to.split('.')[0]]) && src[to.split('.')[0]] !== undefined) continue;
    setPath(src, to, v);
  }
  if (Array.isArray(src.toneCurve)) src.toneCurve = { rgb: src.toneCurve };
  if (Array.isArray(src.hsl)) {
    const arr = src.hsl as unknown[];
    const hsl: PlainObject = {};
    HSL_CHANNELS.forEach((ch, i) => {
      if (arr[i] !== undefined) hsl[ch] = arr[i];
    });
    src.hsl = hsl;
  }
  const crop = src.crop;
  if (isPlainObject(crop) && crop.x === undefined && crop.left !== undefined) {
    const l = toNum(crop.left) ?? 0;
    const t = toNum(crop.top) ?? 0;
    const r = toNum(crop.right) ?? 1;
    const b = toNum(crop.bottom) ?? 1;
    Object.assign(crop, { x: l, y: t, w: r - l, h: b - t });
  }
  return src;
}
