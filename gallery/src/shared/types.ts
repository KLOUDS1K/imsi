/** Shapes the worker sends, plus the formatting every view shares. */

export interface Folder {
  id: string
  parentId: string
  name: string
  note: string
  date: string | null
  sortOrder: number
  createdAt: number
  updatedAt: number
  /** The viewer has not opened this folder yet; its contents are withheld. */
  locked?: boolean
  hidden?: boolean
  /** Admin-only: whether a password is set at all. */
  hasPassword?: boolean
}

/** A folder as it appears inside a listing, with its contents summarised. */
export interface FolderEntry extends Folder {
  photoCount: number
  folderCount: number
  covers: string[]
}

export interface Photo {
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
  /** Signed by the worker — a bare photo id will not fetch a derivative. */
  thumbUrl: string
  previewUrl: string | null
  /**
   * The uploaded file itself, served inline. The viewer upgrades to this once
   * it has something on screen, so what a client looks at is the real photo and
   * not a 2400px re-encode of it.
   */
  originalUrl: string
  hidden?: boolean
  sortOrder?: number
}

export interface BrowseResult {
  folder: Folder | null
  path: Folder[]
  folders: FolderEntry[]
  photos: Photo[]
  admin: boolean
  /** Set when a locked folder is standing between the viewer and this one. */
  lock: { id: string; name: string } | null
}

/** What the owner's stats panel shows. Counters only — nobody is identified. */
export interface StatsReport {
  visitors: number
  visits: number
  views: number
  downloads: number
  daily: { day: string; visits: number; views: number; downloads: number }[]
  topFolders: { id: string; name: string; views: number }[]
  topPhotos: { id: string; name: string; folder: string; downloads: number }[]
  since: number | null
}

export const ROOT = ''

/**
 * Derivative URLs are minted by the worker and arrive on each photo, so there
 * is nothing to construct here — only the download route, which does its own
 * check against the folder's lock.
 */
export const mediaUrl = {
  download: (id: string) => `/download/${id}`,
}

/** The route for a folder. '' is the root, which lives at `/`. */
export function folderHref(id: string): string {
  return id === ROOT ? '/' : `/f/${id}`
}

/**
 * What the explorer prints under a tile. A rename sets `title` and only ever
 * changes this label — the original filename, and therefore the download, is
 * left exactly as uploaded.
 */
export function displayName(photo: Photo): string {
  return photo.title.trim() || photo.filename
}

export function formatDate(iso: string | null): string {
  if (!iso) return ''
  const [y, m, d] = iso.split('-')
  if (!y || !m || !d) return iso
  return `${y}.${m}.${d}`
}

export function formatTimestamp(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  const d = new Date(seconds * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/** `image/jpeg` -> `JPEG`, preferring the extension the file actually carries. */
export function formatKind(photo: Photo): string {
  const ext = photo.filename.includes('.') ? (photo.filename.split('.').pop() as string) : ''
  if (ext) return ext.toUpperCase()
  return (photo.type.split('/')[1] ?? photo.type).toUpperCase()
}

export function formatDimensions(photo: Photo): string {
  if (!photo.width || !photo.height) return '—'
  return `${photo.width} × ${photo.height}`
}

/**
 * "2 folders · 14 photos" — a count of zero is left out rather than printed,
 * and a negative one means "not known yet", which the provisional view uses
 * while the real numbers are still in flight.
 */
export function summarise(folderCount: number, photoCount: number): string {
  if (folderCount < 0 || photoCount < 0) return ''
  const parts: string[] = []
  if (folderCount) parts.push(plural(folderCount, 'folder'))
  if (photoCount) parts.push(plural(photoCount, 'photo'))
  return parts.join(' · ') || 'Empty'
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}
