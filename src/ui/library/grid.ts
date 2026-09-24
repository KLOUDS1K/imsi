/**
 * Virtualized photo grid.
 *
 * Only rows intersecting the scroll viewport (± one screen of overscan) have
 * DOM; tiles are absolutely positioned with transforms and recycled. Layout is
 * pure arithmetic (columns from the container width and the thumbnail-size
 * signal), so selection by marquee and keyboard navigation never query the
 * DOM. Scroll/resize work is coalesced into one rAF where all reads happen
 * before any writes.
 *
 * Interaction: click / Cmd-Ctrl-click / Shift-click, marquee drag on empty
 * space (mouse & pen), double-click (or tap on the already-selected photo on
 * touch) opens, arrows via the shared navigator, drag tiles onto sidebar
 * albums/folders (mouse), context menu (right-click / long-press / menu key).
 */
import type { AppContext } from '@/app/context';
import type { PhotoRecord } from '@/editor/types';
import { Disposer, h, on } from '@/ui/dom';
import { attachContextMenu, openMenu } from '@/ui/kit';
import { menuTargets, photoMenu, toggleFavorite } from './actions';
import { clearSelection, clickSelect, commitSelection, modsOf, navigateKey, activeId } from './selection';
import { librarySignals } from './state';
import { createTile, fitBox, recordAspect, renderTileRecord, type Tile } from './tile';
import { ThumbLoader } from './thumbs';

export const PHOTO_DRAG_TYPE = 'application/x-kloud-photos';

export interface PhotoGridOptions {
  ctx: AppContext;
  /** The scrolling ancestor. */
  scrollEl: HTMLElement;
  onOpen: (id: string) => void;
}

export interface PhotoGrid {
  readonly el: HTMLDivElement;
  setRecords(recs: PhotoRecord[]): void;
  /** Re-measure (call when the container may have changed size). */
  layout(): void;
  reveal(id: string): void;
  columns(): number;
  pageRows(): number;
  dispose(): void;
}

interface Geometry {
  width: number;
  cols: number;
  tileW: number;
  frameH: number;
  rowH: number;
  gapX: number;
  gapY: number;
}

const META_H = 38;
const OVERSCAN = 1; // screens

