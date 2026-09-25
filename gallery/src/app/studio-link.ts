import type { Photo } from '../shared/types'

const PENDING_IMPORT_KEY = 'kloud.studio.pending-import.v1'
const ACTIVE_IMPORT_KEY = 'kloud.studio.active-import.v1'
const STUDIO_LOGIN_RETURN_KEY = 'kloud.studio.return-after-login.v1'

export interface PendingStudioImport {
  photoId: string
  url: string
  name: string
  type: string
}

/** Carries a signed, same-origin original URL across the full-page Studio route. */
export function openPhotoInStudio(photo: Photo): void {
  const pending: PendingStudioImport = {
    photoId: photo.id,
    url: photo.originalUrl,
    name: photo.filename,
    type: photo.type,
  }
  try {
    sessionStorage.setItem(PENDING_IMPORT_KEY, JSON.stringify(pending))
    window.location.assign(`/studio?photo=${encodeURIComponent(photo.id)}`)
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
    if (typeof value.photoId !== 'string' || typeof value.url !== 'string' || typeof value.name !== 'string' || typeof value.type !== 'string') return null
    const pending = { photoId: value.photoId, url: value.url, name: value.name, type: value.type }
    sessionStorage.setItem(ACTIVE_IMPORT_KEY, JSON.stringify(pending))
    return pending
  } catch {
    return null
  }
}

export function activeStudioImport(): PendingStudioImport | null {
  const wanted = new URL(window.location.href).searchParams.get('photo')
  if (!wanted) return null
  try {
    const value = JSON.parse(sessionStorage.getItem(ACTIVE_IMPORT_KEY) ?? 'null') as Partial<PendingStudioImport> | null
    if (!value || value.photoId !== wanted || typeof value.url !== 'string' || typeof value.name !== 'string' || typeof value.type !== 'string') return null
    return { photoId: value.photoId, url: value.url, name: value.name, type: value.type }
  } catch {
    return null
  }
}

export function requestStudioSignIn(): void {
  try { sessionStorage.setItem(STUDIO_LOGIN_RETURN_KEY, '1') } catch { /* continue */ }
  window.location.assign('/admin')
}

export function takeStudioLoginReturn(): boolean {
  try {
    const requested = sessionStorage.getItem(STUDIO_LOGIN_RETURN_KEY) === '1'
    sessionStorage.removeItem(STUDIO_LOGIN_RETURN_KEY)
    return requested
  } catch {
    return false
  }
}
