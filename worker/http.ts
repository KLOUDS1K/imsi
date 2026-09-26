/** Small helpers for JSON responses and request parsing. */

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set('content-type', 'application/json; charset=utf-8')
  if (!headers.has('cache-control')) headers.set('cache-control', 'no-store')
  return new Response(JSON.stringify(data), {
    ...init,
    headers,
  })
}

export function error(status: number, message: string, headers?: HeadersInit): Response {
  return json({ error: message }, { status, headers })
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public headers?: HeadersInit) {
    super(message)
  }
}

export function badRequest(message: string): never {
  throw new HttpError(400, message)
}

/** Parse a small JSON object without turning malformed or oversized input into a 500. */
export async function readJsonObject(
  request: Request,
  maxBytes = 64 * 1024,
): Promise<Record<string, unknown>> {
  const lengthHeader = request.headers.get('content-length')
  if (lengthHeader) {
    if (!/^\d+$/.test(lengthHeader)) throw new HttpError(400, 'Invalid Content-Length')
    const declared = Number(lengthHeader)
    if (!Number.isSafeInteger(declared)) throw new HttpError(400, 'Invalid Content-Length')
    if (declared > maxBytes) throw new HttpError(413, 'Request body is too large')
  }
  const type = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase()
  if (type && type !== 'application/json') throw new HttpError(415, 'Expected JSON')

  // Do not call request.text() here: a chunked request can omit Content-Length,
  // and buffering it first would defeat the limit and could exhaust a Worker.
  const reader = request.body?.getReader()
  if (!reader) throw new HttpError(400, 'Request body is required')
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new HttpError(413, 'Request body is too large')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  const text = new TextDecoder().decode(bytes)
  if (!text.trim()) throw new HttpError(400, 'Request body is required')

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new HttpError(400, 'Malformed JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'Expected a JSON object')
  }
  return value as Record<string, unknown>
}

/** Content-Disposition that survives non-ASCII filenames (RFC 5987). */
export function contentDisposition(
  filename: string,
  disposition: 'attachment' | 'inline' = 'attachment',
): string {
  const safe = filename.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '_',
  )
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  const encoded = encodeURIComponent(safe)
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

/**
 * The type to serve an original under when it is being shown, not saved.
 *
 * A file's stored type is whatever the uploading browser claimed, and for
 * anything it did not recognise the uploader substitutes octet-stream — which,
 * with nosniff, a browser will refuse to paint even when the bytes are a
 * perfectly ordinary JPEG. So for display the extension gets the last word.
 * The download route is untouched by this: what is saved keeps the type it was
 * uploaded with, exactly as before.
 */
const INLINE_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
}

export function inlineImageType(filename: string, storedType: string): string {
  const known = Object.values(INLINE_TYPES)
  if (known.includes(storedType.toLowerCase())) return storedType.toLowerCase()
  const ext = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase()
  // Unknown image-like types (notably SVG) are downloads, never active
  // same-origin documents. The gallery only inlines this explicit raster set.
  return INLINE_TYPES[ext] ?? 'application/octet-stream'
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    const k = part.slice(0, idx).trim()
    const v = part.slice(idx + 1).trim()
    if (!k) continue
    try {
      out[k] = decodeURIComponent(v)
    } catch {
      // One malformed third-party cookie must not take down the whole request.
      out[k] = v
    }
  }
  return out
}
