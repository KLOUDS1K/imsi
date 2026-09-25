import type { Photo } from '../shared/types'

const PENDING_IMPORT_KEY = 'kloud.studio.pending-import.v1'

export interface PendingStudioImport {
  url: string
  name: string
  type: string
}

/** Carries a signed, same-origin original URL across the full-page Studio route. */
export function openPhotoInStudio(photo: Photo): void {
  const pending: PendingStudioImport = {
    url: photo.originalUrl,
    name: photo.filename,
    type: photo.type,
  }
  try {
    sessionStorage.setItem(PENDING_IMPORT_KEY, JSON.stringify(pending))
    window.location.assign('/studio?import=photo')
  } catch {
    // Storage can be disabled. Studio still opens and the file picker remains usable.
    window.location.assign('/studio')
  }
}

export function takePendingStudioImport(): PendingStudioImport | null {
  let raw: string | null = null
  try {
    raw = sessionStorage.getItem(PENDING_IMPORT_KEY)
    sessionStorage.removeItem(PENDING_IMPORT_KEY)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<PendingStudioImport>
    if (typeof value.url !== 'string' || typeof value.name !== 'string' || typeof value.type !== 'string') return null
    return { url: value.url, name: value.name, type: value.type }
  } catch {
    return null
  }
}
