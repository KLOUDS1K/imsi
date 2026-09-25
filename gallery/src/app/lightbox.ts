/** Route-backed photo viewer with original/edited switching and anchored zoom. */
import type { Photo } from '../shared/types'
import { displayName, formatBytes, formatDate, formatTimestamp } from '../shared/types'
import { icon } from './icons'
import { el, need } from './ui'
import { downloadEdited, downloadOriginal } from './download'
import { openPhotoInStudio } from './studio-link'
import { go, parseRoute } from './router'
import { morph } from './motion'
import type { Upgrade } from './fullsize'
import { isRenderable, loadOriginal, wantsOriginal } from './fullsize'
import { state } from './state'

type VariantKind = 'original' | 'edited'

interface Variant {
  kind: VariantKind
  label: string
  fullUrl: string
  previewUrl: string | null
  thumbUrl: string
  filename: string
  type: string
  size: number
  width: number | null
  height: number | null
}

let sequence: Photo[] = []
let openId: string | null = null
let host: HTMLElement | null = null
let restoreFocus: HTMLElement | null = null
let stageImg: HTMLElement | null = null
let refit: (() => void) | null = null
let upgrade: Upgrade | null = null
let generation = 0

function thumbnailFor(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.tile[data-photo="${id}"] .tile__img`)
    ?? document.querySelector<HTMLElement>(`.row[data-photo="${id}"] .row__thumb img`)
}

function dropUpgrade(): void {
  upgrade?.cancel()
  upgrade = null
}

function originalVariant(photo: Photo): Variant {
  return {
    kind: 'original',
    label: 'Original',
    fullUrl: photo.originalUrl,
    previewUrl: photo.originalPreviewUrl,
    thumbUrl: photo.originalThumbUrl,
    filename: photo.filename,
    type: photo.type,
    size: photo.size,
    width: photo.width,
    height: photo.height,
  }
}

function editedVariant(photo: Photo): Variant | null {
  if (!photo.editedUrl) return null
  return {
    kind: 'edited',
    label: 'Edited',
    fullUrl: photo.editedUrl,
    previewUrl: photo.editedPreviewUrl,
    thumbUrl: photo.editedThumbUrl ?? photo.editedPreviewUrl ?? photo.editedUrl,
    filename: photo.editedFilename ?? `edited-${photo.filename}`,
    type: photo.editedType ?? 'image/jpeg',
    size: photo.editedSize ?? 0,
    width: photo.editedWidth,
    height: photo.editedHeight,
  }
}

/** Reuse the original-loader's decode and device-budget safeguards for either variant. */
function asLoadable(photo: Photo, variant: Variant): Photo {
  return {
    ...photo,
    filename: variant.filename,
    type: variant.type,
    size: variant.size,
    width: variant.width,
    height: variant.height,
    originalUrl: variant.fullUrl,
    originalPreviewUrl: variant.previewUrl,
    originalThumbUrl: variant.thumbUrl,
    previewUrl: variant.previewUrl,
    thumbUrl: variant.thumbUrl,
  }
}

export function setSequence(photos: Photo[]): void {
  sequence = photos
}

export function openLightbox(photos: Photo[], id: string): void {
  setSequence(photos)
  const { folderId } = parseRoute()
  const photo = photos.find((p) => p.id === id)
  go({ folderId: photo?.folderId ?? folderId, photoId: id })
}

function step(delta: number): void {
  if (!openId) return
  const at = sequence.findIndex((p) => p.id === openId)
  const next = at >= 0 ? sequence[at + delta] : null
  if (next) go({ folderId: next.folderId, photoId: next.id }, true)
}

function close(): void {
  if (parseRoute().photoId) history.back()
  else teardown()
}

function teardown(): void {
  if (!host) return
  dropUpgrade()
  host.classList.remove('is-open')
  host.hidden = true
  host.replaceChildren()
  openId = null
  stageImg = null
  refit = null
  document.documentElement.classList.remove('is-viewing')
  document.removeEventListener('keydown', onKey, true)
  window.removeEventListener('resize', onResize)
  restoreFocus?.focus?.()
  restoreFocus = null
}

function onResize(): void {
  refit?.()
}

function onKey(event: KeyboardEvent): void {
  if (!openId) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    close()
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault()
    step(-1)
  } else if (event.key === 'ArrowRight' || event.key === ' ') {
    event.preventDefault()
    step(1)
  } else if (event.key === 'Home' && sequence[0]) {
    event.preventDefault()
    go({ folderId: sequence[0].folderId, photoId: sequence[0].id }, true)
  } else if (event.key === 'End') {
    event.preventDefault()
    const last = sequence[sequence.length - 1]
    if (last) go({ folderId: last.folderId, photoId: last.id }, true)
  }
}

function preloadNeighbours(index: number): void {
  for (const offset of [1, -1]) {
    const neighbour = sequence[index + offset]
    if (!neighbour) continue
    const img = new Image()
    img.decoding = 'async'
    img.src = neighbour.previewUrl ?? neighbour.thumbUrl
  }
}

interface Point { x: number; y: number }

function installZoom(
  stage: HTMLElement,
  figure: HTMLElement,
  dimensions: () => { width: number; height: number },
  demandFull: () => void,
): { fit(): void; reset(): void; dispose(): void } {
  const listeners = new AbortController()
  let fitScale = 1
  let scale = 1
  let panX = 0
  let panY = 0
  let zoomed = false
  let moved = false
  let start: Point | null = null
  let startOnPhoto = false
  let startPan: Point = { x: 0, y: 0 }
  const pointers = new Map<number, Point>()
  let pinch: { distance: number; scale: number; panX: number; panY: number; mid: Point } | null = null

  const bounds = () => {
    const rect = stage.getBoundingClientRect()
    const style = getComputedStyle(stage)
    return {
      rect,
      width: Math.max(1, rect.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)),
      height: Math.max(1, rect.height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)),
    }
  }

  const clampPan = () => {
    const { width, height } = dimensions()
    const b = bounds()
    const maxX = Math.max(0, (width * scale - b.width) / 2)
    const maxY = Math.max(0, (height * scale - b.height) / 2)
    panX = Math.max(-maxX, Math.min(maxX, panX))
    panY = Math.max(-maxY, Math.min(maxY, panY))
  }

  const draw = () => {
    const { width, height } = dimensions()
    if (!width || !height) return
    clampPan()
    figure.style.width = `${width}px`
    figure.style.height = `${height}px`
    figure.style.transform = `translate3d(calc(-50% + ${panX}px), calc(-50% + ${panY}px), 0) scale(${scale})`
    zoomed = scale > fitScale + 0.001
    stage.classList.toggle('is-zoomed', zoomed)
  }

  const scaleAround = (next: number, clientX: number, clientY: number) => {
    const b = bounds()
    const max = Math.max(4, fitScale * 8)
    next = Math.max(fitScale, Math.min(max, next))
    const cx = b.rect.left + b.rect.width / 2
    const cy = b.rect.top + b.rect.height / 2
    const sourceX = (clientX - cx - panX) / scale
    const sourceY = (clientY - cy - panY) / scale
    panX = clientX - cx - sourceX * next
    panY = clientY - cy - sourceY * next
    scale = next
    if (scale <= fitScale + 0.001) {
      scale = fitScale
      panX = 0
      panY = 0
    } else {
      demandFull()
    }
    draw()
  }

  const fit = () => {
    const { width, height } = dimensions()
    if (!width || !height) return
    const b = bounds()
    const nextFit = Math.min(b.width / width, b.height / height, 1)
    const wasFit = !zoomed
    fitScale = nextFit
    if (wasFit || scale < fitScale) {
      scale = fitScale
      panX = 0
      panY = 0
    }
    draw()
  }

  const reset = () => {
    zoomed = false
    panX = 0
    panY = 0
    fit()
  }

  const midpoint = (values: Point[]): Point => ({
    x: (values[0].x + values[1].x) / 2,
    y: (values[0].y + values[1].y) / 2,
  })
  const distance = (values: Point[]): number => Math.hypot(values[1].x - values[0].x, values[1].y - values[0].y)

  stage.addEventListener('wheel', (event) => {
    if (!(event.target as Element | null)?.closest('.viewer__figure')) return
    event.preventDefault()
    scaleAround(scale * Math.exp(-event.deltaY * 0.002), event.clientX, event.clientY)
  }, { passive: false, signal: listeners.signal })

  stage.addEventListener('pointerdown', (event) => {
    if ((event.target as Element | null)?.closest('button')) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const onPhoto = Boolean((event.target as Element | null)?.closest('.viewer__figure'))
    startOnPhoto = onPhoto
    if (!onPhoto && !zoomed) {
      start = { x: event.clientX, y: event.clientY }
      moved = false
      return
    }
    event.preventDefault()
    stage.setPointerCapture?.(event.pointerId)
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    moved = false
    start = { x: event.clientX, y: event.clientY }
    startPan = { x: panX, y: panY }
    if (pointers.size === 2) {
      const values = [...pointers.values()]
      pinch = { distance: Math.max(1, distance(values)), scale, panX, panY, mid: midpoint(values) }
      figure.classList.add('is-dragging')
    }
  }, { signal: listeners.signal })

  stage.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId)) return
    event.preventDefault()
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    const values = [...pointers.values()]
    if (values.length >= 2 && pinch) {
      moved = true
      const currentMid = midpoint(values)
      const b = bounds()
      const cx = b.rect.left + b.rect.width / 2
      const cy = b.rect.top + b.rect.height / 2
      const sourceX = (pinch.mid.x - cx - pinch.panX) / pinch.scale
      const sourceY = (pinch.mid.y - cy - pinch.panY) / pinch.scale
      scale = Math.max(fitScale, Math.min(Math.max(4, fitScale * 8), pinch.scale * distance(values) / pinch.distance))
      panX = currentMid.x - cx - sourceX * scale
      panY = currentMid.y - cy - sourceY * scale
      if (scale > fitScale + 0.001) demandFull()
      draw()
      return
    }
    if (!start) return
    const dx = event.clientX - start.x
    const dy = event.clientY - start.y
    if (Math.hypot(dx, dy) > 4) moved = true
    if (zoomed) {
      figure.classList.add('is-dragging')
      panX = startPan.x + dx
      panY = startPan.y + dy
      draw()
    }
  }, { signal: listeners.signal })

  const endPointer = (event: PointerEvent) => {
    const hadPointer = pointers.has(event.pointerId)
    pointers.delete(event.pointerId)
    try { stage.releasePointerCapture?.(event.pointerId) } catch { /* already released */ }
    figure.classList.remove('is-dragging')
    if (pointers.size < 2) pinch = null
    if (!hadPointer && !start) return

    const endedAt = { x: event.clientX, y: event.clientY }
    const dx = start ? endedAt.x - start.x : 0
    const dy = start ? endedAt.y - start.y : 0
    const target = event.target as Element | null
    const onPhoto = startOnPhoto
    const wasMoved = moved
    start = null
    startOnPhoto = false
    moved = false
    if (pointers.size) return

    if (!zoomed && wasMoved && Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      step(dx < 0 ? 1 : -1)
      return
    }
    if (wasMoved) return
    if (onPhoto) {
      if (zoomed) reset()
      else scaleAround(Math.max(0.5, fitScale * 1.5), event.clientX, event.clientY)
    } else if (target === stage) {
      close()
    }
  }
  stage.addEventListener('pointerup', endPointer, { signal: listeners.signal })
  stage.addEventListener('pointercancel', (event) => {
    pointers.delete(event.pointerId)
    start = null
    pinch = null
    figure.classList.remove('is-dragging')
  }, { signal: listeners.signal })

  // Older iOS Safari emits gesture events in addition to Pointer Events. If
  // they reach the page, Safari zooms the whole UI after the image snaps back.
  for (const name of ['gesturestart', 'gesturechange', 'gestureend']) {
    stage.addEventListener(name, (event) => event.preventDefault(), { passive: false, signal: listeners.signal })
  }

  return { fit, reset, dispose: () => listeners.abort() }
}

function paint(photo: Photo): void {
  if (!host) return
  const index = sequence.findIndex((p) => p.id === photo.id)
  const name = displayName(photo)
  const edited = editedVariant(photo)
  let selected: VariantKind = edited ? 'edited' : 'original'
  dropUpgrade()
  const mine = ++generation
  openId = photo.id

  host.replaceChildren()
  host.hidden = false
  document.documentElement.classList.add('is-viewing')

  const originalDownload = el('button', {
    class: 'viewer__btn viewer__btn--download', type: 'button', title: 'Download original',
    'aria-label': `Download the original of ${name}`,
  }, [el('span', { class: 'viewer__btn-icon', html: icon('download') }), el('span', { class: 'viewer__btn-text', text: 'Original' })])
  originalDownload.addEventListener('click', () => downloadOriginal(photo))

  const editedDownload = edited ? el('button', {
    class: 'viewer__btn viewer__btn--download-secondary', type: 'button', title: 'Download edited version',
    'aria-label': `Download the edited version of ${name}`,
  }, [el('span', { class: 'viewer__btn-icon', html: icon('download') }), el('span', { class: 'viewer__btn-text', text: 'Edited' })]) : null
  editedDownload?.addEventListener('click', () => downloadEdited(photo))

  const edit = state.admin ? el('button', {
    class: 'viewer__btn', type: 'button', title: 'Edit the original in KLOUD Studio',
    'aria-label': `Edit the original of ${name} in KLOUD Studio`,
  }, [el('span', { class: 'viewer__btn-icon', html: icon('pencil') }), el('span', { class: 'viewer__btn-text', text: 'Edit' })]) : null
  edit?.addEventListener('click', () => openPhotoInStudio(photo))

  const toggle = edited ? el('button', {
    class: 'viewer__btn viewer__btn--icon', type: 'button', html: icon('eye'),
  }) : null

  const closeBtn = el('button', {
    class: 'viewer__btn viewer__btn--icon', type: 'button', title: 'Close (Esc)', 'aria-label': 'Close', html: icon('close'),
  })
  closeBtn.addEventListener('click', close)

  const badge = el('span', { class: 'viewer__badge', text: edited ? 'Edited' : 'Original' })
  const bar = el('header', { class: 'viewer__bar' }, [
    el('div', { class: 'viewer__id' }, [
      el('span', { class: 'viewer__name', text: name, title: name }),
      el('span', { class: 'viewer__count', text: sequence.length > 1 ? `${index + 1} / ${sequence.length}` : '' }),
      badge,
    ]),
    el('div', { class: 'viewer__tools' }, [toggle, edit, originalDownload, editedDownload, closeBtn]),
  ])

  const stage = el('div', { class: 'viewer__stage' })
  let figure = el('figure', { class: 'viewer__figure' })
  let zoom: ReturnType<typeof installZoom> | null = null
  let retell: (variant: Variant) => void = () => undefined

  const showVariant = (kind: VariantKind) => {
    const variant = kind === 'edited' ? edited : originalVariant(photo)
    if (!variant) return
    selected = kind
    dropUpgrade()
    zoom?.dispose()
    const view = asLoadable(photo, variant)
    figure.remove()
    figure = el('figure', { class: 'viewer__figure' })
    if (photo.placeholder) figure.style.backgroundImage = `url("${photo.placeholder}")`
    let naturalW = variant.width ?? 0
    let naturalH = variant.height ?? 0
    const startedOnFull = !variant.previewUrl && isRenderable(view)
    const img = el('img', {
      class: 'viewer__img',
      src: variant.previewUrl ?? (startedOnFull ? variant.fullUrl : variant.thumbUrl),
      alt: `${name} — ${variant.label}`,
      decoding: 'async',
      draggable: false,
    })
    figure.dataset.quality = startedOnFull ? 'full' : 'preview'
    figure.append(img)
    stage.prepend(figure)
    stageImg = img
    badge.textContent = variant.label
    retell(variant)
    if (toggle) {
      const target = kind === 'edited' ? 'original' : 'edited'
      toggle.title = `Show ${target}`
      toggle.setAttribute('aria-label', `Show ${target} version of ${name}`)
      toggle.setAttribute('aria-pressed', String(kind === 'original'))
    }

    const applyFull = (url: string, width: number, height: number) => {
      if (mine !== generation || openId !== photo.id || selected !== kind) return
      img.src = url
      figure.dataset.quality = 'full'
      if (width && height) {
        naturalW = width
        naturalH = height
        zoom?.fit()
      }
    }
    const beginUpgrade = (force: boolean) => {
      if (mine !== generation || upgrade || figure.dataset.quality === 'full') return
      if (!wantsOriginal(view, force)) return
      upgrade = loadOriginal(view, applyFull)
    }

    zoom = installZoom(stage, figure, () => ({ width: naturalW, height: naturalH }), () => beginUpgrade(true))
    img.addEventListener('load', () => {
      if (mine !== generation || selected !== kind) return
      if (!naturalW || !naturalH) {
        naturalW = img.naturalWidth
        naturalH = img.naturalHeight
      }
      zoom?.fit()
      figure.classList.add('is-loaded')
      preloadNeighbours(index)
      beginUpgrade(false)
    })
    img.addEventListener('error', () => {
      if (figure.classList.contains('is-loaded')) return
      if (!startedOnFull && isRenderable(view) && figure.dataset.quality !== 'full') {
        figure.dataset.quality = 'full'
        img.src = variant.fullUrl
        return
      }
      figure.classList.add('is-loaded', 'viewer__figure--fallback')
      img.remove()
      figure.append(el('span', { class: 'viewer__fallback' }, [
        el('span', { class: 'viewer__fallback-glyph', html: icon('image') }),
        el('span', { class: 'viewer__fallback-text', text: `${variant.label} preview is unavailable. You can still download the file.` }),
      ]))
    })
    refit = () => zoom?.fit()
  }

  toggle?.addEventListener('click', () => showVariant(selected === 'edited' ? 'original' : 'edited'))
  stage.addEventListener('contextmenu', (event) => event.preventDefault())

  if (sequence.length > 1) {
    const prev = el('button', { class: 'viewer__arrow viewer__arrow--prev', type: 'button', title: 'Previous', 'aria-label': 'Previous photo', html: icon('back'), disabled: index <= 0 })
    const next = el('button', { class: 'viewer__arrow viewer__arrow--next', type: 'button', title: 'Next', 'aria-label': 'Next photo', html: icon('forward'), disabled: index >= sequence.length - 1 })
    prev.addEventListener('click', (event) => { event.stopPropagation(); step(-1) })
    next.addEventListener('click', (event) => { event.stopPropagation(); step(1) })
    stage.append(prev, next)
  }

  const factsLine = el('span', { class: 'viewer__facts' })
  const fileLine = el('span', { class: 'viewer__file' })
  retell = (variant) => {
    const when = photo.date ? formatDate(photo.date) : formatTimestamp(photo.createdAt)
    const ext = variant.filename.includes('.') ? variant.filename.split('.').pop()?.toUpperCase() : variant.type.split('/')[1]?.toUpperCase()
    const dims = variant.width && variant.height ? `${variant.width} × ${variant.height}` : '—'
    factsLine.textContent = [variant.label, ext ?? '', dims, formatBytes(variant.size), when].filter(Boolean).join('  ·  ')
    fileLine.textContent = `${variant.label} filename — ${variant.filename}`
  }
  const caption = el('figcaption', { class: 'viewer__caption' }, [
    factsLine,
    fileLine,
    photo.description ? el('span', { class: 'viewer__desc', text: photo.description }) : null,
  ])

  host.append(bar, stage, caption)
  showVariant(selected)
  requestAnimationFrame(() => host?.classList.add('is-open'))
}

export function syncViewer(photoId: string | null): void {
  const node = (host ??= need<HTMLElement>('[data-role="lightbox"]'))
  if (!photoId) {
    if (openId) {
      const returning = openId
      morph(stageImg, teardown, () => thumbnailFor(returning))
    }
    return
  }
  const photo = sequence.find((p) => p.id === photoId)
  if (!photo) {
    if (openId) teardown()
    go({ folderId: parseRoute().folderId, photoId: null }, true)
    return
  }
  if (openId === photoId) return
  if (openId) {
    paint(photo)
    return
  }
  restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  document.addEventListener('keydown', onKey, true)
  window.addEventListener('resize', onResize)
  morph(thumbnailFor(photoId), () => paint(photo), () => stageImg)
  node.focus?.()
}
