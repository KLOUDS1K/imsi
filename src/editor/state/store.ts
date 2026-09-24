/**
 * EditorStore — the per-photo edit state: immutable params snapshots, history
 * with coalescing and gestures, snapshots, persistence.
 *
 * Immutability: `params` is a snapshot that is never mutated. Every change
 * produces a new root that shares all unchanged subtrees with the previous one
 * (set() copies along the path; update()/replace() reconcile against the
 * previous snapshot), so history entries cost only the changed nodes and
 * diffing two snapshots is O(changes). In development builds (and tests) the
 * snapshots are deep-frozen, so a listener that tries to mutate them throws.
 * In production they are not frozen for speed — treat them as read-only.
 *
 * ChangeInfo.paths: exact changed dot paths for set/update/replace/undo/redo/
 * history/snapshot/reset; ['*'] for load(); [] when only metadata changed (history
 * cleared, snapshot created/renamed/deleted) — params are unchanged then.
 */
import { createDefaultParams } from '@/editor/defaults';
import type { ChangeInfo, EditorStoreApi, SetOptions } from '@/editor/contracts';
import type { EditParams, HistoryEntry, SerializedEditState, Snapshot } from '@/editor/types';
import { changeLabel } from './labels';
import { cloneParams, normalizeParams, normCurvePoints, toNum } from './normalize';
import { collectDiff, deepFreeze, getPath, reconcile, setIn } from './paths';
import { clampToSpec, CURVE_PATHS, specForPath } from './specs';

/** Changes with the same coalesce key closer than this merge into one entry. */
export const COALESCE_MS = 1200;
export const DEFAULT_MAX_HISTORY = 200;
/** History entries written by serialize(). */
export const SERIALIZED_HISTORY = 50;
/**
 * Upper bound of brush/removal stroke points summed over serialized history
 * entries. Structured clone (IndexedDB) stores shared stroke arrays once, but a
 * JSON sidecar repeats them per entry — this keeps both bounded.
 */
export const SERIALIZED_POINT_BUDGET = 400_000;

const FREEZE: boolean = (() => {
  try {
    return import.meta.env?.DEV === true;
  } catch {
    return false;
  }
})();

type Source = ChangeInfo['source'];
type Listener = (params: EditParams, info: ChangeInfo) => void;

interface Gesture {
  label: string;
  entry: HistoryEntry | null;
  paths: Set<string>;
  changed: boolean;
  lastSource: Source;
  /** The single path all set() calls targeted (undefined = none yet, null = mixed/update). */
  singlePath: string | null | undefined;
  autoLabel: string;
}

interface CommitMeta {
  label: string;
  paths: string[];
  source: Source;
  coalesceKey: string | null;
  transient: boolean;
  /** set() to one path with a derived label (gestures then show the value). */
  autoPath?: string;
}

export class EditorStore implements EditorStoreApi {
  readonly isRaw: boolean;
  readonly maxHistory: number;
  private _params: EditParams;
  private _history: readonly HistoryEntry[];
  private _index = 0;
  private _snapshots: readonly Snapshot[] = Object.freeze([]);
  private nextEntryId = 0;
  private snapshotSeq = 0;
  private gesture: Gesture | null = null;
  private lastCoalesce: { key: string; entryId: number } | null = null;
  private listeners = new Set<Listener>();

  constructor(initial?: EditParams, opts: { isRaw?: boolean; maxHistory?: number } = {}) {
    this.isRaw = !!opts.isRaw;
    this.maxHistory = Math.max(2, Math.floor(opts.maxHistory ?? DEFAULT_MAX_HISTORY));
    this._params = freeze(normalizeParams(initial ?? createDefaultParams(this.isRaw), this.isRaw));
    this._history = Object.freeze([this.makeEntry('Import', this._params, Date.now())]);
  }

  /* ---------------------------------------------------------------- */
  /* Reading                                                           */
  /* ---------------------------------------------------------------- */

  get params(): EditParams {
    return this._params;
  }

  get<T = unknown>(path: string): T {
    return getPath(this._params, path) as T;
  }

  get gestureActive(): boolean {
    return this.gesture !== null;
  }

  /** Immutable array; a new array identity after every history change. */
  get history(): readonly HistoryEntry[] {
    return this._history;
  }

  get historyIndex(): number {
    return this._index;
  }

  get snapshots(): readonly Snapshot[] {
    return this._snapshots;
  }

  /** True when transient updates moved params away from the current history entry. */
  get dirty(): boolean {
    return this._params !== this._history[this._index].params;
  }

  /* ---------------------------------------------------------------- */
  /* Writing                                                           */
  /* ---------------------------------------------------------------- */

