/**
 * Tone-curve editor (canvas).
 *
 * Point mode
 * - Click adds a point (snapped onto the curve when the click is close to it)
 *   and starts dragging it; drag moves a point between its neighbours.
 * - Drag an interior point off the graph (> 24px) to delete it; drag back in
 *   to restore it before releasing. Double-click deletes (end points reset).
 * - Alt/Option-drag = 10× finer. Keyboard (graph focused): [ / ] select the
 *   previous/next point, arrows nudge by 1/255 (Shift ×10), Delete removes.
 *
 * Parametric mode
 * - The graph shows the parametric curve with the four regions; drag
 *   vertically inside the graph to change the region under the pointer.
 * - Three split handles under the graph move the region boundaries.
 *
 * The rendered-output histogram is drawn behind the curve. Colors come from
 * the theme tokens and the canvas redraws on theme changes.
 */
import { createCurveEvaluator, createParametricEvaluator } from '@/editor/color/curves';
import type { CurvePoint, Histogram, ParametricCurve, ToneCurveParams } from '@/editor/types';
import { Disposer, h, on } from '@/ui/dom';
import { clamp, onThemeChange } from '@/ui/kit';
import { fitCanvas, tokenColor } from '../util';

export type CurveChannel = 'rgb' | 'red' | 'green' | 'blue';
export type CurveMode = 'parametric' | 'point';
export type ParamRegion = 'shadows' | 'darks' | 'lights' | 'highlights';
export type SplitKey = 'split1' | 'split2' | 'split3';

export interface CurveEditorOptions {
  /** Start of a drag / split drag (wire to store.beginGesture). */
  onGestureStart(label: string): void;
  onGestureEnd(): void;
  /** New points for a channel (drag, add, delete, nudge). */
  onPoints(channel: CurveChannel, points: CurvePoint[], label: string): void;
  /** Parametric region drag. */
  onRegion(region: ParamRegion, value: number): void;
  onSplit(key: SplitKey, value: number): void;
}

export interface CurveEditor {
  el: HTMLElement;
  setMode(mode: CurveMode): void;
  setChannel(ch: CurveChannel): void;
  setData(tc: ToneCurveParams | null): void;
  setHistogram(h: Histogram | null): void;
  setDisabled(disabled: boolean): void;
  /** Index of the selected point (tests / keyboard). */
  selected(): number | null;
  destroy(): void;
}

const PAD = 8;
const GAP = 0.01;
const HIT_MOUSE = 9;
const HIT_TOUCH = 16;
const OFF_DELETE = 24;
const REGIONS: ParamRegion[] = ['shadows', 'darks', 'lights', 'highlights'];
const CHANNEL_TOKEN: Record<CurveChannel, [string, string]> = {
  rgb: ['--k-text', '#1b1b1c'],
  red: ['--k-label-red', '#e5484d'],
  green: ['--k-label-green', '#46a758'],
  blue: ['--k-label-blue', '#3e8ae8'],
};

const clonePts = (p: CurvePoint[]): CurvePoint[] => p.map((q) => ({ x: q.x, y: q.y }));

