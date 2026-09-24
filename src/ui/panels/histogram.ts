/**
 * Histogram / scopes block at the top of the Develop right panel.
 *
 * - Histogram: drawn from `ctx.histogram` (the renderer publishes it after
 *   renders, throttled) with analysis.drawHistogram.
 * - Waveform / parade / vectorscope: need pixels, so they read a 256px copy of
 *   the rendered output with engine.readPixels(256) — only while that scope is
 *   selected, and at most once per animation frame.
 * - Clipping triangles toggle ctx.view.clipping and light up in the clip colors
 *   when the current histogram has clipped pixels.
 * - Camera line (ISO · focal · aperture · shutter) or, while the pointer is
 *   over the photo, the R/G/B % readout.
 */
import type { AppContext, ScopeKind } from '@/app/context';
import { drawHistogram, drawParade, drawVectorscope, drawWaveform } from '@/editor/analysis';
import type { Histogram } from '@/editor/types';
import { Disposer, h, on } from '@/ui/dom';
import { createSegmentedControl, onThemeChange } from '@/ui/kit';
import { fitCanvas, formatCameraLine, pct } from './util';

const CLIP_THRESHOLD = 0.0002;

export interface HistogramBlock {
  el: HTMLElement;
  dispose(): void;
}

export function createHistogramBlock(ctx: AppContext): HistogramBlock {
  const d = new Disposer();
  const canvas = h('canvas', { class: 'k-pnl-hist__canvas', attrs: { role: 'img', 'aria-label': 'Histogram' } });
  const empty = h('div', { class: 'k-pnl-hist__empty' }, 'No photo');
  const scopeMsg = h('div', { class: 'k-pnl-hist__empty', hidden: true }, 'Scopes need WebGL2');

  const clipBtn = (kind: 'shadows' | 'highlights'): HTMLButtonElement =>
    h(
      'button',
      {
        type: 'button',
        class: ['k-pnl-hist__clip', `k-pnl-hist__clip--${kind}`],
        title: kind === 'shadows' ? 'Show shadow clipping (J)' : 'Show highlight clipping (J)',
        attrs: { 'aria-label': kind === 'shadows' ? 'Show shadow clipping' : 'Show highlight clipping', 'aria-pressed': 'false' },
        onclick: () => {
          const v = ctx.view.value;
          ctx.view.set({ ...v, clipping: { ...v.clipping, [kind]: !v.clipping[kind] } });
        },
      },
      h('span', { class: 'k-pnl-hist__tri', attrs: { 'aria-hidden': 'true' } }),
    );
  const shadowsBtn = clipBtn('shadows');
  const highlightsBtn = clipBtn('highlights');

  const plot = h('div', { class: 'k-pnl-hist__plot' }, canvas, empty, scopeMsg, shadowsBtn, highlightsBtn);

  const scopeCtl = createSegmentedControl<ScopeKind>({
    ariaLabel: 'Scope',
    size: 'sm',
    value: ctx.scope.value,
    options: [
      { value: 'histogram', icon: 'bar-chart', title: 'Histogram' },
      { value: 'waveform', icon: 'waveform', title: 'Waveform' },
      { value: 'parade', icon: 'columns', title: 'RGB parade' },
      { value: 'vectorscope', icon: 'target', title: 'Vectorscope' },
    ],
    onChange: (v) => ctx.scope.set(v),
  });
  d.add(() => scopeCtl.destroy());

  const info = h('div', { class: 'k-pnl-hist__info k-num' });
  const el = h(
    'div',
    { class: 'k-pnl-hist', attrs: { role: 'group', 'aria-label': 'Histogram and scopes' } },
    plot,
    h('div', { class: 'k-pnl-hist__bar' }, info, scopeCtl.el),
  );

  /* ---- drawing ---- */
  let raf = 0;
  let cssW = 0;
  let cssH = 0;

  function draw(): void {
    raf = 0;
    const doc = ctx.doc.value;
    const scope = ctx.scope.value;
    const hist = ctx.histogram.value;
    el.dataset.scope = scope;
    empty.hidden = !!doc && (scope !== 'histogram' || !!hist);
    const engine = ctx.engine;
    scopeMsg.hidden = scope === 'histogram' || !doc || !!engine;
    const c2d = canvas.getContext('2d');
    if (!doc || !cssW) {
      c2d?.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    try {
      if (scope === 'histogram') {
        if (hist) drawHistogram(canvas, hist, { mode: 'rgb', showClipping: true });
        else c2d?.clearRect(0, 0, canvas.width, canvas.height);
      } else if (engine) {
        const px = engine.readPixels(256);
        if (scope === 'waveform') drawWaveform(canvas, px, { mode: 'rgb' });
        else if (scope === 'parade') drawParade(canvas, px);
        else drawVectorscope(canvas, px);
      } else {
        c2d?.clearRect(0, 0, canvas.width, canvas.height);
      }
    } catch (e) {
      console.error('[panels] scope draw failed', e);
    }
  }

  const schedule = (): void => {
    if (!raf) raf = requestAnimationFrame(draw);
  };
  d.add(() => cancelAnimationFrame(raf));

  const ro = new ResizeObserver((entries) => {
    const r = entries[entries.length - 1].contentRect;
    cssW = r.width;
    cssH = r.height;
    if (fitCanvas(canvas, cssW, cssH)) schedule();
  });
  ro.observe(plot);
  d.add(() => ro.disconnect());

  /* ---- clipping indicators ---- */
  function renderClip(hist: Histogram | null): void {
    const clip = ctx.view.value.clipping;
    shadowsBtn.setAttribute('aria-pressed', String(clip.shadows));
    highlightsBtn.setAttribute('aria-pressed', String(clip.highlights));
    shadowsBtn.classList.toggle('is-clipped', !!hist && hist.clippedShadows > CLIP_THRESHOLD);
    highlightsBtn.classList.toggle('is-clipped', !!hist && hist.clippedHighlights > CLIP_THRESHOLD);
    if (hist) {
      shadowsBtn.title = `Shadow clipping ${pct(hist.clippedShadows)}% (J)`;
      highlightsBtn.title = `Highlight clipping ${pct(hist.clippedHighlights)}% (J)`;
    }
  }

  /* ---- info line ---- */
  function renderInfo(): void {
    const px = ctx.pixelReadout.value;
    const doc = ctx.doc.value;
    info.classList.toggle('is-readout', !!px);
    if (px && doc) {
      const [r, g, b] = px.rgb;
      info.replaceChildren(
        h('span', { class: 'k-pnl-hist__ch k-pnl-hist__ch--r' }, 'R ', pct(r)),
        h('span', { class: 'k-pnl-hist__ch k-pnl-hist__ch--g' }, 'G ', pct(g)),
        h('span', { class: 'k-pnl-hist__ch k-pnl-hist__ch--b' }, 'B ', pct(b), ' %'),
      );
    } else {
      info.textContent = doc ? formatCameraLine(doc.meta) || doc.meta.fileName : '';
    }
  }

  d.add(
    ctx.histogram.subscribe((hist) => {
      renderClip(hist);
      schedule();
    }, true),
  );
  d.add(
    ctx.scope.subscribe((s) => {
      scopeCtl.setValue(s, true);
      canvas.setAttribute('aria-label', s === 'histogram' ? 'Histogram' : s === 'parade' ? 'RGB parade' : s === 'waveform' ? 'Waveform' : 'Vectorscope');
      schedule();
    }, true),
  );
  d.add(ctx.view.subscribe(() => renderClip(ctx.histogram.value), true));
  d.add(
    ctx.doc.subscribe(() => {
      renderInfo();
      schedule();
    }, true),
  );
  d.add(ctx.pixelReadout.subscribe(renderInfo));
  d.add(ctx.engine ? ctx.engine.onRendered((_ms, target) => target === 'main' && ctx.scope.value !== 'histogram' && schedule()) : null);
  d.add(onThemeChange(schedule));
  // Double-click the plot cycles scopes (Lightroom-style quick switch).
  d.add(
    on(plot, 'dblclick', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      const order: ScopeKind[] = ['histogram', 'waveform', 'parade', 'vectorscope'];
      ctx.scope.set(order[(order.indexOf(ctx.scope.value) + 1) % order.length]);
    }),
  );

  return {
    el,
    dispose() {
      d.dispose();
      el.remove();
    },
  };
}
