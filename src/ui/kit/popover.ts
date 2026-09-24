/**
 * Popover — anchored floating panel (portal, position: fixed).
 *
 *   const pop = openPopover({ anchor: button, content: presetPreviewEl, placement: 'left-start' });
 *   pop.close();
 *
 * Flips/shifts to stay on screen, repositions on scroll/resize, closes on
 * outside pointerdown and Escape (topmost first), returns focus to the
 * anchor. Popovers opened from inside another popover (submenus) stack: a
 * click inside a child keeps its parents open.
 */
import './menu.css';
import { Disposer, h, on } from '../dom';
import { type AnchorLike, type Placement, focusableIn, portalRoot, positionFloating } from './util';

export interface PopoverOptions {
  anchor: AnchorLike;
  content: HTMLElement;
  placement?: Placement;
  offset?: number;
  /** Close on outside pointerdown / Escape. Default true. */
  dismissible?: boolean;
  /** Move focus into the popover: true = first focusable, an element, or false. Default true. */
  focus?: boolean | HTMLElement;
  /** Where focus goes on close. Default: the anchor element (if any) or the previously focused element. */
  returnFocus?: HTMLElement | null;
  /** Make the popover at least as wide as the anchor. */
  matchWidth?: boolean;
  role?: string;
  ariaLabel?: string;
  class?: string;
  /** Parent popover (submenus): closing the parent closes this one. */
  parent?: Popover;
  onClose?: () => void;
}

export interface Popover {
  readonly el: HTMLDivElement;
  readonly isOpen: boolean;
  close(): void;
  reposition(): void;
  /** Same as close(). */
  destroy(): void;
}

interface Entry {
  pop: Popover;
  el: HTMLElement;
  anchorEl: HTMLElement | null;
  dismissible: boolean;
  parent?: Popover;
}

const stack: Entry[] = [];
let globalOffs: (() => void)[] = [];

function installGlobal(): void {
  if (globalOffs.length) return;
  globalOffs = [
    on(
      document,
      'pointerdown',
      (e) => {
        const target = e.target as Node | null;
        // Topmost popover that contains the target (or whose anchor does).
        let keep = -1;
        for (let i = stack.length - 1; i >= 0; i--) {
          const s = stack[i];
          if ((target && s.el.contains(target)) || (target && s.anchorEl?.contains(target))) {
            keep = i;
            break;
          }
        }
        for (let i = stack.length - 1; i > keep; i--) if (stack[i].dismissible) stack[i].pop.close();
      },
      { capture: true },
    ),
    on(
      document,
      'keydown',
      (e) => {
        if (e.key !== 'Escape' || !stack.length) return;
        const top = stack[stack.length - 1];
        if (!top.dismissible) return;
        e.preventDefault();
        e.stopPropagation();
        top.pop.close();
      },
      { capture: true },
    ),
  ];
}

function uninstallGlobal(): void {
  if (stack.length) return;
  for (const off of globalOffs) off();
  globalOffs = [];
}

/** Close every open popover/menu (e.g. when switching modules). */
export function closeAllPopovers(): void {
  for (let i = stack.length - 1; i >= 0; i--) stack[i]?.pop.close();
}

export function openPopover(opts: PopoverOptions): Popover {
  const d = new Disposer();
  const anchorEl = opts.anchor instanceof HTMLElement ? opts.anchor : null;
  const prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const placement = opts.placement ?? 'bottom-start';
  const el = h(
    'div',
    {
      class: ['k-popover', opts.class],
      attrs: { role: opts.role ?? 'dialog', 'aria-label': opts.ariaLabel ?? null },
    },
    opts.content,
  );
  let open = true;
  let raf = 0;

  const reposition = (): void => {
    if (!open) return;
    if (anchorEl && !anchorEl.isConnected) {
      pop.close();
      return;
    }
    if (opts.matchWidth && anchorEl) el.style.minWidth = `${anchorEl.getBoundingClientRect().width}px`;
    positionFloating(el, opts.anchor, placement, { offset: opts.offset ?? 6 });
  };
  const schedule = (): void => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      reposition();
    });
  };

  const pop: Popover = {
    el,
    get isOpen() {
      return open;
    },
    reposition,
    close() {
      if (!open) return;
      open = false;
      // Children first.
      for (let i = stack.length - 1; i >= 0; i--) if (stack[i].parent === pop) stack[i].pop.close();
      const idx = stack.findIndex((s) => s.pop === pop);
      if (idx >= 0) stack.splice(idx, 1);
      cancelAnimationFrame(raf);
      d.dispose();
      const hadFocus = el.contains(document.activeElement) || document.activeElement === document.body;
      el.remove();
      uninstallGlobal();
      if (hadFocus) {
        const back = opts.returnFocus !== undefined ? opts.returnFocus : (anchorEl ?? prevFocus);
        back?.focus({ preventScroll: true });
      }
      opts.onClose?.();
    },
    destroy() {
      pop.close();
    },
  };

  portalRoot().appendChild(el);
  reposition();
  stack.push({ pop, el, anchorEl, dismissible: opts.dismissible !== false, parent: opts.parent });
  installGlobal();
  d.add(on(window, 'resize', schedule));
  d.add(on(window, 'scroll', schedule, { capture: true, passive: true }));
  requestAnimationFrame(() => el.classList.add('is-open'));

  if (opts.focus !== false) {
    const target = opts.focus instanceof HTMLElement ? opts.focus : (focusableIn(el)[0] ?? el);
    if (target === el) el.tabIndex = -1;
    target.focus({ preventScroll: true });
  }
  return pop;
}
