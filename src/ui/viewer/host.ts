/**
 * Shared plumbing between the viewer shell and its on-image tools: the
 * coordinate mapping (canvas CSS px ↔ output ↔ source) and the tool interface.
 *
 * Coordinate chain: stage-local CSS px ──DisplayTransform──▶ normalized output
 * (or FRAME when the crop tool is active: the shell renders with ignoreCrop)
 * ──geometry.outputToSource──▶ source-normalized. Masks, heal spots and
 * removal strokes are stored in source-normalized space.
 */
import type { AppContext } from '@/app/context';
import type { DisplayTransform } from '@/editor/contracts';
import { outputToSource, sourceToOutput } from '@/editor/engine/geometry';
import type { EditParams, Point } from '@/editor/types';
import { canvasToOutput, outputToCanvas } from './view-math';

export interface Mapping {
  readonly t: DisplayTransform;
  readonly params: EditParams;
  /** Proxy source size (pixels). */
  readonly srcW: number;
  readonly srcH: number;
  readonly ignoreCrop: boolean;
  toOutput(x: number, y: number): Point;
  fromOutput(u: number, v: number): Point;
  /** Canvas px → source-normalized (NaN when the point maps nowhere). */
  toSource(x: number, y: number): Point;
  /** Source-normalized → canvas px. */
  fromSource(sx: number, sy: number): Point;
  /** Canvas px length of a radius given as a fraction of the source long edge, at a source point. */
  radiusPx(sx: number, sy: number, r: number): number;
  /** Source-normalized radius (fraction of the long edge) for a canvas px length at a canvas point. */
  radiusFromPx(x: number, y: number, px: number): number;
}

/** The params the canvas currently shows (live preview overrides the store). */
export function shownParams(ctx: AppContext): EditParams | null {
  const doc = ctx.doc.value;
  if (!doc) return null;
  return ctx.previewParams.value ?? doc.store.params;
}

export function createMapping(t: DisplayTransform, params: EditParams, srcW: number, srcH: number, ignoreCrop: boolean): Mapping {
  const long = Math.max(srcW, srcH);
  const m: Mapping = {
    t,
    params,
    srcW,
    srcH,
    ignoreCrop,
    toOutput: (x, y) => canvasToOutput(t, x, y),
    fromOutput: (u, v) => outputToCanvas(t, u, v),
    toSource(x, y) {
      const o = canvasToOutput(t, x, y);
      return outputToSource(o.x, o.y, params, srcW, srcH, ignoreCrop);
    },
    fromSource(sx, sy) {
      const o = sourceToOutput(sx, sy, params, srcW, srcH, ignoreCrop);
      return outputToCanvas(t, o.x, o.y);
    },
    radiusPx(sx, sy, r) {
      // Local scale from two orthogonal source offsets (handles rotation/keystone).
      const d = (r * long) / Math.max(1, srcW);
      const e = (r * long) / Math.max(1, srcH);
      const c = m.fromSource(sx, sy);
      const a = m.fromSource(sx + d, sy);
      const b = m.fromSource(sx, sy + e);
      const ra = Math.hypot(a.x - c.x, a.y - c.y);
      const rb = Math.hypot(b.x - c.x, b.y - c.y);
      const v = (ra + rb) / 2;
      return Number.isFinite(v) ? v : r * long * t.scale;
    },
    radiusFromPx(x, y, px) {
      const s = m.toSource(x, y);
      const unit = m.radiusPx(s.x, s.y, 0.01);
      return unit > 1e-9 ? (px / unit) * 0.01 : 0.01;
    },
  };
  return m;
}

export type ToolCommand =
  | 'escape'
  | 'enter'
  | 'delete'
  | 'swap-aspect'
  | 'size-up'
  | 'size-down'
  | 'feather-up'
  | 'feather-down'
  | 'overlay-cycle'
  | 'overlay-orientation';

/** What the viewer offers a tool. */
export interface ViewerHost {
  readonly ctx: AppContext;
  /** Positioned element that receives pointer events (the tools' coordinate space). */
  readonly stage: HTMLElement;
  /** Current mapping, or null without a doc / engine / valid transform. */
  mapping(): Mapping | null;
  /** Schedule an overlay redraw (rAF-coalesced). */
  requestDraw(): void;
  /** Stage-local CSS px of a pointer/mouse event. */
  local(e: { clientX: number; clientY: number }): Point;
  /** Whether the Alt key is currently held (erase modifier). */
  altDown(): boolean;
}

/**
 * An on-image tool. Pointer handlers receive stage-local CSS px. The viewer
 * captures the pointer after onPointerDown returns true and forwards moves/up
 * to the same tool until release.
 */
export interface ViewerTool {
  readonly name: string;
  onPointerDown?(e: PointerEvent, p: Point): boolean;
  onPointerMove?(e: PointerEvent, p: Point): void;
  onPointerUp?(e: PointerEvent, p: Point): void;
  /** A second finger landed or the pointer was cancelled: abandon the drag (revert transient state). */
  onCancel?(): void;
  /** Hover (no button pressed); p = null when the pointer left the stage. */
  onHover?(p: Point | null, e: PointerEvent | null): void;
  /** Return true when the tool consumed a double-click (otherwise it toggles zoom). */
  onDoubleClick?(p: Point): boolean;
  /** CSS cursor for a hover position. */
  cursor?(p: Point, e: PointerEvent | null): string;
  command?(cmd: ToolCommand): boolean;
  /** Redraw into the (already cleared) overlay group. */
  draw(g: SVGGElement, m: Mapping): void;
  dispose(): void;
}

/** Distance helper. */
export const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Distance from p to segment ab. */
export function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Touch targets are bigger than mouse targets. */
export function hitRadius(e: PointerEvent | null): number {
  return e && e.pointerType === 'touch' ? 22 : e && e.pointerType === 'pen' ? 14 : 10;
}

export const isFinitePoint = (p: Point): boolean => Number.isFinite(p.x) && Number.isFinite(p.y);
