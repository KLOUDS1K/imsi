/**
 * View (zoom / pan / compare) mutations shared by the viewer, the navigator and
 * the keyboard commands. Everything goes through ctx.view + ctx.requestRender();
 * the engine's DisplayTransform is the single source of truth for mapping.
 */
import type { AppContext } from '@/app/context';
import type { CompareMode, DisplayTransform, ViewState } from '@/editor/contracts';
import type { Point } from '@/editor/types';
import {
  MAX_ZOOM,
  anchoredCenter,
  clamp,
  clampCenter,
  fillScale,
  gestureCenter,
  minZoom,
  pannedCenter,
  scaleOf,
  stepZoomValue,
  zoomOfScale,
  type ViewportInfo,
  type ZoomPreset,
} from './view-math';

export function currentTransform(ctx: AppContext, view: ViewState = ctx.view.value): DisplayTransform | null {
  const e = ctx.engine;
  if (!e || !ctx.doc.value) return null;
  try {
    const t = e.getDisplayTransform(view);
    if (!(t.scale > 0) || !(t.outWidth > 0) || !(t.outHeight > 0) || !(t.viewportWidth > 0)) return null;
    return t;
  } catch {
    return null;
  }
}

/** Measure fit and 100 % scales from the engine for the current output. */
export function viewportInfo(ctx: AppContext): ViewportInfo | null {
  const v = ctx.view.value;
  const fit = currentTransform(ctx, { ...v, zoom: 'fit' });
  const one = currentTransform(ctx, { ...v, zoom: 1 });
  if (!fit || !one) return null;
  return {
    vw: fit.viewportWidth,
    vh: fit.viewportHeight,
    outW: fit.outWidth,
    outH: fit.outHeight,
    fitScale: fit.scale,
    scalePerZoom: one.scale,
  };
}

function commit(ctx: AppContext, patch: Partial<ViewState>): void {
  ctx.view.set({ ...ctx.view.value, ...patch });
  ctx.requestRender();
}

/** Zoom value (number) a preset resolves to, or 'fit'. */
export function resolvePreset(preset: ZoomPreset, info: ViewportInfo): ViewState['zoom'] {
  if (preset === 'fit') return 'fit';
  if (preset === 'fill') return zoomOfScale(fillScale(info), info);
  return preset / 100;
}

/**
 * Set the zoom. With an `anchor` (stage CSS px) the image point under it stays
 * put; without one the current centre is kept ('fit'/'fill' re-centre).
 */
export function setZoom(ctx: AppContext, preset: ZoomPreset, anchor?: Point): void {
  const info = viewportInfo(ctx);
  if (!info) {
    if (preset === 'fit') commit(ctx, { zoom: 'fit', center: { x: 0.5, y: 0.5 } });
    return;
  }
  const zoom = resolvePreset(preset, info);
  if (zoom === 'fit') {
    commit(ctx, { zoom: 'fit', center: { x: 0.5, y: 0.5 } });
    return;
  }
  const z = clamp(zoom, minZoom(info), MAX_ZOOM);
  const scale = scaleOf(z, info);
  const t = currentTransform(ctx);
  let center: Point;
  if (preset === 'fill') center = { x: 0.5, y: 0.5 };
  else if (anchor && t) center = anchoredCenter(t, anchor, scale, info);
  else center = clampCenter(ctx.view.value.center, scale, info);
  commit(ctx, { zoom: z, center });
}

/** Current zoom as a number (fit resolved). */
export function numericZoom(ctx: AppContext, info: ViewportInfo | null = viewportInfo(ctx)): number {
  const z = ctx.view.value.zoom;
  if (z !== 'fit') return z;
  return info ? zoomOfScale(info.fitScale, info) : 1;
}

/** Multiply the zoom (wheel / pinch), anchored at a stage point. */
export function zoomBy(ctx: AppContext, factor: number, anchor?: Point): void {
  const info = viewportInfo(ctx);
  if (!info || !(factor > 0)) return;
  const fitZ = zoomOfScale(info.fitScale, info);
  let z = clamp(numericZoom(ctx, info) * factor, minZoom(info), MAX_ZOOM);
  // Snap to "fit" when passing close to it so the image re-centres cleanly.
  if (Math.abs(z / fitZ - 1) < 0.015) {
    commit(ctx, { zoom: 'fit', center: { x: 0.5, y: 0.5 } });
    return;
  }
  if (!Number.isFinite(z)) z = 1;
  setZoom(ctx, z * 100, anchor);
}

