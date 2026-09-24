/**
 * Dot-path helpers and structural utilities shared by the store and the params
 * math.
 *
 * Paths are dot separated keys; numeric segments index arrays:
 *   "basic.exposure", "hsl.red.hue", "masks.0.adjustments.exposure".
 *
 * Immutability model: the store keeps params as immutable snapshots with
 * structural sharing. `setIn` copies only the nodes along a path; `reconcile`
 * rebuilds a freshly-cloned draft so every unchanged subtree reuses the previous
 * snapshot's object (cheap history, cheap diffs: shared subtrees compare with
 * `Object.is`).
 */

export type PlainObject = Record<string, unknown>;

export function isPlainObject(v: unknown): v is PlainObject {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Split a dot path into segments ('' → []). */
export function parsePath(path: string): string[] {
  return path === '' ? [] : path.split('.');
}

export function joinPath(base: string, key: string | number): string {
  return base === '' ? String(key) : `${base}.${key}`;
}

const INDEX_RE = /^(0|[1-9]\d*)$/;
const isIndex = (seg: string): boolean => INDEX_RE.test(seg);

/** Read a value at a dot path. Returns undefined when any segment is missing. */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of parsePath(path)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    if (Array.isArray(cur)) {
      if (!isIndex(seg)) return undefined;
      cur = cur[Number(seg)];
    } else {
      if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
      cur = (cur as PlainObject)[seg];
    }
  }
  return cur;
}

/**
 * Write a value at a dot path, MUTATING `obj` (lodash `_.set` semantics) and
 * returning it. Missing intermediate containers are created (an array when the
 * next segment is numeric, otherwise a plain object). Use `setIn` for an
 * immutable copy-on-write update.
 */
export function setPath<T extends object>(obj: T, path: string, value: unknown): T {
  const segs = parsePath(path);
  if (segs.length === 0) throw new Error('setPath: empty path');
  let cur: unknown = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    const container = cur as PlainObject & unknown[];
    const key: string | number = Array.isArray(container) && isIndex(seg) ? Number(seg) : seg;
    let next = (container as PlainObject)[key as string];
    if (next === null || typeof next !== 'object') {
      next = isIndex(segs[i + 1]) ? [] : {};
      (container as PlainObject)[key as string] = next;
    }
    cur = next;
  }
  const last = segs[segs.length - 1];
  const container = cur as PlainObject;
  const key = Array.isArray(container) && isIndex(last) ? Number(last) : last;
  (container as PlainObject)[key as string] = value;
  return obj;
}

/**
 * Immutable copy-on-write set: returns a new root where only the containers on
 * the path are shallow-copied; every other subtree is shared with `obj`.
 * Returns undefined when an intermediate container does not exist (the store
 * refuses to invent structure such as `masks.7` on a two-mask edit).
 */
export function setIn<T>(obj: T, path: string, value: unknown): T | undefined {
  const segs = parsePath(path);
  if (segs.length === 0) return value as T;
  const write = (node: unknown, i: number): unknown => {
    const seg = segs[i];
    if (node === null || typeof node !== 'object') return undefined;
    if (Array.isArray(node)) {
      if (!isIndex(seg)) return undefined;
      const idx = Number(seg);
      if (idx > node.length) return undefined;
      const copy = node.slice();
      if (i === segs.length - 1) copy[idx] = value;
      else {
        const child = write(node[idx], i + 1);
        if (child === undefined) return undefined;
        copy[idx] = child;
      }
      return copy;
    }
    const copy: PlainObject = { ...(node as PlainObject) };
    if (i === segs.length - 1) copy[seg] = value;
    else {
      const child = write((node as PlainObject)[seg], i + 1);
      if (child === undefined) return undefined;
      copy[seg] = child;
    }
    return copy;
  };
  return write(obj, 0) as T | undefined;
}

/** Structural deep equality for JSON-like data (plain objects, arrays, primitives). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ka = Object.keys(a as PlainObject);
  const kb = Object.keys(b as PlainObject);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual((a as PlainObject)[k], (b as PlainObject)[k])) return false;
  }
  return true;
}

/**
 * Collect the dot paths where `a` and `b` differ. Leaves are reported
 * individually; an array whose length changed is reported as the array path.
 * Shared subtrees short-circuit on identity, so diffing two history snapshots
 * costs O(changed nodes).
 */
