/**
 * Counters for the owner's stats panel.
 *
 * Two rules shape this file:
 *
 *   Nothing here is allowed to slow a page down. Every write is handed to
 *   `ctx.waitUntil()` by the caller, so it happens after the response has been
 *   sent, and each recording is a single batched round trip.
 *
 *   Nothing here identifies anybody. A visitor is a random opaque id in a
 *   first-party cookie — no address, no agent string, no referrer. It exists
 *   only so that one person reloading twenty times is one visitor.
 */
import type { Env } from './types'
import { parseCookies } from './http'

const VISITOR_COOKIE = 'kp_visitor'
const VISITOR_TTL_SEC = 60 * 60 * 24 * 365
const VISITOR_RE = /^[0-9a-f]{32}$/

export type Kind = 'visits' | 'views' | 'downloads'

const now = () => Math.floor(Date.now() / 1000)
const today = () => new Date().toISOString().slice(0, 10)

export function visitorFrom(request: Request): string | null {
  const raw = parseCookies(request.headers.get('cookie'))[VISITOR_COOKIE]
  return raw && VISITOR_RE.test(raw) ? raw : null
}

export function newVisitorId(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export function visitorCookie(id: string, secure: boolean): string {
  const flags = [
    `${VISITOR_COOKIE}=${id}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${VISITOR_TTL_SEC}`,
  ]
  if (secure) flags.push('Secure')
  return flags.join('; ')
}

/** `count = count + 1`, creating the row the first time. */
function bump(env: Env, key: string) {
  return env.DB.prepare(
    `INSERT INTO stats (key, count, updated_at) VALUES (?1, 1, ?2)
     ON CONFLICT(key) DO UPDATE SET count = count + 1, updated_at = ?2`,
  ).bind(key, now())
}

function bumpDay(env: Env, kind: Kind) {
  return env.DB.prepare(
    `INSERT INTO daily (day, kind, count) VALUES (?1, ?2, 1)
     ON CONFLICT(day, kind) DO UPDATE SET count = count + 1`,
  ).bind(today(), kind)
}

function touchVisitor(env: Env, id: string) {
  return env.DB.prepare(
    `INSERT INTO visitors (id, first_seen, last_seen, visits) VALUES (?1, ?2, ?2, 1)
     ON CONFLICT(id) DO UPDATE SET last_seen = ?2, visits = visits + 1`,
  ).bind(id, now())
}

export async function recordVisit(env: Env, visitorId: string): Promise<void> {
  await env.DB.batch([touchVisitor(env, visitorId), bump(env, 'visits'), bumpDay(env, 'visits')])
}

export async function recordFolderView(env: Env, folderId: string): Promise<void> {
  // The root has no id of its own; it is counted only in the total.
  const rows = [bump(env, 'views'), bumpDay(env, 'views')]
  if (folderId) rows.push(bump(env, `folder:${folderId}`))
  await env.DB.batch(rows)
}

export async function recordDownload(env: Env, photoId: string): Promise<void> {
  await env.DB.batch([
    bump(env, 'downloads'),
    bumpDay(env, 'downloads'),
    bump(env, `photo:${photoId}`),
  ])
}

// ------------------------------------------------------------------ reading

export interface StatsReport {
  visitors: number
  visits: number
  views: number
  downloads: number
  /** Last 30 days, oldest first, with zero-filled gaps. */
  daily: { day: string; visits: number; views: number; downloads: number }[]
  topFolders: { id: string; name: string; views: number }[]
  topPhotos: { id: string; name: string; folder: string; downloads: number }[]
  since: number | null
}

export async function readStats(env: Env): Promise<StatsReport> {
  const [totals, uniques, series, folders, photos, first] = await env.DB.batch<never>([
    env.DB.prepare(`SELECT key, count FROM stats WHERE key IN ('visits','views','downloads')`),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM visitors`),
    env.DB.prepare(
      `SELECT day, kind, count FROM daily WHERE day >= date('now', '-29 days') ORDER BY day`,
    ),
    env.DB.prepare(
      `SELECT f.id AS id, f.name AS name, s.count AS views
         FROM stats s JOIN folders f ON f.id = substr(s.key, 8)
        WHERE s.key LIKE 'folder:%'
        ORDER BY s.count DESC LIMIT 10`,
    ),
    env.DB.prepare(
      `SELECT p.id AS id,
              CASE WHEN p.title <> '' THEN p.title ELSE p.original_filename END AS name,
              COALESCE(f.name, '') AS folder,
              s.count AS downloads
         FROM stats s
         JOIN photos p ON p.id = substr(s.key, 7)
         LEFT JOIN folders f ON f.id = p.folder_id
        WHERE s.key LIKE 'photo:%'
        ORDER BY s.count DESC LIMIT 10`,
    ),
    env.DB.prepare(`SELECT MIN(first_seen) AS at FROM visitors`),
  ])

  const rows = <T>(slot: { results?: unknown[] } | undefined): T[] =>
    (slot?.results ?? []) as T[]

  const totalOf = new Map(
    rows<{ key: string; count: number }>(totals).map((r) => [r.key, r.count]),
  )

  // Zero-fill so the chart has a bar for every day, not only the busy ones.
  const byDay = new Map<string, { visits: number; views: number; downloads: number }>()
  for (const row of rows<{ day: string; kind: Kind; count: number }>(series)) {
    const slot = byDay.get(row.day) ?? { visits: 0, views: 0, downloads: 0 }
    slot[row.kind] = row.count
    byDay.set(row.day, slot)
  }
  const daily: StatsReport['daily'] = []
  const start = new Date()
  start.setUTCDate(start.getUTCDate() - 29)
  for (let i = 0; i < 30; i++) {
    const d = new Date(start)
    d.setUTCDate(start.getUTCDate() + i)
    const day = d.toISOString().slice(0, 10)
    daily.push({ day, ...(byDay.get(day) ?? { visits: 0, views: 0, downloads: 0 }) })
  }

  return {
    visitors: rows<{ n: number }>(uniques)[0]?.n ?? 0,
    visits: totalOf.get('visits') ?? 0,
    views: totalOf.get('views') ?? 0,
    downloads: totalOf.get('downloads') ?? 0,
    daily,
    topFolders: rows(folders),
    topPhotos: rows(photos),
    since: rows<{ at: number | null }>(first)[0]?.at ?? null,
  }
}
