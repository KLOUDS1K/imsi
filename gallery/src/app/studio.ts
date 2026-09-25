import '../styles/studio.css'
import { activeStudioImport, requestStudioSignIn, takePendingStudioImport } from './studio-link'
import { api } from './api'
import type { AppContext } from '../../../src/app/context'
import type { ExportSettings } from '../../../src/editor/types'

const resize = (edge?: number): ExportSettings['resize'] => edge
  ? { mode: 'long-edge', value: edge, width: edge, height: edge, dontEnlarge: true }
  : { mode: 'none', value: 0, width: 0, height: 0, dontEnlarge: true }

async function publishEdit(ctx: AppContext, photoId: string, originalName: string): Promise<void> {
  const doc = ctx.doc.value
  const engine = ctx.engine
  if (!doc || !engine) throw new Error('Open the photo before saving it.')
  await ctx.saveCurrent()
  const [{ exportPhoto }, { outputSize }] = await Promise.all([
    import('../../../src/editor/export'),
    import('../../../src/editor/engine/geometry'),
  ])
  const source = await doc.decoded.loadFull()
  const params = structuredClone(doc.store.params)
  const fullOutputSize = outputSize(params, source.fullWidth || source.width, source.fullHeight || source.height)
  const baseName = originalName.replace(/\.[^.]+$/, '')
  const baseSettings: ExportSettings = {
    ...structuredClone(ctx.exportSettings.value),
    format: 'jpeg',
    quality: 92,
    bitDepth: 8,
    colorSpace: 'srgb',
    fileNameTemplate: '{name}_edited',
    sequenceStart: 1,
  }
  const render = (width: number, height: number, bitDepth: 8 | 16, colorSpace: ExportSettings['colorSpace']) =>
    engine.renderFull(params, { width, height, bitDepth, colorSpace, source })
  const make = (edge?: number, quality = 92) => exportPhoto({
    params,
    meta: doc.meta,
    settings: { ...structuredClone(baseSettings), quality, resize: resize(edge) },
    baseName,
    index: 0,
    batchSize: 1,
    fullOutputSize,
    render,
  })

  ctx.busy.set({ active: true, label: 'Saving edited version…', progress: 0 })
  try {
    const full = await make()
    ctx.busy.set({ active: true, label: 'Preparing gallery previews…', progress: 0.35 })
    const preview = await make(2400, 88)
    const thumb = await make(800, 84)
    const revision = crypto.randomUUID().replace(/-/g, '')
    ctx.busy.set({ active: true, label: 'Uploading edited version…', progress: 0.7 })
    await Promise.all([
      api.photos.uploadEdited(photoId, revision, 'full', full.blob),
      api.photos.uploadEdited(photoId, revision, 'preview', preview.blob),
      api.photos.uploadEdited(photoId, revision, 'thumb', thumb.blob),
    ])
    await api.photos.commitEdited(photoId, {
      revision,
      filename: full.fileName,
      width: full.width,
      height: full.height,
    })
    ctx.toast('Edited version saved to the gallery.', 'success')
  } finally {
    ctx.busy.set({ active: false })
  }
}

function exitStudio(): void {
  const referrer = document.referrer ? new URL(document.referrer) : null
  if (referrer?.origin === window.location.origin && referrer.pathname !== '/studio') history.back()
  else window.location.assign('/')
}

function safeOriginalUrl(input: string): string {
  const url = new URL(input, window.location.origin)
  if (url.origin !== window.location.origin || !url.pathname.startsWith('/media/o/')) {
    throw new Error('The selected original URL is not valid.')
  }
  return url.toString()
}

export async function bootStudio(): Promise<void> {
  const session = await api.session.status().catch(() => ({ authenticated: false, username: null }))
  if (!session.authenticated) {
    requestStudioSignIn()
    return
  }
  document.title = 'KLOUD Studio'
  document.documentElement.classList.remove('is-viewing', 'is-drawer-open')
  document.body.className = 'studio-page'

  const host = document.createElement('div')
  host.id = 'app'
  host.className = 'studio-host'
  document.body.replaceChildren(host)

  const [{ mountKloudEditor }, pending] = await Promise.all([
    import('../../../src/app'),
    Promise.resolve(takePendingStudioImport() ?? activeStudioImport()),
  ])
  const editor = await mountKloudEditor(host, {
    exit: { label: 'Back to photos', onExit: exitStudio },
    publish: pending
      ? { label: 'Save to gallery', onPublish: (ctx) => publishEdit(ctx, pending.photoId, pending.name) }
      : undefined,
  })

  if (!pending) return
  history.replaceState(history.state, '', `/studio?photo=${encodeURIComponent(pending.photoId)}`)
  editor.ctx.toast(`Loading ${pending.name}…`, 'info')

  try {
    const response = await fetch(safeOriginalUrl(pending.url), { credentials: 'same-origin' })
    if (!response.ok) throw new Error(`Could not load the original (${response.status}).`)
    const blob = await response.blob()
    const file = new File([blob], pending.name, {
      type: blob.type || pending.type || 'application/octet-stream',
      lastModified: Date.now(),
    })
    await editor.importFiles([file])

    const selected = editor.ctx.selection.value[0]
      ?? editor.ctx.library.all().find((photo) => photo.name === pending.name)?.id
    if (selected) {
      await editor.ctx.openPhoto(selected)
      editor.ctx.module.set('develop')
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    editor.ctx.toast(`Could not open this photo in Studio: ${message}`, 'error', 7000)
  }
}
