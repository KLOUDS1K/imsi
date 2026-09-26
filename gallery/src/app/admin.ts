/**
 * Management: sign-in, folders, renames, deletes, and the upload queue.
 *
 * Lazily imported — nothing in here is downloaded until a session exists or
 * someone clicks the padlock, so a visitor's page stays the explorer alone.
 */
import type { Folder, Photo } from '../shared/types'
import { ROOT, displayName, plural } from '../shared/types'
import { api } from './api'
import { state, update } from './state'
import { setAdminHooks } from './hooks'
import { loadTree, reload } from './data'
import { openSheet, toast } from './ui'
import { beginTransfer } from './transfers'
import { uploadPhoto } from './upload'
import { loadStats, statsPanel } from './stats'
import { takeStudioLoginReturn } from './studio-link'
import { go } from './router'

/** Today, offered as a placeholder for people who name folders by date. */
function today(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

// ------------------------------------------------------------------ sign in

export async function signIn(): Promise<void> {
  const { needsSetup, requiresKey, setupAllowed } = await api.session
    .needsSetup()
    .catch(() => ({ needsSetup: false, requiresKey: false, setupAllowed: true }))

  if (needsSetup && !setupAllowed) {
    toast('Administrator setup is locked. Configure SETUP_KEY on the server first.', 'error')
    return
  }

  openSheet({
    title: needsSetup ? 'Create an administrator' : 'Sign in',
    description: needsSetup
      ? 'No administrator exists yet. Choose the credentials for this archive.'
      : 'Sign in to upload photos and manage folders.',
    submitLabel: needsSetup ? 'Create and sign in' : 'Sign in',
    fields: [
      { name: 'username', label: 'Username', autocomplete: 'username', required: true },
      ...(needsSetup && requiresKey
        ? [{ name: 'setupKey', label: 'Setup key', type: 'password' as const, required: true }]
        : []),
      {
        name: 'password',
        label: 'Password',
        type: 'password',
        autocomplete: needsSetup ? 'new-password' : 'current-password',
        minLength: needsSetup ? 10 : undefined,
        hint: needsSetup ? 'At least 10 characters' : undefined,
        required: true,
      },
    ],
    onSubmit: async (values) => {
      const username = (values.username ?? '').trim()
      const password = values.password ?? ''
      if (!username || !password) return 'Enter a username and a password'
      try {
        if (needsSetup) {
          await api.session.createFirstAdmin(username, password, values.setupKey ?? '')
        }
        await api.session.login(username, password)
      } catch (err) {
        return err instanceof Error ? err.message : 'Could not sign in'
      }
      setAdminHooks(HOOKS)
      update({ admin: true, username })
      const studioReturn = takeStudioLoginReturn()
      if (studioReturn) {
        window.location.assign(studioReturn)
        return
      }
      await reload()
      toast(`Signed in as ${username}`)
      return
    },
  })
}

export { loadStats }

export async function signOut(): Promise<void> {
  await api.session.logout().catch(() => undefined)
  setAdminHooks(null)
  update({ admin: false, username: null })
  await reload()
  toast('Signed out')
}

// ------------------------------------------------------------------ folders

/** Every folder as an indented option, for the "move to" pickers. */
function folderOptions(exclude?: string): { value: string; label: string }[] {
  const banned = new Set<string>()
  if (exclude) {
    const collect = (id: string) => {
      banned.add(id)
      for (const child of state.tree.filter((f) => f.parentId === id)) collect(child.id)
    }
    collect(exclude)
  }

  const out: { value: string; label: string }[] = [{ value: ROOT, label: 'Archive (top level)' }]
  const walk = (parentId: string, depth: number) => {
    for (const folder of state.tree
      .filter((f) => f.parentId === parentId)
      .sort((a, b) => a.name.localeCompare(b.name, 'ko'))) {
      if (banned.has(folder.id)) continue
      out.push({ value: folder.id, label: `${'  '.repeat(depth)}${folder.name}` })
      walk(folder.id, depth + 1)
    }
  }
  walk(ROOT, 1)
  return out
}

function createFolder(parentId: string): void {
  const atRoot = parentId === ROOT
  openSheet({
    title: atRoot ? 'New top-level folder' : 'New subfolder',
    description: atRoot
      ? 'Call it anything — a date, a client, a trip. Only the name is required.'
      : `Created inside "${state.tree.find((f) => f.id === parentId)?.name ?? 'the current folder'}".`,
    submitLabel: 'Create',
    fields: [
      {
        name: 'name',
        label: 'Folder name',
        // Empty, with today's date only as a suggestion in the placeholder —
        // pre-filling it made a date look compulsory.
        placeholder: atRoot ? today() : 'Untitled folder',
        required: true,
      },
      { name: 'date', label: 'Date (optional)', type: 'date' },
      { name: 'note', label: 'Note (optional)', type: 'textarea', placeholder: 'A note about this folder' },
    ],
    onSubmit: async (values) => {
      const name = (values.name ?? '').trim()
      if (!name) return 'Enter a folder name'
      try {
        await api.folders.create({ parentId, name, note: values.note ?? '', date: values.date || null })
      } catch (err) {
        return err instanceof Error ? err.message : 'Could not create the folder'
      }
      await reload()
      toast(`Created “${name}”`)
      return
    },
  })
}

function editFolder(folder: Folder): void {
  openSheet({
    title: 'Edit folder',
    submitLabel: 'Save',
    fields: [
      { name: 'name', label: 'Folder name', value: folder.name, required: true },
      { name: 'date', label: 'Date (optional)', type: 'date', value: folder.date ?? '' },
      { name: 'note', label: 'Note (optional)', type: 'textarea', value: folder.note },
    ],
    onSubmit: async (values) => {
      const name = (values.name ?? '').trim()
      if (!name) return 'Enter a folder name'
      try {
        await api.folders.patch(folder.id, {
          name,
          note: values.note ?? '',
          date: values.date || null,
        })
      } catch (err) {
        return err instanceof Error ? err.message : 'Could not save that'
      }
      await reload()
      toast('Saved')
      return
    },
  })
}

/**
 * The share password. It is not an account password — it is the thing you send
 * a client along with the link — so the bar is "hard to guess by hand", and the
 * sheet says plainly that changing it locks out anyone already inside.
 */
function setFolderPassword(folder: Folder): void {
  const existing = folder.hasPassword === true
  openSheet({
    title: existing ? `Change the password on "${folder.name}"` : `Protect "${folder.name}"`,
    description: existing
      ? 'Anyone who already opened this folder will be asked again for the new password.'
      : 'Visitors will see the folder by name, but will have to enter this password to look inside. Everything in its subfolders is covered too.',
    submitLabel: existing ? 'Change password' : 'Protect folder',
    fields: [
      {
        name: 'password',
        label: 'Password',
        type: 'password',
        autocomplete: 'new-password',
        required: true,
        hint: 'At least 4 characters. Share it with whoever should see the folder.',
      },
      { name: 'confirm', label: 'Repeat the password', type: 'password', required: true },
    ],
    onSubmit: async (values) => {
      const password = values.password ?? ''
      if (password.length < 4) return 'Use at least 4 characters'
      if (password !== (values.confirm ?? '')) return 'The two passwords do not match'
      try {
        await api.folders.patch(folder.id, { password })
      } catch (err) {
        return err instanceof Error ? err.message : 'Could not set the password'
      }
      await reload()
      toast(existing ? 'Password changed' : `"${folder.name}" is now password protected`)
      return
    },
  })
}

function clearFolderPassword(folder: Folder): void {
  openSheet({
    title: `Remove the password on "${folder.name}"?`,
    description: 'Anyone with the link will be able to open the folder and download from it.',
    submitLabel: 'Remove password',
    danger: true,
    onSubmit: async () => {
      try {
        await api.folders.patch(folder.id, { password: null })
      } catch (err) {
        return err instanceof Error ? err.message : 'Could not remove the password'
      }
      await reload()
      toast('The folder is public again')
      return
    },
  })
}

function moveFolder(folder: Folder): void {
  openSheet({
    title: `Move “${folder.name}”`,
    description: 'Pick where it should go. A folder cannot move into itself or into anything inside it.',
    submitLabel: 'Move',
    fields: [
      {
        name: 'parentId',
        label: 'Destination',
        type: 'select',
        value: folder.parentId,
        options: folderOptions(folder.id),
      },
    ],
    onSubmit: async (values) => {
      try {
        await api.folders.patch(folder.id, { parentId: values.parentId ?? ROOT })
      } catch (err) {
        return err instanceof Error ? err.message : 'Could not move that'
      }
      await reload()
      toast('Folder moved')
      return
    },
  })
}

function deleteFolder(folder: Folder): void {
  openSheet({
    title: `Delete “${folder.name}”?`,
    description:
      'This folder, every subfolder inside it and every photo they hold will be removed. The original files go too, and this cannot be undone.',
    submitLabel: 'Delete',
    danger: true,
    fields: [
      {
        name: 'confirm',
        label: 'Type the folder name to confirm',
        placeholder: folder.name,
        required: true,
      },
    ],
    onSubmit: async (values) => {
      if ((values.confirm ?? '').trim() !== folder.name) return 'That does not match the folder name'
      let cursor = state.folderId
      let leavesCurrentRouteBehind = cursor === folder.id
      while (!leavesCurrentRouteBehind && cursor !== ROOT) {
        const current = state.tree.find((item) => item.id === cursor)
        if (!current) break
        cursor = current.parentId
        leavesCurrentRouteBehind = cursor === folder.id
      }
      let result
      try {
        result = await api.folders.remove(folder.id)
      } catch (err) {
        return err instanceof Error ? err.message : 'Could not delete that'
      }
      if (leavesCurrentRouteBehind) {
        await loadTree()
        go({ folderId: folder.parentId, photoId: null }, true)
      } else {
        await reload()
      }
      toast(`Deleted ${plural(result.deletedFolders, 'folder')} and ${plural(result.deletedPhotos, 'photo')}`)
      return
    },
  })
}

// ------------------------------------------------------------------- photos

function renamePhoto(photo: Photo): void {
  openSheet({
    title: 'Rename',
    description: `Only the displayed name changes. Downloads keep the original filename, "${photo.filename}".`,
    submitLabel: 'Save',
    fields: [
      { name: 'title', label: 'Displayed name', value: displayName(photo), required: true },
      { name: 'description', label: 'Note (optional)', type: 'textarea', value: photo.description },
    ],
    onSubmit: async (values) => {
      const title = (values.title ?? '').trim()
      try {
        await api.photos.patch(photo.id, {
          title: title === photo.filename ? '' : title,
          description: values.description ?? '',
        })
      } catch (err) {
        return err instanceof Error ? err.message : 'Could not save that'
      }
      await reload()
      toast('Saved')
      return
    },
  })
}

function movePhoto(photo: Photo): void {
  openSheet({
    title: `Move “${displayName(photo)}”`,
    submitLabel: 'Move',
    fields: [
      {
        name: 'folderId',
        label: 'Destination',
        type: 'select',
        value: photo.folderId,
        options: folderOptions(),
      },
    ],
    onSubmit: async (values) => {
      try {
        await api.photos.patch(photo.id, { folderId: values.folderId ?? ROOT })
      } catch (err) {
        return err instanceof Error ? err.message : 'Could not move that'
      }
      await reload()
      toast('Photo moved')
      return
    },
  })
}

function deletePhoto(photo: Photo): void {
  openSheet({
    title: 'Delete this photo?',
    description: `The original file for "${displayName(photo)}" is removed too, and this cannot be undone.`,
    submitLabel: 'Delete',
    danger: true,
    onSubmit: async () => {
      try {
        await api.photos.remove(photo.id)
      } catch (err) {
        return err instanceof Error ? err.message : 'Could not delete that'
      }
      await reload()
      toast('Photo deleted')
      return
    },
  })
}

// ------------------------------------------------------------------ uploads

const PHOTO_EXTENSIONS =
  /\.(jpe?g|png|webp|gif|avif|heic|heif|tiff?|bmp|dng|cr2|cr3|nef|arw|raf|orf|rw2|srw|pef)$/i
const PHOTO_ACCEPT = [
  'image/*', '.dng', '.cr2', '.cr3', '.nef', '.arw', '.raf', '.orf', '.rw2', '.srw', '.pef',
].join(',')

function looksLikePhoto(file: File): boolean {
  return file.type.startsWith('image/') || PHOTO_EXTENSIONS.test(file.name)
}

interface Pending {
  /** Folder names, relative to the drop target. Empty means the target itself. */
  dir: string[]
  file: File
}

/** Names a dropped folder tree can create, so a stray deep tree cannot run away. */
const MAX_DEPTH = 6

async function readDirectory(entry: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = entry.createReader()
  const all: FileSystemEntry[] = []
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve) => {
      reader.readEntries(resolve, () => resolve([]))
    })
    if (!batch.length) break
    all.push(...batch)
  }
  return all
}

