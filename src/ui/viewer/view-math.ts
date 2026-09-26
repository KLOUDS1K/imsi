/**
 * Pure zoom / pan math for the Develop viewport (no DOM, unit-tested).
 *
 * Model (matches contracts.DisplayTransform): a point at output pixel (ox, oy)
 * is drawn at canvas CSS px (offsetX + ox·scale, offsetY + oy·scale).
 * `ViewState.center` is the normalized output point shown at the viewport
 * centre. When the scaled image is smaller than the viewport along an axis the
 * image is centred on that axis instead (the centre is ignored/clamped).
 *
 * `ViewState.zoom` is engine-defined; we only assume it is linear in the display
 * scale. `scalePerZoom` (the display scale of zoom = 1, i.e. "100 %") is
 * measured from the engine once per call (see zoom.ts), so the viewer stays
 * correct whatever unit the engine picked (CSS or device pixels).
 */
import type { DisplayTransform, ViewState } from '@/editor/contracts';
import type { Point } from '@/editor/types';

export interface ViewportInfo {
  /** Viewport size, CSS px. */
  vw: number;
  vh: number;
  /** Output (or crop-tool frame) size in output pixels. */
  outW: number;
  outH: number;
  /** Display scale of zoom = 'fit'. */
  fitScale: number;
  /** Display scale of zoom = 1 (100 %). */
  scalePerZoom: number;
}

export type ZoomPreset = 'fit' | 'fill' | number;

/** Menu presets (percent). */
export const ZOOM_PRESETS: readonly ZoomPreset[] = ['fit', 'fill', 25, 50, 100, 200, 400, 800];
/** Keyboard / button steps (zoom values, 1 = 100 %). */
export const ZOOM_STEPS: readonly number[] = [1 / 16, 1 / 8, 1 / 6, 1 / 4, 1 / 3, 1 / 2, 2 / 3, 1, 1.5, 2, 3, 4, 6, 8, 11, 16];
export const MAX_ZOOM = 16;

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Display scale for a zoom value. */
export function scaleOf(zoom: ViewState['zoom'], info: ViewportInfo): number {
  return zoom === 'fit' ? info.fitScale : zoom * info.scalePerZoom;
}

/** Zoom value (1 = 100 %) for a display scale. */
export function zoomOfScale(scale: number, info: ViewportInfo): number {
  return scale / Math.max(1e-9, info.scalePerZoom);
}

/** Smallest zoom we allow: a quarter of fit or 1/16, whichever is smaller. */
export function minZoom(info: ViewportInfo): number {
  return Math.min(ZOOM_STEPS[0], zoomOfScale(info.fitScale, info) * 0.25);
}

/** Display scale at which the image covers the whole viewport. */
export function fillScale(info: ViewportInfo): number {
  return Math.max(info.vw / Math.max(1, info.outW), info.vh / Math.max(1, info.outH));
}

/**
 * Clamp a view centre so the image never scrolls past a viewport edge when it
 * is larger than the viewport; axes where the image fits are centred (0.5).
 */
export function clampCenter(center: Point, scale: number, info: ViewportInfo): Point {
  const axis = (c: number, out: number, view: number): number => {
    const content = out * scale;
    if (content <= view + 0.5) return 0.5;
    const half = view / (2 * content);
    return clamp(Number.isFinite(c) ? c : 0.5, half, 1 - half);
  };
  return { x: axis(center.x, info.outW, info.vw), y: axis(center.y, info.outH, info.vh) };
}

/** The DisplayTransform we expect for (scale, centre) — used by the stub engine and tests. */
export function transformFor(scale: number, center: Point, info: ViewportInfo): DisplayTransform {
  const c = clampCenter(center, scale, info);
  return {
    scale,
    offsetX: info.vw / 2 - c.x * info.outW * scale,
    offsetY: info.vh / 2 - c.y * info.outH * scale,
    outWidth: info.outW,
    outHeight: info.outH,
    viewportWidth: info.vw,
    viewportHeight: info.vh,
  };
}

