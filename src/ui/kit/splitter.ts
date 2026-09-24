/**
 * Splitter — a resizable panel edge (hairline with a wide hit area).
 *
 *   // Right-hand Develop panel; the splitter sits on its left edge.
 *   const split = createSplitter({ target: panelEl, edge: 'start', min: 260, max: 520,
 *     defaultSize: 312, storageKey: 'kloud-panel-w', cssVar: '--k-panel-w' });
 *   layout.insertBefore(split.el, panelEl);
 *
 * Drag (pointer capture), keyboard (←/→ or ↑/↓ 8px, Shift 32px, Home/End),
 * double-click resets. The size persists in localStorage when `storageKey`
 * is given. With `cssVar`, the size is written to that custom property on the
 * target (so CSS stays in charge of layout); otherwise width/height is set.
 */
import { Disposer, h, on } from '../dom';
import './layout.css';
import { type Component, clamp, loadLocal, saveLocal } from './util';

export interface SplitterOptions {
  target: HTMLElement;
  /** 'x' resizes width (vertical bar, default); 'y' resizes height. */
  axis?: 'x' | 'y';
  /** Edge of the target the splitter sits on: 'start' (left/top) or 'end' (right/bottom, default). */
  edge?: 'start' | 'end';
  min: number;
  max: number;
  defaultSize: number;
  storageKey?: string;
  cssVar?: string;
  label?: string;
  onResize?: (size: number) => void;
  onResizeEnd?: (size: number) => void;
}

export interface Splitter extends Component<HTMLDivElement> {
  setSize(px: number): void;
  getSize(): number;
  reset(): void;
}

export function createSplitter(opts: SplitterOptions): Splitter {
  const d = new Disposer();
  const axis = opts.axis ?? 'x';
  const sign = (opts.edge ?? 'end') === 'end' ? 1 : -1;
  let size = clamp(opts.storageKey ? loadLocal<number>(opts.storageKey, opts.defaultSize) : opts.defaultSize, opts.min, opts.max);
  if (!Number.isFinite(size)) size = opts.defaultSize;
  const el = h('div', {
    class: ['k-splitter', axis === 'y' && 'k-splitter--y'],
    tabIndex: 0,
    attrs: {
      role: 'separator',
      'aria-orientation': axis === 'x' ? 'vertical' : 'horizontal',
      'aria-label': opts.label ?? 'Resize panel',
      'aria-valuemin': opts.min,
      'aria-valuemax': opts.max,
    },
  });

  const apply = (): void => {
    const px = `${Math.round(size)}px`;
    if (opts.cssVar) opts.target.style.setProperty(opts.cssVar, px);
    else if (axis === 'x') opts.target.style.width = px;
    else opts.target.style.height = px;
    el.setAttribute('aria-valuenow', String(Math.round(size)));
  };
  const set = (px: number, persist: boolean): void => {
    const next = clamp(px, opts.min, opts.max);
    if (next === size) return;
    size = next;
    apply();
    opts.onResize?.(size);
    if (persist) {
      if (opts.storageKey) saveLocal(opts.storageKey, Math.round(size));
      opts.onResizeEnd?.(size);
    }
  };

  let dragId: number | null = null;
  let start = 0;
  let startSize = 0;
  d.add(
    on(el, 'pointerdown', (e) => {
      if (dragId !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
      dragId = e.pointerId;
      start = axis === 'x' ? e.clientX : e.clientY;
      startSize = size;
      el.classList.add('is-dragging');
      document.documentElement.classList.add(axis === 'x' ? 'k-resizing-x' : 'k-resizing-y');
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic */
      }
      e.preventDefault();
    }),
  );
  d.add(
    on(el, 'pointermove', (e) => {
      if (e.pointerId !== dragId) return;
      const delta = (axis === 'x' ? e.clientX : e.clientY) - start;
      set(startSize + sign * delta, false);
    }),
  );
  const end = (e: PointerEvent): void => {
    if (e.pointerId !== dragId) return;
    dragId = null;
    el.classList.remove('is-dragging');
    document.documentElement.classList.remove('k-resizing-x', 'k-resizing-y');
    if (opts.storageKey) saveLocal(opts.storageKey, Math.round(size));
    opts.onResizeEnd?.(size);
  };
  d.add(on(el, 'pointerup', end));
  d.add(on(el, 'pointercancel', end));
  d.add(on(el, 'lostpointercapture', end));
  d.add(on(el, 'dblclick', () => set(opts.defaultSize, true)));
  d.add(
    on(el, 'keydown', (e) => {
      const stepPx = e.shiftKey ? 32 : 8;
      const grow = axis === 'x' ? (e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0) : e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
      if (grow) set(size + grow * sign * stepPx, true);
      else if (e.key === 'Home') set(opts.min, true);
      else if (e.key === 'End') set(opts.max, true);
      else if (e.key === 'Enter') set(opts.defaultSize, true);
      else return;
      e.preventDefault();
      e.stopPropagation();
    }),
  );
  apply();

  return {
    el,
    setSize: (px) => set(px, true),
    getSize: () => size,
    reset: () => set(opts.defaultSize, true),
    destroy() {
      d.dispose();
      el.remove();
    },
  };
}
