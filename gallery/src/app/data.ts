/**
 * Loading. Everything that fills the store lives here, so any view can refresh.
 *
 * Three things keep navigation from feeling like a round trip:
 *
 *   provisional  the sidebar already knows the folder tree, so opening a folder
 *                paints its name, path and subfolders immediately and fills in
 *                counts, covers and photos when the answer lands.
 *   cache        a folder already visited is re-shown instantly and revalidated
 *                behind it, which is what makes back and forward feel free.
 *   prefetch     pointing at a folder starts its request, so the click usually
 *                finds the answer already waiting.
 */
import type { BrowseResult, Folder, FolderEntry } from '../shared/types'
import { ROOT } from '../shared/types'
import { api } from './api'
import { state, update, folderById, childFolders } from './state'
import { revealCurrentBranch, scrollPaneToTop } from './explorer'

/** Guards against a slow response for a folder the user has already left. */
let requestToken = 0

/** Folders seen this session, and the requests currently in the air. */
const cache = new Map<string, BrowseResult>()
const inflight = new Map<string, Promise<BrowseResult>>()
const CACHE_LIMIT = 40
let cacheEpoch = 0

function remember(folderId: string, result: BrowseResult): void {
  cache.set(folderId, result)
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next()
    if (!oldest.done) cache.delete(oldest.value)
  }
}

function request(folderId: string): Promise<BrowseResult> {
  const existing = inflight.get(folderId)
  if (existing) return existing
  const epoch = cacheEpoch
  const pending = api
    .browse(folderId)
    .then((result) => {
      // A mutation/logout can invalidate an in-flight prefetch. Let its caller
      // finish, but never put that stale answer back into the fresh cache.
      if (epoch === cacheEpoch) remember(folderId, result)
      return result
    })
    .finally(() => {
      if (inflight.get(folderId) === pending) inflight.delete(folderId)
    })
  inflight.set(folderId, pending)
  return pending
}

/** Warms a folder the pointer is heading for. Failures here are silent. */
export function prefetchFolder(folderId: string): void {
  if (cache.has(folderId) || inflight.has(folderId)) return
  void request(folderId).catch(() => undefined)
}

/**
 * What can be drawn from the tree alone, so a folder opens on the click rather
 * than on the response. Counts are left unknown rather than guessed at zero: a
 * card that says "Empty" and then corrects itself reads worse than one that has
 * simply not said yet.
 */
function provisional(folderId: string): BrowseResult | null {
  const folder = folderId === ROOT ? null : folderById(folderId)
  if (folderId !== ROOT && !folder) return null

  const trail: Folder[] = []
  let cursor: Folder | null = folder
  while (cursor) {
    trail.unshift(cursor)
    cursor = cursor.parentId === ROOT ? null : folderById(cursor.parentId)
  }

  const children: FolderEntry[] = childFolders(folderId).map((child) => ({
    ...child,
    photoCount: -1,
    folderCount: -1,
    covers: [],
  }))

  return {
    folder,
    path: trail,
    folders: children,
    photos: [],
    admin: state.admin,
    lock: null,
  }
}

export async function loadTree(): Promise<void> {
  try {
    const { folders, admin } = await api.tree()
    update({ tree: folders, admin })
  } catch {
    // The folder view carries its own error message; a stale sidebar is
    // better than replacing the whole screen because the tree call failed.
  }
}

export async function loadFolder(folderId: string): Promise<void> {
  const token = ++requestToken
  const known = cache.get(folderId) ?? provisional(folderId)

  update({
    folderId,
    current: known,
    admin: known?.admin ?? state.admin,
    loading: true,
    errorText: null,
    search: null,
  })
  revealCurrentBranch()
  scrollPaneToTop()

  try {
    const result = await request(folderId)
    if (token !== requestToken) return
    update({ current: result, admin: result.admin, loading: false })
    revealCurrentBranch()
    // Counted here rather than in the browse route, which a hover prefetches.
    api.hit({ folder: folderId })
  } catch (err) {
    if (token !== requestToken) return
    update({
      current: null,
      loading: false,
      errorText: err instanceof Error ? err.message : 'Could not open that folder',
    })
  }
}

export async function runSearch(query: string): Promise<void> {
  const token = ++requestToken
  const trimmed = query.trim()

  if (!trimmed) {
    update({ search: null })
    await loadFolder(state.folderId)
    return
  }

  update({ loading: true, errorText: null })
  try {
    const result = await api.search(trimmed)
    if (token !== requestToken) return
    update({ search: result, loading: false })
  } catch (err) {
    if (token !== requestToken) return
    update({ loading: false, errorText: err instanceof Error ? err.message : 'Search failed' })
  }
}

/**
 * After any mutation. The cache has to go with it: an upload, a rename or an
 * unlock changes what the server would say about folders other than the one on
 * screen, and a stale hit would quietly show the old answer.
 */
export async function reload(): Promise<void> {
  cacheEpoch += 1
  cache.clear()
  inflight.clear()
  await Promise.all([loadTree(), loadFolder(state.folderId)])
}
