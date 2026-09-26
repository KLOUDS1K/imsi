/**
 * Folder locks.
 *
 * A folder can carry a password. Everything inside it — subfolders, photos,
 * originals — stays out of every listing until the visitor proves they know
 * it, and a lock applies to the whole subtree beneath it.
 *
 * Two signed artefacts make that work without a session per visitor:
 *
 *   grant   proves "this browser unlocked folder F". Lives in a cookie, and
 *           is signed over the folder's password hash, so changing the
 *           password silently invalidates every grant that was ever issued.
 *
 *   media   proves "the bearer was handed this photo id by a listing". Every
 *           thumbnail and preview URL carries one. Without it the media route
 *           would be an unauthenticated way to read a locked folder's photos
 *           by id, and ids leak (a shared screenshot, a browser history).
 *
 * Both are HMAC-SHA256 under one key kept in `settings`, so verifying either
 * one costs no database read on the hot path.
 */
import type { Env, FolderRow } from './types'
import { parseCookies } from './http'

const GRANT_COOKIE = 'kp_keys'
const GRANT_TTL_SEC = 60 * 60 * 24 * 30
/** How many folders one browser may hold grants for, oldest dropped first. */
const GRANT_LIMIT = 24

/**
 * Media tokens expire on a shared 7-day boundary rather than "now + 7 days".
 * A per-request expiry would change the URL on every page load, so the browser
 * would re-download every thumbnail it already had.
 */
const MEDIA_WINDOW_SEC = 60 * 60 * 24 * 7

const enc = new TextEncoder()

const now = () => Math.floor(Date.now() / 1000)

function b64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// ---------------------------------------------------------------- signing key

let cachedKey: CryptoKey | null = null
let cachedAt = 0
/**
 * Short, because the key is rotated whenever a folder's password changes and
 * every other isolate has to notice. A stale key for a few seconds costs a
 * broken thumbnail that a reload fixes; a permanently stale one would keep
 * honouring image links the owner meant to revoke.
 */
const KEY_CACHE_SEC = 20

async function signingKey(env: Env): Promise<CryptoKey> {
  if (cachedKey && now() - cachedAt < KEY_CACHE_SEC) return cachedKey

  const read = () =>
    env.DB.prepare('SELECT value FROM settings WHERE key = ?')
      .bind('sign_key')
      .first<{ value: string }>()

  let row = await read()
  if (!row) {
    const fresh = b64url(crypto.getRandomValues(new Uint8Array(32)))
    // INSERT OR IGNORE, then read back: two isolates racing on a cold start
    // must end up agreeing on one key, not overwrite each other's.
    await env.DB.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
      .bind('sign_key', fresh)
      .run()
    row = await read()
  }
  if (!row) throw new Error('Could not establish a signing key')

  cachedKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(row.value),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  cachedAt = now()
  return cachedKey
}

/**
 * Called whenever a folder's password is set, changed or removed.
 *
 * Locking a folder has to revoke the image links that were handed out while it
 * was open, and those are signed under this key — so the key is replaced. The
 * price is that every visitor re-fetches thumbnails once and anyone holding a
 * grant for some other folder is asked for its password again, which is the
 * right way round for a mistake you are trying to undo.
 */
export async function rotateSigningKey(env: Env): Promise<void> {
  const fresh = b64url(crypto.getRandomValues(new Uint8Array(32)))
  await env.DB.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  )
    .bind('sign_key', fresh)
    .run()
  cachedKey = null
  cachedAt = 0
}

async function sign(env: Env, message: string): Promise<string> {
  const key = await signingKey(env)
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(message))
  // 16 bytes is 128 bits of tag — far more than enough, and it keeps URLs and
  // the cookie short.
  return b64url(new Uint8Array(mac).slice(0, 16))
}

// -------------------------------------------------------------- media tokens

export async function mediaToken(env: Env, photoId: string): Promise<string> {
  const expires = (Math.floor(now() / MEDIA_WINDOW_SEC) + 2) * MEDIA_WINDOW_SEC
  return `${expires}.${await sign(env, `m:${photoId}.${expires}`)}`
}

export async function mediaTokenIsValid(
  env: Env,
  photoId: string,
  token: string | null,
): Promise<boolean> {
  if (!token) return false
  const dot = token.indexOf('.')
  if (dot < 0) return false
  const expires = Number(token.slice(0, dot))
  const signature = token.slice(dot + 1)
  if (!Number.isFinite(expires) || expires <= now()) return false
  return timingSafeEqual(signature, await sign(env, `m:${photoId}.${expires}`))
}

/**
 * The URL a listing hands out for an image: 't' thumbnail, 'p' preview, 'o' the
 * original file itself. One token covers all three — it says "you were shown
 * this photo in a listing you were allowed to see", and anyone holding it could
 * already take the original through /download.
 */
export async function mediaHref(
  env: Env,
  kind: 't' | 'p' | 'o' | 'et' | 'ep' | 'e',
  photoId: string,
  version?: string | null,
): Promise<string> {
  return mediaPath(kind, photoId, await mediaToken(env, photoId), version)
}

