/**
 * Output size for every ResizeMode.
 *
 *   none         source size
 *   long-edge    long edge  = resize.value
 *   short-edge   short edge = resize.value
 *   width        width  = resize.width  (falls back to resize.value when width ≤ 0)
 *   height       height = resize.height (falls back to resize.value when height ≤ 0)
 *   dimensions   fit inside resize.width × resize.height, aspect preserved
 *   megapixels   width·height ≤ resize.value · 10⁶, aspect preserved
 *
 * `dontEnlarge` caps the scale at 1. Results are integers ≥ 1.
 */
import type { ExportSettings } from '@/editor/types';

type Resize = ExportSettings['resize'];

const pos = (v: number) => Number.isFinite(v) && v > 0;

export function exportScale(srcW: number, srcH: number, r: Resize): number {
  const long = Math.max(srcW, srcH);
  const short = Math.min(srcW, srcH);
  let s = 1;
  switch (r.mode) {
    case 'long-edge':
      if (pos(r.value)) s = r.value / long;
      break;
    case 'short-edge':
      if (pos(r.value)) s = r.value / short;
      break;
    case 'width': {
      const v = pos(r.width) ? r.width : r.value;
      if (pos(v)) s = v / srcW;
      break;
    }
    case 'height': {
      const v = pos(r.height) ? r.height : r.value;
      if (pos(v)) s = v / srcH;
      break;
    }
    case 'dimensions': {
      const sw = pos(r.width) ? r.width / srcW : Infinity;
      const sh = pos(r.height) ? r.height / srcH : Infinity;
      const m = Math.min(sw, sh);
      if (Number.isFinite(m)) s = m;
      break;
    }
    case 'megapixels':
      if (pos(r.value)) s = Math.sqrt((r.value * 1e6) / (srcW * srcH));
      break;
    default:
      s = 1;
  }
  if (r.dontEnlarge && s > 1) s = 1;
  return s;
}

export function computeExportSize(srcW: number, srcH: number, resize: Resize): { width: number; height: number } {
  const w0 = Math.max(1, Math.round(srcW) || 1);
  const h0 = Math.max(1, Math.round(srcH) || 1);
  if (resize.mode === 'none') return { width: w0, height: h0 };
  const s = exportScale(w0, h0, resize);
  if (s === 1) return { width: w0, height: h0 };
  let width = Math.max(1, Math.round(w0 * s));
  let height = Math.max(1, Math.round(h0 * s));
  // Pin the constrained dimension exactly (avoids 2047 from floating-point drift).
  const exact = (v: number) => Math.max(1, Math.round(v));
  switch (resize.mode) {
    case 'long-edge':
      if (w0 >= h0) width = exact(w0 * s);
      else height = exact(h0 * s);
      break;
    case 'megapixels': {
      // Rounding may overshoot the pixel budget by a row/column: floor instead.
      const budget = resize.value * 1e6;
      if (width * height > budget) {
        width = Math.max(1, Math.floor(w0 * s));
        height = Math.max(1, Math.floor(h0 * s));
      }
      break;
    }
    default:
      break;
  }
  return { width, height };
}