  set(path: string, value: unknown, opts: SetOptions = {}): void {
    if (!path) throw new Error('EditorStore.set: empty path (use replace())');
    const clean = sanitizeValue(path, value);
    if (clean === undefined) {
      console.warn(`EditorStore.set: ignored invalid value for "${path}"`, value);
      return;
    }
    const current = getPath(this._params, path);
    if (current !== undefined && current !== null && clean !== null && typeof current !== typeof clean) {
      console.warn(`EditorStore.set: type mismatch for "${path}"`, value);
      return;
    }
    // Reuse unchanged parts of the current value (e.g. existing strokes when one
    // is appended) so history snapshots keep sharing them; identity = no-op.
    const shared = current === undefined ? clean : reconcile(current, clean);
    if (shared === current) return;
    const next = setIn(this._params, path, shared);
    if (next === undefined) {
      console.warn(`EditorStore.set: path "${path}" does not exist`);
      return;
    }
    const label = opts.label ?? this.autoLabel(path, shared);
    this.commit(freeze(next), {
      label,
      paths: [path],
      source: 'set',
      coalesceKey: opts.coalesceKey === undefined ? path : opts.coalesceKey,
      transient: !!opts.transient,
      autoPath: opts.label === undefined ? path : undefined,
    });
  }

  /**
   * Mutate a structuredClone of the params. The result is reconciled against
   * the current snapshot (unchanged subtrees shared, changed paths computed).
   * Default coalesce key: the label (so repeated "Tone Curve" edits within
   * 1.2 s merge); pass `coalesceKey: null` to always create a new entry.
   */
  update(label: string, mutator: (draft: EditParams) => void, opts: SetOptions = {}): void {
    const draft = cloneParams(this._params);
    mutator(draft);
    this.commitReconciled(draft, {
      label: opts.label ?? label,
      source: 'update',
      coalesceKey: opts.coalesceKey === undefined ? `update:${label}` : opts.coalesceKey,
      transient: !!opts.transient,
    });
  }

  replace(params: EditParams, label: string): void {
    this.commitReconciled(params, { label, source: 'replace', coalesceKey: null, transient: false });
  }

  reset(label = 'Original Reset'): void {
    this.endGesture();
    this.commitReconciled(createDefaultParams(this.isRaw), { label, source: 'reset', coalesceKey: null, transient: false });
  }

  /* ---------------------------------------------------------------- */
  /* Gestures                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Start grouping changes into one history entry. Calling it while a gesture
   * is active is a no-op (the outer gesture keeps grouping), so nested
   * components cannot leave a gesture open by double-starting it.
   */
  beginGesture(label: string): void {
    if (this.gesture) return;
    this.gesture = { label, entry: null, paths: new Set(), changed: false, lastSource: 'set', singlePath: undefined, autoLabel: label };
  }

  endGesture(): void {
    const g = this.gesture;
    if (!g) return;
    this.gesture = null;
    // A finished gesture is never extended by later coalescing.
    this.lastCoalesce = null;
    if (!g.changed) return;
    // Final, non-interactive notification: the renderer does a full-quality pass.
    this.emit({ label: g.entry?.label ?? g.label, paths: [...g.paths], source: g.lastSource, interactive: false });
  }

  /* ---------------------------------------------------------------- */
  /* History                                                           */
  /* ---------------------------------------------------------------- */

  canUndo(): boolean {
    return this._index > 0 || this.dirty;
  }

  canRedo(): boolean {
    return this._index < this._history.length - 1;
  }

  undo(): boolean {
    this.endGesture();
    if (this.dirty) {
      // Pending transient changes: undo reverts them to the current entry first.
      this.moveTo(this._index, 'undo', this._history[this._index].label);
      return true;
    }
    if (this._index <= 0) return false;
    const undone = this._history[this._index].label;
    this.moveTo(this._index - 1, 'undo', undone);
    return true;
  }

  redo(): boolean {
    this.endGesture();
    if (!this.canRedo()) return false;
    this.moveTo(this._index + 1, 'redo', this._history[this._index + 1].label);
    return true;
  }

  goToHistory(index: number): void {
    this.endGesture();
    const i = Math.max(0, Math.min(this._history.length - 1, Math.floor(index)));
    if (i === this._index && !this.dirty) return;
    this.moveTo(i, 'history', this._history[i].label);
  }

  /** Keep only the current state as the single history entry. */
  clearHistory(): void {
    this.endGesture();
    this._history = Object.freeze([this.makeEntry('History Cleared', this._params, Date.now())]);
    this._index = 0;
    this.lastCoalesce = null;
    this.emit({ label: 'History Cleared', paths: [], source: 'history', interactive: false });
  }

  /* ---------------------------------------------------------------- */
  /* Snapshots                                                         */
  /* ---------------------------------------------------------------- */

