/** Photo metadata queries. Nothing here knows about HTTP. */
import type { Env, PhotoRow } from './types'

const COLUMNS = `id, folder_id, title, taken_on, location, description, original_key,
                 original_filename, original_type, original_size, preview_key, thumb_key,
                 edited_key, edited_preview_key, edited_thumb_key, edited_filename,
                 edited_type, edited_size, edited_width, edited_height, edited_updated_at,
                 width, height, placeholder, sort_order, published, created_at, updated_at`

const flag = (admin: boolean) => (admin ? 1 : 0)
// Stay below D1/SQLite's bound-parameter ceiling even for very large trees.
const ID_CHUNK = 80

/** Prepared, not run — the folder view sends it with the rest in one batch. */
export function inFolderStmt(env: Env, folderId: string, admin: boolean) {
  return env.DB.prepare(
    `SELECT ${COLUMNS} FROM photos
      WHERE folder_id = ?1 AND (?2 = 1 OR published = 1)
      ORDER BY sort_order DESC, created_at DESC`,
  ).bind(folderId, flag(admin))
}

export async function listInFolder(
  env: Env,
  folderId: string,
  admin: boolean,
): Promise<PhotoRow[]> {
  const { results } = await inFolderStmt(env, folderId, admin).all<PhotoRow>()
  return results ?? []
}

export async function getById(env: Env, id: string): Promise<PhotoRow | null> {
  return env.DB.prepare(`SELECT ${COLUMNS} FROM photos WHERE id = ?`).bind(id).first<PhotoRow>()
}

/** Filename and title, case-insensitively. Bounded so a broad query stays cheap. */
export async function search(env: Env, query: string, admin: boolean): Promise<PhotoRow[]> {
  const like = `%${query.replace(/[\\%_]/g, (m) => `\\${m}`)}%`
  const { results } = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM photos
      WHERE (?2 = 1 OR published = 1)
        AND (original_filename LIKE ?1 ESCAPE '\\' OR title LIKE ?1 ESCAPE '\\')
      ORDER BY created_at DESC
      LIMIT 200`,
  )
    .bind(like, flag(admin))
    .all<PhotoRow>()
  return results ?? []
}

/** Every photo inside the given folders — the delete path needs their R2 keys. */
export async function listInFolders(env: Env, folderIds: string[]): Promise<PhotoRow[]> {
  if (!folderIds.length) return []
  const rows: PhotoRow[] = []
  for (let i = 0; i < folderIds.length; i += ID_CHUNK) {
    const chunk = folderIds.slice(i, i + ID_CHUNK)
    const marks = chunk.map(() => '?').join(',')
    const { results } = await env.DB.prepare(
      `SELECT ${COLUMNS} FROM photos WHERE folder_id IN (${marks})`,
    )
      .bind(...chunk)
      .all<PhotoRow>()
    rows.push(...(results ?? []))
  }
  return rows
}

export interface NewPhoto {
  id: string
  folderId: string
  title: string
  takenOn: string | null
  location: string
  description: string
  originalKey: string
  originalFilename: string
  originalType: string
  originalSize: number
  previewKey: string | null
  thumbKey: string | null
  width: number | null
  height: number | null
  placeholder: string | null
}

export async function insert(env: Env, p: NewPhoto): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO photos
       (id, folder_id, title, taken_on, location, description, original_key, original_filename,
        original_type, original_size, preview_key, thumb_key, width, height, placeholder,
        sort_order, published, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
  )
    .bind(
      p.id, p.folderId, p.title, p.takenOn, p.location, p.description, p.originalKey,
      p.originalFilename, p.originalType, p.originalSize, p.previewKey, p.thumbKey,
      p.width, p.height, p.placeholder, now, now, now,
    )
    .run()
}

export interface PhotoPatch {
  folderId?: string
  title?: string
  takenOn?: string | null
  location?: string
  description?: string
  published?: boolean
  sortOrder?: number
}

export async function update(env: Env, id: string, patch: PhotoPatch): Promise<boolean> {
  const sets: string[] = []
  const values: unknown[] = []

  if (patch.folderId !== undefined) { sets.push('folder_id = ?'); values.push(patch.folderId) }
  if (patch.title !== undefined) { sets.push('title = ?'); values.push(patch.title) }
  if (patch.takenOn !== undefined) { sets.push('taken_on = ?'); values.push(patch.takenOn) }
  if (patch.location !== undefined) { sets.push('location = ?'); values.push(patch.location) }
  if (patch.description !== undefined) { sets.push('description = ?'); values.push(patch.description) }
  if (patch.published !== undefined) { sets.push('published = ?'); values.push(patch.published ? 1 : 0) }
  if (patch.sortOrder !== undefined) { sets.push('sort_order = ?'); values.push(patch.sortOrder) }
  if (!sets.length) return false

  sets.push('updated_at = ?')
  values.push(Math.floor(Date.now() / 1000), id)

  const res = await env.DB.prepare(`UPDATE photos SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run()
  return (res.meta.changes ?? 0) > 0
}

export interface EditedPhoto {
  key: string
  previewKey: string | null
  thumbKey: string | null
  filename: string
  type: string
  size: number
  width: number
  height: number
}

export async function setEdited(env: Env, id: string, edited: EditedPhoto): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000)
  const res = await env.DB.prepare(
    `UPDATE photos SET edited_key = ?, edited_preview_key = ?, edited_thumb_key = ?,
       edited_filename = ?, edited_type = ?, edited_size = ?, edited_width = ?,
       edited_height = ?, edited_updated_at = ?, updated_at = ? WHERE id = ?`,
  ).bind(
    edited.key, edited.previewKey, edited.thumbKey, edited.filename, edited.type,
    edited.size, edited.width, edited.height, now, now, id,
  ).run()
  return (res.meta.changes ?? 0) > 0
}

export async function clearEdited(env: Env, id: string): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000)
  const res = await env.DB.prepare(
    `UPDATE photos SET edited_key = NULL, edited_preview_key = NULL, edited_thumb_key = NULL,
       edited_filename = NULL, edited_type = NULL, edited_size = NULL, edited_width = NULL,
       edited_height = NULL, edited_updated_at = NULL, updated_at = ? WHERE id = ?`,
  ).bind(now, id).run()
  return (res.meta.changes ?? 0) > 0
}

export async function remove(env: Env, id: string): Promise<boolean> {
  const res = await env.DB.prepare('DELETE FROM photos WHERE id = ?').bind(id).run()
  return (res.meta.changes ?? 0) > 0
}

export async function removeMany(env: Env, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK)
    const marks = chunk.map(() => '?').join(',')
    await env.DB.prepare(`DELETE FROM photos WHERE id IN (${marks})`).bind(...chunk).run()
  }
}
