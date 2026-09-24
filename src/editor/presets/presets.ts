/**
 * Preset operations: create, apply with amount, conditional matching,
 * export (.kloudpreset JSON / Lightroom XMP) and import (ours, single-preset
 * JSON, edit files, Lightroom .xmp and legacy .lrtemplate).
 */
import { createDefaultParams } from '@/editor/defaults';
import {
  applyPartial,
  crsValuesToParams,
  filterPartial,
  groupsFromPartial,
  isPlainObject,
  lerpParams,
  modifiedGroups,
  normalizeParams,
  paramsToXmp,
  pickGroups,
  sanitizePartial,
  xmpToParams,
  type XmpReadResult,
} from '@/editor/state';
import type { EditParams, PhotoMeta, Preset, PresetConditions, SettingsGroup } from '@/editor/types';
import { SETTINGS_GROUPS } from '@/editor/types';
import { parseLrTemplate } from './lrtemplate';

export const PRESET_FILE_FORMAT = 'kloud-presets';
export const PRESET_FILE_VERSION = 1;
export const PRESET_FILE_EXTENSION = '.kloudpreset';
export const USER_PRESET_GROUP = 'User Presets';
export const IMPORTED_PRESET_GROUP = 'Imported';

export interface PresetFile {
  format: typeof PRESET_FILE_FORMAT;
  version: typeof PRESET_FILE_VERSION;
  presets: Preset[];
}

