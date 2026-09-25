/**
 * Derivative generation, in the admin's browser.
 *
 * This zone is on a free plan, so Cloudflare Image Transformations are not
 * available. Generating the optimised sizes here instead keeps delivery cheap
 * and, importantly, keeps the original file completely untouched: the original
 * is uploaded byte-for-byte as its own R2 object and these derivatives are
 * written to separate keys.
 */

/** Long edge, in pixels, for each generated size. */
const PREVIEW_EDGE = 2400
/**
 * 900, for a grid whose widest tile is a folder cover at ~300 CSS px. That
 * still leaves headroom on a 2x display without making every tile in a large
 * folder a megabyte of traffic; anything bigger is the viewer's job, and the
 * viewer loads the preview derivative instead.
 */
const THUMB_EDGE = 900
const LQIP_EDGE = 20

const PREVIEW_QUALITY = 0.86
const THUMB_QUALITY = 0.82

export interface Derivatives {
  width: number
  height: number
  preview: Blob | null
  thumb: Blob | null
  placeholder: string | null
  /** Set when the browser cannot decode this format (TIFF, some RAW, …). */
  warning: string | null
}

/** Decodes the file, honouring EXIF orientation so phone shots are upright. */
async function decode(file: File): Promise<ImageBitmap | HTMLImageElement | null> {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' })
    } catch {
      // Fall through to the <img> path below.
    }
  }

  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(null)
    }
    img.src = url
  })
}

function dimensionsOf(source: ImageBitmap | HTMLImageElement): { w: number; h: number } {
  if ('naturalWidth' in source) return { w: source.naturalWidth, h: source.naturalHeight }
  return { w: source.width, h: source.height }
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  return canvas
}

/**
 * Downscales in halving steps when the reduction is large. A single huge
 * downscale aliases badly; stepping keeps fine detail intact.
 */
function resize(
  source: CanvasImageSource,
  sw: number,
  sh: number,
  targetEdge: number,
): HTMLCanvasElement {
  const scale = Math.min(1, targetEdge / Math.max(sw, sh))
  const tw = Math.max(1, Math.round(sw * scale))
  const th = Math.max(1, Math.round(sh * scale))

  let current: CanvasImageSource = source
  let cw = sw
  let ch = sh

  while (cw > tw * 2 && ch > th * 2) {
    const nw = Math.max(tw, Math.round(cw / 2))
    const nh = Math.max(th, Math.round(ch / 2))
    const step = makeCanvas(nw, nh)
    const sctx = step.getContext('2d')
    if (!sctx) break
    sctx.imageSmoothingEnabled = true
    sctx.imageSmoothingQuality = 'high'
    sctx.drawImage(current, 0, 0, nw, nh)
    current = step
    cw = nw
    ch = nh
  }

  const out = makeCanvas(tw, th)
  const ctx = out.getContext('2d')
  if (ctx) {
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(current, 0, 0, tw, th)
  }
  return out
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality))
}

export async function generateDerivatives(file: File): Promise<Derivatives> {
  const source = await decode(file)

  if (!source) {
    return {
      width: 0,
      height: 0,
      preview: null,
      thumb: null,
      placeholder: null,
      warning: 'This browser cannot decode the format, so no preview was generated.',
    }
  }

  const { w, h } = dimensionsOf(source)

  const previewCanvas = resize(source, w, h, PREVIEW_EDGE)
  const thumbCanvas = resize(source, w, h, THUMB_EDGE)
  const lqipCanvas = resize(source, w, h, LQIP_EDGE)

  // WebP where supported; Safari < 14 and friends quietly fall back to JPEG.
  let preview = await toBlob(previewCanvas, 'image/webp', PREVIEW_QUALITY)
  let thumb = await toBlob(thumbCanvas, 'image/webp', THUMB_QUALITY)
  if (!preview || preview.type !== 'image/webp') {
    preview = await toBlob(previewCanvas, 'image/jpeg', 0.9)
  }
  if (!thumb || thumb.type !== 'image/webp') {
    thumb = await toBlob(thumbCanvas, 'image/jpeg', 0.86)
  }

  const placeholder = lqipCanvas.toDataURL('image/jpeg', 0.5)

  if ('close' in source) source.close()

  return {
    width: w,
    height: h,
    preview,
    thumb,
    placeholder: placeholder.length < 3500 ? placeholder : null,
    warning: null,
  }
}
