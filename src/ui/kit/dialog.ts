/**
 * Dialog / Modal + confirm and prompt helpers (what ctx.confirm / ctx.prompt
 * are built on).
 *
 *   const ok = await confirmDialog({ title: 'Delete 3 photos?', danger: true, confirmLabel: 'Delete' });
 *   const name = await promptDialog({ title: 'New preset', label: 'Name', value: 'Untitled' });
 *
 *   const dlg = openDialog<'save' | 'discard'>({ title: 'Unsaved edits', content: formEl, actions: [
 *     { label: 'Discard', value: 'discard', variant: 'ghost' },
 *     { label: 'Save', value: 'save', variant: 'primary', autofocus: true } ] });
 *   const choice = await dlg.result;   // null when dismissed
 *
 * Scrim uses --k-overlay; focus is trapped (Tab cycles, focus that escapes is
 * pulled back, except into popovers opened from the dialog); Escape and a scrim
 * click dismiss (unless `dismissible: false`); focus returns to the previously
 * focused element. On phones the dialog docks to the bottom edge.
 */
import './dialog.css';
import type { ConfirmOptions, PromptOptions } from '../../app/context';
import { Disposer, h, on } from '../dom';
import { type ButtonVariant, createButton, createIconButton } from './button';
import { createTextInput } from './controls';
import { type IconName } from './icons';
import { focusableIn, kitId, portalRoot } from './util';

export interface DialogAction<T> {
  label: string;
  value: T;
  variant?: ButtonVariant;
  icon?: IconName;
  autofocus?: boolean;
  /** Return false to keep the dialog open (e.g. validation failed). */
  onClick?: () => boolean | void;
}

export interface DialogOptions<T> {
  title: string;
  /** Muted paragraph under the title. */
  description?: string;
  content?: Node | string;
  actions?: DialogAction<T>[];
  /** sm 360px · md 480px (default) · lg 720px · xl 960px. */
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Escape / scrim / × resolve null. Default true. */
  dismissible?: boolean;
  /** Header × button. Default = dismissible. */
  closeButton?: boolean;
  /** Element to focus first (default: autofocus action, else first field, else the dialog). */
  initialFocus?: HTMLElement;
  class?: string;
  onClose?: (value: T | null) => void;
}

export interface Dialog<T> {
  /** The dialog panel. */
  readonly el: HTMLDivElement;
  /** Put custom content here (already contains `content`). */
  readonly body: HTMLDivElement;
  /** Resolves with the chosen action value, or null when dismissed. */
  readonly result: Promise<T | null>;
  close(value?: T | null): void;
  setTitle(title: string): void;
  /** Disable all actions and show a spinner on the primary one. */
  setBusy(busy: boolean): void;
}

const openDialogs: HTMLElement[] = [];
let savedOverflow = '';