export function createPhotoGrid(opts: PhotoGridOptions): PhotoGrid {
  const { ctx, scrollEl } = opts;
  const d = new Disposer();
  const el = h('div', {
    class: 'k-grid',
    tabIndex: 0,
    attrs: { role: 'listbox', 'aria-multiselectable': 'true', 'aria-label': 'Photos' },
  });
  const marquee = h('div', { class: 'k-grid__marquee', hidden: true });
  el.append(marquee);

  const loader = new ThumbLoader(ctx.library, scrollEl);
  const measured = new Map<string, number>();
  const live = new Map<string, Tile>();
  const pool: Tile[] = [];
  let recs: PhotoRecord[] = [];
  let indexOf = new Map<string, number>();
  let geo: Geometry = { width: 0, cols: 1, tileW: 0, frameH: 0, rowH: 1, gapX: 0, gapY: 0 };
  let width = 0;
  let viewH = 0;
  let raf = 0;
  let needMeasure = true;
  let lastPointerType = 'mouse';

  const computeGeometry = (w: number): Geometry => {
    const narrow = w < 520;
    const gapX = narrow ? 10 : 18;
    const gapY = narrow ? 14 : 22;
    const min = librarySignals.thumbSize.value;
    let cols = Math.max(1, Math.floor((w + gapX) / (min + gapX)));
    if (narrow) cols = Math.max(2, cols);
    const tileW = Math.max(40, (w - gapX * (cols - 1)) / cols);
    const frameH = Math.round(tileW * 0.75);
    return { width: w, cols, tileW, frameH, rowH: frameH + 8 + META_H + gapY, gapX, gapY };
  };

  /* ---------------- rendering ---------------- */

  const acquire = (): Tile => {
    const t = pool.pop() ?? createTile();
    if (!t.el.isConnected) el.append(t.el);
    t.el.hidden = false;
    t.img.onload = () => {
      const id = t.rec?.id;
      if (!id || !t.img.naturalWidth) return;
      const ar = t.img.naturalWidth / t.img.naturalHeight;
      if (Math.abs((measured.get(id) ?? 0) - ar) > 0.01) {
        measured.set(id, ar);
        t.geo = '';
        schedule();
      }
    };
    return t;
  };

  const release = (id: string, t: Tile): void => {
    live.delete(id);
    loader.unbind(t.img);
    t.el.hidden = true;
    t.rec = null;
    t.geo = '';
    pool.push(t);
  };

  const placeTile = (t: Tile, i: number, rec: PhotoRecord): void => {
    const row = Math.floor(i / geo.cols);
    const col = i % geo.cols;
    const x = Math.round(col * (geo.tileW + geo.gapX));
    const y = row * geo.rowH;
    const img = fitBox(recordAspect(rec, measured), Math.round(geo.tileW), geo.frameH);
    const key = `${x},${y},${geo.tileW},${geo.frameH},${img.w},${img.h}`;
    if (t.geo === key) return;
    t.geo = key;
    t.el.style.transform = `translate(${x}px, ${y}px)`;
    t.el.style.width = `${Math.round(geo.tileW)}px`;
    (t.el.firstElementChild as HTMLElement).style.height = `${geo.frameH}px`;
    t.wrap.style.width = `${img.w}px`;
    t.wrap.style.height = `${img.h}px`;
  };

  const applySelection = (): void => {
    const sel = new Set(ctx.selection.value);
    const act = activeId(ctx);
    for (const [id, t] of live) {
      const s = sel.has(id);
      if (t.el.classList.contains('is-selected') !== s) {
        t.el.classList.toggle('is-selected', s);
        t.el.setAttribute('aria-selected', String(s));
      }
      t.el.classList.toggle('is-active', id === act);
    }
    if (act && indexOf.has(act)) el.setAttribute('aria-activedescendant', `k-tile-${act}`);
    else el.removeAttribute('aria-activedescendant');
  };

  const frame = (): void => {
    raf = 0;
    // ---- reads ----
    if (needMeasure) {
      width = el.clientWidth;
      needMeasure = false;
    }
    viewH = scrollEl.clientHeight;
    const top = el.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top;
    // ---- writes ----
    geo = computeGeometry(width);
    const rows = Math.ceil(recs.length / geo.cols);
    el.style.height = `${Math.max(0, rows * geo.rowH - geo.gapY)}px`;
    const viewTop = -top;
    const over = viewH * OVERSCAN;
    const r0 = Math.max(0, Math.floor((viewTop - over) / geo.rowH));
    const r1 = Math.min(rows - 1, Math.ceil((viewTop + viewH + over) / geo.rowH));
    const i0 = r0 * geo.cols;
    const i1 = Math.min(recs.length - 1, (r1 + 1) * geo.cols - 1);
    for (const [id, t] of live) {
      const i = indexOf.get(id);
      if (i === undefined || i < i0 || i > i1) release(id, t);
    }
    for (let i = i0; i <= i1; i++) {
      const rec = recs[i];
      let t = live.get(rec.id);
      if (!t) {
        t = acquire();
        live.set(rec.id, t);
      }
      renderTileRecord(t, rec);
      loader.bind(t.img, rec.id);
      placeTile(t, i, rec);
    }
    applySelection();
  };

  const schedule = (): void => {
    if (!raf) raf = requestAnimationFrame(frame);
  };

  /* ---------------- geometry helpers ---------------- */

  const tileRect = (i: number): { x: number; y: number; w: number; h: number } => {
    const row = Math.floor(i / geo.cols);
    const col = i % geo.cols;
    return { x: col * (geo.tileW + geo.gapX), y: row * geo.rowH, w: geo.tileW, h: geo.frameH + 8 + META_H };
  };

  const reveal = (id: string): void => {
    const i = indexOf.get(id);
    if (i === undefined) return;
    const r = tileRect(i);
    const top = el.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop;
    const y0 = top + r.y - 12;
    const y1 = top + r.y + r.h + 12;
    if (y0 < scrollEl.scrollTop) scrollEl.scrollTop = y0;
    else if (y1 > scrollEl.scrollTop + scrollEl.clientHeight) scrollEl.scrollTop = y1 - scrollEl.clientHeight;
    schedule();
  };

  /* ---------------- events ---------------- */

  const tileOf = (target: EventTarget | null): string | null => {
    const t = (target as HTMLElement | null)?.closest?.<HTMLElement>('.k-tile');
    return t && el.contains(t) ? (t.dataset.id ?? null) : null;
  };

  d.add(on(scrollEl, 'scroll', schedule, { passive: true }));
  const ro = new ResizeObserver(() => {
    needMeasure = true;
    schedule();
  });
  ro.observe(el);
  ro.observe(scrollEl);
  d.add(() => ro.disconnect());
  d.add(librarySignals.thumbSize.subscribe(() => {
    for (const t of live.values()) t.geo = '';
    schedule();
  }));
  d.add(ctx.selection.subscribe(applySelection));

  d.add(
    on(el, 'pointerdown', (e) => {
      lastPointerType = e.pointerType;
      const id = tileOf(e.target);
      const tile = id ? live.get(id) : undefined;
      // HTML5 drag only for mouse: on touch, long-press must open the context menu.
      if (tile) tile.el.draggable = e.pointerType === 'mouse' && !(e.target as HTMLElement).closest('button');
      if (!id && e.button === 0 && (e.pointerType === 'mouse' || e.pointerType === 'pen')) startMarquee(e);
    }),
  );

  d.add(
    on(el, 'click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
      const id = tileOf(e.target);
      if (!id) return;
      if (act) {
        e.stopPropagation();
        if (act.dataset.act === 'favorite') void toggleFavorite(ctx, menuTargets(ctx, id));
        else openMenu(act, photoMenu(ctx, menuTargets(ctx, id)), { placement: 'bottom-end' });
        return;
      }
      const mods = modsOf(e);
      const sel = ctx.selection.value;
      if (lastPointerType === 'touch' && !mods.toggle && !mods.range && sel.length === 1 && sel[0] === id) {
        opts.onOpen(id);
        return;
      }
      clickSelect(ctx, id, mods);
      el.focus({ preventScroll: true });
    }),
  );

  d.add(
    on(el, 'dblclick', (e) => {
      const id = tileOf(e.target);
      if (id && !(e.target as HTMLElement).closest('button')) opts.onOpen(id);
    }),
  );

  d.add(
    on(el, 'keydown', (e) => {
      if (e.target !== el) return;
      if (navigateKey(ctx, e)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const act = activeId(ctx);
      if (e.key === 'Enter' && act) {
        e.preventDefault();
        e.stopPropagation();
        opts.onOpen(act);
      } else if (e.key === ' ' && act) {
        e.preventDefault();
        clickSelect(ctx, act, { toggle: true, range: false });
      } else if (e.key === 'Escape' && ctx.selection.value.length) {
        e.stopPropagation();
        clearSelection(ctx);
      }
    }),
  );

  d.add(
    on(el, 'dragstart', (e) => {
      const id = tileOf(e.target);
      if (!id || !e.dataTransfer) return;
      const ids = ctx.selection.value.includes(id) ? menuTargets(ctx, id) : (clickSelect(ctx, id, { toggle: false, range: false }), [id]);
      e.dataTransfer.setData(PHOTO_DRAG_TYPE, JSON.stringify(ids));
      e.dataTransfer.setData('text/plain', ids.map((x) => ctx.library.get(x)?.name ?? x).join('\n'));
      e.dataTransfer.effectAllowed = 'copyMove';
      const t = live.get(id);
      if (t) e.dataTransfer.setDragImage(t.wrap, 24, 24);
    }),
  );

  d.add(
    attachContextMenu(el, (e) => {
      const id = tileOf(e.target) ?? (e.type === 'contextmenu' && (e as MouseEvent).button !== 2 ? activeId(ctx) : null);
      if (!id) return null;
      return photoMenu(ctx, menuTargets(ctx, id));
    }),
  );

  /* ---------------- marquee ---------------- */

  function startMarquee(e: PointerEvent): void {
    const origin = el.getBoundingClientRect();
    const sx = e.clientX - origin.left;
    const sy = e.clientY - origin.top;
    const additive = e.metaKey || e.ctrlKey || e.shiftKey;
    const base = additive ? new Set(ctx.selection.value) : new Set<string>();
    let moved = false;
    let lastX = e.clientX;
    let lastY = e.clientY;
    let autoRaf = 0;
    el.setPointerCapture(e.pointerId);
    e.preventDefault();
    el.focus({ preventScroll: true });

    const update = (): void => {
      const r = el.getBoundingClientRect();
      const cx = lastX - r.left;
      const cy = lastY - r.top;
      const x0 = Math.min(sx, cx);
      const y0 = Math.min(sy, cy);
      const x1 = Math.max(sx, cx);
      const y1 = Math.max(sy, cy);
      marquee.hidden = false;
      marquee.style.transform = `translate(${x0}px, ${y0}px)`;
      marquee.style.width = `${x1 - x0}px`;
      marquee.style.height = `${y1 - y0}px`;
      const hit = new Set(base);
      const rows = Math.ceil(recs.length / geo.cols);
      const ra = Math.max(0, Math.floor(y0 / geo.rowH));
      const rb = Math.min(rows - 1, Math.floor(y1 / geo.rowH));
      let first: string | null = null;
      for (let row = ra; row <= rb; row++) {
        for (let col = 0; col < geo.cols; col++) {
          const i = row * geo.cols + col;
          if (i >= recs.length) break;
          const tr = tileRect(i);
          if (tr.x < x1 && tr.x + tr.w > x0 && tr.y < y1 && tr.y + tr.h > y0) {
            hit.add(recs[i].id);
            first ??= recs[i].id;
          }
        }
      }
      commitSelection(ctx, hit, first ?? activeId(ctx));
    };

    const autoScroll = (): void => {
      autoRaf = 0;
      const sr = scrollEl.getBoundingClientRect();
      const edge = 36;
      let dy = 0;
      if (lastY < sr.top + edge) dy = -Math.min(24, sr.top + edge - lastY);
      else if (lastY > sr.bottom - edge) dy = Math.min(24, lastY - (sr.bottom - edge));
      if (dy !== 0) {
        scrollEl.scrollTop += dy;
        update();
        autoRaf = requestAnimationFrame(autoScroll);
      }
    };

    const offMove = on(el, 'pointermove', (ev) => {
      lastX = ev.clientX;
      lastY = ev.clientY;
      if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return;
      moved = true;
      update();
      if (!autoRaf) autoRaf = requestAnimationFrame(autoScroll);
    });
    const end = (): void => {
      offMove();
      offUp();
      offCancel();
      if (autoRaf) cancelAnimationFrame(autoRaf);
      marquee.hidden = true;
      if (!moved && !additive) clearSelection(ctx);
    };
    const offUp = on(el, 'pointerup', end);
    const offCancel = on(el, 'pointercancel', end);
  }

  return {
    el,
    setRecords(next) {
      recs = next;
      indexOf = new Map(next.map((r, i) => [r.id, i]));
      loader.refresh();
      schedule();
    },
    layout() {
      needMeasure = true;
      schedule();
    },
    reveal,
    columns: () => geo.cols,
    pageRows: () => Math.max(1, Math.floor((viewH || scrollEl.clientHeight) / geo.rowH)),
    dispose() {
      if (raf) cancelAnimationFrame(raf);
      d.dispose();
      loader.dispose();
      el.remove();
    },
  };
}