export function createCurveEditor(opts: CurveEditorOptions): CurveEditor {
  const d = new Disposer();
  let mode: CurveMode = 'point';
  let channel: CurveChannel = 'rgb';
  let tc: ToneCurveParams | null = null;
  let hist: Histogram | null = null;
  let disabled = false;
  let selected: number | null = null;
  let hoverRegion: ParamRegion | null = null;

  const canvas = h('canvas', { class: 'k-pnl-curve__canvas', attrs: { 'aria-hidden': 'true' } });
  const plot = h(
    'div',
    {
      class: 'k-pnl-curve__plot',
      tabIndex: 0,
      attrs: { role: 'application', 'aria-label': 'Tone curve. Click to add a point, drag to move, [ and ] select, arrows nudge, Delete removes.' },
    },
    canvas,
  );
  const splitHandles = (['split1', 'split2', 'split3'] as SplitKey[]).map((key, i) =>
    h('div', {
      class: 'k-pnl-curve__split',
      tabIndex: 0,
      dataset: { key },
      attrs: { role: 'slider', 'aria-label': ['Shadows / darks split', 'Darks / lights split', 'Lights / highlights split'][i], 'aria-valuemin': 0, 'aria-valuemax': 100 },
    }),
  );
  const splits = h('div', { class: 'k-pnl-curve__splits' }, h('div', { class: 'k-pnl-curve__splitrail' }), ...splitHandles);
  const status = h('div', { class: 'k-pnl-curve__status k-num', attrs: { 'aria-live': 'polite' } });
  const el = h('div', { class: 'k-pnl-curve', dataset: { mode } }, plot, splits, status);

  /* ------------------------------------------------------------ */
  /* Geometry                                                       */
  /* ------------------------------------------------------------ */
  let cssW = 0;
  let cssH = 0;
  const pw = (): number => Math.max(1, cssW - PAD * 2);
  const ph = (): number => Math.max(1, cssH - PAD * 2);
  const toX = (x: number): number => PAD + x * pw();
  const toY = (y: number): number => PAD + (1 - y) * ph();
  const fromX = (px: number): number => (px - PAD) / pw();
  const fromY = (py: number): number => 1 - (py - PAD) / ph();

  const channelPoints = (): CurvePoint[] => (tc ? tc[channel] : [{ x: 0, y: 0 }, { x: 1, y: 1 }]);
  const param = (): ParametricCurve | null => tc?.parametric ?? null;

  function regionAt(x: number): ParamRegion {
    const p = param();
    const s1 = (p?.split1 ?? 25) / 100;
    const s2 = (p?.split2 ?? 50) / 100;
    const s3 = (p?.split3 ?? 75) / 100;
    return x < s1 ? 'shadows' : x < s2 ? 'darks' : x < s3 ? 'lights' : 'highlights';
  }

  /* ------------------------------------------------------------ */
  /* Drawing                                                        */
  /* ------------------------------------------------------------ */
  let raf = 0;
  /** Points shown while dragging (local, may differ from the store for a frame). */
  let dragPts: CurvePoint[] | null = null;
  let dragRemoved = false;

  const schedule = (): void => {
    if (!raf) raf = requestAnimationFrame(draw);
  };
  d.add(() => cancelAnimationFrame(raf));

  function draw(): void {
    raf = 0;
    const g = canvas.getContext('2d');
    if (!g || !cssW) return;
    const dpr = canvas.width / cssW;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cssW, cssH);
    const cBg = tokenColor(el, '--k-surface-2', '#efeeea');
    const cGrid = tokenColor(el, '--k-border', '#e6e4df');
    const cGridStrong = tokenColor(el, '--k-border-strong', '#d4d1ca');
    const cFaint = tokenColor(el, '--k-text-faint', '#a9a79f');
    const cAccent = tokenColor(el, '--k-accent', '#f2c230');
    const [tok, fb] = mode === 'parametric' ? CHANNEL_TOKEN.rgb : CHANNEL_TOKEN[channel];
    const cCurve = tokenColor(el, tok, fb);

    // plot background
    g.fillStyle = cBg;
    roundRect(g, 0.5, 0.5, cssW - 1, cssH - 1, 6);
    g.fill();

    // parametric region highlight
    const p = param();
    if (mode === 'parametric' && p) {
      const bounds = [0, p.split1 / 100, p.split2 / 100, p.split3 / 100, 1];
      const active = draggingRegion ?? hoverRegion;
      if (active) {
        const i = REGIONS.indexOf(active);
        g.fillStyle = cGrid;
        g.globalAlpha = 0.7;
        g.fillRect(toX(bounds[i]), PAD, toX(bounds[i + 1]) - toX(bounds[i]), ph());
        g.globalAlpha = 1;
      }
    }

    // histogram
    if (hist) drawHist(g, cFaint);

    // grid (quarters) + baseline
    g.lineWidth = 1;
    g.strokeStyle = cGrid;
    g.beginPath();
    for (let i = 1; i < 4; i++) {
      const x = Math.round(toX(i / 4)) + 0.5;
      const y = Math.round(toY(i / 4)) + 0.5;
      g.moveTo(x, PAD);
      g.lineTo(x, PAD + ph());
      g.moveTo(PAD, y);
      g.lineTo(PAD + pw(), y);
    }
    g.stroke();
    if (mode === 'parametric' && p) {
      g.strokeStyle = cGridStrong;
      g.setLineDash([2, 3]);
      g.beginPath();
      for (const s of [p.split1, p.split2, p.split3]) {
        const x = Math.round(toX(s / 100)) + 0.5;
        g.moveTo(x, PAD);
        g.lineTo(x, PAD + ph());
      }
      g.stroke();
      g.setLineDash([]);
    }
    g.strokeStyle = cGridStrong;
    g.beginPath();
    g.moveTo(toX(0), toY(0));
    g.lineTo(toX(1), toY(1));
    g.stroke();

    // curve
    const evalFn =
      mode === 'parametric'
        ? createParametricEvaluator(p ?? { highlights: 0, lights: 0, darks: 0, shadows: 0, split1: 25, split2: 50, split3: 75 })
        : createCurveEvaluator(visiblePoints());
    g.strokeStyle = cCurve;
    g.lineWidth = 1.5;
    g.lineJoin = 'round';
    g.beginPath();
    const steps = Math.max(64, Math.round(pw()));
    for (let i = 0; i <= steps; i++) {
      const x = i / steps;
      const px = toX(x);
      const py = toY(evalFn(x));
      if (i === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    }
    g.stroke();

    // points
    if (mode === 'point') {
      const pts = visiblePoints();
      for (let i = 0; i < pts.length; i++) {
        const isSel = i === selectedVisible();
        g.beginPath();
        g.arc(toX(pts[i].x), toY(pts[i].y), isSel ? 4.5 : 3.5, 0, Math.PI * 2);
        g.fillStyle = isSel ? cAccent : cBg;
        g.fill();
        g.lineWidth = 1.5;
        g.strokeStyle = isSel ? cAccent : cCurve;
        g.stroke();
      }
    }
    if (disabled) {
      g.fillStyle = cBg;
      g.globalAlpha = 0.5;
      g.fillRect(0, 0, cssW, cssH);
      g.globalAlpha = 1;
    }
  }

  function drawHist(g: CanvasRenderingContext2D, color: string): void {
    if (!hist) return;
    const bins = mode === 'point' && channel !== 'rgb' ? hist[channel === 'red' ? 'r' : channel === 'green' ? 'g' : 'b'] : hist.lum;
    let max = 0;
    // Ignore the two end bins for scaling (clipping spikes would flatten the rest).
    for (let i = 1; i < 255; i++) if (bins[i] > max) max = bins[i];
    if (!max) return;
    g.fillStyle = color;
    g.globalAlpha = 0.28;
    g.beginPath();
    g.moveTo(toX(0), toY(0));
    for (let i = 0; i < 256; i++) {
      const v = Math.min(1, Math.sqrt(bins[i] / max));
      g.lineTo(toX(i / 255), toY(v * 0.85));
    }
    g.lineTo(toX(1), toY(0));
    g.closePath();
    g.fill();
    g.globalAlpha = 1;
  }

  /** Points drawn now: the dragged copy while dragging (minus a dragged-off point). */
  function visiblePoints(): CurvePoint[] {
    if (!dragPts) return channelPoints();
    if (dragRemoved && dragIndex !== null) return dragPts.filter((_, i) => i !== dragIndex);
    return dragPts;
  }
  function selectedVisible(): number | null {
    if (dragPts && dragRemoved) return null;
    return selected;
  }

  /* ------------------------------------------------------------ */
  /* Point editing                                                  */
  /* ------------------------------------------------------------ */
  let dragId: number | null = null;
  let dragIndex: number | null = null;
  let draggingRegion: ParamRegion | null = null;
  let rect: DOMRect | null = null;
  let lastX = 0;
  let lastY = 0;
  let startRegionValue = 0;
  let acc = { x: 0, y: 0 };
  let started = false;

  const labelFor = (ch: CurveChannel): string => (ch === 'rgb' ? 'Point Curve' : `${ch[0].toUpperCase()}${ch.slice(1)} Curve`);

  function hitPoint(lx: number, ly: number, touch: boolean): number | null {
    const pts = channelPoints();
    const r = touch ? HIT_TOUCH : HIT_MOUSE;
    let best: number | null = null;
    let bestD = r * r;
    for (let i = 0; i < pts.length; i++) {
      const dx = toX(pts[i].x) - lx;
      const dy = toY(pts[i].y) - ly;
      const dd = dx * dx + dy * dy;
      if (dd <= bestD) {
        bestD = dd;
        best = i;
      }
    }
    return best;
  }

  function constrain(pts: CurvePoint[], i: number, x: number, y: number): CurvePoint {
    const lo = i > 0 ? pts[i - 1].x + GAP : 0;
    const hi = i < pts.length - 1 ? pts[i + 1].x - GAP : 1;
    return { x: clamp(x, lo, Math.max(lo, hi)), y: clamp(y, 0, 1) };
  }

  function emit(pts: CurvePoint[], label: string): void {
    opts.onPoints(channel, clonePts(pts), label);
  }

  function beginGestureOnce(): void {
    if (!started) {
      started = true;
      opts.onGestureStart(mode === 'point' ? labelFor(channel) : 'Parametric Curve');
    }
  }

  d.add(
    on(plot, 'pointerdown', (e) => {
      if (disabled || !tc || dragId !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
      rect = plot.getBoundingClientRect();
      const lx = e.clientX - rect.left;
      const ly = e.clientY - rect.top;
      lastX = e.clientX;
      lastY = e.clientY;
      started = false;
      acc = { x: 0, y: 0 };
      if (mode === 'parametric') {
        const p = param();
        if (!p) return;
        draggingRegion = regionAt(clamp(fromX(lx), 0, 1));
        startRegionValue = p[draggingRegion];
        dragId = e.pointerId;
      } else {
        const touch = e.pointerType === 'touch';
        let idx = hitPoint(lx, ly, touch);
        const pts = clonePts(channelPoints());
        if (idx === null) {
          // Add a point: snap onto the curve when the click is close to it.
          const x = clamp(fromX(lx), 0, 1);
          const curveY = createCurveEvaluator(pts)(x);
          let y = clamp(fromY(ly), 0, 1);
          if (Math.abs(toY(curveY) - ly) < (touch ? 14 : 10)) y = curveY;
          const insertAt = pts.findIndex((q) => q.x > x);
          const at = insertAt < 0 ? pts.length : insertAt;
          if ((at > 0 && x - pts[at - 1].x < GAP) || (at < pts.length && pts[at].x - x < GAP)) return;
          pts.splice(at, 0, { x, y });
          idx = at;
          beginGestureOnce();
          emit(pts, `${labelFor(channel)}: Add Point`);
        }
        selected = idx;
        dragPts = pts;
        dragIndex = idx;
        dragRemoved = false;
        dragId = e.pointerId;
      }
      try {
        plot.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic events */
      }
      plot.focus({ preventScroll: true });
      e.preventDefault();
      schedule();
    }),
  );

  d.add(
    on(plot, 'pointermove', (e) => {
      if (dragId === null) {
        if (mode === 'parametric' && !disabled && e.pointerType !== 'touch') {
          const r = plot.getBoundingClientRect();
          const next = regionAt(clamp(fromX(e.clientX - r.left), 0, 1));
          if (next !== hoverRegion) {
            hoverRegion = next;
            schedule();
          }
        }
        return;
      }
      if (e.pointerId !== dragId || !rect) return;
      const fine = e.altKey ? 0.1 : 1;
      const dx = (e.clientX - lastX) * fine;
      const dy = (e.clientY - lastY) * fine;
      lastX = e.clientX;
      lastY = e.clientY;
      if (mode === 'parametric' && draggingRegion) {
        acc.y += dy;
        const v = Math.round(clamp(startRegionValue - (acc.y / ph()) * 200, -100, 100));
        const p = param();
        if (p && p[draggingRegion] !== v) {
          beginGestureOnce();
          opts.onRegion(draggingRegion, v);
        }
        return;
      }
      if (!dragPts || dragIndex === null) return;
      const i = dragIndex;
      const cur = dragPts[i];
      const nx = cur.x + dx / pw();
      const ny = cur.y - dy / ph();
      // Drag-off deletion for interior points (pointer far outside the plot).
      const lx = e.clientX - rect.left;
      const ly = e.clientY - rect.top;
      const outside = lx < -OFF_DELETE || ly < -OFF_DELETE || lx > rect.width + OFF_DELETE || ly > rect.height + OFF_DELETE;
      const interior = i > 0 && i < dragPts.length - 1;
      if (interior && outside !== dragRemoved) {
        dragRemoved = outside;
        beginGestureOnce();
        emit(dragRemoved ? dragPts.filter((_, k) => k !== i) : dragPts, `${labelFor(channel)}: ${dragRemoved ? 'Delete' : 'Move'} Point`);
        schedule();
      }
      if (dragRemoved) return;
      dragPts[i] = constrain(dragPts, i, nx, ny);
      if (dragPts[i].x !== cur.x || dragPts[i].y !== cur.y) {
        beginGestureOnce();
        emit(dragPts, labelFor(channel));
        updateStatus();
        schedule();
      }
    }),
  );

  const endDrag = (e: PointerEvent): void => {
    if (e.pointerId !== dragId) return;
    dragId = null;
    if (dragRemoved) selected = null;
    dragPts = null;
    dragIndex = null;
    dragRemoved = false;
    draggingRegion = null;
    if (started) {
      started = false;
      opts.onGestureEnd();
    }
    updateStatus();
    schedule();
  };
  d.add(on(plot, 'pointerup', endDrag));
  d.add(on(plot, 'pointercancel', endDrag));
  d.add(on(plot, 'lostpointercapture', endDrag));
  d.add(
    on(plot, 'pointerleave', () => {
      if (hoverRegion && dragId === null) {
        hoverRegion = null;
        schedule();
      }
    }),
  );

  d.add(
    on(plot, 'dblclick', (e) => {
      if (disabled || !tc || mode !== 'point') return;
      const r = plot.getBoundingClientRect();
      const idx = hitPoint(e.clientX - r.left, e.clientY - r.top, false);
      if (idx === null) return;
      deletePoint(idx);
    }),
  );

  function deletePoint(idx: number): void {
    const pts = clonePts(channelPoints());
    if (idx === 0) pts[0] = { x: 0, y: 0 };
    else if (idx === pts.length - 1) pts[idx] = { x: 1, y: 1 };
    else pts.splice(idx, 1);
    selected = null;
    opts.onGestureStart(`${labelFor(channel)}: Delete Point`);
    emit(pts, `${labelFor(channel)}: Delete Point`);
    opts.onGestureEnd();
    updateStatus();
    schedule();
  }

  /* ---- keyboard ---- */
  d.add(
    on(plot, 'keydown', (e) => {
      if (disabled || !tc || mode !== 'point') return;
      const pts = clonePts(channelPoints());
      let handled = true;
      const step = (e.shiftKey ? 10 : 1) / 255;
      switch (e.key) {
        case '[':
          selected = selected === null ? pts.length - 1 : Math.max(0, selected - 1);
          break;
        case ']':
          selected = selected === null ? 0 : Math.min(pts.length - 1, selected + 1);
          break;
        case 'ArrowUp':
        case 'ArrowDown':
        case 'ArrowLeft':
        case 'ArrowRight': {
          if (selected === null || selected >= pts.length) selected = pts.length > 2 ? 1 : 0;
          const i = selected;
          const q = pts[i];
          const nx = q.x + (e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0);
          const ny = q.y + (e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0);
          pts[i] = constrain(pts, i, nx, ny);
          // Key bursts coalesce by path in the store (one history step).
          emit(pts, `${labelFor(channel)}: Nudge`);
          break;
        }
        case 'Delete':
        case 'Backspace':
          if (selected !== null) deletePoint(selected);
          break;
        case 'Escape':
          selected = null;
          break;
        default:
          handled = false;
      }
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
        updateStatus();
        schedule();
      }
    }),
  );

  function updateStatus(): void {
    if (mode !== 'point' || selected === null) {
      status.textContent = '';
      return;
    }
    const pts = visiblePoints();
    const q = pts[selected];
    status.textContent = q ? `In ${Math.round(q.x * 255)}  ·  Out ${Math.round(q.y * 255)}` : '';
  }

  /* ------------------------------------------------------------ */
  /* Split handles                                                  */
  /* ------------------------------------------------------------ */
  function renderSplits(): void {
    const p = param();
    const keys: SplitKey[] = ['split1', 'split2', 'split3'];
    keys.forEach((k, i) => {
      const v = p ? p[k] : [25, 50, 75][i];
      const hEl = splitHandles[i];
      hEl.style.left = `calc(${PAD}px + (100% - ${PAD * 2}px) * ${v / 100})`;
      hEl.setAttribute('aria-valuenow', String(Math.round(v)));
    });
  }

  function splitBounds(k: SplitKey): [number, number] {
    const p = param();
    if (!p) return [0, 100];
    if (k === 'split1') return [5, p.split2 - 5];
    if (k === 'split2') return [p.split1 + 5, p.split3 - 5];
    return [p.split2 + 5, 95];
  }

  splitHandles.forEach((hEl) => {
    const key = hEl.dataset.key as SplitKey;
    let sid: number | null = null;
    let railLeft = 0;
    let railW = 1;
    let splitStarted = false;
    d.add(
      on(hEl, 'pointerdown', (e) => {
        if (disabled || !tc) return;
        const r = splits.getBoundingClientRect();
        railLeft = r.left + PAD;
        railW = Math.max(1, r.width - PAD * 2);
        sid = e.pointerId;
        splitStarted = false;
        try {
          hEl.setPointerCapture(e.pointerId);
        } catch {
          /* synthetic */
        }
        e.preventDefault();
        hEl.focus({ preventScroll: true });
      }),
    );
    d.add(
      on(hEl, 'pointermove', (e) => {
        if (e.pointerId !== sid) return;
        const [lo, hi] = splitBounds(key);
        const v = Math.round(clamp(((e.clientX - railLeft) / railW) * 100, lo, hi));
        if (param()?.[key] === v) return;
        if (!splitStarted) {
          splitStarted = true;
          opts.onGestureStart('Curve Split');
        }
        opts.onSplit(key, v);
      }),
    );
    const end = (e: PointerEvent): void => {
      if (e.pointerId !== sid) return;
      sid = null;
      if (splitStarted) {
        splitStarted = false;
        opts.onGestureEnd();
      }
    };
    d.add(on(hEl, 'pointerup', end));
    d.add(on(hEl, 'pointercancel', end));
    d.add(on(hEl, 'lostpointercapture', end));
    d.add(
      on(hEl, 'keydown', (e) => {
        if (disabled || !tc) return;
        const delta = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
        if (!delta) return;
        e.preventDefault();
        e.stopPropagation();
        const [lo, hi] = splitBounds(key);
        const cur = param()?.[key] ?? 50;
        const v = clamp(cur + delta * (e.shiftKey ? 5 : 1), lo, hi);
        if (v !== cur) opts.onSplit(key, v);
      }),
    );
    d.add(
      on(hEl, 'dblclick', () => {
        if (disabled || !tc) return;
        const def = { split1: 25, split2: 50, split3: 75 }[key];
        const [lo, hi] = splitBounds(key);
        opts.onGestureStart('Curve Split');
        opts.onSplit(key, clamp(def, lo, hi));
        opts.onGestureEnd();
      }),
    );
  });

  /* ------------------------------------------------------------ */
  /* Sizing                                                         */
  /* ------------------------------------------------------------ */
  const ro = new ResizeObserver((entries) => {
    const r = entries[entries.length - 1].contentRect;
    cssW = r.width;
    cssH = r.height;
    fitCanvas(canvas, cssW, cssH);
    draw();
  });
  ro.observe(plot);
  d.add(() => ro.disconnect());
  d.add(onThemeChange(schedule));

  return {
    el,
    setMode(m) {
      if (m === mode) return;
      mode = m;
      el.dataset.mode = m;
      hoverRegion = null;
      updateStatus();
      schedule();
    },
    setChannel(ch) {
      if (ch === channel) return;
      channel = ch;
      selected = null;
      updateStatus();
      schedule();
    },
    setData(next) {
      tc = next;
      if (selected !== null && tc && selected >= tc[channel].length) selected = null;
      renderSplits();
      updateStatus();
      schedule();
    },
    setHistogram(hh) {
      hist = hh;
      schedule();
    },
    setDisabled(b) {
      disabled = b;
      el.classList.toggle('is-disabled', b);
      plot.tabIndex = b ? -1 : 0;
      schedule();
    },
    selected: () => selected,
    destroy() {
      d.dispose();
      el.remove();
    },
  };
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
