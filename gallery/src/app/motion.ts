/**
 * Motion and pointer feedback.
 *
 * Two rules hold everywhere in here:
 *   - nothing runs for `prefers-reduced-motion: reduce`, and nothing
 *     pointer-driven runs for a coarse pointer (a phone has no hover state to
 *     reward, and the listeners would just cost battery);
 *   - the pointer handler never writes to the DOM outside a rAF, and it writes
 *     custom properties only — the compositor does the rest.
 */

const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
const finePointer = () => window.matchMedia('(pointer: fine)').matches

export function motionAllowed(): boolean {
  return !reduceMotion()
}

// ------------------------------------------------------------------ pointer

/**
 * Tilts a card towards the cursor and moves a specular highlight with it.
 * One delegated listener for the whole pane, whatever the item count.
 */
export function initPointerTilt(root: HTMLElement): void {
  if (!finePointer() || reduceMotion()) return

  let active: HTMLElement | null = null
  let queued: { node: HTMLElement; x: number; y: number } | null = null
  let frame = 0

  const clear = (node: HTMLElement) => {
    node.classList.remove('is-tilting')
    node.style.removeProperty('--px')
    node.style.removeProperty('--py')
    node.style.removeProperty('--mx')
    node.style.removeProperty('--my')
  }

  const flush = () => {
    frame = 0
    if (!queued) return
    const { node, x, y } = queued
    const rect = node.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    const px = (x - rect.left) / rect.width
    const py = (y - rect.top) / rect.height
    node.style.setProperty('--px', (px * 2 - 1).toFixed(3))
    node.style.setProperty('--py', (py * 2 - 1).toFixed(3))
    node.style.setProperty('--mx', `${(px * 100).toFixed(1)}%`)
    node.style.setProperty('--my', `${(py * 100).toFixed(1)}%`)
  }

  root.addEventListener(
    'pointermove',
    (event) => {
      if (event.pointerType !== 'mouse') return
      const found = (event.target as Element | null)?.closest?.('.card, .tile')
      const node = found instanceof HTMLElement ? found : null

      if (node !== active) {
        if (active) clear(active)
        active = node
        if (node) node.classList.add('is-tilting')
      }
      if (!node) return

      queued = { node, x: event.clientX, y: event.clientY }
      if (!frame) frame = requestAnimationFrame(flush)
    },
    { passive: true },
  )

  const release = () => {
    if (!active) return
    clear(active)
    active = null
    queued = null
  }
  root.addEventListener('pointerleave', release)
  window.addEventListener('blur', release)
  // A grid redraw can remove the element the cursor was over.
  root.addEventListener('scroll', release, { passive: true })
}

/** Adds a shadow under the chrome once the pane has scrolled away from the top. */
export function initScrollShade(pane: HTMLElement, app: HTMLElement): void {
  let last = false
  pane.addEventListener(
    'scroll',
    () => {
      const scrolled = pane.scrollTop > 4
      if (scrolled === last) return
      last = scrolled
      app.classList.toggle('is-scrolled', scrolled)
    },
    { passive: true },
  )
}

// --------------------------------------------------------- view transitions

interface ViewTransition {
  ready: Promise<void>
  finished: Promise<void>
  updateCallbackDone: Promise<void>
}

type StartViewTransition = (callback: () => void | Promise<void>) => ViewTransition

function startViewTransition(): StartViewTransition | null {
  const start = (document as Document & { startViewTransition?: StartViewTransition })
    .startViewTransition
  if (!start || reduceMotion()) return null
  return start.bind(document) as StartViewTransition
}

/**
 * Runs `update` inside a view transition when the browser has one, and plainly
 * when it does not. `kind` becomes a class on <html> for the duration, so the
 * stylesheet can give each transition its own choreography.
 */
export function transition(kind: string, update: () => void): Promise<void> {
  const start = startViewTransition()
  if (!start) {
    update()
    return Promise.resolve()
  }

  const root = document.documentElement
  root.classList.add(`vt-${kind}`)
  const view = start(update)
  const done = view.finished.finally(() => root.classList.remove(`vt-${kind}`))
  return done
}

/**
 * The theme swap, revealed as a circle growing from the button that was
 * clicked. The default root cross-fade is switched off in CSS for this one, so
 * the outgoing page stays put while the new one is wiped in over it.
 */
export function themeTransition(origin: { x: number; y: number }, update: () => void): void {
  const start = startViewTransition()
  if (!start) {
    update()
    return
  }

  const root = document.documentElement
  root.classList.add('vt-theme')
  const view = start(update)

  void view.ready
    .then(() => {
      const { x, y } = origin
      const radius = Math.hypot(
        Math.max(x, window.innerWidth - x),
        Math.max(y, window.innerHeight - y),
      )
      return root.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        {
          duration: 520,
          easing: 'cubic-bezier(0.22, 0.68, 0.28, 1)',
          pseudoElement: '::view-transition-new(root)',
        },
      ).finished
    })
    .catch(() => undefined)
    .finally(() => {
      void view.finished.finally(() => root.classList.remove('vt-theme'))
    })
}

/**
 * The viewer opening out of, and folding back into, the thumbnail that was
 * clicked. Both elements briefly carry the same view-transition-name — never
 * at the same time, which the API forbids — so the browser morphs one into the
 * other instead of cross-fading the whole screen.
 */
export const MORPH = 'photo-morph'

export function morph(
  from: HTMLElement | null,
  update: () => void,
  after?: () => HTMLElement | null,
): void {
  const start = startViewTransition()
  if (!start) {
    update()
    return
  }

  const root = document.documentElement
  root.classList.add('vt-morph')
  if (from) from.style.setProperty('view-transition-name', MORPH)

  const view = start(() => {
    if (from) from.style.removeProperty('view-transition-name')
    update()
    after?.()?.style.setProperty('view-transition-name', MORPH)
  })

  void view.finished.finally(() => {
    root.classList.remove('vt-morph')
    for (const node of document.querySelectorAll<HTMLElement>('[style*="view-transition-name"]')) {
      if (node.style.getPropertyValue('view-transition-name') === MORPH) {
        node.style.removeProperty('view-transition-name')
      }
    }
  })
}
