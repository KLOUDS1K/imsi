/**
 * Showing the original file in the viewer.
 *
 * The 2400px preview exists to put something sharp on screen in the first
 * moment; it is not what a client should end up looking at. So the viewer
 * paints the preview, then quietly pulls the original — the actual uploaded
 * file, never re-encoded — and swaps it in once it has decoded. The swap is
 * free of flicker because assigning a new `src` leaves the old frame on screen
 * until the new one is ready, and by then it is already decoded and cached.
 *
 * Two things are worth being careful about, and both are handled here rather
 * than in the viewer:
 *
 * - Not every uploaded format is one a browser paints. A TIFF or a raw file is
 *   exactly why derivatives are generated in the first place, so the original
 *   is only ever offered for the types that render everywhere.
 * - An original can be forty megabytes. Pulling that down a phone's metered
 *   connection to fill a 390px screen would be rude, and the preview already
 *   carries far more detail than such a screen can show. The budget below is
 *   about not wasting somebody's data, not about the site's costs — R2 egress
 *   is free.
 *
 * Zooming overrides the budget. Asking for 1:1 is asking for the real pixels,
 * and answering that with an upscaled preview is the one thing this module
 * exists to avoid.
 */
import type { Photo } from '../shared/types'

/**
 * Formats a browser may paint inline, without a decoder of our own.
 *
 * HEIC is in the list even though only Safari renders it, because HEIC is what
 * an iPhone actually produces and Safari is what an iPhone actually runs.
 * Everywhere else the first attempt fails, `unsupported` remembers it, and no
 * second HEIC is fetched for the rest of the session.
 */
const RENDERABLE = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/gif',
  'image/heic',
  'image/heif',
])

/** Types this browser has already proved it cannot decode. */
const unsupported = new Set<string>()

const MB = 1024 * 1024

interface NetworkInformation {
  saveData?: boolean
  effectiveType?: string
}

function connection(): NetworkInformation | undefined {
  return (navigator as Navigator & { connection?: NetworkInformation }).connection
}

function deviceMemory(): number {
  // Chromium only; a browser that will not say is assumed to be comfortable,
  // which is the right guess for the desktops that do not report it.
  return (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8
}

function isPhone(): boolean {
  return window.matchMedia('(max-width: 620px)').matches
}

/**
 * How many bytes of original this device should be asked to pull and decode.
 * Zero means "leave the preview alone".
 */
export function budget(): number {
  const net = connection()
  if (net?.saveData) return 0
  if (net?.effectiveType === '2g' || net?.effectiveType === 'slow-2g') return 0

  const memory = deviceMemory()
  if (memory <= 2) return 0

  // 12MB of file per GB of memory, capped: a phone screen cannot show more
  // detail than the preview already has, so there is nothing to win by
  // spending a client's data allowance on it.
  return Math.min(isPhone() ? 24 : 100, memory * 12) * MB
}

/**
 * Megapixels past which a decode is more than a device should be asked for.
 *
 * This is a separate limit from the byte budget on purpose: compressed size
 * says nothing about what a decode costs. Every pixel is four bytes once it is
 * unpacked, so a tidy 8MB file of 40 megapixels wants 160MB of memory — which
 * is why zooming may spend more data but never more memory than this.
 */
function pixelCeiling(): number {
  return isPhone() ? 24 : 80
}

/** The same list by extension — see below for why the type is not enough. */
const RENDERABLE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif', 'heic', 'heif'])

/** What this photo would be served as, which is what has to be decodable. */
function servedType(photo: Photo): string {
  const mime = photo.type.toLowerCase()
  if (RENDERABLE.has(mime)) return mime
  const dot = photo.filename.lastIndexOf('.')
  const ext = dot < 0 ? '' : photo.filename.slice(dot + 1).toLowerCase()
  return RENDERABLE_EXT.has(ext) ? `image/${ext === 'jpg' ? 'jpeg' : ext}` : mime
}

/*
 * A photo's stored type is whatever the uploading browser claimed for the file,
 * and for anything it did not recognise the uploader wrote octet-stream. That
 * is why the extension gets a say: an ordinary JPEG that arrived mistyped is
 * still an ordinary JPEG, and the worker serves it inline under the type its
 * extension implies.
 */
export function isRenderable(photo: Photo): boolean {
  const type = servedType(photo)
  if (unsupported.has(type)) return false
  return RENDERABLE.has(type)
}

/**
 * Whether the original is worth fetching on top of the preview. `force` is the
 * zoom case: the format still has to be one the browser can paint, but the
 * data budget no longer applies because the viewer asked for real pixels.
 */
export function wantsOriginal(photo: Photo, force = false): boolean {
  if (!isRenderable(photo)) return false
  // Nothing to upgrade to — the original is already what is on screen.
  if (!photo.previewUrl) return false

  // The pixel ceiling holds even when forced. Zooming is a request for detail,
  // not permission to run the tab out of memory, and on a phone the gesture is
  // one stray tap away.
  if (photo.width && photo.height) {
    if ((photo.width * photo.height) / 1_000_000 > pixelCeiling()) return false
  }

  const allowance = budget()
  // Data saver is a request too, and it outranks a tap. Everything else about
  // the budget is only about size, which is exactly what zooming overrides.
  if (allowance === 0) return false
  if (!force && photo.size > allowance) return false

  return true
}

export interface Upgrade {
  /** Stops caring about the result; the fetch itself is left to the browser. */
  cancel(): void
}

/**
 * Warms the original off-screen and reports it once it is decoded, so the
 * viewer can swap `src` and paint it in the same frame.
 *
 * The decode is what is being waited on, not the load: an image that has
 * arrived but not decoded still costs a visible hitch when it is put on screen.
 */
export function loadOriginal(
  photo: Photo,
  onReady: (url: string, width: number, height: number) => void,
): Upgrade {
  let live = true
  let warm: HTMLImageElement | null = new Image()
  warm.decoding = 'async'
  // It is the thing being looked at; the neighbours being warmed alongside it
  // can wait their turn.
  warm.fetchPriority = 'high'
  warm.src = photo.originalUrl

  const image = warm
  const ready = image.decode ? image.decode() : Promise.resolve()
  void ready
    .then(() => {
      const width = image.naturalWidth
      const height = image.naturalHeight
      // The decoded frame lives in the browser's cache from here on, keyed by
      // URL; holding this element too would just pin a second reference to it.
      warm = null
      if (!live) return
      onReady(photo.originalUrl, width, height)
    })
    .catch(() => {
      // A format the browser turned out not to want, a 403 on an expired
      // token, a truncated file: the preview stays on screen and nobody sees
      // an error, because nothing was broken from the viewer's side.
      //
      // Whatever the cause, it is not worth pulling another file of the same
      // kind to find out again. If it was the token rather than the format,
      // every original is failing anyway and holding off is still right.
      warm = null
      unsupported.add(servedType(photo))
    })

  return {
    cancel() {
      live = false
      // Removing the attribute is what actually abandons a transfer nobody is
      // waiting on any more, which matters when arrowing quickly through a
      // folder of large files. Setting src to '' would instead resolve against
      // the document and fetch the page itself as an image.
      if (warm && !warm.complete) warm.removeAttribute('src')
      warm = null
    },
  }
}