export function collectDiff(a: unknown, b: unknown, path: string, out: string[]): void {
  if (Object.is(a, b)) return;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      out.push(path);
      return;
    }
    for (let i = 0; i < a.length; i++) collectDiff(a[i], b[i], joinPath(path, i), out);
    return;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    for (const k of Object.keys(a)) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) out.push(joinPath(path, k));
      else collectDiff(a[k], b[k], joinPath(path, k), out);
    }
    for (const k of Object.keys(b)) if (!Object.prototype.hasOwnProperty.call(a, k)) out.push(joinPath(path, k));
    return;
  }
  out.push(path === '' ? '*' : path);
}

/**
 * Rebuild `next` so every subtree that is deep-equal to the corresponding
 * subtree of `prev` IS that subtree (identity). Returns `prev` itself when
 * nothing changed. Changed paths are appended to `out` (same granularity as
 * collectDiff). Nodes taken from `next` are returned as-is (not copied).
 */
export function reconcile<T>(prev: T, next: T, out?: string[], path = ''): T {
  return rec(prev, next, path, out ?? null) as T;
}

function rec(prev: unknown, next: unknown, path: string, out: string[] | null): unknown {
  if (Object.is(prev, next)) return prev;
  if (Array.isArray(prev) && Array.isArray(next)) {
    const sameLength = prev.length === next.length;
    // When the length changes we report the array itself, but still reuse
    // unchanged elements (e.g. existing brush strokes when one is appended).
    const sub = sameLength ? out : null;
    let changed = !sameLength;
    const result = new Array<unknown>(next.length);
    for (let i = 0; i < next.length; i++) {
      const r = i < prev.length ? rec(prev[i], next[i], joinPath(path, i), sub) : next[i];
      result[i] = r;
      if (i >= prev.length || r !== prev[i]) changed = true;
    }
    if (!sameLength) out?.push(path === '' ? '*' : path);
    return changed ? result : prev;
  }
  if (isPlainObject(prev) && isPlainObject(next)) {
    let changed = false;
    const result: PlainObject = {};
    for (const k of Object.keys(next)) {
      const has = Object.prototype.hasOwnProperty.call(prev, k);
      const r = has ? rec(prev[k], next[k], joinPath(path, k), out) : next[k];
      if (!has) {
        out?.push(joinPath(path, k));
        changed = true;
      } else if (r !== prev[k]) changed = true;
      result[k] = r;
    }
    for (const k of Object.keys(prev)) {
      if (!Object.prototype.hasOwnProperty.call(next, k)) {
        out?.push(joinPath(path, k));
        changed = true;
      }
    }
    return changed ? result : prev;
  }
  if (deepEqual(prev, next)) return prev;
  out?.push(path === '' ? '*' : path);
  return next;
}

/**
 * Deep-freeze plain objects/arrays. Stops at nodes that are already frozen:
 * the store only ever freezes whole subtrees, so a frozen node is known to be
 * deeply frozen, which keeps freezing a new snapshot O(changed nodes).
 */
export function deepFreeze<T>(v: T): T {
  if (v === null || typeof v !== 'object' || Object.isFrozen(v) || ArrayBuffer.isView(v)) return v;
  if (Array.isArray(v)) for (const item of v) deepFreeze(item);
  else for (const k of Object.keys(v as PlainObject)) deepFreeze((v as PlainObject)[k]);
  return Object.freeze(v);
}

/** structuredClone that also tolerates frozen input (the clone is never frozen). */
export function deepClone<T>(v: T): T {
  return structuredClone(v);
}

/**
 * Deep merge `src` into a COPY of `dst` (neither input is mutated). Plain
 * objects merge key by key; arrays and primitives from `src` replace; keys whose
 * value is `undefined` are skipped.
 */
export function deepMerge<T>(dst: T, src: unknown): T {
  if (!isPlainObject(src)) return src === undefined ? dst : (deepClone(src) as T);
  const base: PlainObject = isPlainObject(dst) ? { ...dst } : {};
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (v === undefined) continue;
    base[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : deepClone(v);
  }
  return base as T;
}
