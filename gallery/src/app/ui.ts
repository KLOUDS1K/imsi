/** DOM plumbing shared by every view: elements, toasts, menus and sheets. */
import { icon, paintIcons } from './icons'

type Attrs = Record<string, string | number | boolean | null | undefined>

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: (Node | string | null | undefined)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue
    if (key === 'class') node.className = String(value)
    else if (key === 'html') node.innerHTML = String(value)
    else if (key === 'text') node.textContent = String(value)
    else if (key.startsWith('--')) node.style.setProperty(key, String(value))
    else if (value === true) node.setAttribute(key, '')
    else node.setAttribute(key, String(value))
  }
  for (const child of children) {
    if (child === null || child === undefined) continue
    node.append(typeof child === 'string' ? document.createTextNode(child) : child)
  }
  return node
}

export function need<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T {
  const node = root.querySelector<T>(sel)
  if (!node) throw new Error(`Missing element: ${sel}`)
  return node
}

// -------------------------------------------------------------------- toasts

let toastHost: HTMLElement | null = null

export function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  const host = (toastHost ??= need<HTMLElement>('[data-role="toasts"]'))
  const node = el('div', { class: `toast toast--${kind}`, role: 'status' }, [
    el('span', { class: 'toast__icon', html: icon(kind === 'error' ? 'info' : 'check') }),
    el('span', { text: message }),
  ])
  host.append(node)
  // Let the element land in the DOM before the entrance transition starts.
  requestAnimationFrame(() => node.classList.add('is-in'))
  setTimeout(() => {
    node.classList.remove('is-in')
    node.addEventListener('transitionend', () => node.remove(), { once: true })
    setTimeout(() => node.remove(), 600)
  }, kind === 'error' ? 6000 : 3200)
}

// ------------------------------------------------------------- context menu

export interface MenuItem {
  label: string
  icon?: string
  danger?: boolean
  run: () => void
}

let closeMenu: (() => void) | null = null
let menuAnchor: Element | null = null

/**
 * `anchor` is the control that opened the menu, and passing it makes that
 * control a toggle. Without it the button flickers: the document-level
 * pointerdown closes the menu, and the click that follows immediately reopens
 * it, so a press looks like the menu vanishing and coming back on release.
 */
export function openMenu(
  items: MenuItem[],
  x: number,
  y: number,
  anchor: Element | null = null,
): void {
  const reclick = anchor !== null && menuAnchor === anchor
  closeMenu?.()
  if (reclick) return

  menuAnchor = anchor
  const host = need('[data-role="menu"]')
  host.innerHTML = ''
  host.hidden = false
  host.setAttribute('role', 'menu')

  items.forEach((item, index) => {
    const button = el('button', {
      class: `menu__item${item.danger ? ' menu__item--danger' : ''}`,
      type: 'button',
      role: 'menuitem',
      '--i': String(index),
    }, [
      el('span', { class: 'menu__icon', html: item.icon ? icon(item.icon) : '' }),
      el('span', { text: item.label }),
    ])
    button.addEventListener('click', () => {
      closeMenu?.()
      item.run()
    })
    host.append(button)
  })

  // Measure before positioning: a menu opened near the right or bottom edge
  // has to flip back inside the viewport rather than extend the page.
  const { width, height } = host.getBoundingClientRect()
  const left = Math.min(x, window.innerWidth - width - 12)
  const top = Math.min(y, window.innerHeight - height - 12)
  host.style.left = `${Math.max(12, left)}px`
  host.style.top = `${Math.max(12, top)}px`
  host.classList.add('is-open')

  const dismiss = (event?: Event) => {
    if (event && host.contains(event.target as Node)) return
    // Leave the trigger alone on pointerdown; its own click closes the menu.
    if (event && anchor?.contains(event.target as Node)) return
    menuAnchor = null
    host.classList.remove('is-open')
    host.hidden = true
    document.removeEventListener('pointerdown', dismiss, true)
    document.removeEventListener('keydown', onKey, true)
    window.removeEventListener('resize', dismiss)
    window.removeEventListener('scroll', dismiss, true)
    closeMenu = null
  }
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      dismiss()
    }
  }

  closeMenu = dismiss
  // Deferred so the pointerdown that opened the menu does not close it again.
  setTimeout(() => {
    if (closeMenu !== dismiss) return
    document.addEventListener('pointerdown', dismiss, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', dismiss)
    window.addEventListener('scroll', dismiss, true)
  }, 0)
}

// -------------------------------------------------------------------- sheet

export interface SheetField {
  name: string
  label: string
  value?: string
  type?: 'text' | 'password' | 'date' | 'textarea' | 'select'
  placeholder?: string
  required?: boolean
  minLength?: number
  autocomplete?: string
  hint?: string
  options?: { value: string; label: string }[]
}

