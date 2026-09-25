/**
 * Folder navigation, expressed as real URLs.
 *
 * `/` is the root, `/f/<id>` is a folder, and `?p=<id>` on either of those
 * means the viewer is open on that photo. Every one of those is shareable, and
 * the browser's own back button closes the viewer before it leaves the folder.
 */
import { ROOT } from '../shared/types'

export interface Route {
  folderId: string
  photoId: string | null
  /** The owner's stats page, which lives at /stats rather than inside a folder. */
  stats?: boolean
}

interface HistoryState {
  index: number
}

let index = 0
let maxIndex = 0
let onRoute: (route: Route, options: { replace: boolean }) => void = () => {}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseRoute(url: URL = new URL(window.location.href)): Route {
  if (url.pathname.replace(/\/$/, '') === '/stats') {
    return { folderId: ROOT, photoId: null, stats: true }
  }
  const match = /^\/f\/([0-9a-f-]+)\/?$/i.exec(url.pathname)
  const folderId = match && UUID_RE.test(match[1] as string) ? (match[1] as string).toLowerCase() : ROOT
  const raw = url.searchParams.get('p')
  const photoId = raw && UUID_RE.test(raw) ? raw.toLowerCase() : null
  return { folderId, photoId }
}

export function hrefFor(route: Route): string {
  if (route.stats) return '/stats'
  const path = route.folderId === ROOT ? '/' : `/f/${route.folderId}`
  return route.photoId ? `${path}?p=${route.photoId}` : path
}

export function canGoBack(): boolean {
  return index > 0
}

export function canGoForward(): boolean {
  return index < maxIndex
}

export function go(route: Route, replace = false): void {
  const href = hrefFor(route)
  if (replace) {
    history.replaceState({ index } satisfies HistoryState, '', href)
  } else {
    index += 1
    maxIndex = index
    history.pushState({ index } satisfies HistoryState, '', href)
  }
  onRoute(route, { replace })
}

export function back(): void {
  if (canGoBack()) history.back()
}

export function forward(): void {
  if (canGoForward()) history.forward()
}

export function startRouter(handler: typeof onRoute): void {
  onRoute = handler

  const existing = history.state as HistoryState | null
  index = typeof existing?.index === 'number' ? existing.index : 0
  maxIndex = Math.max(maxIndex, index)
  history.replaceState({ index } satisfies HistoryState, '', hrefFor(parseRoute()))

  window.addEventListener('popstate', (event) => {
    const restored = event.state as HistoryState | null
    if (typeof restored?.index === 'number') index = restored.index
    maxIndex = Math.max(maxIndex, index)
    onRoute(parseRoute(), { replace: true })
  })

  // One delegated handler for every in-app link, so views can just emit
  // ordinary anchors and still get client-side navigation.
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0) return
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const anchor = (event.target as Element | null)?.closest?.('a[data-link]')
    if (!(anchor instanceof HTMLAnchorElement)) return
    const url = new URL(anchor.href, window.location.origin)
    if (url.origin !== window.location.origin) return
    event.preventDefault()
    go(parseRoute(url))
  })

  onRoute(parseRoute(), { replace: true })
}
