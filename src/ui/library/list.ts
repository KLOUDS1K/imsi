/**
 * Virtualized, sortable list (table) view of the photos: name, date taken,
 * camera, lens, ISO, aperture, shutter, focal length, rating, label, size.
 *
 * Rows have a fixed height, so the visible slice is pure arithmetic. Columns
 * that do not fit the container width are dropped from the right-hand
 * detail columns first (name, date and rating always stay), which keeps the
 * table usable at 390 px.
 */
import type { AppContext } from '@/app/context';
import type { PhotoRecord } from '@/editor/types';
import { Disposer, h, on } from '@/ui/dom';
import { attachContextMenu, icon } from '@/ui/kit';
import { menuTargets, photoMenu } from './actions';
import { cameraOf, formatAperture, formatBytes, formatDate, formatFocal, formatShutter, recordDate } from './format';
import { PHOTO_DRAG_TYPE } from './grid';
import { activeId, clearSelection, clickSelect, modsOf, navigateKey } from './selection';
import { librarySignals, SORT_LABELS, type SortKey } from './state';
import { ThumbLoader, thumbImg } from './thumbs';

interface Column {
  id: string;
  label: string;
  sort?: SortKey;
  width: string;
  /** Minimum container width at which the column is shown. */
  minWidth: number;
  num?: boolean;
  cell?: (r: PhotoRecord) => string;
}

const COLUMNS: Column[] = [
  { id: 'thumb', label: '', width: '40px', minWidth: 0 },
  { id: 'name', label: 'Name', sort: 'name', width: 'minmax(140px, 2fr)', minWidth: 0 },
  { id: 'date', label: 'Date taken', sort: 'date-taken', width: 'minmax(128px, 1.1fr)', minWidth: 460, cell: (r) => formatDate(recordDate(r)) },
  { id: 'camera', label: 'Camera', sort: 'camera', width: 'minmax(96px, 1fr)', minWidth: 900, cell: (r) => cameraOf(r.meta) },
  { id: 'lens', label: 'Lens', sort: 'lens', width: 'minmax(96px, 1.2fr)', minWidth: 1180, cell: (r) => r.meta?.lens ?? '' },
  { id: 'iso', label: 'ISO', sort: 'iso', width: '58px', minWidth: 640, num: true, cell: (r) => (r.meta?.iso ? String(Math.round(r.meta.iso)) : '') },
  { id: 'aperture', label: 'Aperture', sort: 'aperture', width: '70px', minWidth: 700, num: true, cell: (r) => formatAperture(r.meta?.aperture) },
  { id: 'shutter', label: 'Shutter', sort: 'shutter', width: '72px', minWidth: 760, num: true, cell: (r) => formatShutter(r.meta?.shutter) },
  { id: 'focal', label: 'Focal', sort: 'focal-length', width: '64px', minWidth: 820, num: true, cell: (r) => formatFocal(r.meta?.focalLength) },
  { id: 'rating', label: 'Rating', sort: 'rating', width: '76px', minWidth: 0 },
  { id: 'label', label: 'Label', sort: 'label', width: '48px', minWidth: 560 },
  { id: 'size', label: 'Size', sort: 'size', width: '70px', minWidth: 1000, num: true, cell: (r) => formatBytes(r.size) },
];

const ROW_H = 36;

export interface PhotoList {
  readonly el: HTMLDivElement;
  setRecords(recs: PhotoRecord[]): void;
  layout(): void;
  reveal(id: string): void;
  pageRows(): number;
  dispose(): void;
}

interface Row {
  el: HTMLDivElement;
  img: HTMLImageElement;
  rec: PhotoRecord | null;
  cols: string;
}