export interface SheetSpec {
  title: string
  description?: string
  fields?: SheetField[]
  submitLabel: string
  danger?: boolean
  /** Return a message to keep the sheet open and show an error. */
  onSubmit: (values: Record<string, string>) => Promise<string | void> | string | void
}

let closeSheet: (() => void) | null = null

export function openSheet(spec: SheetSpec): void {
  closeSheet?.()
  const listeners = new AbortController()
  const restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const app = document.querySelector<HTMLElement>('.app')
  const appWasInert = app?.inert ?? false
  if (app) app.inert = true
  const host = need('[data-role="sheet"]')
  host.innerHTML = ''
  host.hidden = false

  const errorEl = el('p', { class: 'sheet__error', hidden: true })
  const form = el('form', { class: 'sheet__form', novalidate: true })

  const inputs: HTMLElement[] = []
  for (const field of spec.fields ?? []) {
    const id = `f-${field.name}`
    let control: HTMLElement

    if (field.type === 'textarea') {
      control = el('textarea', {
        id,
        name: field.name,
        class: 'input input--area',
        rows: 3,
        placeholder: field.placeholder ?? '',
        required: field.required,
        minlength: field.minLength,
      })
      ;(control as HTMLTextAreaElement).value = field.value ?? ''
    } else if (field.type === 'select') {
      const select = el('select', { id, name: field.name, class: 'input', required: field.required })
      for (const option of field.options ?? []) {
        select.append(el('option', { value: option.value, text: option.label }))
      }
      select.value = field.value ?? ''
      control = select
    } else {
      control = el('input', {
        id,
        name: field.name,
        class: 'input',
        type: field.type ?? 'text',
        placeholder: field.placeholder ?? '',
        autocomplete: field.autocomplete ?? 'off',
        minlength: field.minLength,
        required: field.required,
        value: field.value ?? '',
      })
    }

    inputs.push(control)
    form.append(
      el('label', { class: 'field' }, [
        el('span', { class: 'field__label', text: field.label }),
        control,
        field.hint ? el('span', { class: 'field__hint', text: field.hint }) : null,
      ]),
    )
  }

  const submit = el('button', {
    class: `btn btn--primary${spec.danger ? ' btn--danger' : ''}`,
    type: 'submit',
    text: spec.submitLabel,
  })
  const cancel = el('button', { class: 'btn', type: 'button', text: 'Cancel' })

  form.append(errorEl, el('div', { class: 'sheet__actions' }, [cancel, submit]))

  const titleId = `sheet-title-${crypto.randomUUID()}`
  const card = el('div', {
    class: 'sheet__card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId,
  }, [
    el('h2', { class: 'sheet__title', id: titleId, text: spec.title }),
    spec.description ? el('p', { class: 'sheet__desc', text: spec.description }) : null,
    form,
  ])
  host.append(card)

  const dismiss = () => {
    if (closeSheet !== dismiss) return
    listeners.abort()
    host.classList.remove('is-open')
    host.hidden = true
    host.innerHTML = ''
    closeSheet = null
    if (app) app.inert = appWasInert
    restoreFocus?.focus?.()
  }
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      dismiss()
      return
    }
    if (event.key === 'Tab') {
      const focusable = [...card.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
      )].filter((node) => !node.hidden)
      if (!focusable.length) {
        event.preventDefault()
        card.focus()
        return
      }
      const first = focusable[0] as HTMLElement
      const last = focusable[focusable.length - 1] as HTMLElement
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
  }

  closeSheet = dismiss
  requestAnimationFrame(() => {
    if (closeSheet === dismiss) host.classList.add('is-open')
  })
  cancel.addEventListener('click', dismiss, { signal: listeners.signal })
  host.addEventListener('pointerdown', (event) => {
    if (event.target === host) dismiss()
  }, { signal: listeners.signal })
  document.addEventListener('keydown', onKey, { capture: true, signal: listeners.signal })

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (!form.checkValidity()) {
      form.reportValidity()
      return
    }
    errorEl.hidden = true
    submit.disabled = true
    const values: Record<string, string> = {}
    for (const control of inputs) {
      const named = control as HTMLInputElement
      values[named.name] = named.value
    }
    try {
      const message = await spec.onSubmit(values)
      if (message) {
        errorEl.textContent = message
        errorEl.hidden = false
        submit.disabled = false
        return
      }
      dismiss()
    } catch (err) {
      errorEl.textContent = err instanceof Error ? err.message : 'Could not complete that'
      errorEl.hidden = false
      submit.disabled = false
    }
  }, { signal: listeners.signal })

  const first = inputs[0] as HTMLInputElement | undefined
  ;(first ?? submit).focus()
  if (first && 'select' in first) first.select()
}

export { paintIcons }
