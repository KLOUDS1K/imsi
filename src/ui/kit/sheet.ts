/**
 * Drawer (slides in from the left/right) and BottomSheet (mobile panels with a
 * draggable handle and snap points).
 *
 *   const drawer = createDrawer({ side: 'left', label: 'Folders', content: sidebarEl });
 *   drawer.open();
 *
 *   const sheet = createBottomSheet({ label: 'Edit', content: panelsEl, snapPoints: [0.2, 0.55, 0.92] });
 *   sheet.open(1);   // snap index
 *
 * Both mount themselves into the overlay root (or `container`). Escape closes;
 * modal variants show the --k-overlay scrim and trap focus; focus returns to
 * the opener on close. A drawer can be swiped closed on touch. The sheet
 * follows the finger on its handle/header and snaps to the nearest point
 * (flick velocity counts); dragging below the lowest point closes it.
 */
import './sheet.css';
import { Disposer, h, on } from '../dom';
import { type Component, clamp, focusableIn, portalRoot } from './util';

const INTERACTIVE = 'input, textarea, select, [role="slider"], .k-slider, .k-range, .k-wheel, [contenteditable="true"]';

function trapTab(root: HTMLElement, e: KeyboardEvent): void {
  if (e.key !== 'Tab') return;
  const items = focusableIn(root);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

/* ------------------------------------------------------------------ */
/* Drawer                                                              */
/* ------------------------------------------------------------------ */

export interface DrawerOptions {
  side?: 'left' | 'right';
  label: string;
  content: Node | Node[];
  /** CSS width (default min(var(--k-sidebar-w) + 64px, 86vw)). */
  width?: string;
  /** Scrim + focus trap (default true). */
  modal?: boolean;
  container?: HTMLElement;
  onOpen?: () => void;
  onClose?: () => void;
}

export interface Drawer extends Component<HTMLDivElement> {
  readonly panel: HTMLElement;
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
}

export function createDrawer(opts: DrawerOptions): Drawer {
  const d = new Disposer();
  const side = opts.side ?? 'left';
  const modal = opts.modal !== false;
  const panel = h(
    'aside',
    { class: ['k-drawer__panel', `k-drawer__panel--${side}`], tabIndex: -1, attrs: { role: 'dialog', 'aria-label': opts.label, 'aria-modal': modal ? 'true' : null } },
    ...(Array.isArray(opts.content) ? opts.content : [opts.content]),
  );
  if (opts.width) panel.style.width = opts.width;
  const scrim = h('div', { class: 'k-drawer__scrim' });
  const el = h('div', { class: ['k-drawer', modal && 'k-drawer--modal'], hidden: true }, modal ? scrim : null, panel);
  (opts.container ?? portalRoot()).appendChild(el);
  let isOpen = false;
  let returnTo: HTMLElement | null = null;
  let hideTimer = 0;

  const open = (): void => {
    if (isOpen) return;
    isOpen = true;
    window.clearTimeout(hideTimer);
    returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    el.hidden = false;
    panel.style.transform = '';
    requestAnimationFrame(() => el.classList.add('is-open'));
    (focusableIn(panel)[0] ?? panel).focus({ preventScroll: true });
    opts.onOpen?.();
  };
  const close = (): void => {
    if (!isOpen) return;
    isOpen = false;
    el.classList.remove('is-open');
    panel.style.transform = '';
    const ms = parseFloat(getComputedStyle(panel).transitionDuration) * 1000 || 0;
    hideTimer = window.setTimeout(() => (el.hidden = true), ms);
    if (el.contains(document.activeElement)) returnTo?.focus({ preventScroll: true });
    opts.onClose?.();
  };

  d.add(on(scrim, 'click', close));
  d.add(
    on(el, 'keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      } else if (modal) trapTab(panel, e);
    }),
  );

  // Touch swipe toward the edge closes.
  let sx = 0;
  let sy = 0;
  let dx = 0;
  let swiping: number | null = null;
  let decided = false;
  d.add(
    on(panel, 'pointerdown', (e) => {
      if (e.pointerType !== 'touch' || (e.target as Element).closest(INTERACTIVE)) return;
      swiping = e.pointerId;
      decided = false;
      sx = e.clientX;
      sy = e.clientY;
      dx = 0;
    }),
  );
  d.add(
    on(panel, 'pointermove', (e) => {
      if (e.pointerId !== swiping) return;
      const mx = e.clientX - sx;
      const my = e.clientY - sy;
      if (!decided) {
        if (Math.hypot(mx, my) < 8) return;
        decided = true;
        // Only a mostly-horizontal move toward the edge becomes a swipe.
        if (Math.abs(mx) < Math.abs(my) * 1.3 || (side === 'left' ? mx > 0 : mx < 0)) {
          swiping = null;
          return;
        }
        try {
          panel.setPointerCapture(e.pointerId);
        } catch {
          /* synthetic */
        }
        panel.classList.add('is-dragging');
      }
      dx = side === 'left' ? Math.min(0, mx) : Math.max(0, mx);
      panel.style.transform = `translateX(${dx}px)`;
    }),
  );
  const endSwipe = (e: PointerEvent): void => {
    if (e.pointerId !== swiping) return;
    swiping = null;
    panel.classList.remove('is-dragging');
    if (Math.abs(dx) > panel.offsetWidth * 0.3) close();
    else panel.style.transform = '';
  };
  d.add(on(panel, 'pointerup', endSwipe));
  d.add(on(panel, 'pointercancel', endSwipe));

  return {
    el,
    panel,
    open,
    close,
    toggle: () => (isOpen ? close() : open()),
    isOpen: () => isOpen,
    destroy() {
      window.clearTimeout(hideTimer);
      d.dispose();
      el.remove();
    },
  };
}