/** Canvas CSS px → normalized output coords. */
export function canvasToOutput(t: DisplayTransform, x: number, y: number): Point {
  return {
    x: (x - t.offsetX) / (t.scale * Math.max(1, t.outWidth)),
    y: (y - t.offsetY) / (t.scale * Math.max(1, t.outHeight)),
  };
}

/** Normalized output coords → canvas CSS px. */
export function outputToCanvas(t: DisplayTransform, u: number, v: number): Point {
  return { x: t.offsetX + u * t.outWidth * t.scale, y: t.offsetY + v * t.outHeight * t.scale };
}

/**
 * New centre so that the output point currently under `anchor` (canvas px)
 * stays under it at `newScale` (cursor-anchored zoom). Result is clamped.
 */
export function anchoredCenter(t: DisplayTransform, anchor: Point, newScale: number, info: ViewportInfo): Point {
  const p = canvasToOutput(t, anchor.x, anchor.y);
  const c = {
    x: p.x - (anchor.x - info.vw / 2) / (info.outW * newScale),
    y: p.y - (anchor.y - info.vh / 2) / (info.outH * newScale),
  };
  return clampCenter(c, newScale, info);
}

/**
 * Centre for a combined pinch: the image point under `from` stays under the
 * moving midpoint `to` at `newScale`. Calculating both changes together avoids
 * the two-frame jump caused by applying zoom and pan separately.
 */
export function gestureCenter(t: DisplayTransform, from: Point, to: Point, newScale: number, info: ViewportInfo): Point {
  const p = canvasToOutput(t, from.x, from.y);
  return clampCenter(
    {
      x: p.x - (to.x - info.vw / 2) / (info.outW * newScale),
      y: p.y - (to.y - info.vh / 2) / (info.outH * newScale),
    },
    newScale,
    info,
  );
}

/** Centre after dragging the image by (dx, dy) canvas px. */
export function pannedCenter(center: Point, dx: number, dy: number, scale: number, info: ViewportInfo): Point {
  return clampCenter({ x: center.x - dx / (info.outW * scale), y: center.y - dy / (info.outH * scale) }, scale, info);
}

/** Next zoom step above/below the current zoom value. */
export function stepZoomValue(current: number, dir: 1 | -1, info: ViewportInfo): number {
  const fitZ = zoomOfScale(info.fitScale, info);
  // Fit is a stop too, so +/- from a large zoom passes through "fit".
  const stops = [...ZOOM_STEPS, fitZ].sort((a, b) => a - b);
  const eps = 1e-3;
  if (dir > 0) {
    const next = stops.find((s) => s > current * (1 + eps));
    return next ?? MAX_ZOOM;
  }
  for (let i = stops.length - 1; i >= 0; i--) if (stops[i] < current * (1 - eps)) return Math.max(stops[i], minZoom(info));
  return minZoom(info);
}

/** Human zoom label: "Fit", "Fill" or "100%". */
export function zoomLabel(zoom: ViewState['zoom'], info: ViewportInfo | null): string {
  if (zoom === 'fit') return info ? `Fit ${Math.round(zoomOfScale(info.fitScale, info) * 100)}%` : 'Fit';
  const pct = zoom * 100;
  return `${pct >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10}%`;
}

/** Visible part of the output, normalized (for the navigator rectangle). */
export function visibleRect(t: DisplayTransform): { x: number; y: number; w: number; h: number } {
  const a = canvasToOutput(t, 0, 0);
  const b = canvasToOutput(t, t.viewportWidth, t.viewportHeight);
  const x0 = clamp(a.x, 0, 1);
  const y0 = clamp(a.y, 0, 1);
  const x1 = clamp(b.x, 0, 1);
  const y1 = clamp(b.y, 0, 1);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}
