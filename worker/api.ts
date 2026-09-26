/**
 * HTTP surface.
 *
 * Upload is staged rather than a single multipart POST: originals can be very
 * large (TIFF), and `request.formData()` would buffer the whole file in worker
 * memory. Instead each part is PUT as a raw stream straight into R2, and a
 * final small JSON call commits the metadata row.
 */
import type { Env, FolderRow, PhotoRow, PublicPhoto } from './types'
import { ROOT, toPublicFolder, toPublicPhoto } from './types'
import {
  json,
  error,
  HttpError,
  contentDisposition,
  inlineImageType,
  badRequest,
  readJsonObject,
} from './http'
import {
  requireSession,
  assertSameOrigin,
  createSession,
  destroySession,
  getSession,
  hashPassword,
  verifyPassword,
} from './auth'
import * as photos from './photos'
import * as folders from './folders'
import {
  holdsGrant,
  issueGrant,
  lockView,
  lockedAncestor,
  mediaHref,
  mediaPath,
  mediaToken,
  mediaTokenIsValid,
  readGrants,
  rotateSigningKey,
} from './lock'
import {
  keys,
  putOriginal,
  putDerivative,
  deleteObjects,
  serveObject,
  imageBytesMatch,
  listObjectKeys,
} from './storage'
import {
  assertWithinLimit,
  clearFailures,
  consumeLimit,
  rateLimitKey,
  recordFailure,
} from './rate-limit'
import {
  newVisitorId,
  readStats,
  recordDownload,
  recordFolderView,
  recordVisit,
  visitorCookie,
  visitorFrom,
} from './stats'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REVISION_RE = /^[A-Za-z0-9_-]{8,64}$/
const SAFE_IMAGE_RE = /^image\/(jpeg|png|webp|avif)$/
const LOGIN_LIMIT = 5
const LOGIN_GLOBAL_LIMIT = 20
const LOGIN_WINDOW_SEC = 15 * 60
const UNLOCK_LIMIT = 10
const UNLOCK_WINDOW_SEC = 10 * 60
const HIT_LIMIT = 300
const HIT_WINDOW_SEC = 60 * 60
const DERIVATIVE_MAX_BYTES = 25 * 1024 * 1024

function assertId(id: string | undefined): string {
  if (!id || !UUID_RE.test(id)) badRequest('Invalid id')
  return id.toLowerCase()
}

function assertRevision(value: unknown): string {
  if (typeof value !== 'string' || !REVISION_RE.test(value)) badRequest('Invalid edit revision')
  return value
}

function positiveDimension(value: unknown, label: string): number {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n) || n < 1 || n > 100_000) badRequest(`Invalid ${label}`)
  return n
}

function optionalDimension(value: unknown, label: string): number | null {
  if (value === undefined || value === null || value === '') return null
  return positiveDimension(value, label)
}

function finiteInteger(value: unknown, label: string): number {
  const n = Number(value)
  if (!Number.isFinite(n)) badRequest(`Invalid ${label}`)
  return Math.max(-2_147_483_648, Math.min(2_147_483_647, Math.trunc(n)))
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') badRequest(`Invalid ${label}`)
  return value
}

function declaredLength(request: Request, required = false): number | null {
  const raw = request.headers.get('content-length')
  if (!raw) {
    if (required) throw new HttpError(411, 'Content-Length is required')
    return null
  }
  if (!/^\d+$/.test(raw)) badRequest('Invalid Content-Length')
  const size = Number(raw)
  if (!Number.isSafeInteger(size)) badRequest('Invalid Content-Length')
  return size
}

/** '' is the root of the tree and is always a legal destination. */
function assertFolderId(id: unknown): string {
  if (id === undefined || id === null || id === '') return ROOT
  if (typeof id !== 'string' || !UUID_RE.test(id)) badRequest('Invalid folder id')
  return id.toLowerCase()
}

/** Keeps unicode (Korean filenames survive) but removes anything path-like. */
function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'photo'
  const cleaned = base
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '_')
    .replace(/^\.+/, '')
    .trim()
  return [...cleaned].slice(0, 200).join('') || 'photo'
}

/**
 * Header values may only carry ASCII, so the client percent-encodes the
 * filename. Decode before sanitising, and tolerate a raw ASCII name too.
 */
function decodeFilenameHeader(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

function isoDateOrNull(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) badRequest('Date must be YYYY-MM-DD')
  const [year, month, day] = v.split('-').map(Number)
  const parsed = new Date(Date.UTC(year as number, (month as number) - 1, day))
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() + 1 !== month
    || parsed.getUTCDate() !== day
  ) badRequest('Date is not valid')
  return v
}

function str(v: unknown, max: number): string {
  if (v === undefined || v === null) return ''
  if (typeof v !== 'string') badRequest('Expected a string')
  return v.slice(0, max)
}

/**
 * Folder names double as breadcrumb labels, so they are trimmed, kept to one
 * line and stripped of the separators that would make a path ambiguous.
 */
function folderName(v: unknown): string {
  const raw = str(v, 120)
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/[\\/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!raw) badRequest('Folder name is required')
  return raw.slice(0, 80)
}

const IMMUTABLE = { 'cache-control': 'public, max-age=31536000, immutable' }
/**
 * The bytes never change, so the browser may keep them forever — but nothing
 * in between may, because whether this particular reader is allowed to see
 * them depends on the cookies they sent.
 */