async function walkEntry(entry: FileSystemEntry, dir: string[], out: Pending[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File | null>((resolve) => {
      ;(entry as FileSystemFileEntry).file(resolve, () => resolve(null))
    })
    if (file) out.push({ dir, file })
    return
  }
  if (dir.length >= MAX_DEPTH) return
  const children = await readDirectory(entry as FileSystemDirectoryEntry)
  for (const child of children) await walkEntry(child, [...dir, entry.name], out)
}

/** Finds or creates the folder at `names` under `rootId`, one level at a time. */
async function ensurePath(rootId: string, names: string[]): Promise<string> {
  let parentId = rootId
  for (const rawName of names) {
    const name = rawName.replace(/[\\/]/g, ' ').trim().slice(0, 80) || 'Untitled folder'
    const existing = state.tree.find((f) => f.parentId === parentId && f.name === name)
    if (existing) {
      parentId = existing.id
      continue
    }
    try {
      const { folder } = await api.folders.create({ parentId, name })
      state.tree.push(folder)
      parentId = folder.id
    } catch {
      // Most likely a 409 from a sibling upload that just created it — reread
      // the tree and use whatever is there now.
      await loadTree()
      const found = state.tree.find((f) => f.parentId === parentId && f.name === name)
      if (!found) throw new Error(`Could not create the folder “${name}”`)
      parentId = found.id
    }
  }
  return parentId
}

