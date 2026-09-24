/**
 * CPU mirror of the geometry pipeline (GeometryModule, see contracts.ts):
 * source → lens distortion → orientation/flips → straighten + transform →
 * crop. The math lives in `fx/geometry-core.ts` and is shared verbatim with
 * the GPU geometry pass (`buildGeometryUniforms`), so pointer mapping in the
 * viewer lands on exactly the pixel the shader samples.
 *
 * Lens correction: the GeometryModule signatures carry no PhotoMeta, so the
 * lens correction is resolved from `params.lens` and the meta registered with
 * `setGeometryMeta()` (engine/shell call it when a photo is opened). Every
 * mapping function also accepts an explicit trailing `lens` argument that
 * overrides this (tests, workers, batch processing).
 */
import type { GeometryModule, LensCorrection } from '../contracts';
import type { EditParams, PhotoMeta, Point, Rect } from '../types';
import { resolveLensCorrection } from '@/editor/lens';
import {
  aspectRatioOf,
  createGeometryPlan,
  frameSizeOf,
  lensTermsFrom,
  mapOutToSource,
  mapSourceToOut,
  outputSizeOf,
  sanitizeCrop,
  type GeometryPlan,
} from './fx/geometry-core';
import { rectValidInPlan, searchMaxValidCrop } from './fx/crop-search';

export {
  buildGeometryUniforms,
  isGeometryIdentity,
  createGeometryPlan,
  mapOutToSource,
  mapSourceToOut,
  lensTermsFrom,
  undistortRadius,
  type GeometryPlan,
  type GeometryUniforms,
  type GeometryUniformContext,
  type LensTerms,
} from './fx/geometry-core';

/* ------------------------------------------------------------------ */
/* Lens context                                                        */
/* ------------------------------------------------------------------ */

let currentMeta: PhotoMeta | null = null;
let lensCache: { key: string; meta: PhotoMeta | null; value: LensCorrection } | null = null;

const EMPTY_META: PhotoMeta = {
  fileName: '',
  fileSize: 0,
  mimeType: '',
  format: 'unknown',
  width: 0,
  height: 0,
  orientation: 1,
  bitDepth: 8,
};

/** Register the metadata of the photo being edited (lens auto-detection for the CPU mapping). */
export function setGeometryMeta(meta: PhotoMeta | null): void {
  currentMeta = meta;
  lensCache = null;
}

export function getGeometryMeta(): PhotoMeta | null {
  return currentMeta;
}

/** Lens correction (profile + manual sliders) for `params` and `meta`. Delegates to the lens module. */
export function lensCorrectionFor(params: EditParams, meta: PhotoMeta | null | undefined): LensCorrection {
  return resolveLensCorrection(params.lens, meta ?? EMPTY_META);
}

function lensKey(l: EditParams['lens']): string {
  return [
    l.profileEnabled,
    l.profileId,
    l.profileDistortionScale,
    l.profileVignettingScale,
    l.distortion,
    l.vignetting,
    l.vignettingMidpoint,
    l.removeCA,
  ].join('|');
}

/** Memoized for the registered meta: maxValidCrop maps thousands of points per call. */
function defaultLens(params: EditParams): LensCorrection {
  const key = lensKey(params.lens);
  if (lensCache && lensCache.key === key && lensCache.meta === currentMeta) return lensCache.value;
  const value = lensCorrectionFor(params, currentMeta);
  lensCache = { key, meta: currentMeta, value };
  return value;
}

function plan(params: EditParams, srcW: number, srcH: number, ignoreCrop: boolean, lens?: LensCorrection): GeometryPlan {
  return createGeometryPlan(params, srcW, srcH, ignoreCrop, lensTermsFrom(params, lens ?? defaultLens(params)));
}

/* ------------------------------------------------------------------ */
/* GeometryModule                                                      */
/* ------------------------------------------------------------------ */

/** Pixel size of the uncropped frame (= oriented source size; straighten/transform keep the canvas). */
export function frameSize(params: EditParams, srcW: number, srcH: number): { width: number; height: number } {
  return frameSizeOf(params, srcW, srcH);
}

/** Pixel size of the cropped output. */
export function outputSize(params: EditParams, srcW: number, srcH: number): { width: number; height: number } {
  return outputSizeOf(params, srcW, srcH);
}

/**
 * Normalized output (or frame, when ignoreCrop) coords → source-normalized
 * coords. Points outside the image map outside [0,1]; a point on the far side
 * of a keystone horizon (or beyond the lens model's fold) yields NaN.
 */
export function outputToSource(
  u: number,
  v: number,
  params: EditParams,
  srcW: number,
  srcH: number,
  ignoreCrop = false,
  lens?: LensCorrection,
): Point {
  const out: Point = { x: 0, y: 0 };
  mapOutToSource(plan(params, srcW, srcH, ignoreCrop, lens), u, v, out);
  return out;
}

/**
 * Source-normalized coords → normalized output (or frame) coords. Exact
 * inverse of `outputToSource`: the projective part is inverted in closed form
 * and the radial lens model by Newton iteration (bisection fallback).
 */
export function sourceToOutput(
  x: number,
  y: number,
  params: EditParams,
  srcW: number,
  srcH: number,
  ignoreCrop = false,
  lens?: LensCorrection,
): Point {
  const out: Point = { x: 0, y: 0 };
  mapSourceToOut(plan(params, srcW, srcH, ignoreCrop, lens), x, y, out);
  return out;
}

/**
 * Largest crop rect (frame-normalized) with pixel aspect `aspect` (w/h) that
 * stays inside valid image data; `aspect === null` = largest area. Ties are
 * broken towards the frame centre / the current crop centre.
 */
export function maxValidCrop(params: EditParams, srcW: number, srcH: number, aspect: number | null, lens?: LensCorrection): Rect {
  const c = sanitizeCrop(params.crop);
  const hint = { x: c.x + c.w / 2, y: c.y + c.h / 2 };
  return searchMaxValidCrop(plan(params, srcW, srcH, true, lens), aspect, [hint]);
}

/** Whether a frame-normalized rect lies fully on valid image data (and inside the frame). */
export function isCropValid(params: EditParams, srcW: number, srcH: number, rect: Rect, lens?: LensCorrection): boolean {
  return rectValidInPlan(plan(params, srcW, srcH, true, lens), rect);
}

/** Numeric aspect (w/h) for params.crop.aspect ('original' = frame aspect), or null for 'free'. */
export function aspectRatioValue(params: EditParams, srcW: number, srcH: number): number | null {
  return aspectRatioOf(params, srcW, srcH);
}

export const geometryModule = {
  frameSize,
  outputSize,
  outputToSource,
  sourceToOutput,
  maxValidCrop,
  isCropValid,
  aspectRatioValue,
} satisfies GeometryModule;
