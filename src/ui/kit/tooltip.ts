/**
 * Tooltip — one shared, delayed, positioned tooltip.
 *
 *   const tip = attachTooltip(button, 'Undo', { shortcut: 'Mod+Z' });
 *   tip.update('Undo Exposure');   tip.destroy();
 *
 * Mouse/pen: shows after `delay` (default 450 ms) of hover; once a tooltip has
 * been visible, moving to the next control shows instantly (warm state).
 * Keyboard: shows on :focus-visible. Touch: long-press shows it for 1.5 s
 * (the click that would follow is swallowed). Escape, pointerdown, scroll and
 * blur hide it.
 */
import './tooltip.css';
import { h, on } from '../dom';
import { type Placement, onLongPress, portalRoot, positionFloating, shortcutParts } from './util';

export interface TooltipOptions {
  placement?: Placement;
  /** Shown as key caps after the text ("Mod+Z" → ⌘Z / Ctrl+Z). */
  shortcut?: string;
  /** Hover delay in ms. */
  delay?: number;
}

export interface TooltipHandle {
  update(content: string | (() => string), shortcut?: string): void;
  destroy(): void;
}

let tipEl: HTMLDivElement | null = null;
let textEl: HTMLSpanElement | null = null;
let keysEl: HTMLSpanElement | null = null;
let owner: HTMLElement | null = null;
let lastHiddenAt = -1e9;
let hideTimer = 0;
let docOffs: (() => void)[] = [];

function ensureEl(): HTMLDivElement {
  if (tipEl && tipEl.isConnected) return tipEl;
  textEl = h('span', { class: 'k-tooltip__text' });
  keysEl = h('span', { class: 'k-tooltip__keys' });
  tipEl = h('div', { class: 'k-tooltip', id: 'k-tooltip', attrs: { role: 'tooltip' }, hidden: true }, textEl, keysEl);
  portalRoot().appendChild(tipEl);
  return tipEl;
}

function show(target: HTMLElement, text: string, shortcut: string | undefined, placement: Placement): void {
  if (!target.isConnected || !text) return;
  const el = ensureEl();
  window.clearTimeout(hideTimer);
  textEl!.textContent = text;
  keysEl!.replaceChildren(...(shortcut ? shortcutParts(shortcut).map((k) => h('kbd', { class: 'k-tooltip__key' }, k)) : []));
  keysEl!.hidden = !shortcut;
  el.hidden = false;
  el.classList.remove('is-visible');
  positionFloating(el, target, placement, { offset: 6 });
  // Next frame so the fade-in transition runs from the final position.
  requestAnimationFrame(() => el.classList.add('is-visible'));
  owner = target;
  if (target.getAttribute('aria-label') !== text) target.setAttribute('aria-describedby', el.id);
  if (!docOffs.length) {
    docOffs = [
      on(document, 'keydown', (e) => e.key === 'Escape' && hide(), { capture: true }),
      on(window, 'scroll', () => hide(), { capture: true, passive: true }),
      on(window, 'blur', () => hide()),
    ];
  }
}

/** Hide the tooltip (optionally only if `target` owns it). */
export function hideTooltip(target?: HTMLElement): void {
  if (target && owner !== target) return;
  hide();
}

function hide(): void {
  window.clearTimeout(hideTimer);
  if (!tipEl || tipEl.hidden) return;
  tipEl.classList.remove('is-visible');
  tipEl.hidden = true;
  if (owner?.getAttribute('aria-describedby') === tipEl.id) owner.removeAttribute('aria-describedby');
  owner = null;
  lastHiddenAt = performance.now();
  for (const off of docOffs) off();
  docOffs = [];
}

/** Attach a tooltip to `target`. Returns a handle to update or remove it. */
export function attachTooltip(target: HTMLElement, content: string | (() => string), opts: TooltipOptions = {}): TooltipHandle {
  let get: () => string = typeof content === 'function' ? content : () => content;
  let shortcut = opts.shortcut;
  const placement = opts.placement ?? 'bottom';
  const delay = opts.delay ?? 450;
  let timer = 0;
  let suppressed = false;

  const schedule = (ms: number): void => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => show(target, get(), shortcut, placement), ms);
  };
  const cancel = (): void => {
    window.clearTimeout(timer);
    timer = 0;
  };

  const offs = [
    on(target, 'pointerenter', (e) => {
      if (e.pointerType === 'touch' || suppressed) return;
      // Warm state: another tooltip was just visible → show immediately.
      schedule(performance.now() - lastHiddenAt < 400 || (tipEl && !tipEl.hidden) ? 0 : delay);
    }),
    on(target, 'pointerleave', () => {
      suppressed = false;
      cancel();
      hideTooltip(target);
    }),
    on(target, 'pointerdown', (e) => {
      cancel();
      if (e.pointerType !== 'touch') {
        suppressed = true;
        hideTooltip(target);
      }
    }),
    on(target, 'focus', () => {
      if (target.matches(':focus-visible')) schedule(150);
    }),
    on(target, 'blur', () => {
      cancel();
      hideTooltip(target);
    }),
    onLongPress(target, () => {
      show(target, get(), shortcut, placement);
      hideTimer = window.setTimeout(hide, 1500);
    }),
    on(target, 'contextmenu', (e) => {
      // Android fires contextmenu on long-press; the tooltip replaces it.
      if (owner === target && (e as PointerEvent).pointerType !== 'mouse') e.preventDefault();
    }),
  ];

  return {
    update(next, nextShortcut) {
      get = typeof next === 'function' ? next : () => next;
      if (nextShortcut !== undefined) shortcut = nextShortcut;
      if (owner === target && textEl) textEl.textContent = get();
    },
    destroy() {
      cancel();
      hideTooltip(target);
      for (const off of offs) off();
    },
  };
}