/* ------------------------------------------------------------------ */
/* BottomSheet                                                         */
/* ------------------------------------------------------------------ */

export interface BottomSheetOptions {
  label: string;
  content: Node | Node[];
  /** Optional header row under the handle (title, actions) — also a drag area. */
  header?: HTMLElement;
  /** Visible heights as fractions of the viewport height, ascending. Default [0.2, 0.55, 0.92]. */
  snapPoints?: number[];
  /** Snap index used by open() without an argument. Default 1. */
  initialSnap?: number;
  /** Scrim + focus trap (default false — panels float over the photo). */
  modal?: boolean;
  /** Dragging below the lowest snap point closes the sheet (default true). */
  dismissible?: boolean;
  container?: HTMLElement;
  onSnap?: (index: number) => void;
  onClose?: () => void;
}

export interface BottomSheet extends Component<HTMLDivElement> {
  readonly body: HTMLDivElement;
  open(snap?: number): void;
  close(): void;
  snapTo(index: number): void;
  getSnap(): number;
  isOpen(): boolean;
}

export function createBottomSheet(opts: BottomSheetOptions): BottomSheet {
  const d = new Disposer();
  const snaps = [...(opts.snapPoints ?? [0.2, 0.55, 0.92])].sort((a, b) => a - b);
  const modal = !!opts.modal;
  const dismissible = opts.dismissible !== false;
  let snap = clamp(opts.initialSnap ?? 1, 0, snaps.length - 1);
  let isOpen = false;
  let vh = 0;

  const handle = h('button', { type: 'button', class: 'k-sheet__handle', attrs: { 'aria-label': `Resize ${opts.label}` } }, h('span', { class: 'k-sheet__grabber' }));
  const grip = h('div', { class: 'k-sheet__grip' }, handle, opts.header ?? null);
  const body = h('div', { class: 'k-sheet__body' }, ...(Array.isArray(opts.content) ? opts.content : [opts.content]));
  const panel = h(
    'div',
    { class: 'k-sheet__panel', tabIndex: -1, attrs: { role: 'dialog', 'aria-label': opts.label, 'aria-modal': modal ? 'true' : null } },
    grip,
    body,
  );
  const scrim = h('div', { class: 'k-sheet__scrim' });
  const el = h('div', { class: ['k-sheet', modal && 'k-sheet--modal'], hidden: true }, modal ? scrim : null, panel);
  (opts.container ?? portalRoot()).appendChild(el);

  const maxH = (): number => snaps[snaps.length - 1] * vh;
  /** translateY for a visible height (panel is maxH tall, anchored to the bottom). */
  const yFor = (visible: number): number => maxH() - visible;
  const place = (visible: number): void => {
    panel.style.transform = `translate3d(0, ${yFor(visible).toFixed(1)}px, 0)`;
  };
  const measure = (): void => {
    vh = window.innerHeight;
    panel.style.height = `${maxH()}px`;
  };

  let returnTo: HTMLElement | null = null;
  let hideTimer = 0;

  function snapTo(i: number): void {
    snap = clamp(i, 0, snaps.length - 1);
    place(snaps[snap] * vh);
    el.dataset.snap = String(snap);
    handle.setAttribute('aria-valuenow', String(snap));
    opts.onSnap?.(snap);
  }

  function open(i = snap): void {
    window.clearTimeout(hideTimer);
    measure();
    if (!isOpen) {
      isOpen = true;
      returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      el.hidden = false;
      place(0);
      // Next frame: animate from closed to the snap point.
      requestAnimationFrame(() => {
        el.classList.add('is-open');
        snapTo(i);
      });
      if (modal) (focusableIn(body)[0] ?? panel).focus({ preventScroll: true });
    } else snapTo(i);
  }

  function close(): void {
    if (!isOpen) return;
    isOpen = false;
    el.classList.remove('is-open');
    place(0);
    const ms = parseFloat(getComputedStyle(panel).transitionDuration) * 1000 || 0;
    hideTimer = window.setTimeout(() => (el.hidden = true), ms);
    if (el.contains(document.activeElement)) returnTo?.focus({ preventScroll: true });
    opts.onClose?.();
  }

  /* ---- drag ---- */
  let dragId: number | null = null;
  let startY = 0;
  let startVisible = 0;
  let visible = 0;
  let samples: { t: number; y: number }[] = [];
  let moved = false;

  d.add(
    on(grip, 'pointerdown', (e) => {
      if (dragId !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
      if ((e.target as Element).closest(INTERACTIVE) || ((e.target as Element).closest('button') && e.target !== handle && !handle.contains(e.target as Node))) return;
      dragId = e.pointerId;
      startY = e.clientY;
      startVisible = snaps[snap] * vh;
      visible = startVisible;
      samples = [{ t: e.timeStamp, y: e.clientY }];
      moved = false;
      try {
        grip.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic */
      }
    }),
  );
  d.add(
    on(grip, 'pointermove', (e) => {
      if (e.pointerId !== dragId) return;
      const dy = e.clientY - startY;
      if (!moved && Math.abs(dy) < 4) return;
      if (!moved) {
        moved = true;
        el.classList.add('is-dragging');
      }
      // Rubber-band above the top snap.
      let v = startVisible - dy;
      const top = maxH();
      if (v > top) v = top + (v - top) * 0.25;
      visible = Math.max(0, v);
      place(Math.min(visible, top + 40));
      samples.push({ t: e.timeStamp, y: e.clientY });
      if (samples.length > 6) samples.shift();
    }),
  );
  const endDrag = (e: PointerEvent): void => {
    if (e.pointerId !== dragId) return;
    dragId = null;
    el.classList.remove('is-dragging');
    if (!moved) return; // a tap: the handle's click handler cycles snaps
    // The click that may follow this drag is swallowed once, then reset.
    window.setTimeout(() => (moved = false), 0);
    const first = samples[0];
    const last = samples[samples.length - 1];
    const dt = Math.max(1, last.t - first.t);
    // Held still before releasing → no flick.
    const velocity = e.timeStamp - last.t > 100 ? 0 : -(last.y - first.y) / dt; // px/ms, positive = upward
    const projected = visible + velocity * 180;
    if (dismissible && projected < snaps[0] * vh * 0.55) {
      close();
      return;
    }
    let best = 0;
    for (let i = 1; i < snaps.length; i++) if (Math.abs(snaps[i] * vh - projected) < Math.abs(snaps[best] * vh - projected)) best = i;
    snapTo(best);
  };
  d.add(on(grip, 'pointerup', endDrag));
  d.add(on(grip, 'pointercancel', endDrag));
  // Suppress the click that ends a drag on the handle.
  d.add(
    on(
      handle,
      'click',
      (e) => {
        if (moved) {
          moved = false;
          e.stopImmediatePropagation();
          return;
        }
        snapTo((snap + 1) % snaps.length);
      },
    ),
  );
  d.add(
    on(handle, 'keydown', (e) => {
      if (e.key === 'ArrowUp') snapTo(snap + 1);
      else if (e.key === 'ArrowDown') {
        if (snap === 0 && dismissible) close();
        else snapTo(snap - 1);
      } else return;
      e.preventDefault();
      e.stopPropagation();
    }),
  );
  d.add(
    on(el, 'keydown', (e) => {
      if (e.key === 'Escape' && (modal || dismissible)) {
        e.stopPropagation();
        close();
      } else if (modal) trapTab(panel, e);
    }),
  );
  d.add(on(scrim, 'click', () => dismissible && close()));
  d.add(
    on(window, 'resize', () => {
      if (!isOpen) return;
      measure();
      place(snaps[snap] * vh);
    }),
  );

  return {
    el,
    body,
    open,
    close,
    snapTo: (i) => (isOpen ? snapTo(i) : open(i)),
    getSnap: () => snap,
    isOpen: () => isOpen,
    destroy() {
      window.clearTimeout(hideTimer);
      d.dispose();
      el.remove();
    },
  };
}
