import type { Env } from './types'
import { handleApi, toErrorResponse } from './api'

/**
 * No inline scripts are used, so the script policy can stay strict. Styles
 * keep `unsafe-inline` because the explorer passes per-tile aspect ratios and
 * placeholder images through inline custom properties.
 */
const CSP = [
  "default-src 'self'",
  // Cloudflare injects its Web Analytics beacon into HTML responses at the
  // edge, after this policy is set — without these two entries the browser
  // blocks it and the zone's analytics silently stop recording.
  "script-src 'self' 'wasm-unsafe-eval' https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "connect-src 'self' https://cloudflareinsights.com",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ')

/**
 * Applied to what the Worker itself returns. Static assets never reach this
 * code — the asset router serves them directly — so the same policy is
 * repeated in `public/_headers`. Change one, change the other.
 */
const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'permissions-policy': 'geolocation=(), microphone=(), camera=()',
}

/** Paths the worker owns outright — never rewritten to the app shell. */
const RESERVED = ['/api/', '/media/', '/download/']

function withSecurityHeaders(res: Response, extra: Record<string, string> = {}): Response {
  const headers = new Headers(res.headers)
  for (const [k, v] of Object.entries({ ...SECURITY_HEADERS, ...extra })) headers.set(k, v)
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    try {
      // ctx goes through so the counters can be written after the response has
      // already gone out — a stats write must never sit in front of a photo.
      const handled = await handleApi(request, env, url, ctx)
      if (handled) return handled
    } catch (err) {
      return toErrorResponse(err)
    }

    const res = await env.ASSETS.fetch(request)

    // Deep links like /f/<id> are client-side routes with no file behind them.
    // Hand back the app shell so a reload or a shared link opens the folder
    // instead of a 404 — but only for real page requests, so a mistyped asset
    // URL still fails loudly instead of returning HTML with a 200.
    const wantsPage =
      request.method === 'GET' &&
      (request.headers.get('accept') ?? '').includes('text/html') &&
      !RESERVED.some((p) => url.pathname.startsWith(p)) &&
      !/\.[a-z0-9]+$/i.test(url.pathname)

    if (res.status === 404 && wantsPage) {
      const shell = await env.ASSETS.fetch(new URL('/', url).toString())
      return withSecurityHeaders(shell, { 'cache-control': 'no-cache' })
    }

    return withSecurityHeaders(res)
  },
} satisfies ExportedHandler<Env>
