/** The upload panel: one row per file, from queued to done. */
import { icon } from './icons'
import { el, need } from './ui'

export type Stage = 'queued' | 'processing' | 'uploading' | 'finishing' | 'done' | 'failed'

const STAGE_TEXT: Record<Stage, string> = {
  queued: 'Queued',
  processing: 'Making preview',
  uploading: 'Uploading',
  finishing: 'Finishing',
  done: 'Done',
  failed: 'Failed',
}

export interface Transfer {
  stage(next: Stage, detail?: string): void
  progress(ratio: number): void
  finish(error?: string): void
}

interface Panel {
  host: HTMLElement
  head: HTMLElement
  list: HTMLElement
}

let panel: Panel | null = null
let active = 0
let completed = 0
let failed = 0
let hideTimer = 0

function ensurePanel(): Panel {
  if (panel) return panel

  const host = need<HTMLElement>('[data-role="transfers"]')
  host.innerHTML = ''

  const head = el('div', { class: 'transfers__head' })
  const list = el('div', { class: 'transfers__list' })

  const close = el('button', {
    class: 'icon-btn transfers__close',
    type: 'button',
    title: 'Close',
    'aria-label': 'Close the upload list',
    html: icon('close'),
  })
  close.addEventListener('click', () => hide())

  host.append(el('div', { class: 'transfers__bar' }, [head, close]), list)

  /*
   * On a phone the panel and the toasts share the bottom edge, so the toasts
   * sit on top of the panel. CSS alone could only lift them by the panel's
   * largest possible height, which left a one-line panel with a notice
   * floating halfway up the screen. The real height is published here instead.
   */
  if ('ResizeObserver' in window) {
    new ResizeObserver(() => {
      document.documentElement.style.setProperty('--transfers-h', `${host.offsetHeight}px`)
    }).observe(host)
  }

  panel = { host, head, list }
  return panel
}

function refreshHead(): void {
  const head = panel?.head
  if (!head) return
  if (active > 0) {
    head.textContent = `Uploading ${completed + failed + 1} of ${completed + failed + active}`
  } else if (failed > 0) {
    head.textContent = `${completed} done · ${failed} failed`
  } else {
    head.textContent = `${completed} done`
  }
}

function hide(): void {
  if (!panel) return
  panel.host.classList.remove('is-open')
  panel.host.hidden = true
  panel.list.innerHTML = ''
  completed = 0
  failed = 0
}

function scheduleHide(): void {
  window.clearTimeout(hideTimer)
  // Only tidy itself away when nothing went wrong — a failure has to stay on
  // screen until it is read.
  if (failed > 0) return
  hideTimer = window.setTimeout(() => {
    if (active === 0) hide()
  }, 4000)
}

export function beginTransfer(name: string, onCancel?: () => void): Transfer {
  const { host, list } = ensurePanel()
  window.clearTimeout(hideTimer)
  active += 1

  const label = el('span', { class: 'transfer__name', text: name, title: name })
  const status = el('span', { class: 'transfer__status', text: STAGE_TEXT.queued })
  const fill = el('span', { class: 'transfer__fill' })
  const top = el('div', { class: 'transfer__top' }, [label, status])
  if (onCancel) {
    const stop = el('button', {
      class: 'transfer__stop',
      type: 'button',
      title: 'Cancel',
      'aria-label': `Cancel ${name}`,
      html: icon('close'),
    })
    stop.addEventListener('click', () => {
      stop.remove()
      onCancel()
    })
    top.append(stop)
  }

  const row = el('div', { class: 'transfer' }, [
    top,
    el('div', { class: 'transfer__track' }, [fill]),
  ])

  list.prepend(row)
  host.hidden = false
  requestAnimationFrame(() => host.classList.add('is-open'))
  refreshHead()

  return {
    stage(next, detail) {
      status.textContent = detail ?? STAGE_TEXT[next]
      row.dataset.stage = next
      if (next === 'processing' || next === 'finishing') fill.classList.add('is-indeterminate')
      else fill.classList.remove('is-indeterminate')
    },
    progress(ratio) {
      fill.classList.remove('is-indeterminate')
      fill.style.width = `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`
    },
    finish(error) {
      active -= 1
      row.dataset.stage = error ? 'failed' : 'done'
      status.textContent = error ?? STAGE_TEXT.done
      if (error) {
        failed += 1
        row.classList.add('is-failed')
        fill.style.width = '100%'
      } else {
        completed += 1
        fill.style.width = '100%'
      }
      fill.classList.remove('is-indeterminate')
      refreshHead()
      if (active === 0) scheduleHide()
    },
  }
}
