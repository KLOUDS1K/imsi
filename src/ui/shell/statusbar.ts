/**
 * 26px bottom status bar (site style: muted, small, tabular numerals).
 *
 *   Library:  128 photos · 3 selected                       WebGL2 · RGBA16F   Saved
 *   Develop:  IMG_0412.jpg · 6000×4000 · 12 of 128  |  100%  R 212 G 180 B 96  |  14 ms   WebGL2 · RGBA16F   Saved
 *
 * The busy task (label + thin progress) takes over the left side while active.
 */
import './statusbar.css';
import { createStatusBar } from '@/ui/kit';
import { Disposer, h } from '@/ui/dom';
import type { AppRuntime } from '@/app/createContext';
import type { SaveState } from '@/app/document';

export interface AppStatusBar {
  el: HTMLElement;
  dispose(): void;
}

const SAVE_TEXT: Record<SaveState, string> = {
  idle: '',
  pending: 'Unsaved changes',
  saving: 'Saving…',
  saved: 'Saved',
  error: 'Save failed',
};

export function createAppStatusBar(rt: AppRuntime): AppStatusBar {
  const { ctx } = rt;
  const d = new Disposer();
  const t = (cls: string): HTMLSpanElement => h('span', { class: cls });

  const count = t('k-sb__count');
  const busyLabel = t('k-sb__busy-label');
  const busyFill = h('span', { class: 'k-sb__busy-fill' });
  const busy = h('span', { class: 'k-sb__busy', hidden: true }, h('span', { class: 'k-sb__busy-track' }, busyFill), busyLabel);
  const zoom = t('k-sb__zoom k-sb__dev');
  const readout = t('k-sb__readout k-sb__dev');
  const ms = t('k-sb__ms k-sb__dev');
  const caps = t('k-sb__caps');
  const save = t('k-sb__save');
  const el = createStatusBar(
    h('span', { class: 'k-sb__left' }, count, busy),
    h('span', { class: 'k-sb__spacer' }),
    zoom,
    readout,
    ms,
    caps,
    save,
  );
  el.classList.add('k-sb');

  /* ---- capability badge ---- */
  const engine = ctx.engine;
  if (engine) {
    const c = engine.caps;
    caps.textContent = `WebGL2 · ${c.halfFloatRender ? 'RGBA16F' : 'RGBA8'}${c.webgpu ? ' · WebGPU available' : ''}`;
    caps.title = c.renderer;
  } else {
    caps.textContent = 'No WebGL2';
    caps.title = rt.engineStatus.message ?? '';
    caps.classList.add('is-warn');
  }
  // WebGPU is probed asynchronously by the engine; refresh the badge once.
  const capsTimer = window.setTimeout(() => {
    if (engine?.caps.webgpu && !caps.textContent?.includes('WebGPU')) caps.textContent += ' · WebGPU available';
  }, 1500);
  d.add(() => window.clearTimeout(capsTimer));
  if (rt.storageBackend === 'memory') {
    save.title = 'Browser storage is unavailable: edits are kept only until this tab closes.';
  }

  /* ---- counts ---- */
  const updateCount = (): void => {
    const total = ctx.library.all().length;
    const doc = ctx.doc.value;
    if (ctx.module.value === 'develop' && doc) {
      const ids = ctx.visibleIds.value;
      const i = ids.indexOf(doc.photoId);
      const dims = `${doc.meta.width}×${doc.meta.height}`;
      count.textContent = `${doc.record.name} · ${dims}${i >= 0 ? ` · ${i + 1} of ${ids.length}` : ''}`;
    } else {
      const sel = ctx.selection.value.length;
      const shown = ctx.visibleIds.value.length;
      const base = shown !== total ? `${shown} of ${total} photos` : `${total} ${total === 1 ? 'photo' : 'photos'}`;
      count.textContent = sel > 1 ? `${base} · ${sel} selected` : base;
    }
  };
  d.add(ctx.library.subscribe(updateCount));
  d.add(ctx.selection.subscribe(updateCount));
  d.add(ctx.visibleIds.subscribe(updateCount));
  d.add(ctx.doc.subscribe(updateCount));

  /* ---- develop readouts ---- */
  const updateZoom = (): void => {
    const e = ctx.engine;
    if (!e || !ctx.doc.value || ctx.module.value !== 'develop') {
      zoom.textContent = '';
      return;
    }
    try {
      const tr = e.getDisplayTransform(ctx.view.value);
      const pct = Math.round(tr.scale * 100);
      zoom.textContent = ctx.view.value.zoom === 'fit' ? `Fit · ${pct}%` : `${pct}%`;
    } catch {
      zoom.textContent = '';
    }
  };
  let zoomRaf = 0;
  const queueZoom = (): void => {
    if (!zoomRaf) zoomRaf = requestAnimationFrame(() => ((zoomRaf = 0), updateZoom()));
  };
  d.add(() => cancelAnimationFrame(zoomRaf));
  d.add(ctx.view.subscribe(queueZoom));
  d.add(ctx.doc.subscribe(queueZoom));
  // The fit scale is only known once the viewer has sized the canvas and the first frame rendered.
  if (ctx.engine) d.add(ctx.engine.onRendered(() => queueZoom()));
  // The viewport size changes the fit scale.
  const ro = new ResizeObserver(queueZoom);
  ro.observe(document.documentElement);
  d.add(() => ro.disconnect());

  d.add(
    ctx.pixelReadout.subscribe((p) => {
      if (!p) {
        readout.textContent = '';
        return;
      }
      const [r, g, b] = p.rgb.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255));
      readout.textContent = `R ${r}  G ${g}  B ${b}`;
    }),
  );
  d.add(rt.renderMs.subscribe((v) => (ms.textContent = v === null ? '' : `${v < 10 ? v.toFixed(1) : Math.round(v)} ms`)));

  /* ---- save + busy ---- */
  d.add(
    rt.saveState.subscribe((s) => {
      save.textContent = rt.storageBackend === 'memory' && s === 'saved' ? 'Saved (this session only)' : SAVE_TEXT[s];
      save.dataset.state = s;
    }, true),
  );
  d.add(
    ctx.busy.subscribe((b) => {
      busy.hidden = !b.active;
      count.hidden = b.active;
      busyLabel.textContent = b.label ?? 'Working…';
      const p = b.progress;
      busy.classList.toggle('is-indeterminate', p === undefined || p === null || !Number.isFinite(p));
      busyFill.style.transform = `scaleX(${p !== undefined && Number.isFinite(p) ? Math.max(0.02, Math.min(1, p)) : 0.3})`;
    }, true),
  );
  d.add(ctx.module.subscribe((m) => ((el.dataset.module = m), updateCount(), queueZoom()), true));

  return {
    el,
    dispose() {
      d.dispose();
      el.remove();
    },
  };
}
