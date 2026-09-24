/**
 * Panel ⇄ document binding.
 *
 * Every develop panel talks to the current photo through a `DocBinder`:
 * - it follows `ctx.doc` (photo switches, "no photo open") and re-subscribes to
 *   the new document's EditorStore,
 * - it dispatches store notifications only to watchers whose path prefixes
 *   intersect the changed paths, so a slider drag on Exposure never touches the
 *   Color Mixer DOM,
 * - it offers `paramSlider` / `paramSection` factories that implement the
 *   gesture contract (beginGesture → set → endGesture = one history entry).
 */
import type { AppContext, EditorDocument } from '@/app/context';
import type { ChangeInfo, EditorStoreApi } from '@/editor/contracts';
import { createDefaultParams, type ParamSpec } from '@/editor/defaults';
import { deepEqual, getPath, setPath, specForPath } from '@/editor/state';
import type { EditParams } from '@/editor/types';
import { Disposer } from '@/ui/dom';
import {
  createRangeSlider,
  createSection,
  createSlider,
  createToggle,
  type RangeSlider,
  type RangeSliderOptions,
  type Section,
  type SectionOptions,
  type Slider,
  type SliderOptions,
  type Toggle,
} from '@/ui/kit';

export type Watcher = (params: EditParams | null, info: ChangeInfo | null) => void;

interface WatchEntry {
  prefixes: string[] | null;
  fn: Watcher;
}

const defaultsCache = new Map<boolean, EditParams>();
/** Neutral params for RAW / non-RAW documents (cached, never mutate). */
export function defaultsFor(isRaw: boolean): EditParams {
  let d = defaultsCache.get(isRaw);
  if (!d) {
    d = createDefaultParams(isRaw);
    defaultsCache.set(isRaw, d);
  }
  return d;
}

/** True when a changed path touches a watched prefix (either is a prefix of the other). */
export function pathsIntersect(changed: readonly string[], prefixes: readonly string[]): boolean {
  for (const c of changed) {
    if (c === '*') return true;
    for (const w of prefixes) {
      if (c === w) return true;
      if (c.length > w.length ? c.startsWith(w) && c.charCodeAt(w.length) === 46 : w.startsWith(c) && w.charCodeAt(c.length) === 46) {
        return true;
      }
    }
  }
  return false;
}

export class DocBinder {
  readonly ctx: AppContext;
  private watchers = new Set<WatchEntry>();
  private docListeners = new Set<(doc: EditorDocument | null) => void>();
  private unsubStore: (() => void) | null = null;
  private unsubDoc: () => void;
  private _doc: EditorDocument | null = null;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
    this.unsubDoc = ctx.doc.subscribe((doc) => this.attach(doc));
    this.attach(ctx.doc.value, true);
  }

  get doc(): EditorDocument | null {
    return this._doc;
  }

  get store(): EditorStoreApi | null {
    return this._doc?.store ?? null;
  }

  get params(): EditParams | null {
    return this._doc?.store.params ?? null;
  }

  get defaults(): EditParams {
    return defaultsFor(this._doc?.isRaw ?? false);
  }

  private attach(doc: EditorDocument | null, first = false): void {
    if (!first && doc === this._doc) return;
    this.unsubStore?.();
    this.unsubStore = null;
    this._doc = doc;
    if (doc) {
      this.unsubStore = doc.store.subscribe((params, info) => this.dispatch(params, info));
    }
    for (const fn of [...this.docListeners]) fn(doc);
    const p = doc?.store.params ?? null;
    for (const w of [...this.watchers]) w.fn(p, null);
  }

  private dispatch(params: EditParams, info: ChangeInfo): void {
    for (const w of [...this.watchers]) {
      if (!w.prefixes || pathsIntersect(info.paths, w.prefixes)) w.fn(params, info);
    }
  }

  /**
   * Call `fn` whenever a path under one of `prefixes` changes (or the document
   * changes). `null` prefixes = every notification, including metadata-only
   * ones (history / snapshots). `fn` runs immediately with the current params.
   */
  watch(prefixes: string[] | null, fn: Watcher, immediate = true): () => void {
    const entry: WatchEntry = { prefixes, fn };
    this.watchers.add(entry);
    if (immediate) fn(this.params, null);
    return () => this.watchers.delete(entry);
  }

  /** Document switched (null = no photo open). Runs immediately. */
  onDoc(fn: (doc: EditorDocument | null) => void, immediate = true): () => void {
    this.docListeners.add(fn);
    if (immediate) fn(this._doc);
    return () => this.docListeners.delete(fn);
  }

  dispose(): void {
    this.unsubDoc();
    this.unsubStore?.();
    this.unsubStore = null;
    this.watchers.clear();
    this.docListeners.clear();
  }
}