const CONCURRENCY = 2

async function runQueue(items: Pending[], targetId: string): Promise<void> {
  // Folders first and sequentially: two uploads racing to create the same
  // folder would otherwise collide on the unique index.
  const resolved: { folderId: string; file: File }[] = []
  const cache = new Map<string, string>()
  for (const item of items) {
    const key = item.dir.join('/')
    let folderId = cache.get(key)
    if (folderId === undefined) {
      folderId = item.dir.length ? await ensurePath(targetId, item.dir) : targetId
      cache.set(key, folderId)
    }
    resolved.push({ folderId, file: item.file })
  }

  let cursor = 0
  let warnings = 0
  let failures = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++
      const job = resolved[index]
      if (!job) return

      const transfer = beginTransfer(job.file.name)
      try {
        const result = await uploadPhoto(job.file, job.folderId, (p) => {
          transfer.stage(p.stage)
          if (p.ratio !== undefined) transfer.progress(p.ratio)
        })
        if (result.warning) warnings += 1
        transfer.finish()
      } catch (err) {
        failures += 1
        transfer.finish(err instanceof Error ? err.message : 'Failed')
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, resolved.length) }, worker))
  await reload()

  const done = resolved.length - failures
  if (done > 0) toast(`Uploaded ${plural(done, 'photo')}`)
  if (warnings > 0) {
    toast(
      `${plural(warnings, 'file')} could not be decoded here, so they have no preview — the originals were still stored`,
      'error',
    )
  }
  if (failures > 0) toast(`${plural(failures, 'upload')} failed`, 'error')
}

