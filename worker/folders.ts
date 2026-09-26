/**
 * The folder tree. Nothing here knows about HTTP.
 *
 * The tree is a plain adjacency list (`parent_id`), and every question that
 * spans more than one level — the breadcrumb, a folder's recursive photo
 * count, the set of rows a delete has to take with it — is answered by a
 * recursive CTE rather than by walking the tree in JS. One round trip per
 * question keeps navigation snappy on D1, where each query is a network hop.
 */
import type { Env, FolderRow, FolderEntry } from './types'
import { ROOT, toPublicFolder } from './types'
import { HttpError } from './http'

const COLS = [
  'id',
  'parent_id',
  'name',
  'note',
  'folder_date',
  'sort_order',
  'published',
  'password_hash',
  'created_at',
  'updated_at',
]
const COLUMNS = COLS.join(', ')
const PREFIXED = COLS.map((c) => `f.${c}`).join(', ')

/** `1` lifts the published filter; `0` keeps visitors to public rows only. */
/** One batch slot's rows, whatever D1 says about the tuple shape. */
export function rowsOf<T>(slot: { results?: unknown[] } | undefined): T[] {
  return (slot?.results ?? []) as T[]
}

const flag = (admin: boolean) => (admin ? 1 : 0)
const ID_CHUNK = 80

/*
 * One pass down the subtree of every child, ranked so photos that actually
 * have a thumbnail win the cover slots. A constant because both the folder
 * listing and the batched folder view need it.
 */
/*
 * The photos a folder shows on its cover, and how many it has in total.
 *
 * The walk stops at any locked folder. Without that it would reach straight
 * through a password and put the pictures behind it on the parent's cover,
 * where anyone could see them — the count alone would say how much is in
 * there. A visitor who has already unlocked that folder loses nothing but a
 * few cover thumbnails on the parent's card, which is the cheap side of the
 * trade: SQL cannot see who holds which key, so it treats everyone as if they
 * hold none.
 */
const COVER_SQL = `WITH RECURSIVE sub(root, id) AS (
     SELECT id, id FROM folders
      WHERE parent_id = ?1 AND (?2 = 1 OR (published = 1 AND password_hash IS NULL))
     UNION ALL
     SELECT s.root, f.id FROM folders f JOIN sub s ON f.parent_id = s.id
      WHERE (?2 = 1 OR (f.published = 1 AND f.password_hash IS NULL))
   ),
   owned AS (
     SELECT s.root AS root, p.id AS pid,
            CASE WHEN p.edited_thumb_key IS NOT NULL OR p.edited_preview_key IS NOT NULL
                       OR p.edited_key IS NOT NULL OR p.thumb_key IS NOT NULL
                       OR p.preview_key IS NOT NULL THEN 1 ELSE 0 END AS has_thumb,
            CASE WHEN p.edited_thumb_key IS NOT NULL THEN 'et'
                 WHEN p.edited_preview_key IS NOT NULL THEN 'ep'
                 WHEN p.edited_key IS NOT NULL THEN 'e'
                 WHEN p.thumb_key IS NOT NULL THEN 't'
                 ELSE 'p' END AS kind,
            p.edited_key AS edited_key,
            p.sort_order AS so, p.created_at AS ca
       FROM sub s JOIN photos p ON p.folder_id = s.id
      WHERE (?2 = 1 OR p.published = 1)
   ),
   ranked AS (
     SELECT root, pid, has_thumb, kind, edited_key,
            ROW_NUMBER() OVER (PARTITION BY root ORDER BY has_thumb DESC, so DESC, ca DESC) AS rn,
            COUNT(*)     OVER (PARTITION BY root) AS total
       FROM owned
   )
   SELECT root, pid, has_thumb, kind, edited_key, total FROM ranked WHERE rn <= 5`

/**
 * The statements one folder view needs, ready to hand to `DB.batch()`.
 *
 * D1 charges a network round trip per `.all()`, and a folder view asks six
 * questions. Issuing them one at a time is what made navigation feel slow from
 * far away — batched, the whole view costs a single trip.
 */
export function listAllStmt(env: Env, admin: boolean) {
  return env.DB.prepare(
    `SELECT ${COLUMNS} FROM folders
      WHERE (?1 = 1 OR published = 1)
      ORDER BY sort_order DESC, created_at DESC`,
  ).bind(flag(admin))
}

