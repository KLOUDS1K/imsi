/**
 * Graceful stand-ins used when a feature module failed to load, so the app
 * still boots and stays usable:
 * - a minimal Library page (site Archive layout, thumbnail grid, import),
 * - a bare viewer (engine canvas that fits the viewport),
 * - a quiet "unavailable" panel.
 */
import './fallbacks.css';
import { createButton, createEmptyState, createSectionLabel } from '@/ui/kit';
import { Disposer, h, on } from '@/ui/dom';
import type { AppRuntime } from '@/app/createContext';
import type { Mounted } from '@/app/modules';
import type { ShellState } from './state';
import { addSamples } from './toolbar';

export function createUnavailable(title: string, detail: string): Mounted {
  const el = h('div', { class: 'k-unavail', attrs: { role: 'note' } }, h('p', { class: 'k-unavail__title' }, title), h('p', { class: 'k-unavail__detail' }, detail));
  return { el, dispose: () => el.remove() };
}

/** Library page with a plain thumbnail grid (used only when the Library UI module is unavailable). */
export function createFallbackLibraryView(rt: AppRuntime, state: ShellState): Mounted {
  const { ctx } = rt;
  const d = new Disposer();
  const grid = h('div', { class: 'k-fb-grid', attrs: { role: 'list' } });
  const label = h('div', { class: 'k-fb-label' });
  const body = h('div', { class: 'k-fb-body' });
  const el = h(
    'div',
    { class: 'k-fb-library k-scroll' },
    h('h1', { class: 'k-h1' }, 'Library'),
    h('p', { class: 'k-desc' }, 'Import photos, then open one to edit. Originals are never changed.'),
    h('hr', { class: 'k-divider' }),
    body,
  );
  const urls = new Map<string, string>();

  const render = (): void => {
    const q = state.librarySearch.value.trim();
    const sort = state.librarySort.value;
    const recs = ctx.library.query({ text: q || undefined, sort: sort.sort, order: sort.order });
    ctx.visibleIds.set(recs.map((r) => r.id));
    if (!ctx.library.all().length) {
      const imp = createButton({ label: 'Import photos', icon: 'upload', variant: 'primary', onClick: () => void ctx.importFiles() });
      const demo = createButton({ label: 'Add sample photos', icon: 'sparkles', onClick: () => void addSamples(rt) });
      body.replaceChildren(
        createEmptyState({ title: 'No photos yet', description: 'Import photos or drop a folder anywhere on this window.', actions: [imp.el, demo.el] }).el,
      );
      return;
    }
    label.replaceChildren(createSectionLabel('Photos', recs.length));
    grid.replaceChildren(
      ...recs.map((r) => {
        const img = h('img', { class: 'k-fb-tile__img', alt: '', loading: 'lazy', decoding: 'async' });
        const cached = urls.get(r.id);
        if (cached) img.src = cached;
        else
          void ctx.library.getThumbnailUrl(r.id).then((u) => {
            if (u) {
              urls.set(r.id, u);
              img.src = u;
            }
          });
        const tile = h(
          'button',
          {
            type: 'button',
            class: ['k-fb-tile', ctx.selection.value.includes(r.id) && 'is-selected'],
            dataset: { id: r.id },
            attrs: { role: 'listitem', 'aria-label': r.name },
          },
          h('span', { class: 'k-fb-tile__frame' }, img),
          h('span', { class: 'k-fb-tile__name k-truncate' }, r.name),
          h('span', { class: 'k-fb-tile__sub k-truncate' }, [r.meta.camera, r.meta.iso ? `ISO ${r.meta.iso}` : ''].filter(Boolean).join(' · ') || `${r.meta.width}×${r.meta.height}`),
        );
        return tile;
      }),
    );
    body.replaceChildren(label, grid);
  };

  d.add(
    on(grid, 'click', (e) => {
      const tile = (e.target as Element).closest<HTMLElement>('.k-fb-tile');
      if (tile?.dataset.id) ctx.selection.set([tile.dataset.id]);
    }),
  );
  d.add(
    on(grid, 'dblclick', (e) => {
      const tile = (e.target as Element).closest<HTMLElement>('.k-fb-tile');
      if (tile?.dataset.id) void rt.enterDevelop(tile.dataset.id);
    }),
  );
  d.add(ctx.library.subscribe(render));
  d.add(state.librarySearch.subscribe(render));
  d.add(state.librarySort.subscribe(render));
  d.add(ctx.selection.subscribe(() => grid.querySelectorAll<HTMLElement>('.k-fb-tile').forEach((t) => t.classList.toggle('is-selected', ctx.selection.value.includes(t.dataset.id ?? '')))));
  render();
  return {
    el,
    dispose() {
      d.dispose();
      el.remove();
    },
  };
}

/** The engine canvas alone, fitted to its container (used when the viewer module is unavailable). */
export function createFallbackViewer(rt: AppRuntime): Mounted {
  const { ctx } = rt;
  const engine = ctx.engine;
  if (!engine) return createUnavailable('Rendering is unavailable', rt.engineStatus.message ?? 'WebGL2 could not be started in this browser.');
  const el = h('div', { class: 'k-fb-viewer' }, engine.canvas);
  const ro = new ResizeObserver(() => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    engine.resize(r.width, r.height, window.devicePixelRatio || 1);
    ctx.requestRender();
  });
  ro.observe(el);
  return {
    el,
    dispose() {
      ro.disconnect();
      el.remove();
    },
  };
}