/** Apply a moving-midpoint pinch as one state change and one render. */
export function zoomGesture(ctx: AppContext, factor: number, from: Point, to: Point): void {
  const info = viewportInfo(ctx);
  const t = currentTransform(ctx);
  if (!info || !t || !(factor > 0)) return;
  let z = clamp(numericZoom(ctx, info) * factor, minZoom(info), MAX_ZOOM);
  if (!Number.isFinite(z)) z = 1;
  const fitZ = zoomOfScale(info.fitScale, info);
  if (Math.abs(z / fitZ - 1) < 0.015) {
    commit(ctx, { zoom: 'fit', center: { x: 0.5, y: 0.5 } });
    return;
  }
  const scale = scaleOf(z, info);
  commit(ctx, { zoom: z, center: gestureCenter(t, from, to, scale, info) });
}

export function stepZoom(ctx: AppContext, dir: 1 | -1, anchor?: Point): void {
  const info = viewportInfo(ctx);
  if (!info) return;
  const next = stepZoomValue(numericZoom(ctx, info), dir, info);
  const fitZ = zoomOfScale(info.fitScale, info);
  if (Math.abs(next / fitZ - 1) < 1e-3) setZoom(ctx, 'fit');
  else setZoom(ctx, next * 100, anchor);
}

/** Whether the image is shown larger than "fit" (plain wheel then pans). */
export function isZoomedIn(ctx: AppContext, info: ViewportInfo | null = viewportInfo(ctx)): boolean {
  const z = ctx.view.value.zoom;
  if (z === 'fit' || !info) return false;
  const t = currentTransform(ctx);
  if (!t) return false;
  return t.outWidth * t.scale > t.viewportWidth + 1 || t.outHeight * t.scale > t.viewportHeight + 1;
}

/** Z / double-click: fit ↔ 100 % (anchored at the pointer when given). */
export function toggleFit100(ctx: AppContext, anchor?: Point): void {
  const z = ctx.view.value.zoom;
  if (z === 'fit') setZoom(ctx, 100, anchor);
  else setZoom(ctx, 'fit');
}

/** Pan by a stage-pixel delta (image follows the pointer). */
export function panBy(ctx: AppContext, dx: number, dy: number): void {
  const info = viewportInfo(ctx);
  const t = currentTransform(ctx);
  if (!info || !t || ctx.view.value.zoom === 'fit') return;
  const center = pannedCenter(ctx.view.value.center, dx, dy, t.scale, info);
  const c = ctx.view.value.center;
  if (Math.abs(center.x - c.x) < 1e-7 && Math.abs(center.y - c.y) < 1e-7) return;
  commit(ctx, { center });
}

/** Centre the view on a normalized output point (navigator). Keeps the zoom. */
export function centerOn(ctx: AppContext, u: number, v: number): void {
  const info = viewportInfo(ctx);
  const t = currentTransform(ctx);
  if (!info || !t) return;
  if (ctx.view.value.zoom === 'fit') return;
  commit(ctx, { center: clampCenter({ x: u, y: v }, t.scale, info) });
}

/* ------------------------------ compare ------------------------------ */

export const COMPARE_LAYOUTS: readonly CompareMode[] = ['side-by-side', 'split-vertical', 'split-horizontal'];

let lastNonBefore = new WeakMap<AppContext, CompareMode>();

export function setCompare(ctx: AppContext, mode: CompareMode): void {
  if (ctx.view.value.compare === mode) return;
  commit(ctx, { compare: mode });
}

/** "\" — toggle Before/After; returns to the previous layout afterwards. */
export function toggleBefore(ctx: AppContext): void {
  const cur = ctx.view.value.compare;
  if (cur === 'before') setCompare(ctx, lastNonBefore.get(ctx) ?? 'off');
  else {
    lastNonBefore.set(ctx, cur === 'reference' ? 'off' : cur);
    setCompare(ctx, 'before');
  }
}

/** "Y" — off → side-by-side → split vertical → split horizontal → off. */
export function cycleCompareLayout(ctx: AppContext): void {
  const cur = ctx.view.value.compare;
  const i = COMPARE_LAYOUTS.indexOf(cur);
  setCompare(ctx, i < 0 ? COMPARE_LAYOUTS[0] : i === COMPARE_LAYOUTS.length - 1 ? 'off' : COMPARE_LAYOUTS[i + 1]);
}

export function toggleClipping(ctx: AppContext): void {
  const c = ctx.view.value.clipping;
  const on = !(c.highlights || c.shadows);
  commit(ctx, { clipping: { highlights: on, shadows: on } });
}

export function setSplitPosition(ctx: AppContext, pos: number): void {
  commit(ctx, { splitPosition: clamp(pos, 0.02, 0.98) });
}

/** For tests: forget the remembered compare layout. */
export function _resetCompareMemory(): void {
  lastNonBefore = new WeakMap();
}
