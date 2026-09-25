import '../styles/studio.css'
import { takePendingStudioImport } from './studio-link'

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
  document.title = 'KLOUD Studio'
  document.documentElement.classList.remove('is-viewing', 'is-drawer-open')
  document.body.className = 'studio-page'

  const host = document.createElement('div')
  host.id = 'app'
  host.className = 'studio-host'
  document.body.replaceChildren(host)

  const [{ mountKloudEditor }, pending] = await Promise.all([
    import('../../../src/app'),
    Promise.resolve(takePendingStudioImport()),
  ])
  const editor = await mountKloudEditor(host, {
    exit: { label: 'Back to photos', onExit: exitStudio },
  })

  if (!pending) return
  history.replaceState(history.state, '', '/studio')
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
