/**
 * Library selection model on top of ctx.selection / ctx.visibleIds.
 *
 * ctx.selection order: the ACTIVE ("most selected") photo first, then the rest
 * in display order. The shift-click anchor is kept per context here so the
 * grid, list and filmstrip share it.
 */
import type { AppContext } from '@/app/context';

interface SelState {
  anchor: string | null;
}
const states = new WeakMap<AppContext, SelState>();

function state(ctx: AppContext): SelState {
  let s = states.get(ctx);
  if (!s) {
    s = { anchor: null };
    states.set(ctx, s);
  }
  return s;
}

/** The active (focused, most-selected) photo id. */
export function activeId(ctx: AppContext): string | null {
  return ctx.selection.value[0] ?? null;
}

/** Commit a selection set with `active` first and the rest in display order. */
export function commitSelection(ctx: AppContext, ids: Iterable<string>, active: string | null): void {
  const set = new Set(ids);
  const order = ctx.visibleIds.value;
  const rest: string[] = [];
  for (const id of order) if (set.has(id) && id !== active) rest.push(id);
  // Keep selected ids that are not visible (e.g. filmstrip in Develop) at the end.
  if (rest.length + (active && set.has(active) ? 1 : 0) < set.size) {
    const seen = new Set(rest);
    for (const id of set) if (id !== active && !seen.has(id)) rest.push(id);
  }
  const next = active && set.has(active) ? [active, ...rest] : rest;
  const cur = ctx.selection.value;
  if (cur.length === next.length && cur.every((v, i) => v === next[i])) return;
  ctx.selection.set(next);
}

export interface ClickMods {
  /** Cmd (mac) / Ctrl — toggle. */
  toggle: boolean;
  /** Shift — range from the anchor. */
  range: boolean;
}

export function modsOf(e: MouseEvent | KeyboardEvent | PointerEvent): ClickMods {
  return { toggle: e.metaKey || e.ctrlKey, range: e.shiftKey };
}

/** Click semantics: plain = only this, toggle = add/remove, range = anchor..id (additive with toggle). */
export function clickSelect(ctx: AppContext, id: string, mods: ClickMods): void {
  const s = state(ctx);
  const cur = new Set(ctx.selection.value);
  if (mods.range) {
    const order = ctx.visibleIds.value;
    const anchor = s.anchor && order.includes(s.anchor) ? s.anchor : (activeId(ctx) ?? id);
    const a = order.indexOf(anchor);
    const b = order.indexOf(id);
    if (a < 0 || b < 0) {
      commitSelection(ctx, [id], id);
      s.anchor = id;
      return;
    }
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const range = order.slice(lo, hi + 1);
    const base = mods.toggle ? cur : new Set<string>();
    for (const r of range) base.add(r);
    commitSelection(ctx, base, id);
    return;
  }
  if (mods.toggle) {
    if (cur.has(id)) {
      cur.delete(id);
      const nextActive = activeId(ctx) === id ? (ctx.visibleIds.value.find((v) => cur.has(v)) ?? null) : activeId(ctx);
      commitSelection(ctx, cur, nextActive);
    } else {
      cur.add(id);
      commitSelection(ctx, cur, id);
    }
    s.anchor = id;
    return;
  }
  commitSelection(ctx, [id], id);
  s.anchor = id;
}

export function selectAll(ctx: AppContext): void {
  const order = ctx.visibleIds.value;
  const active = activeId(ctx);
  commitSelection(ctx, order, active && order.includes(active) ? active : (order[0] ?? null));
}

export function clearSelection(ctx: AppContext): void {
  if (ctx.selection.value.length) ctx.selection.set([]);
  state(ctx).anchor = null;
}

/**
 * Keyboard move: `delta` in display positions (±1, ±columns). `extend` (Shift)
 * grows the range from the anchor; otherwise the selection becomes the new
 * photo. Returns the new active id.
 */
export function moveSelection(ctx: AppContext, delta: number | 'home' | 'end', extend: boolean): string | null {
  const order = ctx.visibleIds.value;
  if (order.length === 0) return null;
  const cur = activeId(ctx);
  const idx = cur ? order.indexOf(cur) : -1;
  let next: number;
  if (delta === 'home') next = 0;
  else if (delta === 'end') next = order.length - 1;
  else if (idx < 0) next = delta > 0 ? 0 : order.length - 1;
  else next = Math.max(0, Math.min(order.length - 1, idx + delta));
  const id = order[next];
  if (extend) {
    const s = state(ctx);
    if (!s.anchor) s.anchor = cur ?? id;
    clickSelect(ctx, id, { toggle: false, range: true });
  } else {
    commitSelection(ctx, [id], id);
    state(ctx).anchor = id;
  }
  return id;
}

/* ------------------------------------------------------------------ */
/* Keyboard navigator registry                                          */
/* ------------------------------------------------------------------ */

/** The mounted grid/list registers how arrows move (columns per row, reveal). */
export interface Navigator {
  columns(): number;
  pageRows(): number;
  reveal(id: string): void;
  /** Element that handles its own arrow keys while focused. */
  el: HTMLElement;
}
const navigators = new WeakMap<AppContext, Navigator>();

export function setNavigator(ctx: AppContext, nav: Navigator | null): void {
  if (nav) navigators.set(ctx, nav);
  else navigators.delete(ctx);
}

export function getNavigator(ctx: AppContext): Navigator | undefined {
  return navigators.get(ctx);
}

/** Handle an arrow/Home/End/Page key for the library. Returns true when consumed. */
export function navigateKey(ctx: AppContext, e: KeyboardEvent): boolean {
  const nav = navigators.get(ctx);
  if (!nav) return false;
  const cols = Math.max(1, nav.columns());
  let delta: number | 'home' | 'end';
  switch (e.key) {
    case 'ArrowLeft':
      delta = -1;
      break;
    case 'ArrowRight':
      delta = 1;
      break;
    case 'ArrowUp':
      delta = -cols;
      break;
    case 'ArrowDown':
      delta = cols;
      break;
    case 'PageUp':
      delta = -cols * Math.max(1, nav.pageRows());
      break;
    case 'PageDown':
      delta = cols * Math.max(1, nav.pageRows());
      break;
    case 'Home':
      delta = 'home';
      break;
    case 'End':
      delta = 'end';
      break;
    default:
      return false;
  }
  const id = moveSelection(ctx, delta, e.shiftKey);
  if (id) nav.reveal(id);
  return true;
}
