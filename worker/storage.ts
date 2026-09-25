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
  const present = objectKeys.filter((k): k is string => Boolean(k))
  if (present.length) await env.MEDIA.delete(present)
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
