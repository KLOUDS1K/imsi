/**
 * The viewer.
 *
 * It is a route, not a mode: opening a photo pushes `?p=<id>`, stepping to the
 * next one replaces that entry, and closing goes back. So the browser's back
 * gesture leaves the viewer instead of leaving the folder, and a link to a
 * single photo opens straight onto it.
 */
import type { Photo } from '../shared/types'
import {
  displayName,
  formatBytes,
  formatDate,
  formatDimensions,
  formatKind,
  formatTimestamp,
} from '../shared/types'
import { icon } from './icons'
import { el, need } from './ui'
import { downloadOriginal } from './download'
import { openPhotoInStudio } from './studio-link'
import { go, parseRoute } from './router'
import { morph } from './motion'
import type { Upgrade } from './fullsize'
import { isRenderable, loadOriginal, wantsOriginal } from './fullsize'

let sequence: Photo[] = []
let openId: string | null = null
let host: HTMLElement | null = null
let restoreFocus: HTMLElement | null = null
let gesturesBound = false
/** The <img> currently on the stage — the other half of the open/close morph. */
let stageImg: HTMLElement | null = null

/** The thumbnail a photo is showing in behind the viewer, grid or list. */
function thumbnailFor(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.tile[data-photo="${id}"] .tile__img`)
    ?? document.querySelector<HTMLElement>(`.row[data-photo="${id}"] .row__thumb img`)
}
/** Re-fit on resize while the viewer is open. */
let refit: (() => void) | null = null
/** The original being warmed for the photo on screen, if any. */
let upgrade: Upgrade | null = null
/** Asks the photo on screen for its real pixels — set up by `paint`. */
let demandOriginal: (() => void) | null = null
/**
 * Which paint owns the stage. Every paint throws the previous DOM away, but the
 * image it left behind goes on loading, and its handlers still hold references
 * to elements that are no longer in the document. The counter is how a handler
 * asks "am I still the one on screen?" before doing anything.
 */
let generation = 0

function dropUpgrade(): void {
  upgrade?.cancel()
  upgrade = null
  demandOriginal = null
}

/**
 * Sizes the figure to the photo, letterboxed inside the stage and never
 * enlarged past the original's own pixel dimensions.
 */
function fitFigure(
  stage: HTMLElement,
  figure: HTMLElement,
  width: number,
  height: number,
): void {
  if (!width || !height) return
  const rect = stage.getBoundingClientRect()
  const style = getComputedStyle(stage)
  const availableW =
    rect.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
  const availableH =
    rect.height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
  if (availableW <= 0 || availableH <= 0) return

  if (stage.classList.contains('is-zoomed')) {
    figure.style.width = `${width}px`
    figure.style.height = `${height}px`
    return
  }

  const scale = Math.min(availableW / width, availableH / height, 1)
  figure.style.width = `${Math.round(width * scale)}px`
  figure.style.height = `${Math.round(height * scale)}px`
}

/** The list the arrows step through — whatever the pane is currently showing. */
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
  if (at < 0) return
  const next = sequence[at + delta]
  if (!next) return
  // No paint() here. go() runs the route handler, which calls syncViewer and
  // repaints — doing it again built the whole viewer a second time on every
  // arrow press and left the first copy loading into a stage nobody could see.
  go({ folderId: next.folderId, photoId: next.id }, true)
}

function close(): void {
  const route = parseRoute()
  if (route.photoId) history.back()
  else teardown()
}

function teardown(): void {
  if (!host) return
  dropUpgrade()
  host.classList.remove('is-open')
  host.hidden = true
  host.innerHTML = ''
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
  switch (event.key) {
    case 'Escape':
      event.preventDefault()
      event.stopPropagation()
      close()
      break
    case 'ArrowLeft':
      event.preventDefault()
      step(-1)
      break
    case 'ArrowRight':
    case ' ':
      event.preventDefault()
      step(1)
      break
    case 'Home':
      event.preventDefault()
      if (sequence[0]) go({ folderId: sequence[0].folderId, photoId: sequence[0].id }, true)
      break
    case 'End': {
      event.preventDefault()
      const last = sequence[sequence.length - 1]
      if (last) go({ folderId: last.folderId, photoId: last.id }, true)
      break
    }
  }
}

/** Warms the neighbours so an arrow press shows the next frame immediately. */
function preloadNeighbours(index: number): void {
  for (const offset of [1, -1]) {
    const neighbour = sequence[index + offset]
    if (!neighbour) continue
    const img = new Image()
    img.decoding = 'async'
    img.src = neighbour.previewUrl ?? neighbour.thumbUrl
  }
}

function paint(photo: Photo): void {
  if (!host) return
  const index = sequence.findIndex((p) => p.id === photo.id)
  const name = displayName(photo)
  // Stepping to another frame abandons whatever was being warmed for this one.
  dropUpgrade()
  const mine = ++generation
  openId = photo.id

  host.innerHTML = ''
  host.hidden = false
  document.documentElement.classList.add('is-viewing')

  // ------------------------------------------------------------------ chrome
  const download = el('button', {
    class: 'viewer__btn viewer__btn--download',
    type: 'button',
    title: 'Download original',
    'aria-label': `Download the original of ${name}`,
  }, [
    el('span', { class: 'viewer__btn-icon', html: icon('download') }),
    el('span', { class: 'viewer__btn-text', text: 'Original' }),
  ])
  download.addEventListener('click', () => downloadOriginal(photo))

  const edit = el('button', {
    class: 'viewer__btn',
    type: 'button',
    title: 'Edit in KLOUD Studio',
    'aria-label': `Edit ${name} in KLOUD Studio`,
  }, [
    el('span', { class: 'viewer__btn-icon', html: icon('pencil') }),
    el('span', { class: 'viewer__btn-text', text: 'Edit' }),
  ])
  edit.addEventListener('click', () => openPhotoInStudio(photo))

  const closeBtn = el('button', {
    class: 'viewer__btn viewer__btn--icon',
    type: 'button',
    title: 'Close (Esc)',
    'aria-label': 'Close',
    html: icon('close'),
  })
  closeBtn.addEventListener('click', close)

  /*
   * Quiet until there is something true to say. It ends up in one of two
   * states: a label, once the uploaded file itself is on screen; or an offer,
   * when the file is large enough that pulling it down uninvited would be rude
   * — in which case saying nothing would be worse, because the viewer would
   * have no way of knowing there was anything more to see.
   */
  const badge = el('button', {
    class: 'viewer__badge',
    type: 'button',
    text: 'Original',
    hidden: true,
  })

  const bar = el('header', { class: 'viewer__bar' }, [
    el('div', { class: 'viewer__id' }, [
      el('span', { class: 'viewer__name', text: name, title: name }),
      el('span', {
        class: 'viewer__count',
        text: sequence.length > 1 ? `${index + 1} / ${sequence.length}` : '',
      }),
      badge,
    ]),
    el('div', { class: 'viewer__tools' }, [edit, download, closeBtn]),
  ])

  // ------------------------------------------------------------------- stage
  const stage = el('div', { class: 'viewer__stage' })
  const figure = el('figure', { class: 'viewer__figure' })

  if (photo.width && photo.height) {
    figure.style.setProperty('--ar', `${photo.width} / ${photo.height}`)
  }
  if (photo.placeholder) {
    figure.style.backgroundImage = `url("${photo.placeholder}")`
  }

  // Dimensions come from the metadata when it has them; a photo committed
  // before those were recorded falls back to what the decoded file reports.
  let naturalW = photo.width ?? 0
  let naturalH = photo.height ?? 0
  const fit = () => fitFigure(stage, figure, naturalW, naturalH)

  /*
   * What goes up first. The preview is there to be quick; the original follows
   * and replaces it below. When a photo has no preview at all — a format the
   * uploading browser could not re-encode — the original is the only candidate
   * there has ever been, so it goes straight up if it is one browsers paint.
   */
  const startedOnOriginal = !photo.previewUrl && isRenderable(photo)
  const img = el('img', {
    class: 'viewer__img',
    src: photo.previewUrl ?? (startedOnOriginal ? photo.originalUrl : photo.thumbUrl),
    alt: name,
    decoding: 'async',
  })
  figure.dataset.quality = startedOnOriginal ? 'original' : 'preview'
  badge.hidden = !startedOnOriginal
  /** Rewrites the caption's facts line; wired up once the caption exists. */
  let retellFacts: (width: number, height: number) => void = () => undefined

  /** Puts the real file on screen. The old frame stays until this one paints. */
  const applyOriginal = (url: string, width: number, height: number): void => {
    if (mine !== generation || openId !== photo.id) return
    img.src = url
    figure.dataset.quality = 'original'
    badge.hidden = false
    badge.textContent = 'Original'
    badge.disabled = true
    badge.title = 'You are looking at the uploaded file itself, at full resolution.'
    badge.classList.remove('viewer__badge--ask')
    // A photo committed before dimensions were recorded had them read off the
    // preview; the original is the honest answer, and 1:1 zoom depends on it.
    if (width && height && (width !== naturalW || height !== naturalH)) {
      naturalW = width
      naturalH = height
      // The caption was printed from the recorded metadata. Now that the file
      // itself has answered, say what it actually says.
      retellFacts(width, height)
    }
    fit()
  }

  const beginUpgrade = (force: boolean): void => {
    if (mine !== generation) return
    if (upgrade || figure.dataset.quality === 'original') return
    if (!wantsOriginal(photo, force)) return
    upgrade = loadOriginal(photo, applyOriginal)
  }
  // Zooming is a request for real pixels, so it overrides the data budget that
  // would otherwise leave a phone on the preview.
  demandOriginal = () => beginUpgrade(true)

  // Held back on size alone: offer it rather than decide for them.
  if (!startedOnOriginal && !wantsOriginal(photo) && wantsOriginal(photo, true)) {
    badge.hidden = false
    badge.textContent = 'Show original'
    badge.title = `Load the full ${formatBytes(photo.size)} file`
    badge.classList.add('viewer__badge--ask')
    badge.addEventListener('click', (event) => {
      event.stopPropagation()
      badge.disabled = true
      badge.textContent = 'Loading'
      demandOriginal?.()
    })
  }

  img.addEventListener('load', () => {
    if (mine !== generation) return
    if (!naturalW || !naturalH) {
      naturalW = img.naturalWidth
      naturalH = img.naturalHeight
      fit()
    }
    figure.classList.add('is-loaded')
    preloadNeighbours(index)
    // Only now: the preview's job is to be first, and it cannot be that while
    // sharing the connection with a file forty times its size.
    beginUpgrade(false)
  })
  img.addEventListener('error', () => {
    // Something is already on screen and the swap to the original failed: keep
    // what works rather than trading a good frame for an apology.
    if (figure.classList.contains('is-loaded')) return

    // A preview that was recorded but is not in storage. The original is right
    // there and the browser can paint it, so try that before giving up — an
    // apology for a photo that could have been shown is the worse answer.
    if (!startedOnOriginal && isRenderable(photo) && !img.src.includes('/media/o/')) {
      figure.dataset.quality = 'original'
      badge.hidden = false
      img.src = photo.originalUrl
      return
    }
    figure.classList.add('is-loaded', 'viewer__figure--fallback')
    img.remove()
    figure.append(
      el('span', { class: 'viewer__fallback' }, [
        el('span', { class: 'viewer__fallback-glyph', html: icon('image') }),
        el('span', {
          class: 'viewer__fallback-text',
          text: `No preview could be generated for this ${formatKind(photo)} file — the original is still available to download.`,
        }),
      ]),
    )
  })
  figure.append(img)
  stageImg = img

  // Click to toggle between fit-to-screen and 1:1, the way a viewer should.
  figure.addEventListener('click', (event) => {
    event.stopPropagation()
    stage.classList.toggle('is-zoomed')
    if (stage.classList.contains('is-zoomed')) demandOriginal?.()
    fit()
  })
  stage.addEventListener('click', close)
  stage.append(figure)

  // ------------------------------------------------------------------ arrows
  if (sequence.length > 1) {
    const prev = el('button', {
      class: 'viewer__arrow viewer__arrow--prev',
      type: 'button',
      title: 'Previous',
      'aria-label': 'Previous photo',
      html: icon('back'),
      disabled: index <= 0,
    })
    const next = el('button', {
      class: 'viewer__arrow viewer__arrow--next',
      type: 'button',
      title: 'Next',
      'aria-label': 'Next photo',
      html: icon('forward'),
      disabled: index >= sequence.length - 1,
    })
    prev.addEventListener('click', (event) => {
      event.stopPropagation()
      step(-1)
    })
    next.addEventListener('click', (event) => {
      event.stopPropagation()
      step(1)
    })
    stage.append(prev, next)
  }

  // ------------------------------------------------------------------ caption
  const facts = [formatKind(photo), formatDimensions(photo), formatBytes(photo.size)]
  const when = photo.date ? formatDate(photo.date) : formatTimestamp(photo.createdAt)
  if (when) facts.push(when)

  const factsLine = el('span', { class: 'viewer__facts', text: facts.filter(Boolean).join('  ·  ') })
  retellFacts = (width, height) => {
    const told = [...facts]
    told[1] = `${width} × ${height}`
    factsLine.textContent = told.filter(Boolean).join('  ·  ')
  }

  const caption = el('figcaption', { class: 'viewer__caption' }, [
    factsLine,
    photo.title.trim() && photo.title.trim() !== photo.filename
      ? el('span', { class: 'viewer__file', text: `Original filename — ${photo.filename}` })
      : null,
    photo.description ? el('span', { class: 'viewer__desc', text: photo.description }) : null,
  ])

  host.append(bar, stage, caption)
  // The stage has to be in the document before it can be measured.
  fit()
  refit = fit
  requestAnimationFrame(() => host?.classList.add('is-open'))
}

// ------------------------------------------------------------------ gestures

function initGestures(node: HTMLElement): void {
  if (gesturesBound) return
  gesturesBound = true
  let startX = 0
  let startY = 0
  let tracking = false

  node.addEventListener('touchstart', (event) => {
    if (event.touches.length !== 1) return
    const touch = event.touches[0] as Touch
    startX = touch.clientX
    startY = touch.clientY
    tracking = true
  }, { passive: true })

  node.addEventListener('touchend', (event) => {
    if (!tracking) return
    tracking = false
    const touch = event.changedTouches[0]
    if (!touch) return
    const dx = touch.clientX - startX
    const dy = touch.clientY - startY
    // Horizontal intent only, and far enough that it is not a tap.
    if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.4) return
    step(dx < 0 ? 1 : -1)
  }, { passive: true })
}

// ---------------------------------------------------------------------- sync

/**
 * Called after every route change: opens, switches or closes the viewer so it
 * always agrees with the URL.
 */
export function syncViewer(photoId: string | null): void {
  const node = (host ??= need<HTMLElement>('[data-role="lightbox"]'))

  if (!photoId) {
    if (openId) {
      // Fold the photo back into the thumbnail it came from.
      const returning = openId
      morph(stageImg, teardown, () => thumbnailFor(returning))
    }
    return
  }

  const photo = sequence.find((p) => p.id === photoId)
  if (!photo) {
    // The link points at a photo this folder is not showing — most likely a
    // stale URL. Drop the parameter and stay in the folder.
    if (openId) teardown()
    go({ folderId: parseRoute().folderId, photoId: null }, true)
    return
  }

  if (openId === photoId) return

  if (openId) {
    // Already open and stepping to another frame — no morph, just repaint.
    paint(photo)
    return
  }

  restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  document.addEventListener('keydown', onKey, true)
  window.addEventListener('resize', onResize)
  initGestures(node)

  morph(thumbnailFor(photoId), () => paint(photo), () => stageImg)
  node.focus?.()
}
