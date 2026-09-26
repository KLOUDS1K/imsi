/**
 * R2 access.
 *
 * Three objects per photo, and the original is written exactly once and never
 * touched again:
 *   originals/<id>/<filename>   the untouched upload — this is what downloads serve
 *   preview/<id>                long-edge ~2400px WebP, for the lightbox
 *   thumb/<id>                  long-edge ~800px WebP, for the grid
 */
import type { Env } from './types'

export const keys = {
  original: (id: string, filename: string) => `originals/${id}/${filename}`,
  preview: (id: string) => `preview/${id}`,
  thumb: (id: string) => `thumb/${id}`,
  edited: (id: string, revision: string) => `edited/${id}/${revision}/full`,
  editedPreview: (id: string, revision: string) => `edited/${id}/${revision}/preview`,
  editedThumb: (id: string, revision: string) => `edited/${id}/${revision}/thumb`,
}

/** Lightweight magic-byte validation for browser-generated derivatives. */
export function imageBytesMatch(buffer: ArrayBuffer, contentType: string): boolean {
  const bytes = new Uint8Array(buffer)
  if (contentType === 'image/jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  }
  if (contentType === 'image/png') {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    return bytes.length >= sig.length && sig.every((value, index) => bytes[index] === value)
  }
  if (contentType === 'image/webp') {
    return bytes.length >= 12
      && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
      && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  }
  if (contentType === 'image/avif') {
    if (bytes.length < 16 || String.fromCharCode(...bytes.slice(4, 8)) !== 'ftyp') return false
    const brands = String.fromCharCode(...bytes.slice(8, Math.min(bytes.length, 64)))
    return brands.includes('avif') || brands.includes('avis')
  }
  return false
}

export async function putOriginal(
  env: Env,
  id: string,
  filename: string,
  body: ReadableStream | ArrayBuffer,
  contentType: string,
): Promise<string> {
  const key = keys.original(id, filename)
  await env.MEDIA.put(key, body, {
    httpMetadata: { contentType, cacheControl: 'private, max-age=0, must-revalidate' },
  })
  return key
}

export async function putDerivative(
  env: Env,
  key: string,
  body: ArrayBuffer,
  contentType: string,
): Promise<void> {
  await env.MEDIA.put(key, body, {
    httpMetadata: { contentType, cacheControl: 'public, max-age=31536000, immutable' },
  })
}

export async function deleteObjects(env: Env, objectKeys: (string | null)[]): Promise<void> {
  const present = [...new Set(objectKeys.filter((k): k is string => Boolean(k)))]
  for (let i = 0; i < present.length; i += 1000) {
    await env.MEDIA.delete(present.slice(i, i + 1000))
  }
}

/** List every object below a controlled prefix, following R2 pagination. */
export async function listObjectKeys(env: Env, prefix: string): Promise<string[]> {
  const out: string[] = []
  let cursor: string | undefined
  do {
    const page = await env.MEDIA.list({ prefix, cursor, limit: 1000 })
    out.push(...page.objects.map((object) => object.key))
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return out
}

/**
 * Streams an R2 object out, honouring Range requests so large originals can be
 * resumed and so browsers can seek. Returns null when the object is gone.
 */
export async function serveObject(
  env: Env,
  key: string,
  request: Request,
  extraHeaders: Record<string, string> = {},
): Promise<Response | null> {
  const range = request.headers.get('range')
  const onlyIf = request.headers.get('if-none-match')

  const object = await env.MEDIA.get(key, {
    range: range ? request.headers : undefined,
    onlyIf: onlyIf ? { etagDoesNotMatch: onlyIf } : undefined,
  })

  if (!object) return null

  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('etag', object.httpEtag)
  headers.set('accept-ranges', 'bytes')
  for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v)

  // A hit on If-None-Match comes back without a body.
  if (!('body' in object) || object.body === null) {
    return new Response(null, { status: onlyIf ? 304 : 200, headers })
  }

  // workerd fills object.range even for full reads — only honour it when the
  // client actually asked for a range.
  if (range && object.range && 'offset' in object.range) {
    const offset = object.range.offset ?? 0
    const length = object.range.length ?? object.size - offset
    headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${object.size}`)
    return new Response(object.body, { status: 206, headers })
  }

  headers.set('content-length', String(object.size))
  return new Response(object.body, { status: 200, headers })
}
