/**
 * Settings groups: partial presets, copy/paste, sync, "modified" indicators.
 */
import { createDefaultParams } from '@/editor/defaults';
import type { EditParams, PartialParams, SettingsGroup } from '@/editor/types';
import { SETTINGS_GROUPS } from '@/editor/types';
import { collectDiff, deepClone, deepMerge, getPath, isPlainObject, setPath, type PlainObject } from './paths';
import { cloneParams, fixConsistency, normalizeParams } from './normalize';

/** Group → dot paths it owns. 'exposure' and 'tone' split `basic`. */
export const GROUP_PATHS: Record<SettingsGroup, string[]> = {
  exposure: ['basic.exposure'],
  tone: ['basic.contrast', 'basic.highlights', 'basic.shadows', 'basic.whites', 'basic.blacks'],
  whiteBalance: ['whiteBalance'],
  color: ['color'],
  hsl: ['hsl'],
  toneCurve: ['toneCurve'],
  colorGrading: ['colorGrading'],
  calibration: ['calibration'],
  presence: ['presence'],
  detail: ['detail'],
  noise: ['noise'],
  lens: ['lens'],
  transform: ['transform'],
  // crop.* also carries orientation, flips, straighten angle and the aspect lock.
  crop: ['crop'],
  effects: ['effects'],
  masks: ['masks'],
  retouch: ['retouch'],
};

/**
 * Settings that never change the rendered pixels (crop-tool UI preferences).
 * They are ignored when deciding whether a photo is edited.
 */
const COSMETIC_PATHS = new Set(['crop.overlay', 'crop.constrainToImage', 'crop.aspect', 'crop.customAspect']);
const isCosmetic = (p: string) => COSMETIC_PATHS.has(p) || p.startsWith('crop.customAspect.');

const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);

/** Groups a path belongs to ('basic' → exposure + tone; '*' or '' → every group). */
export function groupsForPath(path: string): SettingsGroup[] {
  if (path === '' || path === '*') return [...SETTINGS_GROUPS];
  return SETTINGS_GROUPS.filter((g) => GROUP_PATHS[g].some((gp) => overlaps(path, gp)));
}

/** Which groups a (sparse) partial touches. */
export function groupsFromPartial(partial: PartialParams): SettingsGroup[] {
  const set = new Set<SettingsGroup>();
  for (const g of SETTINGS_GROUPS) {
    for (const p of GROUP_PATHS[g]) if (getPath(partial, p) !== undefined) set.add(g);
  }
  return SETTINGS_GROUPS.filter((g) => set.has(g));
}

export function diffPaths(a: EditParams, b: EditParams): string[] {
  const out: string[] = [];
  collectDiff(a, b, '', out);
  return out;
}

/** Deep copy of the values of `groups` only (a complete partial for those groups). */
export function pickGroups(params: EditParams, groups: SettingsGroup[]): PartialParams {
  const out: PlainObject = {};
  for (const g of groups) {
    for (const p of GROUP_PATHS[g] ?? []) {
      const v = getPath(params, p);
      if (v !== undefined) setPath(out, p, deepClone(v));
    }
  }
  return out as PartialParams;
}

/** Restrict a sparse partial to the given groups' paths. */
export function filterPartial(partial: PartialParams, groups: SettingsGroup[]): PartialParams {
  const out: PlainObject = {};
  for (const g of groups) {
    for (const p of GROUP_PATHS[g] ?? []) {
      const v = getPath(partial, p);
      if (v !== undefined) setPath(out, p, deepClone(v));
    }
  }
  return out as PartialParams;
}

/**
 * Validate a partial of unknown provenance (imported presets, AI output):
 * every present leaf is type-checked and clamped exactly as normalizeParams
 * would, unknown keys and wrongly-typed values are dropped, and the result stays
 * sparse (only keys that were present).
 */
export function sanitizePartial(partial: unknown): PartialParams {
  if (!isPlainObject(partial)) return {};
  const full = normalizeParams(deepMerge(createDefaultParams(), partial));
  return intersect(full, partial) as PartialParams;
}

function intersect(full: unknown, shape: PlainObject): PlainObject {
  const out: PlainObject = {};
  if (!isPlainObject(full)) return out;
  for (const k of Object.keys(shape)) {
    if (!Object.prototype.hasOwnProperty.call(full, k) || k === 'version') continue;
    const f = full[k];
    const s = shape[k];
    if (isPlainObject(f)) {
      if (!isPlainObject(s)) continue;
      const sub = intersect(f, s);
      if (Object.keys(sub).length > 0) out[k] = sub;
    } else if (Array.isArray(f)) {
      if (Array.isArray(s)) out[k] = f;
    } else if (f === null || typeof f === 'string') {
      if (s === null || typeof s === 'string') out[k] = f;
    } else if (typeof f === 'number') {
      if (typeof s === 'number' ? Number.isFinite(s) : typeof s === 'string' && Number.isFinite(Number(s))) out[k] = f;
    } else if (typeof f === typeof s || (typeof f === 'boolean' && (s === 'true' || s === 'false'))) {
      out[k] = f;
    }
  }
  return out;
}

/**
 * Deep-merge a partial on top of `base` (arrays replace) and return an
 * independent, valid EditParams. With `groups`, only those groups' paths of the
 * partial are applied. The partial is sanitized first, so untrusted input
 * (imported presets) can never produce out-of-range params.
 */
export function applyPartial(base: EditParams, partial: PartialParams, groups?: SettingsGroup[]): EditParams {
  const scoped = groups ? filterPartial(partial, groups) : partial;
  const clean = sanitizePartial(scoped);
  const merged = deepMerge(cloneParams(base), clean);
  return fixConsistency(merged);
}

export function modifiedGroups(p: EditParams, isRaw = false): SettingsGroup[] {
  const diffs = diffPaths(p, createDefaultParams(isRaw)).filter((d) => !isCosmetic(d));
  const set = new Set<SettingsGroup>();
  for (const d of diffs) {
    if (d === '*') return [...SETTINGS_GROUPS];
    for (const g of groupsForPath(d)) set.add(g);
  }
  return SETTINGS_GROUPS.filter((g) => set.has(g));
}

export function isDefaultParams(p: EditParams, isRaw = false): boolean {
  return modifiedGroups(p, isRaw).length === 0;
}
