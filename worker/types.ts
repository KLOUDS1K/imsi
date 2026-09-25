export interface Env {
  DB: D1Database
  MEDIA: R2Bucket
  ASSETS: Fetcher
  SITE_TITLE: string
  MAX_UPLOAD_BYTES: string
  SETUP_KEY?: string
}

/** The root of the tree is addressed by an empty parent id, never NULL. */
export const ROOT = ''

// ------------------------------------------------------------------ folders

export interface FolderRow {
  id: string
  parent_id: string
  name: string
  note: string
  folder_date: string | null
  sort_order: number
  published: number
  /** NULL means the folder is public. */
  password_hash: string | null
  created_at: number
  updated_at: number
}

export interface PublicFolder {
  id: string
  parentId: string
  name: string
  note: string
  date: string | null
  sortOrder: number
  createdAt: number
  updatedAt: number
  /** Set when this viewer has not opened the folder — its contents are withheld. */
  locked?: boolean
  /** Admin-only; absent for visitors. */
  hidden?: boolean
  hasPassword?: boolean
}

/** A folder as it appears in a listing: with its recursive contents summarised. */
export interface FolderEntry extends PublicFolder {
  photoCount: number
  folderCount: number
  /** Up to three photo ids, newest first, for the stacked cover thumbnail. */
  covers: string[]
}

export function toPublicFolder(r: FolderRow, admin: boolean, locked = false): PublicFolder {
  const out: PublicFolder = {
    id: r.id,
    parentId: r.parent_id,
    name: r.name,
    // A locked folder still shows its name — that is the point of a door you
    // can see — but nothing that describes what is behind it.
    note: locked ? '' : r.note,
    date: locked ? null : r.folder_date,
    sortOrder: r.sort_order,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
  if (locked) out.locked = true
  if (admin) {
    out.hidden = r.published === 0
    out.hasPassword = Boolean(r.password_hash)
  }
  return out
}

// ------------------------------------------------------------------- photos

/** Row as stored in D1. */
export interface PhotoRow {
  id: string
  folder_id: string
  title: string
  taken_on: string | null
  location: string
  description: string
  original_key: string
  original_filename: string
  original_type: string
  original_size: number
  preview_key: string | null
  thumb_key: string | null
  width: number | null
  height: number | null
  placeholder: string | null
  sort_order: number
  published: number
  created_at: number
  updated_at: number
}

/** Shape sent to the browser — no storage keys leak out. */
export interface PublicPhoto {
  id: string
  folderId: string
  title: string
  date: string | null
  location: string
  description: string
  width: number | null
  height: number | null
  placeholder: string | null
  filename: string
  size: number
  type: string
  createdAt: number
  /**
   * Signed URLs. The media route will not serve a derivative without the token
   * in these, so a photo id on its own is not enough to read one out of a
   * locked folder.
   */
  thumbUrl: string
  previewUrl: string | null
  /**
   * The untouched original, served inline so the viewer can show the real file
   * rather than a re-encoded copy of it.
   */
  originalUrl: string
  hidden?: boolean
  sortOrder?: number
}

export function toPublicPhoto(
  r: PhotoRow,
  admin: boolean,
  thumbUrl: string,
  previewUrl: string | null,
  originalUrl: string,
): PublicPhoto {
  const out: PublicPhoto = {
    id: r.id,
    folderId: r.folder_id,
    title: r.title,
    date: r.taken_on,
    location: r.location,
    description: r.description,
    width: r.width,
    height: r.height,
    placeholder: r.placeholder,
    filename: r.original_filename,
    size: r.original_size,
    type: r.original_type,
    createdAt: r.created_at,
    thumbUrl,
    previewUrl,
    originalUrl,
  }
  if (admin) {
    out.hidden = r.published === 0
    out.sortOrder = r.sort_order
  }
  return out
}
