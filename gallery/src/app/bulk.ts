/**
 * "Download all" — a whole folder, subfolders and all, as one zip.
 *
 * The originals are fetched one at a time and written straight into the
 * archive, so peak memory is one photo rather than the whole folder. Where the
 * browser offers a save-file handle the archive streams to disk and never has
 * to fit in memory at all; elsewhere it is collected and handed over at the end.
 *
 * Every file still goes through /download, so a locked folder is as locked here
 * as anywhere else, and the counters see the same downloads they would if each
 * had been taken by hand.
 */
import type { Photo } from '../shared/types'
import { formatBytes, mediaUrl } from '../shared/types'
import { api } from './api'
import { toast } from './ui'
import { beginTransfer } from './transfers'
import type { ZipSink } from './zip'
import { ZipStream, memorySink, pickFileSink } from './zip'

/** A photo plus where it should sit inside the archive. */
interface Item {
  photo: Photo
  path: string
}

/** Trims what a zip entry may not carry, and keeps names unique. */
function safeName(name: string, taken: Set<string>, prefix: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '_').replace(/[\x00-\x1f]/g, '') || 'photo'
  let candidate = prefix + cleaned
  if (!taken.has(candidate)) {
    taken.add(candidate)
    return candidate
  }
  const dot = cleaned.lastIndexOf('.')
  const stem = dot > 0 ? cleaned.slice(0, dot) : cleaned
  const ext = dot > 0 ? cleaned.slice(dot) : ''
  for (let n = 2; ; n++) {
    candidate = `${prefix}${stem} (${n})${ext}`
    if (!taken.has(candidate)) {
      taken.add(candidate)
      return candidate
    }
  }
}

/**
 * Everything under `folderId`, depth first, with archive paths that mirror the
 * folder names. A subfolder the visitor has not unlocked simply is not there.
 */
async function collect(folderId: string, prefix: string, taken: Set<string>): Promise<Item[]> {
  const view = await api.browse(folderId)
  if (view.lock) return []

  const items: Item[] = view.photos.map((photo) => ({
    photo,
    path: safeName(photo.filename, taken, prefix),
  }))

  for (const child of view.folders) {
    if (child.locked) continue
    const folderName = child.name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'folder'
    items.push(...(await collect(child.id, `${prefix}${folderName}/`, taken)))
  }
  return items
}

let running = false

export async function downloadFolder(folderId: string, folderName: string): Promise<void> {
  if (running) {
    toast('A download is already running', 'error')
    return
  }
  running = true

  const archiveName = `${folderName.replace(/[\\/:*?"<>|]/g, '_').trim() || 'photos'}.zip`
  const controller = new AbortController()
  const transfer = beginTransfer(archiveName, () => controller.abort())

  try {
    transfer.stage('processing', 'Listing photos')
    const items = await collect(folderId, '', new Set())

    if (!items.length) {
      transfer.finish('Nothing to download')
      toast('That folder has no photos in it', 'error')
      return
    }

    const total = items.reduce((sum, item) => sum + item.photo.size, 0)

    // The picker has to be opened before anything long-running, while the
    // click that started this still counts as user activation.
    let target: { sink: ZipSink; done: () => void } | null = null
    try {
      target = await pickFileSink(archiveName)
    } catch {
      transfer.finish('Cancelled')
      return
    }
    const output = target ?? memorySink(archiveName)
    if (!target && total > 1_500_000_000) {
      toast(`${formatBytes(total)} is a lot to hold in memory — this may fail`, 'error')
    }

    const zip = new ZipStream(output.sink)
    let written = 0

    for (const [index, item] of items.entries()) {
      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError')
      transfer.stage('uploading', `${index + 1} / ${items.length} · ${item.photo.filename}`)

      const res = await fetch(mediaUrl.download(item.photo.id), {
        credentials: 'same-origin',
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`Could not fetch ${item.photo.filename} (${res.status})`)

      const bytes = new Uint8Array(await res.arrayBuffer())
      await zip.add(item.path, bytes, new Date(item.photo.createdAt * 1000))

      written += bytes.length
      transfer.progress(total ? written / total : 1)
    }

    transfer.stage('finishing', 'Closing the archive')
    await zip.finish()
    output.done()

    transfer.finish()
    toast(`${items.length} photos · ${formatBytes(written)}`)
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      transfer.finish('Cancelled')
    } else {
      const message = err instanceof Error ? err.message : 'The download failed'
      transfer.finish(message)
      toast(message, 'error')
    }
  } finally {
    running = false
  }
}