export function openDialog<T = string>(opts: DialogOptions<T>): Dialog<T> {
  const d = new Disposer();
  const dismissible = opts.dismissible !== false;
  const prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const titleId = kitId('k-dialog-title');
  const descId = kitId('k-dialog-desc');

  let resolve!: (v: T | null) => void;
  const result = new Promise<T | null>((r) => (resolve = r));

  const titleEl = h('h2', { class: 'k-dialog__title', id: titleId }, opts.title);
  const head = h('header', { class: 'k-dialog__head' }, titleEl);
  if (opts.closeButton ?? dismissible) {
    const x = createIconButton({ icon: 'x', label: 'Close', size: 'sm', tooltip: false, onClick: () => close(null) });
    head.append(x.el);
    d.add(() => x.destroy());
  }
  const body = h(
    'div',
    { class: 'k-dialog__body' },
    opts.description ? h('p', { class: 'k-dialog__desc', id: descId }, opts.description) : null,
    typeof opts.content === 'string' ? h('p', { class: 'k-dialog__text' }, opts.content) : (opts.content ?? null),
  );
  const buttons = (opts.actions ?? []).map((a) => {
    const b = createButton({
      label: a.label,
      icon: a.icon,
      variant: a.variant ?? 'default',
      onClick: () => {
        if (a.onClick?.() === false) return;
        close(a.value);
      },
    });
    d.add(() => b.destroy());
    return { b, a };
  });
  const foot = buttons.length ? h('footer', { class: 'k-dialog__foot' }, ...buttons.map((x) => x.b.el)) : null;
  const panel = h(
    'div',
    {
      class: ['k-dialog', `k-dialog--${opts.size ?? 'md'}`, opts.class],
      tabIndex: -1,
      attrs: {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': titleId,
        'aria-describedby': opts.description ? descId : null,
      },
    },
    head,
    body,
    foot,
  );
  const scrim = h('div', { class: 'k-dialog-scrim' });
  const layer = h('div', { class: 'k-dialog-layer' }, scrim, panel);

  let closed = false;
  function close(value: T | null = null): void {
    if (closed) return;
    closed = true;
    const i = openDialogs.indexOf(layer);
    if (i >= 0) openDialogs.splice(i, 1);
    if (!openDialogs.length) document.documentElement.style.overflow = savedOverflow;
    layer.classList.remove('is-open');
    layer.classList.add('is-closing');
    const ms = parseFloat(getComputedStyle(layer).transitionDuration) * 1000 || 0;
    // Listeners stay until the fade-out ends (they are inert: the layer no
    // longer counts as topmost and has pointer-events: none).
    window.setTimeout(() => {
      layer.remove();
      d.dispose();
    }, ms);
    if (prevFocus?.isConnected) prevFocus.focus({ preventScroll: true });
    opts.onClose?.(value);
    resolve(value);
  }

  // Focus trap: Tab cycles inside the panel.
  d.add(
    on(layer, 'keydown', (e) => {
      if (e.key === 'Escape') {
        if (!dismissible) return;
        e.preventDefault();
        e.stopPropagation();
        close(null);
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusableIn(panel);
      if (!items.length) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }),
  );
  // Focus that escapes (click on page behind, programmatic) is pulled back —
  // unless it went into an overlay opened after this dialog (menus, pickers).
  d.add(
    on(document, 'focusin', (e) => {
      if (openDialogs[openDialogs.length - 1] !== layer) return;
      const t = e.target as Node;
      if (layer.contains(t)) return;
      const inLaterOverlay = portalRoot().contains(t) && !!(layer.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING);
      if (inLaterOverlay) return;
      (focusableIn(panel)[0] ?? panel).focus({ preventScroll: true });
    }),
  );
  if (dismissible) d.add(on(scrim, 'click', () => close(null)));

  if (!openDialogs.length) {
    savedOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
  }
  openDialogs.push(layer);
  portalRoot().appendChild(layer);
  requestAnimationFrame(() => layer.classList.add('is-open'));

  const auto = buttons.find((x) => x.a.autofocus)?.b.el;
  const firstField = body.querySelector<HTMLElement>('input, select, textarea');
  (opts.initialFocus ?? auto ?? firstField ?? panel).focus({ preventScroll: true });

  return {
    el: panel,
    body,
    result,
    close,
    setTitle: (t) => void (titleEl.textContent = t),
    setBusy(busy) {
      const primary = buttons.find((x) => x.a.variant === 'primary' || x.a.variant === 'danger') ?? buttons[buttons.length - 1];
      for (const x of buttons) x.b.setDisabled(busy);
      primary?.b.setBusy(busy);
    },
  };
}

/** Yes/no confirmation. Resolves true only when confirmed. */
export async function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  const dlg = openDialog<boolean>({
    title: opts.title,
    description: opts.message,
    size: 'sm',
    closeButton: false,
    actions: [
      // Destructive confirmations focus Cancel so Enter is safe.
      { label: opts.cancelLabel ?? 'Cancel', value: false, variant: 'ghost', autofocus: !!opts.danger },
      { label: opts.confirmLabel ?? 'OK', value: true, variant: opts.danger ? 'danger' : 'primary', autofocus: !opts.danger },
    ],
  });
  return (await dlg.result) === true;
}

/** Single-line text prompt. Resolves the text (Enter or confirm), or null when cancelled. */
export async function promptDialog(opts: PromptOptions): Promise<string | null> {
  const field = createTextInput({ label: opts.label, ariaLabel: opts.label ?? opts.title, value: opts.value ?? '', placeholder: opts.placeholder });
  let dlg: Dialog<'ok' | 'cancel'> | null = null;
  const off = on(field.input, 'keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      dlg?.close('ok');
    }
  });
  dlg = openDialog<'ok' | 'cancel'>({
    title: opts.title,
    content: field.el,
    size: 'sm',
    closeButton: false,
    initialFocus: field.input,
    actions: [
      { label: 'Cancel', value: 'cancel', variant: 'ghost' },
      { label: opts.confirmLabel ?? 'OK', value: 'ok', variant: 'primary' },
    ],
  });
  field.input.select();
  const res = await dlg.result;
  off();
  const text = field.getValue();
  field.destroy();
  return res === 'ok' ? text : null;
}