export async function listAll(env: Env, admin: boolean): Promise<FolderRow[]> {
  const { results } = await listAllStmt(env, admin).all<FolderRow>()
  return results ?? []
}

export function pathStmt(env: Env, id: string) {
  return env.DB.prepare(
    `WITH RECURSIVE up AS (
       SELECT ${COLUMNS} FROM folders WHERE id = ?1
       UNION ALL
       SELECT ${PREFIXED} FROM folders f JOIN up ON f.id = up.parent_id
     )
     SELECT ${COLUMNS} FROM up`,
  ).bind(id)
}

export function childrenStmt(env: Env, parentId: string, admin: boolean) {
  return env.DB.prepare(
    `SELECT ${COLUMNS} FROM folders
      WHERE parent_id = ?1 AND (?2 = 1 OR published = 1)
      ORDER BY sort_order DESC, created_at DESC`,
  ).bind(parentId, flag(admin))
}

export function coversStmt(env: Env, parentId: string, admin: boolean) {
  return env.DB.prepare(COVER_SQL).bind(parentId, flag(admin))
}

export function subcountsStmt(env: Env, admin: boolean) {
  return env.DB.prepare(
    `SELECT parent_id AS parent, COUNT(*) AS n FROM folders
      WHERE (?1 = 1 OR published = 1) GROUP BY parent_id`,
  ).bind(flag(admin))
}

/** Assembles one folder listing from the rows the batch brought back. */
export interface CoverRef {
  id: string
  kind: 't' | 'p' | 'et' | 'ep' | 'e'
  version: string | null
}

export interface FolderEntryWithCoverRefs extends FolderEntry {
  /** Worker-internal; replaced by signed URLs before a response is sent. */
  coverRefs?: CoverRef[]
}

export function toEntries(
  children: FolderRow[],
  covers: CoverRow[],
  subcounts: SubcountRow[],
  admin: boolean,
  locked: ReadonlySet<string>,
): FolderEntryWithCoverRefs[] {
  const totals = new Map<string, number>()
  const shots = new Map<string, CoverRef[]>()
  for (const row of covers) {
    totals.set(row.root, row.total)
    if (row.has_thumb === 1) {
      const list = shots.get(row.root) ?? []
      list.push({
        id: row.pid,
        kind: row.kind,
        version: row.edited_key?.split('/')[2] ?? null,
      })
      shots.set(row.root, list)
    }
  }

  const subcount = new Map<string, number>()
  for (const row of subcounts) subcount.set(row.parent, row.n)

  return children.map((row) => {
    // A locked child is listed by name only: no covers, and no counts, which
    // would otherwise say how much is inside.
    if (locked.has(row.id)) {
      return { ...toPublicFolder(row, admin, true), photoCount: 0, folderCount: 0, covers: [] }
    }
    return {
      ...toPublicFolder(row, admin),
      photoCount: totals.get(row.id) ?? 0,
      folderCount: subcount.get(row.id) ?? 0,
      covers: [],
      coverRefs: shots.get(row.id) ?? [],
    }
  })
}

export interface CoverRow {
  root: string
  pid: string
  has_thumb: number
  kind: CoverRef['kind']
  edited_key: string | null
  total: number
}
export interface SubcountRow {
  parent: string
  n: number
}

export async function getById(env: Env, id: string): Promise<FolderRow | null> {
  if (id === ROOT) return null
  return env.DB.prepare(`SELECT ${COLUMNS} FROM folders WHERE id = ?`).bind(id).first<FolderRow>()
}

/** Sibling names must stay unique so the breadcrumb is never ambiguous. */
export async function nameIsTaken(
  env: Env,
  parentId: string,
  name: string,
  exceptId?: string,
): Promise<boolean> {
  const sql = exceptId
    ? 'SELECT id FROM folders WHERE parent_id = ? AND name = ? AND id != ?'
    : 'SELECT id FROM folders WHERE parent_id = ? AND name = ?'
  const stmt = exceptId
    ? env.DB.prepare(sql).bind(parentId, name, exceptId)
    : env.DB.prepare(sql).bind(parentId, name)
  return Boolean(await stmt.first<{ id: string }>())
}

