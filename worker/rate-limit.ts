/** Durable, privacy-minimised throttling for password verification endpoints. */
import type { Env } from './types'
import { HttpError } from './http'

const enc = new TextEncoder()

function now(): number {
  return Math.floor(Date.now() / 1000)
}

async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(value)))
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Cloudflare supplies the real edge address; local development gets one shared bucket. */
function clientAddress(request: Request): string {
  return request.headers.get('cf-connecting-ip')?.trim()
    || request.headers.get('x-real-ip')?.trim()
    || 'local'
}

export async function rateLimitKey(
  request: Request,
  scope: string,
  subject = '',
): Promise<string> {
  return digest(`${scope}\n${clientAddress(request)}\n${subject.toLowerCase()}`)
}

interface LimitRow {
  attempts: number
  expires_at: number
}

function blocked(row: LimitRow | null, limit: number, at: number): number | null {
  if (!row || row.expires_at <= at || row.attempts < limit) return null
  return Math.max(1, row.expires_at - at)
}

function reject(retryAfter: number): never {
  throw new HttpError(429, 'Too many attempts. Try again later.', {
    'retry-after': String(retryAfter),
  })
}

/** Refuse before spending a PBKDF2 pass when this bucket is already blocked. */
export async function assertWithinLimit(env: Env, key: string, limit: number): Promise<void> {
  const at = now()
  const row = await env.DB.prepare(
    'SELECT attempts, expires_at FROM rate_limits WHERE key = ?',
  ).bind(key).first<LimitRow>()
  const retryAfter = blocked(row, limit, at)
  if (retryAfter !== null) reject(retryAfter)
}

/** Count a failed check atomically and block the request that reaches the limit. */
export async function recordFailure(
  env: Env,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<void> {
  const at = now()
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, attempts, expires_at)
     VALUES (?1, 1, ?2)
     ON CONFLICT(key) DO UPDATE SET
       attempts = CASE WHEN rate_limits.expires_at <= ?3 THEN 1 ELSE rate_limits.attempts + 1 END,
       expires_at = CASE WHEN rate_limits.expires_at <= ?3 THEN ?2 ELSE rate_limits.expires_at END
     RETURNING attempts, expires_at`,
  ).bind(key, at + windowSeconds, at).first<LimitRow>()

  // Opportunistic bounded-state cleanup without adding a write to every hit.
  if (crypto.getRandomValues(new Uint8Array(1))[0] === 0) {
    await env.DB.prepare('DELETE FROM rate_limits WHERE expires_at <= ?').bind(at).run()
  }

  const retryAfter = blocked(row, limit, at)
  if (retryAfter !== null) reject(retryAfter)
}

export async function clearFailures(env: Env, key: string): Promise<void> {
  await env.DB.prepare('DELETE FROM rate_limits WHERE key = ?').bind(key).run()
}

/** Consume one request from a general-purpose fixed-window bucket. */
export async function consumeLimit(
  env: Env,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<void> {
  await assertWithinLimit(env, key, limit)
  await recordFailure(env, key, limit, windowSeconds)
}