const PRIVATE = {
  'cache-control': 'private, max-age=31536000, immutable',
  vary: 'Cookie',
}

/**
 * May this request read the original bytes of this photo?
 *
 * The media token proves the photo was handed out in some listing, but it says
 * nothing about *who* holds it now — a signed thumbnail URL can be copied out
 * of a screenshot or a browser history. The original is the file the whole site
 * exists to protect, so it is checked the same way a download is: the photo has
 * to be published, and no locked folder may stand between the reader and it.
 */
async function mayReadOriginal(
  env: Env,
  request: Request,
  row: PhotoRow,
  admin: boolean,
): Promise<Response | null> {
  if (row.published !== 1 && !admin) return error(404, 'Not found')
  if (row.folder_id === ROOT || admin) return null
  const trail = await folders.pathOf(env, row.folder_id)
  if (await lockedAncestor(env, trail, readGrants(request), false)) {
    return error(403, 'This folder is locked')
  }
  return null
}

/**
 * Rows out to the browser, each with its signed derivative URLs. The token in
 * those URLs is what stops a bare photo id from being enough to read a locked
 * folder's pictures.
 */
function publicPhotos(env: Env, rows: PhotoRow[], admin: boolean): Promise<PublicPhoto[]> {
  return Promise.all(
    rows.map(async (row) => {
      // One token per photo, three URLs from it — a listing of a hundred photos
      // signs a hundred times rather than three hundred.
      const token = await mediaToken(env, row.id)
      const original = mediaPath('o', row.id, token)
      const originalPreview = row.preview_key ? mediaPath('p', row.id, token) : null
      const originalThumb = row.thumb_key
        ? mediaPath('t', row.id, token)
        : originalPreview ?? original
      const editVersion = row.edited_key?.split('/')[2] ?? null
      const edited = row.edited_key ? mediaPath('e', row.id, token, editVersion) : null
      const editedPreview = row.edited_preview_key ? mediaPath('ep', row.id, token, editVersion) : null
      const editedThumb = row.edited_thumb_key ? mediaPath('et', row.id, token, editVersion) : null
      return toPublicPhoto(
        row,
        admin,
        editedThumb ?? editedPreview ?? edited ?? originalThumb,
        editedPreview ?? edited ?? originalPreview,
        original,
        originalThumb,
        originalPreview,
        edited,
        editedPreview,
        editedThumb,
      )
    }),
  )
}

/** Folder covers arrive as ids; the explorer needs signed URLs. */
async function signCovers(env: Env, entries: folders.FolderEntryWithCoverRefs[]): Promise<void> {
  await Promise.all(
    entries.map(async (entry) => {
      entry.covers = await Promise.all(
        (entry.coverRefs ?? []).map((cover) =>
          mediaHref(env, cover.kind, cover.id, cover.version),
        ),
      )
      delete entry.coverRefs
    }),
  )
}

/** A share password only has to be hard to guess by hand, not by a cluster. */
function sharePassword(v: unknown): string {
  const value = typeof v === 'string' ? v : ''
  if (value.length < 4) badRequest('Password must be at least 4 characters')
  if (value.length > 200) badRequest('Password is too long')
  return value
}

/** A dummy hash so a missing username costs the same time as a wrong password. */
const DUMMY_HASH =
  'pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

