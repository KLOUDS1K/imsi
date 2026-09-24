/**
 * Shared services behind AppContext: persistent AI-mask and patch stores,
 * presets, KLOUD Style models and export settings.
 *
 * Persistence model
 * - AI mask bitmaps live in the 'maskBitmaps' store and removal-patch pixels in
 *   'patches', both keyed by the key stored in the edit params
 *   (AiMaskParams.bitmapKey / RemovalPatch.patchKey). Writes happen in the
 *   background when a producer calls `set`; `restore(keys)` loads the ones an
 *   opened photo references before its first render. The library deletes
 *   orphaned keys when photos are removed.
 */
import type { AiMaskStore, KloudDB, PatchProvider } from '@/editor/contracts';
import type { ExportSettings, MaskBitmap, PixelBuffer, Preset, StyleModel } from '@/editor/types';
import { createDefaultExportSettings } from '@/editor/defaults';
import { BUILTIN_PRESETS } from '@/editor/presets';
import { loadSetting, saveSetting } from '@/editor/storage';
import { Signal } from '@/ui/signal';

/* ------------------------------------------------------------------ */
/* AI mask store                                                       */
/* ------------------------------------------------------------------ */

export interface PersistentAiMaskStore extends AiMaskStore {
  /** Load the given keys from IndexedDB into memory (skips keys already loaded). */
  restore(keys: Iterable<string>): Promise<void>;
  /** Keep a bitmap in memory only (e.g. per-session depth maps). */
  setVolatile(key: string, bmp: MaskBitmap): void;
}