  createSnapshot(name: string): Snapshot {
    const snap: Snapshot = Object.freeze({
      id: `snap-${Date.now().toString(36)}-${(this.snapshotSeq++).toString(36)}`,
      name: name.trim() || `Snapshot ${this._snapshots.length + 1}`,
      params: this._params,
      created: Date.now(),
    });
    this._snapshots = Object.freeze([...this._snapshots, snap]);
    this.emit({ label: `Snapshot: ${snap.name}`, paths: [], source: 'snapshot', interactive: false });
    return snap;
  }

  applySnapshot(id: string): void {
    const snap = this._snapshots.find((s) => s.id === id);
    if (!snap) return;
    this.endGesture();
    this.commitReconciled(snap.params, { label: `Snapshot: ${snap.name}`, source: 'snapshot', coalesceKey: null, transient: false });
  }

  deleteSnapshot(id: string): void {
    const next = this._snapshots.filter((s) => s.id !== id);
    if (next.length === this._snapshots.length) return;
    this._snapshots = Object.freeze(next);
    this.emit({ label: 'Delete Snapshot', paths: [], source: 'snapshot', interactive: false });
  }

  renameSnapshot(id: string, name: string): void {
    const trimmed = name.trim();
    const i = this._snapshots.findIndex((s) => s.id === id);
    if (i < 0 || !trimmed || this._snapshots[i].name === trimmed) return;
    const next = [...this._snapshots];
    next[i] = Object.freeze({ ...next[i], name: trimmed });
    this._snapshots = Object.freeze(next);
    this.emit({ label: `Rename Snapshot: ${trimmed}`, paths: [], source: 'snapshot', interactive: false });
  }

  /* ---------------------------------------------------------------- */
  /* Subscription                                                      */
  /* ---------------------------------------------------------------- */

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /* ---------------------------------------------------------------- */
  /* Persistence                                                       */
  /* ---------------------------------------------------------------- */

  serialize(): SerializedEditState {
    const len = this._history.length;
    let start = Math.max(0, len - SERIALIZED_HISTORY);
    let end = len;
    if (this._index < start) {
      start = this._index;
      end = Math.min(len, start + SERIALIZED_HISTORY);
    }
    // Enforce the stroke-point budget by dropping the entries farthest from the current one.
    const weights = this._history.map((e) => strokePointCount(e.params));
    let total = 0;
    for (let i = start; i < end; i++) total += weights[i];
    while (total > SERIALIZED_POINT_BUDGET && end - start > 1) {
      if (this._index - start >= end - 1 - this._index) total -= weights[start++];
      else total -= weights[--end];
    }
    return {
      format: 'kloud-edit',
      version: 1,
      params: this._params,
      history: this._history.slice(start, end),
      historyIndex: this._index - start,
      snapshots: [...this._snapshots],
      updated: Date.now(),
    };
  }

  load(state: SerializedEditState): void {
    this.gesture = null;
    this.lastCoalesce = null;
    const now = Date.now();
    const raw = Array.isArray(state?.history) ? state.history : [];
    const entries: HistoryEntry[] = [];
    let prev: EditParams | null = null;
    for (const e of raw) {
      if (!e || typeof e !== 'object') continue;
      // Re-establish structural sharing between consecutive entries.
      let p = normalizeParams(e.params, this.isRaw);
      if (prev) p = reconcile(prev, p);
      p = freeze(p);
      entries.push(this.makeEntry(typeof e.label === 'string' ? e.label : 'Edit', p, toNum(e.time) ?? now));
      prev = p;
    }
    let params = normalizeParams(state?.params ?? (prev as EditParams | null) ?? undefined, this.isRaw);
    if (entries.length === 0) entries.push(this.makeEntry('Import', freeze(params), toNum(state?.updated) ?? now));
    const idxRaw = Math.floor(toNum(state?.historyIndex) ?? entries.length - 1);
    const dropped = Math.max(0, entries.length - this.maxHistory);
    if (dropped) entries.splice(0, dropped);
    const index = Math.max(0, Math.min(entries.length - 1, idxRaw - dropped));
    params = freeze(reconcile(entries[index].params, params));
    this._history = Object.freeze(entries);
    this._index = index;
    this._params = params;
    const snaps: Snapshot[] = [];
    for (const s of Array.isArray(state?.snapshots) ? state.snapshots : []) {
      if (!s || typeof s !== 'object') continue;
      snaps.push(
        Object.freeze({
          id: typeof s.id === 'string' && s.id ? s.id : `snap-${(this.snapshotSeq++).toString(36)}`,
          name: typeof s.name === 'string' && s.name ? s.name : `Snapshot ${snaps.length + 1}`,
          params: freeze(reconcile(params, normalizeParams(s.params, this.isRaw))),
          created: toNum(s.created) ?? now,
        }),
      );
    }
    this._snapshots = Object.freeze(snaps);
    this.emit({ label: 'Load', paths: ['*'], source: 'load', interactive: false });
  }