/** Outermost ancestor first, ending with the folder itself. */
export async function pathOf(env: Env, id: string): Promise<FolderRow[]> {
  if (id === ROOT) return []
  const { results } = await env.DB.prepare(
    `WITH RECURSIVE up AS (
       SELECT ${COLUMNS} FROM folders WHERE id = ?1
       UNION ALL
       SELECT ${PREFIXED} FROM folders f JOIN up ON f.id = up.parent_id
     )
     SELECT ${COLUMNS} FROM up`,
  )
    .bind(id)
    .all<FolderRow>()
  return (results ?? []).reverse()
}

/** The folder itself plus every folder beneath it, at any depth. */
export async function subtreeIds(env: Env, id: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `WITH RECURSIVE sub(id) AS (
       SELECT id FROM folders WHERE id = ?1
       UNION ALL
       SELECT f.id FROM folders f JOIN sub s ON f.parent_id = s.id
     )
     SELECT id FROM sub`,
  )
    .bind(id)
    .all<{ id: string }>()
  return (results ?? []).map((r) => r.id)
}

/**
 * Direct children of `parentId`, each carrying the summary the explorer draws
 * on its card: how many photos live anywhere beneath it, how many folders sit
 * directly inside it, and up to five cover thumbnails.
 */
export async function childrenOf(
  env: Env,
  parentId: string,
  admin: boolean,
  locked: ReadonlySet<string> = new Set(),
): Promise<FolderEntry[]> {
  const batched = await env.DB.batch<never>([
    childrenStmt(env, parentId, admin),
    coversStmt(env, parentId, admin),
    subcountsStmt(env, admin),
  ])
  return toEntries(
    rowsOf<FolderRow>(batched[0]),
    rowsOf<CoverRow>(batched[1]),
    rowsOf<SubcountRow>(batched[2]),
    admin,
    locked,
  )
}

// ------------------------------------------------------------------ mutation

export interface NewFolder {
  id: string
  parentId: string
  name: string
  note: string
  date: string | null
}

export async function insert(env: Env, folder: NewFolder): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000)
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO folders (id, parent_id, name, note, folder_date, sort_order, published, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  )
    .bind(folder.id, folder.parentId, folder.name, folder.note, folder.date, now, now, now)
    .run()
  return (res.meta.changes ?? 0) === 1
}

export interface FolderPatch {
  name?: string
  note?: string
  date?: string | null
  parentId?: string
  published?: boolean
  sortOrder?: number
  /** '' clears the password; undefined leaves it alone. */
  passwordHash?: string | null
}

export async function update(env: Env, id: string, patch: FolderPatch): Promise<boolean> {
  const sets: string[] = []
  const values: unknown[] = []

  if (patch.name !== undefined) { sets.push('name = ?'); values.push(patch.name) }
  if (patch.note !== undefined) { sets.push('note = ?'); values.push(patch.note) }
  if (patch.date !== undefined) { sets.push('folder_date = ?'); values.push(patch.date) }
  if (patch.parentId !== undefined) { sets.push('parent_id = ?'); values.push(patch.parentId) }
  if (patch.published !== undefined) { sets.push('published = ?'); values.push(patch.published ? 1 : 0) }
  if (patch.sortOrder !== undefined) { sets.push('sort_order = ?'); values.push(patch.sortOrder) }
  if (patch.passwordHash !== undefined) { sets.push('password_hash = ?'); values.push(patch.passwordHash) }
  if (!sets.length) return false

  sets.push('updated_at = ?')
  values.push(Math.floor(Date.now() / 1000), id)

  const res = await env.DB.prepare(`UPDATE folders SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run()
  return (res.meta.changes ?? 0) > 0
}

/**
 * Re-parenting has to refuse a folder dropped inside its own subtree: that
 * would detach the whole branch from the root and strand every photo in it —
 * invisible, but still billed for in R2.
 */
export async function assertMoveIsLegal(env: Env, id: string, newParentId: string): Promise<void> {
  if (newParentId === ROOT) return
  if (newParentId === id) throw new HttpError(400, 'A folder cannot contain itself')
  const parent = await getById(env, newParentId)
  if (!parent) throw new HttpError(404, 'Destination folder not found')
  const inside = await subtreeIds(env, id)
  if (inside.includes(newParentId)) throw new HttpError(400, 'A folder cannot move inside itself')
}

export async function removeMany(env: Env, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK)
    const marks = chunk.map(() => '?').join(',')
    await env.DB.prepare(`DELETE FROM folders WHERE id IN (${marks})`).bind(...chunk).run()
  }
}