let idSeq = 0;
function newPresetId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return `preset-${c.randomUUID()}`;
  return `preset-${Date.now().toString(36)}-${(idSeq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const isGroup = (g: unknown): g is SettingsGroup => typeof g === 'string' && (SETTINGS_GROUPS as readonly string[]).includes(g);

/** Unique, valid groups in canonical order. */
function cleanGroups(groups: readonly unknown[]): SettingsGroup[] {
  const set = new Set(groups.filter(isGroup));
  return SETTINGS_GROUPS.filter((g) => set.has(g));
}

export function sanitizeConditions(c: unknown): PresetConditions | undefined {
  if (!isPlainObject(c)) return undefined;
  const out: PresetConditions = {};
  if (typeof c.camera === 'string' && c.camera.trim()) out.camera = c.camera.trim();
  if (typeof c.lens === 'string' && c.lens.trim()) out.lens = c.lens.trim();
  const isoMin = Number(c.isoMin);
  const isoMax = Number(c.isoMax);
  if (c.isoMin !== undefined && c.isoMin !== null && Number.isFinite(isoMin) && isoMin >= 0) out.isoMin = isoMin;
  if (c.isoMax !== undefined && c.isoMax !== null && Number.isFinite(isoMax) && isoMax >= 0) out.isoMax = isoMax;
  if (c.autoApply === true) out.autoApply = true;
  return Object.keys(out).length ? out : undefined;
}

/* ------------------------------------------------------------------ */
/* Create / apply                                                      */
/* ------------------------------------------------------------------ */

export function createPreset(
  name: string,
  params: EditParams,
  groups: SettingsGroup[],
  opts: { group?: string; conditions?: Preset['conditions'] } = {},
): Preset {
  const now = Date.now();
  const gs = cleanGroups(groups);
  const preset: Preset = {
    id: newPresetId(),
    name: name.trim() || 'Untitled Preset',
    group: opts.group?.trim() || USER_PRESET_GROUP,
    builtin: false,
    groups: gs,
    params: pickGroups(params, gs),
    created: now,
    updated: now,
  };
  const cond = sanitizeConditions(opts.conditions);
  if (cond) preset.conditions = cond;
  return preset;
}

/**
 * Apply a preset at `amount` % (0..200). 100 = as authored; below 100 blends
 * from the current look toward it; above 100 extrapolates past it (clamped to
 * each slider's range). Only the preset's groups can change.
 */
export function applyPreset(current: EditParams, preset: Preset, amount = 100): EditParams {
  const groups = preset.groups?.length ? cleanGroups(preset.groups) : groupsFromPartial(preset.params);
  const target = applyPartial(current, preset.params, groups);
  const a = Number.isFinite(amount) ? Math.max(0, Math.min(200, amount)) : 100;
  if (a === 100) return target;
  return lerpParams(current, target, a / 100);
}

/** History label for a preset application: "Preset: KLOUD Night Drive (80%)". */
export function presetLabel(preset: Pick<Preset, 'name'>, amount = 100): string {
  const a = Math.round(amount);
  return a === 100 ? `Preset: ${preset.name}` : `Preset: ${preset.name} (${a}%)`;
}

/* ------------------------------------------------------------------ */
/* Conditional presets                                                 */
/* ------------------------------------------------------------------ */

/** Case-insensitive substring, or /regex/flags (defaults to the i flag). */
export function matchPattern(pattern: string, candidates: (string | undefined)[]): boolean {
  const values = candidates.filter((c): c is string => !!c);
  if (values.length === 0) return false;
  const m = /^\/(.+)\/([a-z]*)$/.exec(pattern.trim());
  if (m) {
    try {
      const flags = (m[2] || 'i').replace(/[gy]/g, '');
      const re = new RegExp(m[1], flags);
      return values.some((v) => re.test(v));
    } catch {
      // Invalid regex → fall back to a plain substring match of the whole pattern.
    }
  }
  const p = pattern.trim().toLowerCase();
  return values.some((v) => v.toLowerCase().includes(p));
}

function conditionCount(c: PresetConditions): number {
  return (c.camera ? 1 : 0) + (c.lens ? 1 : 0) + (c.isoMin !== undefined ? 1 : 0) + (c.isoMax !== undefined ? 1 : 0);
}

export function presetMatches(c: PresetConditions, meta: PhotoMeta): boolean {
  if (conditionCount(c) === 0) return false;
  if (c.camera) {
    const makeModel = [meta.make, meta.model].filter(Boolean).join(' ');
    if (!matchPattern(c.camera, [meta.camera, meta.model, makeModel])) return false;
  }
  if (c.lens) {
    const full = [meta.lensMake, meta.lens].filter(Boolean).join(' ');
    if (!matchPattern(c.lens, [meta.lens, full])) return false;
  }
  if (c.isoMin !== undefined || c.isoMax !== undefined) {
    const iso = meta.iso;
    if (iso === undefined || !Number.isFinite(iso)) return false;
    if (c.isoMin !== undefined && iso < c.isoMin) return false;
    if (c.isoMax !== undefined && iso > c.isoMax) return false;
  }
  return true;
}

/**
 * Presets whose conditions match the photo. Auto-apply presets come first,
 * then more specific ones (more conditions); otherwise the input order is kept.
 */
export function matchConditionalPresets(presets: Preset[], meta: PhotoMeta): Preset[] {
  return presets
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => !!p.conditions && presetMatches(p.conditions, meta))
    .sort((a, b) => {
      const auto = Number(!!b.p.conditions?.autoApply) - Number(!!a.p.conditions?.autoApply);
      if (auto) return auto;
      const spec = conditionCount(b.p.conditions as PresetConditions) - conditionCount(a.p.conditions as PresetConditions);
      return spec || a.i - b.i;
    })
    .map(({ p }) => p);
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

export function exportPresets(presets: Preset[]): Blob {
  const file: PresetFile = { format: PRESET_FILE_FORMAT, version: PRESET_FILE_VERSION, presets };
  return new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
}

/** A Lightroom-compatible XMP develop preset (crs: settings of the preset's groups). */
export function presetToXmp(preset: Preset): string {
  const groups = preset.groups?.length ? cleanGroups(preset.groups) : groupsFromPartial(preset.params);
  const full = applyPartial(createDefaultParams(), preset.params, groups);
  return paramsToXmp(full, undefined, { name: preset.name, group: preset.group, groups, conditions: preset.conditions });
}

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

const baseName = (fileName: string) => fileName.replace(/^.*[\\/]/, '').replace(/\.(kloudpreset|json|xmp|lrtemplate)$/i, '').trim();

function fromXmpResult(r: XmpReadResult, fallbackName: string): Preset | null {
  if (r.groups.length === 0) return null;
  const now = Date.now();
  const preset: Preset = {
    id: newPresetId(),
    name: r.name?.trim() || fallbackName || 'Imported Preset',
    group: IMPORTED_PRESET_GROUP,
    builtin: false,
    groups: r.groups,
    params: filterPartial(r.params, r.groups),
    created: now,
    updated: now,
  };
  if (r.conditions) preset.conditions = r.conditions;
  return preset;
}

function fromJsonPreset(raw: unknown, fallbackName: string): Preset | null {
  if (!isPlainObject(raw) || !isPlainObject(raw.params)) return null;
  const params = sanitizePartial(raw.params);
  let groups = Array.isArray(raw.groups) ? cleanGroups(raw.groups) : [];
  if (groups.length === 0) groups = groupsFromPartial(params);
  if (groups.length === 0) return null;
  const now = Date.now();
  const preset: Preset = {
    id: newPresetId(),
    name: (typeof raw.name === 'string' && raw.name.trim()) || fallbackName || 'Imported Preset',
    group: IMPORTED_PRESET_GROUP,
    builtin: false,
    groups,
    params: filterPartial(params, groups),
    created: now,
    updated: now,
  };
  const cond = sanitizeConditions(raw.conditions);
  if (cond) preset.conditions = cond;
  return preset;
}

/**
 * Parse preset file contents. `fileName` is used to sniff the format and as the
 * fallback name. Throws an Error with a user-readable message when nothing
 * usable is found.
 */
export function parsePresetText(text: string, fileName = ''): Preset[] {
  const src = text.replace(/^﻿/, '');
  const trimmed = src.trim();
  const fallback = baseName(fileName);
  if (!trimmed) throw new Error('The preset file is empty.');

  if (/\.lrtemplate$/i.test(fileName) || /^s\s*=\s*\{/.test(trimmed)) {
    const t = parseLrTemplate(src);
    const p = t ? fromXmpResult(crsValuesToParams(t.values), t.title ?? fallback) : null;
    if (t?.title && p) p.name = t.title;
    if (!p) throw new Error('No develop settings found in this Lightroom template.');
    return [p];
  }

  if (/\.xmp$/i.test(fileName) || trimmed.startsWith('<')) {
    const p = fromXmpResult(xmpToParams(src), fallback);
    if (!p) throw new Error('No Lightroom develop settings found in this XMP file.');
    return [p];
  }

  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    throw new Error('Unrecognised preset file (expected .kloudpreset, .json, .xmp or .lrtemplate).');
  }
  let list: unknown[] = [];
  if (isPlainObject(data) && data.format === PRESET_FILE_FORMAT && Array.isArray(data.presets)) list = data.presets;
  else if (Array.isArray(data)) list = data;
  else if (isPlainObject(data) && isPlainObject(data.params) && data.format === 'kloud-edit') {
    // An edit sidecar: turn its modified groups into a preset.
    const params = normalizeParams(data.params);
    const groups = modifiedGroups(params).filter((g) => g !== 'masks' && g !== 'retouch' && g !== 'crop');
    list = [{ name: fallback, groups, params: pickGroups(params, groups) }];
  } else if (isPlainObject(data)) list = [data];

  const presets = list.map((raw) => fromJsonPreset(raw, fallback)).filter((p): p is Preset => p !== null);
  if (presets.length === 0) throw new Error('No valid presets found in this file.');
  return presets;
}

/** Accepts .kloudpreset/.json (ours), Lightroom .xmp presets/sidecars and legacy .lrtemplate files. */
export async function importPresetFile(file: File): Promise<Preset[]> {
  return parsePresetText(await file.text(), file.name);
}
