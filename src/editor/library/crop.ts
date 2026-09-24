/**
 * Crop mapping between photos of different dimensions (sync / paste / presets).
 *
 * The crop rect is frame-normalized, so copying it verbatim keeps its
 * RELATIVE position and size. That is exactly right for 'free' crops, but a
 * locked aspect ('1:1', '4:5', 'original', custom) would come out distorted on
 * a frame of another shape. For locked aspects the rect is re-fitted:
 *
 *   scale s = how large the crop is relative to the LARGEST crop of that
 *   aspect that fits the source frame. Because the source rect satisfies
 *   w·Ws / (h·Hs) = r, the source frame aspect is r·h/w and s simplifies to
 *   max(w, h) — no source dimensions needed.
 *
 *   On the target frame (aspect At) the largest crop of aspect r is
 *   (1, At/r) when r ≥ At, else (r/At, 1); the new rect is s times that,
 *   centred where the source crop was centred, shifted to stay inside.
 *
 * A rect that already has the locked aspect on the target frame (photos of
 * the same shape) and 'original' crops (frame-relative by definition) are
 * copied verbatim, so the mapping is idempotent for equal frames. When `crop.constrainToImage` is
 * on and the target is straightened/transformed, the rect is additionally
 * shrunk about its centre until it lies on valid image data, using the
 * engine's CPU geometry mirror when it is available.
 */
import type { CropParams, EditParams, PhotoMeta, Rect } from '@/editor/types';

/** Frame (oriented, uncropped) size in px for a source of w×h: 90°/270° swap the axes. */
export function frameDims(meta: Pick<PhotoMeta, 'width' | 'height'>, orientation: CropParams['orientation']): { width: number; height: number } {
  const swap = orientation === 90 || orientation === 270;
  return swap ? { width: meta.height, height: meta.width } : { width: meta.width, height: meta.height };
}

/**
 * Numeric w/h of the crop's aspect lock on a frame of frameW×frameH; null for
 * 'free'. Presets are literal ('4:5' = 0.8), matching the geometry module.
 */
export function cropAspect(crop: Pick<CropParams, 'aspect' | 'customAspect'>, frameW: number, frameH: number): number | null {
  switch (crop.aspect) {
    case 'free':
      return null;
    case 'original':
      return frameW > 0 && frameH > 0 ? frameW / frameH : null;
    case 'custom': {
      const [a, b] = crop.customAspect;
      return a > 0 && b > 0 ? a / b : null;
    }
    default: {
      const [a, b] = crop.aspect.split(':').map(Number);
      return a > 0 && b > 0 ? a / b : null;
    }
  }
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Re-fit a (source) crop rect onto a target frame; see the module comment. */
export function refitCropRect(crop: CropParams, frameW: number, frameH: number): Rect {
  const rect: Rect = { x: crop.x, y: crop.y, w: crop.w, h: crop.h };
  // 'original' is frame-relative: in normalized coords it is the same rect on every frame.
  if (crop.aspect === 'original') return rect;
  const r = cropAspect(crop, frameW, frameH);
  if (r === null || !(frameW > 0 && frameH > 0) || !(rect.w > 0 && rect.h > 0)) return rect;
  const at = frameW / frameH;
  // Already of the locked aspect on this frame (same-shaped photos): copy verbatim.
  if (Math.abs((rect.w * at) / rect.h - r) <= 1e-3 * r) return rect;
  const s = Math.min(1, Math.max(rect.w, rect.h));
  const maxW = r >= at ? 1 : r / at;
  const maxH = r >= at ? at / r : 1;
  const w = s * maxW;
  const h = s * maxH;
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  return {
    x: clamp01(Math.min(Math.max(cx - w / 2, 0), 1 - w)),
    y: clamp01(Math.min(Math.max(cy - h / 2, 0), 1 - h)),
    w,
    h,
  };
}

/** Validity test on the target (frame-normalized rect); from the geometry module when loaded. */
export type CropValidator = (params: EditParams, rect: Rect) => boolean;

/** Largest rect scaled about `rect`'s centre (factor 0..1) that passes `valid`; binary search, 12 steps ≈ 0.02 %. */
export function shrinkToValid(params: EditParams, rect: Rect, valid: CropValidator): Rect {
  if (valid(params, rect)) return rect;
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const scaled = (k: number): Rect => ({ x: cx - (rect.w * k) / 2, y: cy - (rect.h * k) / 2, w: rect.w * k, h: rect.h * k });
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    if (valid(params, scaled(mid))) lo = mid;
    else hi = mid;
  }
  // Keep a usable minimum even when the centre itself is off the image.
  return lo > 0.02 ? scaled(lo) : rect;
}

/**
 * Apply the crop re-fit to `params` (already carrying the synced crop) for a
 * photo with `meta`. Returns a new params object.
 */
export function fitSyncedCrop(params: EditParams, meta: Pick<PhotoMeta, 'width' | 'height'>, valid?: CropValidator | null): EditParams {
  const { width, height } = frameDims(meta, params.crop.orientation);
  if (!(width > 0 && height > 0)) return params;
  let rect = refitCropRect(params.crop, width, height);
  const transformed =
    params.crop.angle !== 0 ||
    params.transform.vertical !== 0 ||
    params.transform.horizontal !== 0 ||
    params.transform.rotate !== 0 ||
    params.transform.aspect !== 0 ||
    params.transform.scale !== 100 ||
    params.transform.offsetX !== 0 ||
    params.transform.offsetY !== 0;
  const next: EditParams = { ...params, crop: { ...params.crop, ...rect } };
  if (valid && params.crop.constrainToImage && transformed) {
    rect = shrinkToValid(next, rect, valid);
    next.crop = { ...next.crop, ...rect };
  }
  return next;
}