/** In-memory AiMaskStore used when the masks module is unavailable. */
export function createMemoryAiMaskStore(): AiMaskStore {
  const map = new Map<string, MaskBitmap>();
  const listeners = new Set<(key: string) => void>();
  const emit = (key: string): void => {
    for (const l of [...listeners]) l(key);
  };
  return {
    get: (key) => map.get(key),
    set(key, bmp) {
      map.set(key, bmp);
      emit(key);
    },
    delete(key) {
      if (map.delete(key)) emit(key);
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

function isMaskBitmap(v: unknown): v is MaskBitmap {
  const b = v as MaskBitmap | undefined;
  return !!b && typeof b === 'object' && typeof b.width === 'number' && typeof b.height === 'number' && b.data instanceof Uint8Array;
}

/** Wraps an AiMaskStore so `set`/`delete` are mirrored to the 'maskBitmaps' store. */
export function createPersistentAiMaskStore(base: AiMaskStore, db: KloudDB): PersistentAiMaskStore {
  const persist = (key: string, bmp: MaskBitmap): void => {
    db.put('maskBitmaps', key, bmp).catch((err: unknown) => console.warn('[kloud] could not persist AI mask', key, err));
  };
  return {
    get: (key) => base.get(key),
    set(key, bmp) {
      base.set(key, bmp);
      persist(key, bmp);
    },
    setVolatile(key, bmp) {
      base.set(key, bmp);
    },
    delete(key) {
      base.delete(key);
      db.delete('maskBitmaps', key).catch(() => undefined);
    },
    onChange: (cb) => base.onChange(cb),
    async restore(keys) {
      const missing = [...new Set(keys)].filter((k) => k && !base.get(k));
      await Promise.all(
        missing.map(async (key) => {
          try {
            const v = await db.get<unknown>('maskBitmaps', key);
            if (isMaskBitmap(v) && !base.get(key)) base.set(key, v);
          } catch (err) {
            console.warn('[kloud] could not restore AI mask', key, err);
          }
        }),
      );
    },
  };
}

/* ------------------------------------------------------------------ */
/* Patch store (removal patches)                                       */
/* ------------------------------------------------------------------ */

export type PatchStore = PatchProvider & {
  set(key: string, px: PixelBuffer): void;
  delete(key: string): void;
  keys(): string[];
};

export interface PersistentPatchStore extends PatchStore {
  restore(keys: Iterable<string>): Promise<void>;
  /** Fires after set/delete/restore (the renderer invalidates its output). */
  onChange(cb: () => void): () => void;
}

export function createMemoryPatchStore(): PatchStore {
  const map = new Map<string, PixelBuffer>();
  return {
    getPatch: (key) => map.get(key) ?? null,
    set: (key, px) => void map.set(key, px),
    delete: (key) => void map.delete(key),
    keys: () => [...map.keys()],
  };
}

function isPixelBuffer(v: unknown): v is PixelBuffer {
  const p = v as PixelBuffer | undefined;
  return !!p && typeof p === 'object' && typeof p.width === 'number' && typeof p.height === 'number' && ArrayBuffer.isView(p.data);
}

export function createPersistentPatchStore(base: PatchStore, db: KloudDB): PersistentPatchStore {
  const listeners = new Set<() => void>();
  const emit = (): void => {
    for (const l of [...listeners]) l();
  };
  return {
    getPatch: (key) => base.getPatch(key),
    keys: () => base.keys(),
    set(key, px) {
      base.set(key, px);
      db.put('patches', key, px).catch((err: unknown) => console.warn('[kloud] could not persist patch', key, err));
      emit();
    },
    delete(key) {
      base.delete(key);
      db.delete('patches', key).catch(() => undefined);
      emit();
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    async restore(keys) {
      const missing = [...new Set(keys)].filter((k) => k && !base.getPatch(k));
      let any = false;
      await Promise.all(
        missing.map(async (key) => {
          try {
            const v = await db.get<unknown>('patches', key);
            if (isPixelBuffer(v)) {
              base.set(key, v);
              any = true;
            }
          } catch (err) {
            console.warn('[kloud] could not restore patch', key, err);
          }
        }),
      );
      if (any) emit();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Presets                                                             */
/* ------------------------------------------------------------------ */

function isPreset(v: unknown): v is Preset {
  const p = v as Preset | undefined;
  return !!p && typeof p === 'object' && typeof p.id === 'string' && typeof p.name === 'string' && !!p.params && Array.isArray(p.groups);
}

export interface PresetService {
  presets: Signal<Preset[]>;
  save(preset: Preset): Promise<void>;
  remove(id: string): Promise<void>;
}

/** Built-in presets first (their authored order), then user presets by name. */
function sortPresets(list: Preset[]): Preset[] {
  const builtin = list.filter((p) => p.builtin);
  const user = list.filter((p) => !p.builtin).sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
  return [...builtin, ...user];
}

export async function createPresetService(db: KloudDB): Promise<PresetService> {
  let user: Preset[] = [];
  try {
    user = (await db.getAll<unknown>('presets')).filter(isPreset).filter((p) => !p.builtin);
  } catch (err) {
    console.warn('[kloud] could not load presets', err);
  }
  const presets = new Signal<Preset[]>(sortPresets([...BUILTIN_PRESETS, ...user]));
  return {
    presets,
    async save(preset) {
      if (preset.builtin) throw new Error('Built-in presets cannot be modified. Save a copy instead.');
      const next: Preset = { ...preset, updated: Date.now() };
      await db.put('presets', next.id, next);
      presets.set(sortPresets([...presets.value.filter((p) => p.id !== next.id), next]));
    },
    async remove(id) {
      const p = presets.value.find((x) => x.id === id);
      if (!p || p.builtin) return;
      await db.delete('presets', id);
      presets.set(presets.value.filter((x) => x.id !== id));
    },
  };
}

/* ------------------------------------------------------------------ */
/* KLOUD Style models                                                  */
/* ------------------------------------------------------------------ */

function isStyleModel(v: unknown): v is StyleModel {
  const m = v as StyleModel | undefined;
  return !!m && typeof m === 'object' && typeof m.id === 'string' && Array.isArray(m.paramPaths) && Array.isArray(m.weights);
}

export interface StyleModelService {
  models: Signal<StyleModel[]>;
  save(model: StyleModel): Promise<void>;
  /** Add the built-in house style once the (lazy) style module has loaded. */
  setBuiltin(model: StyleModel): void;
}

export async function createStyleModelService(db: KloudDB): Promise<StyleModelService> {
  let stored: StyleModel[] = [];
  try {
    stored = (await db.getAll<unknown>('styleModels')).filter(isStyleModel).filter((m) => !m.builtin);
  } catch (err) {
    console.warn('[kloud] could not load style models', err);
  }
  const order = (list: StyleModel[]): StyleModel[] => [
    ...list.filter((m) => m.builtin),
    ...list.filter((m) => !m.builtin).sort((a, b) => a.created - b.created),
  ];
  const models = new Signal<StyleModel[]>(order(stored));
  return {
    models,
    async save(model) {
      if (model.builtin) {
        // The house style is hand-authored; keep edits in memory only.
        models.set(order([...models.value.filter((m) => m.id !== model.id), model]));
        return;
      }
      await db.put('styleModels', model.id, model);
      models.set(order([...models.value.filter((m) => m.id !== model.id), model]));
    },
    setBuiltin(model) {
      if (models.value.some((m) => m.id === model.id)) return;
      models.set(order([model, ...models.value]));
    },
  };
}

/* ------------------------------------------------------------------ */
/* Export settings (persisted app setting)                             */
/* ------------------------------------------------------------------ */

export const EXPORT_SETTINGS_KEY = 'exportSettings';

export async function createExportSettings(db: KloudDB): Promise<{ signal: Signal<ExportSettings>; dispose(): void }> {
  const defaults = createDefaultExportSettings();
  const loaded = await loadSetting<ExportSettings>(db, EXPORT_SETTINGS_KEY, defaults);
  // Nested objects are merged one level deeper than loadSetting does, so new fields get defaults.
  const merged: ExportSettings = {
    ...defaults,
    ...loaded,
    resize: { ...defaults.resize, ...(loaded.resize ?? {}) },
    watermark: { ...defaults.watermark, ...(loaded.watermark ?? {}) },
    outputSharpening: { ...defaults.outputSharpening, ...(loaded.outputSharpening ?? {}) },
  };
  const signal = new Signal<ExportSettings>(merged);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const off = signal.subscribe((v) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      saveSetting(db, EXPORT_SETTINGS_KEY, v).catch((err: unknown) => console.warn('[kloud] could not save export settings', err));
    }, 300);
  });
  return {
    signal,
    dispose() {
      off();
      if (timer) {
        clearTimeout(timer);
        timer = null;
        void saveSetting(db, EXPORT_SETTINGS_KEY, signal.value).catch(() => undefined);
      }
    },
  };
}
