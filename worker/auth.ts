/**
 * Admin authentication.
 *
 * - Passwords: PBKDF2-SHA256, per-user random salt, stored as
 *   `pbkdf2$<iterations>$<salt_b64>$<hash_b64>`.
 * - Sessions: a 256-bit random token goes to the client in an httpOnly cookie;
 *   only its SHA-256 is stored, so a database leak cannot be replayed.
 * - The admin route is NOT protected by obscurity — every /api/admin/* call is
 *   checked against a live session.
 */
import type { Env } from './types'
import { HttpError, parseCookies } from './http'

const COOKIE = 'kp_session'
const SESSION_TTL_SEC = 60 * 60 * 12 // 12 hours
const PBKDF2_ITERATIONS = 100_000 // Cloudflare Workers enforces a 100k cap on PBKDF2

const enc = new TextEncoder()

function b64(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ''
  for (const b of arr) s += String.fromCharCode(b)
  return btoa(s)
}

function unb64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as unknown as BufferSource, iterations },
    key,
    256,
  )
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const bits = await pbkdf2(password, salt, PBKDF2_ITERATIONS)
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64(salt)}$${b64(bits)}`
}

/** Constant-time comparison — avoids leaking how much of the hash matched. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number)
  return diff === 0
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false
  const iterations = Number(parts[1])
  if (!Number.isFinite(iterations) || iterations < 1000) return false
  const salt = unb64(parts[2] as string)
  const expected = unb64(parts[3] as string)
  const actual = new Uint8Array(await pbkdf2(password, salt, iterations))
  return timingSafeEqual(actual, expected)
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(input))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export interface Session {
  adminId: number
  username: string
}

/** Creates a session row and returns the Set-Cookie header value. */
export async function createSession(env: Env, adminId: number, secure: boolean): Promise<string> {
  const raw = b64(crypto.getRandomValues(new Uint8Array(32)))
  const id = await sha256Hex(raw)
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare('INSERT INTO sessions (id, admin_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(id, adminId, now + SESSION_TTL_SEC, now)
    .run()

  const flags = [
    `${COOKIE}=${encodeURIComponent(raw)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${SESSION_TTL_SEC}`,
  ]
  if (secure) flags.push('Secure')
  return flags.join('; ')
}

export async function destroySession(env: Env, request: Request, secure: boolean): Promise<string> {
  const raw = parseCookies(request.headers.get('cookie'))[COOKIE]
  if (raw) {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(await sha256Hex(raw)).run()
  }
  const flags = [`${COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0']
  if (secure) flags.push('Secure')
  return flags.join('; ')
}

/** Returns the session for this request, or null. Also prunes expired rows. */
export async function getSession(env: Env, request: Request): Promise<Session | null> {
  const raw = parseCookies(request.headers.get('cookie'))[COOKIE]
  if (!raw) return null
  const id = await sha256Hex(raw)
  const now = Math.floor(Date.now() / 1000)

  const row = await env.DB.prepare(
    `SELECT s.admin_id AS adminId, a.username AS username
       FROM sessions s JOIN admins a ON a.id = s.admin_id
      WHERE s.id = ? AND s.expires_at > ?`,
  )
    .bind(id, now)
    .first<{ adminId: number; username: string }>()

  if (!row) return null
  return { adminId: row.adminId, username: row.username }
}

export async function requireSession(env: Env, request: Request): Promise<Session> {
  const session = await getSession(env, request)
  if (!session) throw new HttpError(401, 'Authentication required')
  return session
}

/**
 * Cookie-authenticated mutations need CSRF protection. SameSite=Strict already
 * blocks cross-site sends; this is the belt to that pair of braces.
 */
export function assertSameOrigin(request: Request): void {
  const method = request.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return
  const origin = request.headers.get('origin')
  if (!origin) return // same-origin non-CORS clients may omit it
  const target = new URL(request.url).origin
  if (origin !== target) throw new HttpError(403, 'Cross-origin request rejected')
}

export { COOKIE as SESSION_COOKIE }
