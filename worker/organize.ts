import { HttpError } from './http'

interface FolderMoveEntry {
  id: string
  parent_id: string
  name: string
}

/** Validate the complete folder move before issuing any UPDATE statements. */
export function validateFolderMove(
  allFolders: FolderMoveEntry[],
  folderIds: string[],
  destination: string,
): void {
  const byId = new Map(allFolders.map((folder) => [folder.id, folder]))
  if (destination && !byId.has(destination)) throw new HttpError(404, 'Destination folder not found')
  const names = new Set<string>()

  for (const id of folderIds) {
    const folder = byId.get(id)
    if (!folder) throw new HttpError(404, 'Folder not found')
    let cursor = destination
    while (cursor) {
      if (cursor === id) throw new HttpError(400, 'A folder cannot move inside itself')
      cursor = byId.get(cursor)?.parent_id ?? ''
    }
    if (names.has(folder.name) || allFolders.some((other) =>
      other.parent_id === destination && other.name === folder.name && other.id !== id
    )) throw new HttpError(409, `A folder named “${folder.name}” already exists there`)
    names.add(folder.name)
  }
}
