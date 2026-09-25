/**
 * Original-file downloads.
 *
 * Deliberately a plain same-origin navigation rather than fetch + blob: the
 * originals can be hundreds of megabytes, and buffering one into a blob would
 * put the whole file in browser memory. Letting the browser stream it means
 * the `Content-Disposition` filename the worker sets is the one that lands on
 * disk, and downloads stay resumable.
 */
import type { Photo } from '../shared/types'
import { mediaUrl } from '../shared/types'

export function downloadOriginal(photo: Photo): void {
  const a = document.createElement('a')
  a.href = mediaUrl.download(photo.id)
  // A hint only — the server's Content-Disposition is authoritative, and it
  // always names the file exactly as it was uploaded.
  a.download = photo.filename
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  // Give the navigation a tick to start before detaching the node.
  setTimeout(() => a.remove(), 1000)
}
