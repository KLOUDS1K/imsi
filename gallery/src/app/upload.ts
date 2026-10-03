/**
 * The staged upload.
 *
 *   PUT  original   the file, streamed from disk, byte for byte
 *   PUT  preview    long-edge 2400 derivative, made in this browser
 *   PUT  thumb      long-edge 900 derivative
 *   POST metadata   commits the row, keyed to what actually landed in R2
 *
 * The original is written first and never touched again, so a failure at any
 * later stage can be rolled back by deleting the id — there is no state in
 * which the gallery lists a photo whose original is missing.
 */
import { generateDerivatives } from './imaging'
import { api, ApiError } from './api'

export type UploadStage = 'processing' | 'uploading' | 'finishing'

export interface UploadProgress {
  stage: UploadStage
  /** 0..1 while the original transfers; absent for the other stages. */
  ratio?: number
  detail?: string
}

export interface UploadResult {
  id: string
  warning: string | null
}

const MAX_ATTEMPTS = 3

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))

function canRetry(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true
  return error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500
}

/** PUTs are idempotent and the final commit endpoint is idempotent server-side. */
async function retry<T>(run: () => Promise<T>, onRetry: (attempt: number) => void): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await run()
    } catch (error) {
      lastError = error
      if (attempt >= MAX_ATTEMPTS || !canRetry(error)) throw error
      onRetry(attempt + 1)
      await wait(250 * attempt)
    }
  }
  throw lastError
}

/**
 * XHR rather than fetch: it is the only way to observe upload progress, and it
 * streams the File straight from disk instead of buffering it in JS memory.
 */
function putWithProgress(
  url: string,
  body: Blob,
  headers: Record<string, string>,
  onProgress?: (ratio: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url, true)
    xhr.withCredentials = true
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v)

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total)
    })
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve()
      let message = `Upload failed (${xhr.status})`
      try {
        const parsed = JSON.parse(xhr.responseText) as { error?: string }
        if (parsed.error) message = parsed.error
      } catch {
        /* keep the status-code message */
      }
      reject(new ApiError(xhr.status, message))
    })
    xhr.addEventListener('error', () => reject(new Error('Network error during upload')))
    xhr.addEventListener('abort', () => reject(new Error('Upload cancelled')))
    xhr.send(body)
  })
}

/** RFC 7230 forbids non-ASCII in header values, so the name travels encoded. */
const encodeFilenameHeader = (name: string) => encodeURIComponent(name)

export async function uploadPhoto(
  file: File,
  folderId: string,
  onProgress?: (p: UploadProgress) => void,
): Promise<UploadResult> {
  const id = crypto.randomUUID()
  let commitStarted = false

  try {
    onProgress?.({ stage: 'processing' })
    const derived = await generateDerivatives(file)

    onProgress?.({ stage: 'uploading', ratio: 0 })
    await retry(
      () => putWithProgress(
        `/api/admin/photos/${id}/original`,
        file,
        {
          'content-type': file.type || 'application/octet-stream',
          'x-filename': encodeFilenameHeader(file.name),
        },
        (ratio) => onProgress?.({ stage: 'uploading', ratio }),
      ),
      (attempt) => onProgress?.({ stage: 'uploading', ratio: 0, detail: `Retrying original · ${attempt}/${MAX_ATTEMPTS}` }),
    )

    onProgress?.({ stage: 'finishing' })
    // Send each blob's real type — imaging.ts falls back to JPEG where the
    // browser cannot encode WebP, and the stored object must say so.
    if (derived.preview) {
      await retry(
        () => putWithProgress(`/api/admin/photos/${id}/preview`, derived.preview as Blob, {
          'content-type': derived.preview?.type || 'image/webp',
        }),
        (attempt) => onProgress?.({ stage: 'finishing', detail: `Retrying preview · ${attempt}/${MAX_ATTEMPTS}` }),
      )
    }
    if (derived.thumb) {
      await retry(
        () => putWithProgress(`/api/admin/photos/${id}/thumb`, derived.thumb as Blob, {
          'content-type': derived.thumb?.type || 'image/webp',
        }),
        (attempt) => onProgress?.({ stage: 'finishing', detail: `Retrying thumbnail · ${attempt}/${MAX_ATTEMPTS}` }),
      )
    }

    commitStarted = true
    await retry(
      () => api.photos.commit(id, {
        folderId,
        title: '',
        date: null,
        location: '',
        description: '',
        type: file.type || 'application/octet-stream',
        width: derived.width || null,
        height: derived.height || null,
        placeholder: derived.placeholder,
        hasPreview: Boolean(derived.preview),
        hasThumb: Boolean(derived.thumb),
      }),
      (attempt) => onProgress?.({ stage: 'finishing', detail: `Confirming upload · ${attempt}/${MAX_ATTEMPTS}` }),
    )

    return { id, warning: derived.warning }
  } catch (err) {
    // Once a commit request was sent, a lost response means the server might
    // still be inserting the row. Even a read-then-cleanup check can race
    // that insert, so never delete staging objects after this point.
    if (!commitStarted) await api.photos.cleanupUpload(id).catch(() => undefined)
    else if (canRetry(err)) {
      throw new Error('Could not confirm the upload. Refresh the gallery before retrying this photo.')
    }
    throw err
  }
}