function startUpload(items: Pending[], targetId: string): void {
  const photos = items.filter((item) => looksLikePhoto(item.file))
  const skipped = items.length - photos.length

  if (skipped > 0) toast(`Skipped ${plural(skipped, 'file')} that are not photos`, 'error')
  if (!photos.length) return

  void runQueue(photos, targetId).catch((err) => {
    toast(err instanceof Error ? err.message : 'The upload failed', 'error')
  })
}

function pickFiles(folderId: string): void {
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.accept = PHOTO_ACCEPT
  input.style.display = 'none'
  document.body.append(input)
  input.addEventListener('change', () => {
    const files = Array.from(input.files ?? [])
    input.remove()
    startUpload(files.map((file) => ({ dir: [], file })), folderId)
  })
  input.addEventListener('cancel', () => input.remove(), { once: true })
  input.click()
}

function acceptDrop(transfer: DataTransfer, folderId: string): void {
  // The DataTransfer is emptied the moment the drop handler returns, so every
  // entry has to be claimed synchronously and walked afterwards.
  const entries: FileSystemEntry[] = []
  const loose: File[] = []

  for (const item of Array.from(transfer.items ?? [])) {
    if (item.kind !== 'file') continue
    const entry = item.webkitGetAsEntry?.()
    if (entry) entries.push(entry)
    else {
      const file = item.getAsFile()
      if (file) loose.push(file)
    }
  }
  if (!entries.length && !loose.length) loose.push(...Array.from(transfer.files ?? []))

  void (async () => {
    const pending: Pending[] = loose.map((file) => ({ dir: [], file }))
    for (const entry of entries) await walkEntry(entry, [], pending)
    if (!pending.length) {
      toast('No files were found in that drop', 'error')
      return
    }
    startUpload(pending, folderId)
  })()
}

// --------------------------------------------------------------------- init

const HOOKS = {
  createFolder,
  statsPanel,
  pickFiles,
  acceptDrop,
  editFolder,
  setFolderPassword,
  clearFolderPassword,
  moveFolder,
  deleteFolder,
  renamePhoto,
  movePhoto,
  deletePhoto,
}

/**
 * The hooks are what the explorer checks before drawing any management
 * control, so they go up only for a live session and come straight back down
 * on sign-out — clicking the padlock to look at the login sheet must not make
 * the page look like it is signed in.
 */
export async function installAdmin(): Promise<void> {
  const session = await api.session.status().catch(() => ({ authenticated: false, username: null }))
  update({ admin: session.authenticated, username: session.username })
  setAdminHooks(session.authenticated ? HOOKS : null)
}
