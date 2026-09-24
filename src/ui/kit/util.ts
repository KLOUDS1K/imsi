/**
 * Shared helpers for the UI kit: number formatting/parsing, safe storage,
 * shortcut formatting, floating-element positioning, focus helpers and small
 * gesture detectors (double-tap, long-press).
 *
 * Nothing here touches the DOM at import time, so the kit can be imported in
 * node-based unit tests.
 */
import { on } from '../dom';

/** Every kit component returns at least this. */
export interface Component<E extends Element = HTMLElement> {
  /** Root element — insert it wherever you like. */
  readonly el: E;
  /** Removes every listener the component registered and detaches `el`. */
  destroy(): void;
}

/* ------------------------------------------------------------------ */
/* Numbers                                                             */
/* ------------------------------------------------------------------ */

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Number of decimals implied by a step (0.05 → 2, 1 → 0, 1e-3 → 3). */
export function decimalsOf(step: number): number {
  if (!Number.isFinite(step) || step <= 0 || Number.isInteger(step)) return 0;
  const s = String(step);
  const exp = s.indexOf('e-');
  if (exp >= 0) return Number(s.slice(exp + 2));
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

/** Round to `decimals` places without float noise (0.1 + 0.2 → 0.3). */
export function roundTo(v: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

/** Snap to a step grid anchored at `origin`, then clean float noise. */
export function snapTo(v: number, step: number, origin = 0): number {
  if (!(step > 0)) return v;
  const snapped = origin + Math.round((v - origin) / step) * step;
  return roundTo(snapped, Math.max(decimalsOf(step), decimalsOf(origin)) + 2);
}

/** Typographic minus used in readouts (−12, not -12). */
export const MINUS = '−';

/**
 * Format a number for a readout: fixed decimals, typographic minus, optional
 * explicit "+" for positive values (bipolar sliders show "+0.50").
 * Negative zero and values that round to zero print without a sign.
 */
export function formatNumber(v: number, decimals: number, signed = false): string {
  if (!Number.isFinite(v)) return '–';
  const abs = Math.abs(v).toFixed(decimals);
  if (Number(abs) === 0) return abs;
  if (v < 0) return MINUS + abs;
  return signed ? '+' + abs : abs;
}

/**
 * Parse user input from a readout field. Accepts "1.5", "+1,5", "−12",
 * "40 %", "5500K"… Returns null when nothing numeric is present.
 */
export function parseNumber(text: string): number | null {
  const norm = text.trim().replace(/[−–—]/g, '-').replace(',', '.');
  const m = /[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i.exec(norm);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/* ------------------------------------------------------------------ */
/* Storage (never throws: private mode / blocked storage)              */
/* ------------------------------------------------------------------ */

export function loadLocal<T>(key: string, fallback: T): T {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function saveLocal(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable — state simply isn't remembered */
  }
}

/* ------------------------------------------------------------------ */
/* Environment                                                         */
/* ------------------------------------------------------------------ */

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

let macCache: boolean | null = null;
/** True on macOS / iOS (⌘ instead of Ctrl). */
export function isMac(): boolean {
  if (macCache !== null) return macCache;
  const nav = typeof navigator === 'undefined' ? null : navigator;
  const uaData = nav as (Navigator & { userAgentData?: { platform?: string } }) | null;
  const platform = uaData?.userAgentData?.platform ?? nav?.platform ?? '';
  macCache = /mac|iphone|ipad|ipod/i.test(platform);
  return macCache;
}

/* ------------------------------------------------------------------ */
/* Shortcuts                                                           */
/* ------------------------------------------------------------------ */

const KEY_GLYPHS: Record<string, string> = {
  arrowleft: '←',
  arrowright: '→',
  arrowup: '↑',
  arrowdown: '↓',
  enter: '↵',
  escape: 'Esc',
  esc: 'Esc',
  backspace: '⌫',
  delete: 'Del',
  space: 'Space',
  ' ': 'Space',
  tab: 'Tab',
  pageup: 'PgUp',
  pagedown: 'PgDn',
  home: 'Home',
  end: 'End',
};
const MAC_MODS: Record<string, string> = { mod: '⌘', meta: '⌘', cmd: '⌘', ctrl: '⌃', control: '⌃', shift: '⇧', alt: '⌥', option: '⌥' };
const PC_MODS: Record<string, string> = { mod: 'Ctrl', meta: 'Win', cmd: 'Ctrl', ctrl: 'Ctrl', control: 'Ctrl', shift: 'Shift', alt: 'Alt', option: 'Alt' };

/**
 * Split a shortcut ("Shift+Mod+Z", "Mod+\\", "ArrowRight") into display key
 * caps for the current platform: mac → ['⇧','⌘','Z'], others → ['Ctrl','Shift','Z'].
 * Modifiers are emitted in platform order.
 */
export function shortcutParts(shortcut: string): string[] {
  const mac = isMac();
  // "+" itself may be the key ("Mod++"); split on "+" that separates tokens.
  const tokens = shortcut === '+' ? ['+'] : shortcut.split(/\+(?!$)/);
  const mods: string[] = [];
  const keys: string[] = [];
  const order = mac ? ['⌃', '⌥', '⇧', '⌘'] : ['Ctrl', 'Win', 'Alt', 'Shift'];
  for (const raw of tokens) {
    const t = raw.trim();
    const lower = t.toLowerCase();
    const mod = (mac ? MAC_MODS : PC_MODS)[lower];
    if (mod) mods.push(mod);
    else keys.push(KEY_GLYPHS[lower] ?? (t.length === 1 ? t.toUpperCase() : t));
  }
  mods.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return [...new Set(mods), ...keys];
}

/** Compact one-string form: "⇧⌘Z" on mac, "Ctrl+Shift+Z" elsewhere. */
export function formatShortcut(shortcut: string): string {
  const parts = shortcutParts(shortcut);
  return isMac() ? parts.join('') : parts.join('+');
}

/* ------------------------------------------------------------------ */
/* Floating positioning (tooltips, popovers, menus)                    */
/* ------------------------------------------------------------------ */

export type Side = 'top' | 'bottom' | 'left' | 'right';
export type Placement = Side | `${Side}-start` | `${Side}-end`;
/** An element, a rect, or a point (context menus). */
export type AnchorLike = Element | DOMRectReadOnly | { x: number; y: number; width?: number; height?: number };

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function anchorBox(anchor: AnchorLike): Box {
  if (typeof Element !== 'undefined' && anchor instanceof Element) {
    const r = anchor.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }
  const a = anchor as { x: number; y: number; width?: number; height?: number };
  return { left: a.x, top: a.y, width: a.width ?? 0, height: a.height ?? 0 };
}

const OPPOSITE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

/**
 * Position a `position: fixed` element next to an anchor. Flips to the
 * opposite side when it does not fit, then shifts along the cross axis to stay
 * inside the viewport; if it is still taller than the room available, a
 * max-height is applied (the element should scroll). Returns the placement used.
 *
 * Reads layout once (anchor rect + element size) — call it on open / resize,
 * never from pointermove.
 */
export function positionFloating(
  el: HTMLElement,
  anchor: AnchorLike,
  placement: Placement = 'bottom-start',
  opts: { offset?: number; padding?: number; flip?: boolean } = {},
): Placement {
  const offset = opts.offset ?? 6;
  const pad = opts.padding ?? 8;
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const vh = window.innerHeight;
  el.style.maxHeight = '';
  const a = anchorBox(anchor);
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  let [side, align] = placement.split('-') as [Side, 'start' | 'end' | undefined];

  const room: Record<Side, number> = {
    top: a.top - pad,
    bottom: vh - (a.top + a.height) - pad,
    left: a.left - pad,
    right: vw - (a.left + a.width) - pad,
  };
  const need = side === 'top' || side === 'bottom' ? h + offset : w + offset;
  if (opts.flip !== false && room[side] < need && room[OPPOSITE[side]] > room[side]) side = OPPOSITE[side];

  let left: number;
  let top: number;
  if (side === 'top' || side === 'bottom') {
    top = side === 'bottom' ? a.top + a.height + offset : a.top - offset - h;
    left = align === 'start' ? a.left : align === 'end' ? a.left + a.width - w : a.left + a.width / 2 - w / 2;
    left = clamp(left, pad, Math.max(pad, vw - w - pad));
    const avail = room[side] - offset;
    if (h > avail) {
      el.style.maxHeight = `${Math.max(80, avail)}px`;
      if (side === 'top') top = a.top - offset - Math.min(h, Math.max(80, avail));
    }
  } else {
    left = side === 'right' ? a.left + a.width + offset : a.left - offset - w;
    top = align === 'start' ? a.top : align === 'end' ? a.top + a.height - h : a.top + a.height / 2 - h / 2;
    if (h > vh - pad * 2) el.style.maxHeight = `${vh - pad * 2}px`;
    top = clamp(top, pad, Math.max(pad, vh - Math.min(h, vh - pad * 2) - pad));
    left = clamp(left, pad, Math.max(pad, vw - w - pad));
  }
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
  const resolved = (align ? `${side}-${align}` : side) as Placement;
  el.dataset.placement = resolved;
  return resolved;
}

/* ------------------------------------------------------------------ */
/* Overlay root + focus                                                */
/* ------------------------------------------------------------------ */

let portal: HTMLElement | null = null;
/**
 * Shared container for overlays (dialogs, popovers, tooltips, toasts), appended
 * to <body>. Later overlays stack above earlier ones by DOM order.
 */
export function portalRoot(): HTMLElement {
  if (portal && portal.isConnected) return portal;
  portal = document.createElement('div');
  portal.className = 'k-portal';
  document.body.appendChild(portal);
  return portal;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** Focusable, visible descendants in DOM order. */
export function focusableIn(root: Element): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.closest('[inert]') && !el.hasAttribute('hidden') && el.getClientRects().length > 0,
  );
}

let idCounter = 0;
/** Deterministic unique id for aria wiring ("k-slider-3"). */
export function kitId(prefix = 'k'): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

/* ------------------------------------------------------------------ */
/* Gesture helpers                                                     */
/* ------------------------------------------------------------------ */

/**
 * Double-tap for touch pointers (dblclick is unreliable on mobile). Mouse
 * double-clicks should still use the native `dblclick` event.
 */
export function onDoubleTap(el: HTMLElement, cb: (e: PointerEvent) => void, ms = 320): () => void {
  let lastT = 0;
  let lastX = 0;
  let lastY = 0;
  return on(el, 'pointerup', (e) => {
    if (e.pointerType !== 'touch') return;
    const now = e.timeStamp;
    if (now - lastT < ms && Math.hypot(e.clientX - lastX, e.clientY - lastY) < 24) {
      lastT = 0;
      cb(e);
    } else {
      lastT = now;
      lastX = e.clientX;
      lastY = e.clientY;
    }
  });
}

/**
 * Long-press (touch / pen by default). Fires once after `ms` without moving
 * more than `tolerance` px. The click that follows the release is swallowed.
 */
export function onLongPress(
  el: HTMLElement,
  cb: (e: PointerEvent) => void,
  opts: { ms?: number; tolerance?: number; pointerTypes?: string[] } = {},
): () => void {
  const ms = opts.ms ?? 500;
  const tol = opts.tolerance ?? 8;
  const types = opts.pointerTypes ?? ['touch', 'pen'];
  let timer = 0;
  let startX = 0;
  let startY = 0;
  let fired = false;
  const cancel = (): void => {
    if (timer) window.clearTimeout(timer);
    timer = 0;
  };
  const offs = [
    on(el, 'pointerdown', (e) => {
      if (!types.includes(e.pointerType) || !e.isPrimary) return;
      fired = false;
      startX = e.clientX;
      startY = e.clientY;
      cancel();
      timer = window.setTimeout(() => {
        timer = 0;
        fired = true;
        cb(e);
      }, ms);
    }),
    on(el, 'pointermove', (e) => {
      if (timer && Math.hypot(e.clientX - startX, e.clientY - startY) > tol) cancel();
    }),
    on(el, 'pointerup', cancel),
    on(el, 'pointercancel', cancel),
    on(
      el,
      'click',
      (e) => {
        if (fired) {
          fired = false;
          e.preventDefault();
          e.stopPropagation();
        }
      },
      { capture: true },
    ),
  ];
  return () => {
    cancel();
    for (const off of offs) off();
  };
}