  /* ---------------------------------------------------------------- */
  /* Internals                                                         */
  /* ---------------------------------------------------------------- */

  private makeEntry(label: string, params: EditParams, time: number): HistoryEntry {
    return Object.freeze({ id: this.nextEntryId++, label, params, time });
  }

  private autoLabel(path: string, value: unknown): string {
    const m = /^masks\.(\d+)\./.exec(path);
    const maskName = m ? this._params.masks[Number(m[1])]?.name : undefined;
    return changeLabel(path, value, maskName);
  }

  private commitReconciled(next: EditParams, meta: Omit<CommitMeta, 'paths'>): void {
    const paths: string[] = [];
    const reconciled = reconcile(this._params, next, paths);
    if (reconciled === this._params) return;
    this.commit(freeze(reconciled), { ...meta, paths });
  }

  private commit(next: EditParams, meta: CommitMeta): void {
    this._params = next;
    const now = Date.now();
    const g = this.gesture;

    if (g) {
      g.changed = true;
      g.lastSource = meta.source;
      for (const p of meta.paths) g.paths.add(p);
      if (meta.autoPath !== undefined && (g.singlePath === undefined || g.singlePath === meta.autoPath)) {
        g.singlePath = meta.autoPath;
        g.autoLabel = meta.label;
      } else if (!meta.transient) g.singlePath = null;
      if (!meta.transient) {
        const label = g.singlePath ? g.autoLabel : g.label;
        if (g.entry && this._history[this._index] === g.entry) {
          g.entry = Object.freeze({ ...g.entry, label, params: next, time: now });
          this.replaceTip(g.entry);
        } else {
          g.entry = this.makeEntry(label, next, now);
          this.pushEntry(g.entry);
        }
      }
      this.emit({ label: meta.label, paths: meta.paths, source: meta.source, interactive: true });
      return;
    }

    if (meta.transient) {
      this.emit({ label: meta.label, paths: meta.paths, source: meta.source, interactive: false });
      return;
    }

    const tip = this._history[this._index];
    const atTip = this._index === this._history.length - 1;
    const lc = this.lastCoalesce;
    if (meta.coalesceKey !== null && atTip && lc && lc.key === meta.coalesceKey && lc.entryId === tip.id && now - tip.time < COALESCE_MS) {
      this.replaceTip(Object.freeze({ ...tip, label: meta.label, params: next, time: now }));
    } else {
      const entry = this.makeEntry(meta.label, next, now);
      this.pushEntry(entry);
      this.lastCoalesce = meta.coalesceKey !== null ? { key: meta.coalesceKey, entryId: entry.id } : null;
    }
    this.emit({ label: meta.label, paths: meta.paths, source: meta.source, interactive: false });
  }

  /** Append after the current index (dropping any redo branch) and trim to maxHistory. */
  private pushEntry(entry: HistoryEntry): void {
    const list = this._history.slice(0, this._index + 1);
    list.push(entry);
    const overflow = Math.max(0, list.length - this.maxHistory);
    if (overflow) list.splice(0, overflow);
    this._history = Object.freeze(list);
    this._index = list.length - 1;
  }

  private replaceTip(entry: HistoryEntry): void {
    const list = this._history.slice();
    list[this._index] = entry;
    this._history = Object.freeze(list);
  }

  private moveTo(index: number, source: Source, label: string): void {
    const prev = this._params;
    this._index = index;
    this._params = this._history[index].params;
    this.lastCoalesce = null;
    const paths: string[] = [];
    collectDiff(prev, this._params, '', paths);
    this.emit({ label, paths, source, interactive: false });
  }

  private emit(info: ChangeInfo): void {
    const params = this._params;
    for (const fn of [...this.listeners]) {
      try {
        fn(params, info);
      } catch (err) {
        console.error('EditorStore listener failed', err);
      }
    }
  }
}

function freeze<T>(v: T): T {
  return FREEZE ? deepFreeze(v) : v;
}

/**
 * Validate / normalize a value written with set(): numbers are clamped to the
 * field's range, curves normalized, objects deep-copied (the caller may keep
 * mutating its own copy). Returns undefined for an unusable value.
 */
function sanitizeValue(path: string, value: unknown): unknown {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    return specForPath(path) || path.endsWith('.hue') ? clampToSpec(path, value) : value;
  }
  if (CURVE_PATHS.has(path)) return normCurvePoints(value);
  if (value !== null && typeof value === 'object') return structuredClone(value);
  return value;
}

function strokePointCount(p: EditParams): number {
  let n = 0;
  for (const m of p.masks) for (const c of m.components) if (c.brush) for (const s of c.brush.strokes) n += s.points.length;
  for (const r of p.retouch.removals) for (const s of r.strokes) n += s.points.length;
  return n;
}