/* ------------------------------------------------------------------ */
/* Slider bound to a params path                                        */
/* ------------------------------------------------------------------ */

export interface ParamSliderOptions extends Partial<Omit<SliderOptions, 'onInput' | 'onChange' | 'onGestureStart' | 'onGestureEnd' | 'value'>> {
  /** Explicit spec when the path has none in PARAM_SPECS / specForPath. */
  spec?: ParamSpec;
  /** Value transform store → slider (e.g. 0..1 → 0..100). */
  toUi?: (v: number) => number;
  fromUi?: (v: number) => number;
  /** Extra writes inside the same gesture before the value is set (e.g. WB mode → custom). */
  beforeSet?: (store: EditorStoreApi, params: EditParams) => void;
  /** Resolve the path lazily (mask sliders: index changes when masks are reordered). */
  resolvePath?: () => string | null;
}

/** Humanized fallback label from the last path segment. */
function labelFromPath(path: string): string {
  const last = path.slice(path.lastIndexOf('.') + 1);
  return last.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}

/**
 * A kit Slider wired to `store` at `path`:
 * onGestureStart → beginGesture(label), onInput → set(path, v), onGestureEnd → endGesture().
 * Wheel/keyboard bursts are gestures too (the kit coalesces them), so every
 * interaction is exactly one history step.
 */
export interface ParamSlider extends Slider {
  /** Re-read default and value (after a lazily resolved path changed). */
  resync(): void;
}

export function paramSlider(b: DocBinder, d: Disposer, path: string, o: ParamSliderOptions = {}): ParamSlider {
  const spec = o.spec ?? specForPath(path) ?? { min: -100, max: 100, step: 1, def: 0 };
  const toUi = o.toUi ?? ((v: number) => v);
  const fromUi = o.fromUi ?? ((v: number) => v);
  const label = o.label ?? labelFromPath(path);
  const currentPath = (): string | null => (o.resolvePath ? o.resolvePath() : path);
  const defAt = (p: string | null): number => {
    if (!p) return spec.def;
    const v = getPath(b.defaults, p);
    return typeof v === 'number' ? v : spec.def;
  };
  const slider = createSlider({
    step: spec.step,
    fineStep: spec.fine,
    unit: spec.unit ? (spec.unit === '°' ? '°' : ` ${spec.unit}`) : undefined,
    ...o,
    label,
    min: o.min ?? toUi(spec.min),
    max: o.max ?? toUi(spec.max),
    defaultValue: toUi(defAt(currentPath())),
    value: toUi(defAt(currentPath())),
    id: o.id ?? path,
    onGestureStart: () => b.store?.beginGesture(label),
    onInput: (v) => {
      const store = b.store;
      const p = currentPath();
      if (!store || !p) return;
      o.beforeSet?.(store, store.params);
      store.set(p, fromUi(v));
    },
    onGestureEnd: () => b.store?.endGesture(),
  });
  const sync = (params: EditParams | null): void => {
    const p = currentPath();
    slider.setDisabled(!params || !p);
    if (!params || !p) return;
    const v = getPath(params, p);
    if (typeof v === 'number') slider.setValue(toUi(v), true);
  };
  d.add(
    b.onDoc(() => {
      slider.setDefault(toUi(defAt(currentPath())));
    }),
  );
  // Lazily-resolved paths (masks) must re-sync on any change of their container.
  const watchPrefix = o.resolvePath ? path.split('.')[0] : path;
  d.add(b.watch([watchPrefix], (p) => sync(p)));
  d.add(() => slider.destroy());
  return Object.assign(slider, {
    resync() {
      slider.setDefault(toUi(defAt(currentPath())));
      sync(b.params);
    },
  });
}