export async function handleApi(
  request: Request,
  env: Env,
  url: URL,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const path = url.pathname
  const method = request.method.toUpperCase()
  const secure = url.protocol === 'https:'

  // ---------------------------------------------------------------- public

  // The whole tree, flat. It is what the sidebar, the breadcrumb and the move
  // dialog all read from, and it is small enough that shipping it once beats
  // a request per expanded node.
  if (path === '/api/tree' && method === 'GET') {
    const admin = Boolean(await getSession(env, request))
    const rows = await folders.listAll(env, admin)
    const view = await lockView(env, rows, readGrants(request), admin)
    return json({
      // A locked folder is still listed — you can see the door. What is behind
      // it is not, so its whole subtree is dropped from the tree.
      folders: rows
        .filter((r) => !view.blocked.has(r.id))
        .map((r) => toPublicFolder(r, admin, view.locked.has(r.id))),
      admin,
      siteTitle: env.SITE_TITLE,
    })
  }

  /*
   * Everything one folder view needs, in a single round trip.
   *
   * Every D1 statement is a network hop, and this view asks six questions. Run
   * one after another they stacked up to roughly half a second of dead time
   * before a folder appeared; sent together as one batch, the whole view costs
   * one hop. The path doubles as the lookup for the folder itself — its last
   * row is the folder — so there is no separate SELECT for it either.
   */
  if (path === '/api/browse' && method === 'GET') {
    const admin = Boolean(await getSession(env, request))
    const grants = readGrants(request)
    const folderId = assertFolderId(url.searchParams.get('folder') ?? '')

    const batched = await env.DB.batch<never>([
      folders.pathStmt(env, folderId === ROOT ? '\u0000' : folderId),
      folders.listAllStmt(env, admin),
      folders.childrenStmt(env, folderId, admin),
      folders.coversStmt(env, folderId, admin),
      folders.subcountsStmt(env, admin),
      photos.inFolderStmt(env, folderId, admin),
    ])

    const trail = folders.rowsOf<FolderRow>(batched[0]).reverse()
    const allFolders = folders.rowsOf<FolderRow>(batched[1])

    const folder = folderId === ROOT ? null : (trail[trail.length - 1] ?? null)
    // A visitor may not reach a hidden folder, nor anything under one.
    if (folderId !== ROOT && (!folder || (!admin && trail.some((f) => f.published !== 1)))) {
      return error(404, 'Folder not found')
    }

    const barrier = await lockedAncestor(env, trail, grants, admin)

    // Somewhere at or above this folder is a door that has not been opened.
    // Answer with the door, and nothing that is behind it — not the contents,
    // not the deeper part of the path, not even whether this folder exists.
    if (barrier) {
      const visible = trail.slice(0, trail.findIndex((f) => f.id === barrier.id) + 1)
      return json({
        folder: toPublicFolder(barrier, admin, true),
        path: visible.map((r) => toPublicFolder(r, admin, r.id === barrier.id)),
        folders: [],
        photos: [],
        admin,
        lock: { id: barrier.id, name: barrier.name },
      })
    }

    const view = await lockView(env, allFolders, grants, admin)
    const children = folders.toEntries(
      folders.rowsOf<FolderRow>(batched[2]),
      folders.rowsOf<folders.CoverRow>(batched[3]),
      folders.rowsOf<folders.SubcountRow>(batched[4]),
      admin,
      view.locked,
    )
    await signCovers(env, children)

    return json({
      folder: folder ? toPublicFolder(folder, admin) : null,
      path: trail.map((r) => toPublicFolder(r, admin)),
      folders: children.filter((c) => !view.blocked.has(c.id)),
      photos: await publicPhotos(env, folders.rowsOf<PhotoRow>(batched[5]), admin),
      admin,
      lock: null,
    })
  }

  if (path === '/api/search' && method === 'GET') {
    const admin = Boolean(await getSession(env, request))
    const q = (url.searchParams.get('q') ?? '').trim().slice(0, 80)
    if (q.length < 1) return json({ query: '', folders: [], photos: [] })

    const [allFolders, found] = await Promise.all([
      folders.listAll(env, admin),
      photos.search(env, q, admin),
    ])
    const view = await lockView(env, allFolders, readGrants(request), admin)
    const needle = q.toLowerCase()

    // Search must not become the way around a lock: a photo inside a folder
    // that has not been opened is simply not a result.
    const shut = (folderId: string) => view.blocked.has(folderId) || view.locked.has(folderId)

    return json({
      query: q,
      folders: allFolders
        .filter((f) => !view.blocked.has(f.id) && f.name.toLowerCase().includes(needle))
        .slice(0, 60)
        .map((f) => toPublicFolder(f, admin, view.locked.has(f.id))),
      photos: await publicPhotos(
        env,
        found.filter((r) => r.folder_id === ROOT || !shut(r.folder_id)),
        admin,
      ),
    })
  }

  // Optimised derivatives for browsing. Keyed by photo id, and the bytes for a
  // given id never change, so they can cache forever.
  const media = /^\/media\/(et|ep|e|t|p|o)\/([0-9a-f-]+)$/i.exec(path)
  if (media && method === 'GET') {
    const id = assertId(media[2])
    // The token is the capability. Without it this route would hand out the
    // pictures inside a locked folder to anyone who learned a photo id.
    const token = url.searchParams.get('t')
    const signed = await mediaTokenIsValid(env, id, token)
    if (!signed) {
      if (!(await getSession(env, request))) return error(403, 'This image link has expired')
    }
    /*
     * Only a URL that carried its own token may be cached by anything other
     * than the browser that asked for it. The owner's session opens these
     * routes without a token, and a shared cache that stored one of those
     * responses would go on handing it to visitors who have no token at all.
     */
    const shareable = signed ? IMMUTABLE : PRIVATE

    /*
     * 'o' is the original, shown inline in the viewer so that what a client
     * looks at is the actual file rather than a re-encoded copy of it.
     *
     * It is deliberately NOT the download route. Nothing is counted here — a
     * download is somebody deciding to keep the file, not the viewer painting
     * it — and the disposition is inline so the browser renders it instead of
     * offering to save it. The bytes are identical either way; the original is
     * never re-encoded on any path.
     */
    if (media[1] === 'o' || media[1] === 'e') {
      const row = await photos.getById(env, id)
      if (!row) return error(404, 'Not found')
      const refusal = await mayReadOriginal(env, request, row, Boolean(await getSession(env, request)))
      if (refusal) return refusal

      // Who may read this depends on the grant cookie, so the answer is never
      // shareable however it was asked for.
      const edited = media[1] === 'e'
      const key = edited ? row.edited_key : row.original_key
      const filename = edited ? row.edited_filename : row.original_filename
      const storedType = edited ? row.edited_type : row.original_type
      if (!key || !filename) return error(404, edited ? 'Edited file not found' : 'Not found')
      if (edited && signed && url.searchParams.get('v') !== key.split('/')[2]) {
        return error(404, 'This edited image link is no longer current')
      }
      const type = inlineImageType(filename, storedType ?? '')
      // Inline is only ever offered for something that is actually a picture.
      // Anything else is handed over as a file, so this route can never be
      // talked into rendering arbitrary content on the gallery's own origin.
      const showable = type.startsWith('image/')
      const res = await serveObject(env, key, request, {
        ...PRIVATE,
        'content-disposition': contentDisposition(
          filename,
          showable ? 'inline' : 'attachment',
        ),
        'content-type': type,
        'x-content-type-options': 'nosniff',
      })
      return res ?? error(404, 'Not found')
    }

    let key: string | null = null
    if (media[1] === 't') key = keys.thumb(id)
    else if (media[1] === 'p') key = keys.preview(id)
    else {
      const row = await photos.getById(env, id)
      if (!row) return error(404, 'Not found')
      key = media[1] === 'et' ? row.edited_thumb_key : row.edited_preview_key
      const version = row.edited_key?.split('/')[2] ?? null
      if (signed && url.searchParams.get('v') !== version) {
        return error(404, 'This edited image link is no longer current')
      }
    }
    if (!key) return error(404, 'Not found')
    const res = await serveObject(env, key, request, shareable)
    return res ?? error(404, 'Not found')
  }

  // The whole point of the site: hand back the untouched original, under the
  // name it was uploaded with. A rename in the explorer changes the label the
  // gallery shows, never the bytes or the filename that lands on disk.
  const dl = /^\/download\/([0-9a-f-]+)(?:\/(original|edited))?$/i.exec(path)
  if (dl && method === 'GET') {
    const id = assertId(dl[1])
    const row = await photos.getById(env, id)
    if (!row) return error(404, 'Not found')
    const admin = Boolean(await getSession(env, request))
    const refusal = await mayReadOriginal(env, request, row, admin)
    if (refusal) return refusal
    const edited = dl[2] === 'edited'
    const key = edited ? row.edited_key : row.original_key
    const filename = edited ? row.edited_filename : row.original_filename
    const type = edited ? row.edited_type : row.original_type
    if (!key || !filename) return error(404, edited ? 'Edited file not found' : 'Original file not found')
    const res = await serveObject(env, key, request, {
      'content-disposition': contentDisposition(filename),
      'content-type': type || 'application/octet-stream',
      'cache-control': 'private, max-age=0, must-revalidate',
      'x-content-type-options': 'nosniff',
    })
    if (!res) return error(404, edited ? 'Edited file is missing from storage' : 'Original file is missing from storage')
    // Only a fresh start counts — a resumed range is the same download coming
    // back for more of itself.
    if (!admin && res.status === 200) ctx.waitUntil(recordDownload(env, id))
    return res
  }

  /*
   * The counter beacon.
   *
   * Counting is done here rather than inside /api/browse because that route is
   * also what a hover prefetches — counting there would score a folder every
   * time the pointer crossed it. The explorer calls this only once a view has
   * actually been drawn.
   *
   * The owner's own traffic is not counted: a signed-in session is skipped.
   */
  if (path === '/api/hit' && method === 'POST') {
    assertSameOrigin(request)
    const body = await readJsonObject(request, 4 * 1024)

    if (await getSession(env, request)) return json({ ok: true })
    await consumeLimit(env, await rateLimitKey(request, 'hit'), HIT_LIMIT, HIT_WINDOW_SEC)

    let visitor = visitorFrom(request)
    const headers: Record<string, string> = {}
    if (!visitor) {
      visitor = newVisitorId()
      headers['set-cookie'] = visitorCookie(visitor, secure)
    }

    if (body.visit === true) ctx.waitUntil(recordVisit(env, visitor))
    if (typeof body.folder === 'string') {
      const folderId = assertFolderId(body.folder)
      if (folderId === ROOT) {
        ctx.waitUntil(recordFolderView(env, folderId))
      } else {
        const trail = await folders.pathOf(env, folderId)
        const folder = trail[trail.length - 1]
        if (
          folder?.id === folderId
          && trail.every((row) => row.published === 1)
          && !(await lockedAncestor(env, trail, readGrants(request), false))
        ) ctx.waitUntil(recordFolderView(env, folderId))
      }
    }
    return json({ ok: true }, { headers })
  }

  // Opening a locked folder. Each address/folder pair gets a fixed-window
  // attempt budget before another expensive PBKDF2 check is allowed.
  if (path === '/api/unlock' && method === 'POST') {
    assertSameOrigin(request)
    const b = await readJsonObject(request, 4 * 1024)
    const folderId = assertFolderId(b.folderId)
    const folder = await folders.getById(env, folderId)
    if (!folder || folder.published !== 1) return error(404, 'Folder not found')
    if (!folder.password_hash) return json({ ok: true })

    const password = typeof b.password === 'string' ? b.password.slice(0, 512) : ''
    const limitKey = await rateLimitKey(request, 'unlock', folderId)
    await assertWithinLimit(env, limitKey, UNLOCK_LIMIT)
    if (!(await verifyPassword(password, folder.password_hash))) {
      await recordFailure(env, limitKey, UNLOCK_LIMIT, UNLOCK_WINDOW_SEC)
      return error(401, 'Incorrect password')
    }
    await clearFailures(env, limitKey)
    const cookie = await issueGrant(env, folder, readGrants(request), secure)
    return json({ ok: true }, { headers: { 'set-cookie': cookie } })
  }

  // Which of the folders on screen this browser has already opened, so the
  // explorer can draw an open padlock without asking again.
  if (path === '/api/unlocked' && method === 'GET') {
    const grants = readGrants(request)
    const rows = await folders.listAll(env, false)
    const open: string[] = []
    for (const row of rows) {
      if (row.password_hash && (await holdsGrant(env, row, grants))) open.push(row.id)
    }
    return json({ folders: open })
  }

  // ----------------------------------------------------------------- admin

  if (!path.startsWith('/api/admin/')) {
    if (path.startsWith('/api/') || path.startsWith('/media/') || path.startsWith('/download/')) {
      return error(404, 'Unknown endpoint')
    }
    return null
  }
  assertSameOrigin(request)

  // First-run bootstrap. Permitted only while no administrator exists, and —
  // in production, where SETUP_KEY is set — only with that key, so a stranger
  // cannot claim the admin account between deploy and first sign-in.
  if (path === '/api/admin/setup') {
    const existing = await env.DB.prepare('SELECT COUNT(*) AS n FROM admins').first<{ n: number }>()
    const isEmpty = (existing?.n ?? 0) === 0
    const setupAllowed = !secure || Boolean(env.SETUP_KEY)
    if (method === 'GET') {
      return json({ needsSetup: isEmpty, requiresKey: Boolean(env.SETUP_KEY), setupAllowed })
    }
    if (method === 'POST') {
      if (!isEmpty) return error(403, 'An administrator already exists')
      if (!setupAllowed) {
        return error(503, 'Administrator setup is disabled until SETUP_KEY is configured')
      }
      const limitKey = await rateLimitKey(request, 'setup')
      await assertWithinLimit(env, limitKey, LOGIN_LIMIT)
      if (env.SETUP_KEY) {
        const provided = request.headers.get('x-setup-key') ?? ''
        const enc = new TextEncoder()
        const a = await crypto.subtle.digest('SHA-256', enc.encode(provided))
        const b = await crypto.subtle.digest('SHA-256', enc.encode(env.SETUP_KEY))
        if (!new Uint8Array(a).every((v, i) => v === new Uint8Array(b)[i])) {
          await recordFailure(env, limitKey, LOGIN_LIMIT, LOGIN_WINDOW_SEC)
          return error(403, 'Invalid setup key')
        }
      }
      const body = await readJsonObject(request, 4 * 1024)
      const username = str(body.username, 64).trim()
      const password = typeof body.password === 'string' ? body.password : ''
      if (username.length < 3) return error(400, 'Username must be at least 3 characters')
      if (password.length < 10) return error(400, 'Password must be at least 10 characters')
      if (password.length > 512) return error(400, 'Password is too long')
      const now = Math.floor(Date.now() / 1000)
      const created = await env.DB.prepare(
        `INSERT INTO admins (username, password_hash, created_at)
         SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM admins)`,
      ).bind(username, await hashPassword(password), now).run()
      if ((created.meta.changes ?? 0) !== 1) {
        return error(409, 'An administrator was created by another request')
      }
      await clearFailures(env, limitKey)
      return json({ ok: true })
    }
  }

  if (path === '/api/admin/login' && method === 'POST') {
    const body = await readJsonObject(request, 4 * 1024)
    const username = str(body.username, 64).trim()
    const password = typeof body.password === 'string' ? body.password.slice(0, 512) : ''
    const limitKey = await rateLimitKey(request, 'login', username)
    const globalLimitKey = await rateLimitKey(request, 'login-global')
    await assertWithinLimit(env, limitKey, LOGIN_LIMIT)
    await assertWithinLimit(env, globalLimitKey, LOGIN_GLOBAL_LIMIT)
    const admin = await env.DB.prepare('SELECT id, password_hash FROM admins WHERE username = ?')
      .bind(username)
      .first<{ id: number; password_hash: string }>()

    const ok = await verifyPassword(password, admin?.password_hash ?? DUMMY_HASH)
    if (!admin || !ok) {
      await Promise.all([
        recordFailure(env, limitKey, LOGIN_LIMIT, LOGIN_WINDOW_SEC),
        recordFailure(env, globalLimitKey, LOGIN_GLOBAL_LIMIT, LOGIN_WINDOW_SEC),
      ])
      return error(401, 'Incorrect username or password')
    }

    await Promise.all([
      clearFailures(env, limitKey),
      clearFailures(env, globalLimitKey),
    ])
    const cookie = await createSession(env, admin.id, secure)
    return json({ ok: true, username }, { headers: { 'set-cookie': cookie } })
  }

  if (path === '/api/admin/logout' && method === 'POST') {
    const cookie = await destroySession(env, request, secure)
    return json({ ok: true }, { headers: { 'set-cookie': cookie } })
  }

  if (path === '/api/admin/session' && method === 'GET') {
    const session = await getSession(env, request)
    return json({ authenticated: Boolean(session), username: session?.username ?? null })
  }

  // Everything past this point requires a live session.
  await requireSession(env, request)

  if (path === '/api/admin/stats' && method === 'GET') {
    return json(await readStats(env))
  }

  // --------------------------------------------------------------- folders

  if (path === '/api/admin/folders' && method === 'POST') {
    const b = await readJsonObject(request)
    const parentId = assertFolderId(b.parentId)
    if (parentId !== ROOT && !(await folders.getById(env, parentId))) {
      return error(404, 'Parent folder not found')
    }
    const name = folderName(b.name)
    if (await folders.nameIsTaken(env, parentId, name)) {
      return error(409, 'A folder with that name already exists here')
    }
    const id = crypto.randomUUID()
    const inserted = await folders.insert(env, {
      id,
      parentId,
      name,
      note: str(b.note, 2000),
      date: isoDateOrNull(b.date),
    })
    if (!inserted) return error(409, 'A folder with that name already exists here')
    if (b.password !== undefined && b.password !== null && b.password !== '') {
      await folders.update(env, id, { passwordHash: await hashPassword(sharePassword(b.password)) })
      await rotateSigningKey(env)
    }
    const row = await folders.getById(env, id)
    return json({ ok: true, folder: row ? toPublicFolder(row, true) : null }, { status: 201 })
  }

  const folderPath = /^\/api\/admin\/folders\/([0-9a-f-]+)$/i.exec(path)

  if (folderPath && method === 'PATCH') {
    const id = assertId(folderPath[1])
    const current = await folders.getById(env, id)
    if (!current) return error(404, 'Folder not found')

    const b = await readJsonObject(request)
    const patch: folders.FolderPatch = {}

    if (b.parentId !== undefined) {
      const parentId = assertFolderId(b.parentId)
      await folders.assertMoveIsLegal(env, id, parentId)
      patch.parentId = parentId
    }
    if (b.name !== undefined) patch.name = folderName(b.name)
    if (b.note !== undefined) patch.note = str(b.note, 2000)
    if (b.date !== undefined) patch.date = isoDateOrNull(b.date)
    if (b.published !== undefined) patch.published = booleanValue(b.published, 'published value')
    if (b.sortOrder !== undefined) patch.sortOrder = finiteInteger(b.sortOrder, 'sort order')
    // null clears the lock; a string sets a new one. Either way every grant
    // already handed out for this folder stops verifying, because the grant is
    // signed over the hash that is about to change.
    if (b.password !== undefined) {
      patch.passwordHash =
        b.password === null || b.password === ''
          ? null
          : await hashPassword(sharePassword(b.password))
    }

    // Uniqueness is per parent, so a rename and a move have to be checked
    // against wherever the folder is going to end up, not where it is now.
    const destParent = patch.parentId ?? current.parent_id
    const destName = patch.name ?? current.name
    if (await folders.nameIsTaken(env, destParent, destName, id)) {
      return error(409, 'A folder with that name already exists there')
    }

    await folders.update(env, id, patch)
    // A lock that changes has to take the image links issued under the old one
    // with it.
    if (
      patch.passwordHash !== undefined
      || patch.parentId !== undefined
      || patch.published !== undefined
    ) await rotateSigningKey(env)
    const row = await folders.getById(env, id)
    return json({ ok: true, folder: row ? toPublicFolder(row, true) : null })
  }

  if (folderPath && method === 'DELETE') {
    const id = assertId(folderPath[1])
    if (!(await folders.getById(env, id))) return error(404, 'Folder not found')

    // Depth first in effect: collect the whole subtree, drop its photos and
    // their R2 objects, and only then remove the folder rows. Doing it in this
    // order means a failure halfway through leaves rows that are still
    // reachable in the explorer rather than orphaned bytes nobody can see.
    const ids = await folders.subtreeIds(env, id)
    const doomed = await photos.listInFolders(env, ids)

    for (const row of doomed) {
      const [listed, edited] = await Promise.all([
        listObjectKeys(env, `originals/${row.id}/`),
        listObjectKeys(env, `edited/${row.id}/`),
      ])
      await deleteObjects(env, [
        ...listed,
        ...edited,
        row.original_key,
        keys.preview(row.id),
        keys.thumb(row.id),
        row.edited_key,
        row.edited_preview_key,
        row.edited_thumb_key,
      ])
    }
    await photos.removeMany(env, doomed.map((r) => r.id))
    await folders.removeMany(env, ids)

    return json({ ok: true, deletedFolders: ids.length, deletedPhotos: doomed.length })
  }

  // ---------------------------------------------------------------- photos

  // A rendered edit is versioned as one full image plus two browsing sizes.
  // The revision is deliberately server-validated and only used below this
  // photo's prefix, so a client can never choose an arbitrary R2 key.
  const editedPart = /^\/api\/admin\/photos\/([0-9a-f-]+)\/edited\/([A-Za-z0-9_-]+)\/(full|preview|thumb)$/i.exec(path)
  if (editedPart && method === 'PUT') {
    const id = assertId(editedPart[1])
    const revision = assertRevision(editedPart[2])
    const kind = editedPart[3] as 'full' | 'preview' | 'thumb'
    if (!(await photos.getById(env, id))) return error(404, 'Photo not found')
    if (!request.body) return error(400, 'Empty body')

    const declared = declaredLength(request)
    const max = Number(env.MAX_UPLOAD_BYTES || '104857600')
    const partMax = kind === 'full' ? max : Math.min(max, DERIVATIVE_MAX_BYTES)
    if (declared !== null && declared > partMax) {
      return error(413, `File exceeds the ${Math.round(partMax / 1048576)} MB limit`)
    }
    const type = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
    if (!SAFE_IMAGE_RE.test(type)) return error(415, 'Edited files must be JPEG, PNG, WebP, or AVIF')
    const buf = await request.arrayBuffer()
    if (!buf.byteLength) return error(400, 'Empty body')
    if (buf.byteLength > partMax) {
      return error(413, `File exceeds the ${Math.round(partMax / 1048576)} MB limit`)
    }
    if (!imageBytesMatch(buf, type)) return error(415, 'The file bytes do not match its image type')
    const key = kind === 'full'
      ? keys.edited(id, revision)
      : kind === 'preview'
        ? keys.editedPreview(id, revision)
        : keys.editedThumb(id, revision)
    await putDerivative(env, key, buf, type)
    return json({ ok: true, key })
  }

  const stagedEdit = /^\/api\/admin\/photos\/([0-9a-f-]+)\/edited\/([A-Za-z0-9_-]+)$/i.exec(path)
  if (stagedEdit && method === 'DELETE') {
    const id = assertId(stagedEdit[1])
    const revision = assertRevision(stagedEdit[2])
    const current = await photos.getById(env, id)
    if (!current) return error(404, 'Photo not found')
    const prefix = `edited/${id}/${revision}/`
    if (current.edited_key?.startsWith(prefix)) {
      return error(409, 'The published edited version cannot be removed as staging data')
    }
    await deleteObjects(env, await listObjectKeys(env, prefix))
    return json({ ok: true })
  }

  const editedPhoto = /^\/api\/admin\/photos\/([0-9a-f-]+)\/edited$/i.exec(path)
  if (editedPhoto && method === 'POST') {
    const id = assertId(editedPhoto[1])
    const current = await photos.getById(env, id)
    if (!current) return error(404, 'Photo not found')
    const body = await readJsonObject(request)
    const revision = assertRevision(body.revision)
    const fullKey = keys.edited(id, revision)
    const previewKey = keys.editedPreview(id, revision)
    const thumbKey = keys.editedThumb(id, revision)
    const [full, preview, thumb] = await Promise.all([
      env.MEDIA.head(fullKey),
      env.MEDIA.head(previewKey),
      env.MEDIA.head(thumbKey),
    ])
    if (!full || !preview || !thumb) return error(409, 'The edited image is not fully uploaded yet')
    const type = (full.httpMetadata?.contentType ?? '').toLowerCase()
    if (!SAFE_IMAGE_RE.test(type)) return error(415, 'The edited image has an unsupported type')
    for (const part of [preview, thumb]) {
      const partType = (part.httpMetadata?.contentType ?? '').toLowerCase()
      if (!SAFE_IMAGE_RE.test(partType) || part.size < 1 || part.size > DERIVATIVE_MAX_BYTES) {
        return error(415, 'An edited preview has invalid metadata')
      }
    }
    if (full.size < 1) return error(409, 'The edited image is empty')

    const filename = safeFilename(str(body.filename, 200) || `edited-${id}.jpg`)
    const updated = await photos.setEdited(env, id, {
      key: fullKey,
      previewKey,
      thumbKey,
      filename,
      type,
      size: full.size,
      width: positiveDimension(body.width, 'width'),
      height: positiveDimension(body.height, 'height'),
    })
    if (!updated) return error(404, 'Photo not found')

    // Delete the previous immutable version only after the row points at the
    // complete replacement. Readers therefore see either whole version.
    ctx.waitUntil(deleteObjects(env, [
      current.edited_key !== fullKey ? current.edited_key : null,
      current.edited_preview_key !== previewKey ? current.edited_preview_key : null,
      current.edited_thumb_key !== thumbKey ? current.edited_thumb_key : null,
    ]).catch((error) => console.error('Could not remove the previous edited version:', error)))
    const row = await photos.getById(env, id)
    const [photo] = await publicPhotos(env, row ? [row] : [], true)
    return json({ ok: true, photo })
  }

  if (editedPhoto && method === 'DELETE') {
    const id = assertId(editedPhoto[1])
    const current = await photos.getById(env, id)
    if (!current) return error(404, 'Photo not found')
    await photos.clearEdited(env, id)
    const listed = await listObjectKeys(env, `edited/${id}/`)
    await deleteObjects(env, [
      ...listed,
      current.edited_key,
      current.edited_preview_key,
      current.edited_thumb_key,
    ])
    return json({ ok: true })
  }

  // Stage 1-3: stream each part straight into R2.
  const part = /^\/api\/admin\/photos\/([0-9a-f-]+)\/(original|preview|thumb)$/i.exec(path)
  if (part && method === 'PUT') {
    const id = assertId(part[1])
    const kind = part[2] as 'original' | 'preview' | 'thumb'
    if (!request.body) return error(400, 'Empty body')
    if (await photos.getById(env, id)) {
      return error(409, 'An existing photo cannot be overwritten through the upload staging route')
    }

    const max = Number(env.MAX_UPLOAD_BYTES || '104857600')

    if (kind === 'original') {
      const declared = declaredLength(request, true) as number
      if (declared < 1) return error(400, 'Empty body')
      if (declared > max) return error(413, `File exceeds the ${Math.round(max / 1048576)} MB limit`)
      const filename = safeFilename(decodeFilenameHeader(request.headers.get('x-filename') ?? 'photo'))
      const type = (request.headers.get('content-type') || 'application/octet-stream')
        .split(';')[0]!.trim().toLowerCase().slice(0, 120)
      await deleteObjects(env, await listObjectKeys(env, `originals/${id}/`))
      const key = await putOriginal(env, id, filename, request.body, type)
      return json({ ok: true, key, filename })
    }

    // Honour the sent type: browsers without WebP encoding (older Safari) send
    // JPEG derivatives instead, and mislabelling them breaks caching and sniffing.
    const sent = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase()
    const type = sent && /^image\/(webp|jpeg|png|avif)$/.test(sent) ? sent : 'image/webp'
    const buf = await request.arrayBuffer()
    if (!buf.byteLength) return error(400, 'Empty body')
    const derivativeMax = Math.min(max, DERIVATIVE_MAX_BYTES)
    if (buf.byteLength > derivativeMax) {
      return error(413, `File exceeds the ${Math.round(derivativeMax / 1048576)} MB limit`)
    }
    if (!imageBytesMatch(buf, type)) return error(415, 'The file bytes do not match its image type')
    await putDerivative(env, kind === 'preview' ? keys.preview(id) : keys.thumb(id), buf, type)
    return json({ ok: true })
  }

  // Stage 4: commit the metadata row. The original's key, size and type come
  // from what actually landed in R2 — never re-derived from client input, so
  // the download key can never drift from the stored object. This also refuses
  // to commit metadata for an original that was never uploaded.
  const single = /^\/api\/admin\/photos\/([0-9a-f-]+)$/i.exec(path)
  if (single && method === 'POST') {
    const id = assertId(single[1])
    if (await photos.getById(env, id)) return error(409, 'Photo already exists')

    const b = await readJsonObject(request)
    const folderId = assertFolderId(b.folderId)
    if (folderId !== ROOT && !(await folders.getById(env, folderId))) {
      return error(404, 'Destination folder not found')
    }

    const listed = await env.MEDIA.list({
      prefix: `originals/${id}/`,
      limit: 2,
      include: ['httpMetadata'],
    })
    const original = listed.objects[0]
    if (!original) return error(409, 'The original file has not been uploaded yet')

    const hasPreview = b.hasPreview === true
    const hasThumb = b.hasThumb === true
    const [preview, thumb] = await Promise.all([
      hasPreview ? env.MEDIA.head(keys.preview(id)) : null,
      hasThumb ? env.MEDIA.head(keys.thumb(id)) : null,
    ])
    if (hasPreview && !preview) return error(409, 'The preview has not been uploaded yet')
    if (hasThumb && !thumb) return error(409, 'The thumbnail has not been uploaded yet')
    for (const derivative of [preview, thumb]) {
      if (!derivative) continue
      const type = (derivative.httpMetadata?.contentType ?? '').toLowerCase()
      if (!SAFE_IMAGE_RE.test(type) || derivative.size < 1 || derivative.size > DERIVATIVE_MAX_BYTES) {
        return error(415, 'A gallery preview has invalid metadata')
      }
    }

    await photos.insert(env, {
      id,
      folderId,
      title: str(b.title, 200),
      takenOn: isoDateOrNull(b.date),
      location: str(b.location, 120),
      description: str(b.description, 4000),
      originalKey: original.key,
      originalFilename: original.key.slice(`originals/${id}/`.length) || 'photo',
      originalType:
        original.httpMetadata?.contentType || str(b.type, 120) || 'application/octet-stream',
      originalSize: original.size,
      previewKey: hasPreview ? keys.preview(id) : null,
      thumbKey: hasThumb ? keys.thumb(id) : null,
      width: optionalDimension(b.width, 'width'),
      height: optionalDimension(b.height, 'height'),
      placeholder: str(b.placeholder, 4000) || null,
    })
    return json({ ok: true, id }, { status: 201 })
  }

  if (single && method === 'PATCH') {
    const id = assertId(single[1])
    const b = await readJsonObject(request)
    const patch: photos.PhotoPatch = {}
    if (b.folderId !== undefined) {
      const folderId = assertFolderId(b.folderId)
      if (folderId !== ROOT && !(await folders.getById(env, folderId))) {
        return error(404, 'Destination folder not found')
      }
      patch.folderId = folderId
    }
    if (b.title !== undefined) patch.title = str(b.title, 200)
    if (b.description !== undefined) patch.description = str(b.description, 4000)
    if (b.date !== undefined) patch.takenOn = isoDateOrNull(b.date)
    if (b.location !== undefined) patch.location = str(b.location, 120)
    if (b.published !== undefined) patch.published = booleanValue(b.published, 'published value')
    if (b.sortOrder !== undefined) patch.sortOrder = finiteInteger(b.sortOrder, 'sort order')

    if (!Object.keys(patch).length) return error(400, 'No changes were supplied')
    const ok = await photos.update(env, id, patch)
    if (!ok) return error(404, 'Photo not found')
    if (patch.folderId !== undefined || patch.published !== undefined) await rotateSigningKey(env)
    const row = await photos.getById(env, id)
    const [updated] = await publicPhotos(env, row ? [row] : [], true)
    return json({ ok: true, photo: updated ?? null })
  }

  if (single && method === 'DELETE') {
    const id = assertId(single[1])
    const row = await photos.getById(env, id)
    // List rather than trust the row: this also purges the orphaned objects of
    // an upload that failed before its metadata was committed.
    const [listed, edited] = await Promise.all([
      listObjectKeys(env, `originals/${id}/`),
      listObjectKeys(env, `edited/${id}/`),
    ])
    await deleteObjects(env, [
      ...listed,
      ...edited,
      row?.original_key ?? null,
      keys.preview(id),
      keys.thumb(id),
      row?.edited_key ?? null,
      row?.edited_preview_key ?? null,
      row?.edited_thumb_key ?? null,
    ])
    if (row) await photos.remove(env, id)
    return json({ ok: true })
  }

  return error(404, 'Unknown endpoint')
}

export function toErrorResponse(err: unknown): Response {
  if (err instanceof HttpError) return error(err.status, err.message, err.headers)
  console.error('Unhandled error:', err)
  return error(500, 'Internal error')
}