export function createPhotoList(opts: { ctx: AppContext; scrollEl: HTMLElement; onOpen: (id: string) => void }): PhotoList {
  const { ctx, scrollEl } = opts;
  const d = new Disposer();
  const head = h('div', { class: 'k-list__head', attrs: { role: 'row' } });
  const body = h('div', { class: 'k-list__body', tabIndex: 0, attrs: { role: 'rowgroup', 'aria-label': 'Photos' } });
  const el = h('div', { class: 'k-list', attrs: { role: 'grid', 'aria-multiselectable': 'true' } }, head, body);
  const loader = new ThumbLoader(ctx.library, scrollEl);
  const live = new Map<string, Row>();
  const pool: Row[] = [];
  let recs: PhotoRecord[] = [];
  let indexOf = new Map<string, number>();
  let visibleCols: Column[] = COLUMNS;
  let colKey = '';
  let width = 0;
  let needMeasure = true;
  let raf = 0;

  const renderHead = (): void => {
    const sort = librarySignals.sort.value;
    head.replaceChildren(
      ...visibleCols.map((c) => {
        if (!c.sort) return h('span', { class: 'k-list__th', attrs: { role: 'columnheader' } }, c.label ? c.label : h('span', { class: 'k-sr-only' }, 'Thumbnail'));
        const active = sort.key === c.sort;
        return h(
          'button',
          {
            type: 'button',
            class: ['k-list__th', 'k-list__sort', c.num && 'is-num', active && 'is-active'],
            dataset: { sort: c.sort },
            attrs: { role: 'columnheader', 'aria-sort': active ? (sort.order === 'asc' ? 'ascending' : 'descending') : 'none', title: `Sort by ${SORT_LABELS[c.sort]}` },
          },
          h('span', { class: 'k-truncate' }, c.label),
          active ? icon(sort.order === 'asc' ? 'chevron-up' : 'chevron-down', 12) : null,
        );
      }),
    );
  };

  const fillRow = (row: Row, rec: PhotoRecord): void => {
    if (row.rec === rec && row.cols === colKey) return;
    row.rec = rec;
    row.cols = colKey;
    row.el.dataset.id = rec.id;
    row.el.id = `k-row-${rec.id}`;
    row.el.classList.toggle('is-rejected', rec.flag === 'reject');
    const cells: Node[] = [];
    for (const c of visibleCols) {
      if (c.id === 'thumb') cells.push(h('span', { class: 'k-list__td k-list__thumb' }, row.img));
      else if (c.id === 'name')
        cells.push(
          h(
            'span',
            { class: 'k-list__td k-list__name' },
            h('span', { class: 'k-truncate' }, rec.name),
            rec.favorite ? icon('heart-filled', 11, { class: 'k-list__fav' }) : null,
            rec.flag !== 'none' ? icon(rec.flag === 'pick' ? 'flag' : 'flag-x', 11, { class: `k-list__flag k-list__flag--${rec.flag}` }) : null,
            rec.hasEdits ? icon('sliders', 11, { class: 'k-list__edited', title: 'Edited' }) : null,
          ),
        );
      else if (c.id === 'rating')
        cells.push(
          h(
            'span',
            { class: 'k-list__td k-list__rating', attrs: { 'aria-label': `${rec.rating} stars` } },
            h('span', { class: 'k-list__stars-on' }, '★'.repeat(rec.rating)),
            h('span', { class: 'k-list__stars-off' }, '★'.repeat(5 - rec.rating)),
          ),
        );
      else if (c.id === 'label') cells.push(h('span', { class: 'k-list__td' }, rec.label ? h('span', { class: `k-list__label k-tile__label--${rec.label}`, attrs: { title: rec.label } }) : null));
      else cells.push(h('span', { class: ['k-list__td', c.num && 'is-num', 'k-truncate'] }, c.cell?.(rec) ?? ''));
    }
    row.el.replaceChildren(...cells);
    row.el.setAttribute('aria-label', rec.name);
  };

  const frame = (): void => {
    raf = 0;
    if (needMeasure) {
      width = el.clientWidth;
      needMeasure = false;
    }
    const viewH = scrollEl.clientHeight;
    const top = body.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top;
    const cols = COLUMNS.filter((c) => width >= c.minWidth);
    const key = cols.map((c) => c.id).join(',');
    if (key !== colKey) {
      colKey = key;
      visibleCols = cols;
      el.style.setProperty('--k-list-cols', cols.map((c) => c.width).join(' '));
      renderHead();
    }
    body.style.height = `${recs.length * ROW_H}px`;
    const i0 = Math.max(0, Math.floor((-top - viewH) / ROW_H));
    const i1 = Math.min(recs.length - 1, Math.ceil((-top + 2 * viewH) / ROW_H));
    for (const [id, row] of live) {
      const i = indexOf.get(id);
      if (i === undefined || i < i0 || i > i1) {
        live.delete(id);
        loader.unbind(row.img);
        row.el.hidden = true;
        row.rec = null;
        pool.push(row);
      }
    }
    for (let i = i0; i <= i1; i++) {
      const rec = recs[i];
      let row = live.get(rec.id);
      if (!row) {
        row = pool.pop() ?? { el: h('div', { class: 'k-list__row', attrs: { role: 'row', 'aria-selected': 'false' } }), img: thumbImg('k-list__img'), rec: null, cols: '' };
        if (!row.el.isConnected) body.append(row.el);
        row.el.hidden = false;
        live.set(rec.id, row);
      }
      fillRow(row, rec);
      loader.bind(row.img, rec.id);
      row.el.style.transform = `translateY(${i * ROW_H}px)`;
    }
    applySelection();
  };
  const schedule = (): void => {
    if (!raf) raf = requestAnimationFrame(frame);
  };

  const applySelection = (): void => {
    const sel = new Set(ctx.selection.value);
    const act = activeId(ctx);
    for (const [id, row] of live) {
      const s = sel.has(id);
      row.el.classList.toggle('is-selected', s);
      row.el.setAttribute('aria-selected', String(s));
      row.el.classList.toggle('is-active', id === act);
    }
    if (act && indexOf.has(act)) body.setAttribute('aria-activedescendant', `k-row-${act}`);
    else body.removeAttribute('aria-activedescendant');
  };

  const rowOf = (t: EventTarget | null): string | null => (t as HTMLElement | null)?.closest?.<HTMLElement>('.k-list__row')?.dataset.id ?? null;

  d.add(
    on(head, 'click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-sort]');
      const key = b?.dataset.sort as SortKey | undefined;
      if (!key) return;
      const cur = librarySignals.sort.value;
      const defaultDesc = key === 'date-taken' || key === 'date-added' || key === 'edited' || key === 'rating' || key === 'size';
      librarySignals.sort.set({ key, order: cur.key === key ? (cur.order === 'asc' ? 'desc' : 'asc') : defaultDesc ? 'desc' : 'asc' });
    }),
  );
  d.add(librarySignals.sort.subscribe(renderHead));
  d.add(on(scrollEl, 'scroll', schedule, { passive: true }));
  const ro = new ResizeObserver(() => {
    needMeasure = true;
    schedule();
  });
  ro.observe(el);
  ro.observe(scrollEl);
  d.add(() => ro.disconnect());
  d.add(ctx.selection.subscribe(applySelection));
  d.add(
    on(body, 'click', (e) => {
      const id = rowOf(e.target);
      if (!id) {
        if (!e.metaKey && !e.ctrlKey && !e.shiftKey) clearSelection(ctx);
        return;
      }
      clickSelect(ctx, id, modsOf(e));
      body.focus({ preventScroll: true });
    }),
  );
  d.add(
    on(body, 'dblclick', (e) => {
      const id = rowOf(e.target);
      if (id) opts.onOpen(id);
    }),
  );
  d.add(
    on(body, 'keydown', (e) => {
      if (e.target !== body) return;
      if (navigateKey(ctx, e)) {
        e.preventDefault();
        e.stopPropagation();
      } else if (e.key === 'Enter' && activeId(ctx)) {
        e.preventDefault();
        e.stopPropagation();
        opts.onOpen(activeId(ctx) as string);
      }
    }),
  );
  d.add(
    on(body, 'pointerdown', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('.k-list__row');
      if (row) row.draggable = e.pointerType === 'mouse';
    }),
  );
  d.add(
    on(body, 'dragstart', (e) => {
      const id = rowOf(e.target);
      if (!id || !e.dataTransfer) return;
      const ids = ctx.selection.value.includes(id) ? menuTargets(ctx, id) : [id];
      e.dataTransfer.setData(PHOTO_DRAG_TYPE, JSON.stringify(ids));
      e.dataTransfer.effectAllowed = 'copyMove';
    }),
  );
  d.add(attachContextMenu(body, (e) => {
    const id = rowOf(e.target) ?? activeId(ctx);
    return id ? photoMenu(ctx, menuTargets(ctx, id)) : null;
  }));

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
    reveal(id) {
      const i = indexOf.get(id);
      if (i === undefined) return;
      const top = body.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop;
      const headH = head.offsetHeight;
      const y0 = top + i * ROW_H - headH - 4;
      const y1 = top + (i + 1) * ROW_H + 4;
      if (y0 < scrollEl.scrollTop) scrollEl.scrollTop = y0;
      else if (y1 > scrollEl.scrollTop + scrollEl.clientHeight) scrollEl.scrollTop = y1 - scrollEl.clientHeight;
      schedule();
    },
    pageRows: () => Math.max(1, Math.floor(scrollEl.clientHeight / ROW_H) - 1),
    dispose() {
      if (raf) cancelAnimationFrame(raf);
      d.dispose();
      loader.dispose();
      el.remove();
    },
  };
}