/* ------------------------------------------------------------------ */
/* Section with group reset                                             */
/* ------------------------------------------------------------------ */

export interface ParamSectionOptions extends Omit<SectionOptions, 'onReset'> {
  /** Paths reset by the header button and checked for the "modified" dot. */
  paths: string[];
  /** Label of the reset history step (default "Reset <title>"). */
  resetLabel?: string;
}

/** Restore `paths` to the document's defaults in ONE history step. */
export function resetPaths(b: DocBinder, paths: string[], label: string): void {
  const store = b.store;
  if (!store) return;
  const defs = b.defaults;
  store.update(
    label,
    (draft) => {
      for (const p of paths) setPath(draft, p, structuredCloneSafe(getPath(defs, p)));
    },
    { coalesceKey: null },
  );
}

function structuredCloneSafe<T>(v: T): T {
  return v !== null && typeof v === 'object' ? structuredClone(v) : v;
}

export function isModifiedAt(b: DocBinder, params: EditParams, paths: string[]): boolean {
  const defs = b.defaults;
  for (const p of paths) if (!deepEqual(getPath(params, p), getPath(defs, p))) return true;
  return false;
}

export function paramSection(b: DocBinder, d: Disposer, o: ParamSectionOptions): Section {
  const section = createSection({
    ...o,
    onReset: () => resetPaths(b, o.paths, o.resetLabel ?? `Reset ${o.title}`),
    resetLabel: `Reset ${o.title}`,
  });
  d.add(b.watch(o.paths, (p) => section.setModified(!!p && isModifiedAt(b, p, o.paths))));
  d.add(() => section.destroy());
  return section;
}

/* ------------------------------------------------------------------ */
/* Toggle and range bound to params                                     */
/* ------------------------------------------------------------------ */

/** Switch bound to a boolean path (one history step per flip). */
export function paramToggle(b: DocBinder, d: Disposer, path: string, label: string, onLabel?: (on: boolean) => string): Toggle {
  const t = createToggle({
    label,
    size: 'sm',
    onChange: (on) => b.store?.set(path, on, { label: onLabel ? onLabel(on) : `${label} ${on ? 'On' : 'Off'}`, coalesceKey: null }),
  });
  t.el.dataset.id = path;
  d.add(
    b.watch([path], (p) => {
      t.setDisabled(!p);
      if (p) t.setChecked(!!getPath(p, path), true);
    }),
  );
  d.add(() => t.destroy());
  return t;
}

/** Two-thumb range bound to two numeric paths (lo, hi), with optional UI scaling. */
export function paramRange(
  b: DocBinder,
  d: Disposer,
  paths: [string, string],
  o: Omit<RangeSliderOptions, 'value' | 'onInput' | 'onGestureStart' | 'onGestureEnd' | 'onChange'> & {
    toUi?: (v: number) => number;
    fromUi?: (v: number) => number;
    resolvePaths?: () => [string, string] | null;
  },
): RangeSlider & { resync(): void } {
  const toUi = o.toUi ?? ((v: number) => v);
  const fromUi = o.fromUi ?? ((v: number) => v);
  const cur = (): [string, string] | null => (o.resolvePaths ? o.resolvePaths() : paths);
  const label = o.label ?? 'Range';
  const r = createRangeSlider({
    ...o,
    id: o.id ?? paths.join('|'),
    onGestureStart: () => b.store?.beginGesture(label),
    onInput: ([lo, hi]) => {
      const ps = cur();
      const store = b.store;
      if (!ps || !store) return;
      store.set(ps[0], fromUi(lo));
      store.set(ps[1], fromUi(hi));
    },
    onGestureEnd: () => b.store?.endGesture(),
  });
  const sync = (p: EditParams | null): void => {
    const ps = cur();
    r.setDisabled(!p || !ps);
    if (!p || !ps) return;
    const lo = getPath(p, ps[0]);
    const hi = getPath(p, ps[1]);
    if (typeof lo === 'number' && typeof hi === 'number') r.setValue([toUi(lo), toUi(hi)], true);
  };
  d.add(b.watch([o.resolvePaths ? paths[0].split('.')[0] : paths[0], paths[1]], sync));
  d.add(() => r.destroy());
  return Object.assign(r, { resync: () => sync(b.params) });
}