/**
 * The same URL from a token that has already been minted. A listing hands out
 * two or three URLs per photo and they all carry the same token, so signing
 * once per photo rather than once per URL is the difference between one HMAC
 * per row and three.
 */
export function mediaPath(
  kind: 't' | 'p' | 'o' | 'et' | 'ep' | 'e',
  photoId: string,
  token: string,
  version?: string | null,
): string {
  const suffix = version ? `&v=${encodeURIComponent(version)}` : ''
  return `/media/${kind}/${photoId}?t=${token}${suffix}`
}

// -------------------------------------------------------------------- grants

export type Grants = Map<string, { expires: number; signature: string }>

export function readGrants(request: Request): Grants {
  const raw = parseCookies(request.headers.get('cookie'))[GRANT_COOKIE]
  const out: Grants = new Map()
  if (!raw) return out
  for (const part of raw.split('|')) {
    const [id, expires, signature] = part.split('.')
    if (!id || !expires || !signature) continue
    const at = Number(expires)
    if (!Number.isFinite(at) || at <= now()) continue
    out.set(id, { expires: at, signature })
  }
  return out
}

async function grantSignature(env: Env, folder: FolderRow, expires: number): Promise<string> {
  // The password hash is part of the message, so a password change makes every
  // outstanding grant for this folder stop verifying.
  return sign(env, `g:${folder.id}.${expires}.${folder.password_hash ?? ''}`)
}

export async function holdsGrant(env: Env, folder: FolderRow, grants: Grants): Promise<boolean> {
  const held = grants.get(folder.id)
  if (!held) return false
  return timingSafeEqual(held.signature, await grantSignature(env, folder, held.expires))
}

/** Adds a grant for `folder` to whatever the browser already holds. */
export async function issueGrant(
  env: Env,
  folder: FolderRow,
  grants: Grants,
  secure: boolean,
): Promise<string> {
  const expires = now() + GRANT_TTL_SEC
  const next = new Map(grants)
  next.delete(folder.id)
  next.set(folder.id, { expires, signature: await grantSignature(env, folder, expires) })

  const entries = [...next.entries()]
    .slice(-GRANT_LIMIT)
    .map(([id, g]) => `${id}.${g.expires}.${g.signature}`)
    .join('|')

  const flags = [
    `${GRANT_COOKIE}=${encodeURIComponent(entries)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${GRANT_TTL_SEC}`,
  ]
  if (secure) flags.push('Secure')
  return flags.join('; ')
}

// ------------------------------------------------------------- lock topology

export interface LockView {
  /** Locked folders the viewer has not opened — shown, but as a closed door. */
  locked: Set<string>
  /** Folders that must not appear at all, because something above them is locked. */
  blocked: Set<string>
}

/**
 * Works out, for every folder in one pass, whether the viewer may see it and
 * whether it should be drawn with a lock on it.
 */
export async function lockView(
  env: Env,
  folders: FolderRow[],
  grants: Grants,
  admin: boolean,
): Promise<LockView> {
  const locked = new Set<string>()
  const blocked = new Set<string>()
  if (admin) return { locked, blocked }

  for (const folder of folders) {
    if (folder.password_hash && !(await holdsGrant(env, folder, grants))) locked.add(folder.id)
  }
  if (!locked.size) return { locked, blocked }

  const byId = new Map(folders.map((f) => [f.id, f]))
  const resolved = new Map<string, boolean>()

  /** True when something strictly above `id` is locked and still shut. */
  const hidden = (id: string): boolean => {
    const cached = resolved.get(id)
    if (cached !== undefined) return cached

    const chain: string[] = []
    let cursor: string | undefined = id
    let value = false

    while (cursor) {
      const known = resolved.get(cursor)
      if (known !== undefined) {
        value = known
        break
      }
      const row: FolderRow | undefined = byId.get(cursor)
      // A parent that is not in the list has already been filtered out.
      if (!row) {
        value = cursor !== ''
        break
      }
      chain.push(cursor)
      if (locked.has(row.parent_id) || resolved.get(row.parent_id) === true) {
        value = true
        break
      }
      if (row.parent_id === '') {
        value = false
        break
      }
      cursor = row.parent_id
    }

    for (const step of chain) resolved.set(step, value)
    return value
  }

  for (const folder of folders) {
    if (hidden(folder.id)) blocked.add(folder.id)
  }
  return { locked, blocked }
}

/**
 * The gate for one folder: every locked ancestor, plus the folder itself,
 * has to have been opened. Returns the folder that is standing in the way.
 */
export async function lockedAncestor(
  env: Env,
  path: FolderRow[],
  grants: Grants,
  admin: boolean,
): Promise<FolderRow | null> {
  if (admin) return null
  for (const folder of path) {
    if (folder.password_hash && !(await holdsGrant(env, folder, grants))) return folder
  }
  return null
}

export { GRANT_COOKIE }
