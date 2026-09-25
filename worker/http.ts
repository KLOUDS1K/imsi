/** Small helpers for JSON responses and request parsing. */

export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...(init.headers ?? {}),
    },
  })
}

export function error(status: number, message: string): Response {
  return json({ error: message }, { status })
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

export function badRequest(message: string): never {
  throw new HttpError(400, message)
}

/** Content-Disposition that survives non-ASCII filenames (RFC 5987). */
export function contentDisposition(
  filename: string,
  disposition: 'attachment' | 'inline' = 'attachment',
): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  const encoded = encodeURIComponent(filename)
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
}

export function inlineImageType(filename: string, storedType: string): string {
  const known = Object.values(INLINE_TYPES)
  if (known.includes(storedType.toLowerCase())) return storedType.toLowerCase()
  const ext = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase()
  return INLINE_TYPES[ext] ?? storedType ?? 'application/octet-stream'
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    const k = part.slice(0, idx).trim()
    const v = part.slice(idx + 1).trim()
    if (k) out[k] = decodeURIComponent(v)
  }
  return out
}
