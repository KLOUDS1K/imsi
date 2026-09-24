/**
 * Tiny observable value. UI state that several components share (current
 * module, selected tool, view state, selection…) lives in Signals.
 */
export type Listener<T> = (value: T, prev: T) => void;

export class Signal<T> {
  private listeners = new Set<Listener<T>>();
  constructor(private _value: T) {}

  get value(): T {
    return this._value;
  }

  set value(v: T) {
    this.set(v);
  }

  set(v: T): void {
    if (Object.is(v, this._value)) return;
    const prev = this._value;
    this._value = v;
    for (const l of [...this.listeners]) l(v, prev);
  }

  /** Mutate objects/arrays in place and notify. */
  update(fn: (v: T) => T | void): void {
    const prev = this._value;
    const next = fn(prev);
    this._value = next === undefined ? prev : next;
    for (const l of [...this.listeners]) l(this._value, prev);
  }

  /** Subscribe; `immediate` calls the listener with the current value first. */
  subscribe(fn: Listener<T>, immediate = false): () => void {
    this.listeners.add(fn);
    if (immediate) fn(this._value, this._value);
    return () => this.listeners.delete(fn);
  }
}

export function signal<T>(v: T): Signal<T> {
  return new Signal(v);
}

/** Derived read-only signal. */
export function computed<T>(deps: Signal<unknown>[], fn: () => T): Signal<T> {
  const s = new Signal(fn());
  for (const d of deps) d.subscribe(() => s.set(fn()));
  return s;
}
