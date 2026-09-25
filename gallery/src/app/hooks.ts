/**
 * The seam between the explorer and the management code.
 *
 * The admin bundle — upload, imaging, folder editing — is a lazy import that
 * only a signed-in session pulls down. The explorer calls into it through this
 * registry, so a visitor's page never loads a byte of it.
 */
import type { Folder, Photo } from '../shared/types'

export interface AdminHooks {
  createFolder(parentId: string): void
  /** The stats page, drawn from `state.stats`. */
  statsPanel(): HTMLElement
  pickFiles(folderId: string): void
  acceptDrop(transfer: DataTransfer, folderId: string): void
  editFolder(folder: Folder): void
  setFolderPassword(folder: Folder): void
  clearFolderPassword(folder: Folder): void
  moveFolder(folder: Folder): void
  deleteFolder(folder: Folder): void
  renamePhoto(photo: Photo): void
  movePhoto(photo: Photo): void
  deletePhoto(photo: Photo): void
}

let hooks: AdminHooks | null = null

export function setAdminHooks(next: AdminHooks | null): void {
  hooks = next
}

export function adminHooks(): AdminHooks | null {
  return hooks
}
