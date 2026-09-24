/**
 * Toasts — stacked bottom-centre notifications (what ctx.toast uses).
 *
 *   const toaster = createToaster();         // mounts itself into the overlay root
 *   toaster.show('Exported 12 photos', 'success');
 *   const dismiss = toaster.show('Rendering…', 'info', 0);   // 0 = sticky
 *
 * Auto-dismiss pauses while hovered. Info/success announce politely; errors
 * use role="alert". At most `max` toasts are shown (oldest leave first).
 */
import './toast.css';
import { Disposer, h, on } from '../dom';
import { type IconName, icon } from './icons';
import { type Component, portalRoot } from './util';

export type ToastKind = 'info' | 'success' | 'error';

export interface ToasterOptions {
  /** Mount point (default: the kit overlay root). */
  container?: HTMLElement;
  /** Maximum toasts on screen. Default 4. */
  max?: number;
}

export interface Toaster extends Component<HTMLDivElement> {
  /** Returns a function that dismisses this toast. `ms` 0 = until dismissed. */
  show(message: string, kind?: ToastKind, ms?: number): () => void;
  clear(): void;
}

const ICONS: Record<ToastKind, IconName> = { info: 'info', success: 'check-circle', error: 'alert' };

export function createToaster(opts: ToasterOptions = {}): Toaster {
  const d = new Disposer();
  const max = opts.max ?? 4;
  const el = h('div', { class: 'k-toaster', attrs: { 'aria-live': 'polite', 'aria-relevant': 'additions' } });
  const live = new Set<() => void>();

  function mount(): void {
    if (!el.isConnected) (opts.container ?? portalRoot()).appendChild(el);
  }

  function show(message: string, kind: ToastKind = 'info', ms = kind === 'error' ? 6000 : 3200): () => void {
    mount();
    const td = new Disposer();
    const close = h('button', { type: 'button', class: 'k-toast__close', attrs: { 'aria-label': 'Dismiss' } }, icon('x', 12, { strokeWidth: 1.75 }));
    const toast = h(
      'div',
      { class: ['k-toast', `k-toast--${kind}`], attrs: { role: kind === 'error' ? 'alert' : 'status' } },
      icon(ICONS[kind], 15, { class: 'k-toast__icon' }),
      h('span', { class: 'k-toast__msg' }, message),
      close,
    );
    let timer = 0;
    let remaining = ms;
    let startedAt = 0;
    let gone = false;
    const dismiss = (): void => {
      if (gone) return;
      gone = true;
      live.delete(dismiss);
      window.clearTimeout(timer);
      td.dispose();
      toast.classList.remove('is-in');
      toast.classList.add('is-leaving');
      const dur = parseFloat(getComputedStyle(toast).transitionDuration) * 1000 || 0;
      window.setTimeout(() => toast.remove(), dur);
    };
    const arm = (): void => {
      if (!remaining) return;
      startedAt = performance.now();
      timer = window.setTimeout(dismiss, remaining);
    };
    td.add(on(close, 'click', dismiss));
    td.add(
      on(toast, 'pointerenter', () => {
        if (!remaining) return;
        window.clearTimeout(timer);
        remaining = Math.max(800, remaining - (performance.now() - startedAt));
      }),
    );
    td.add(on(toast, 'pointerleave', arm));
    el.appendChild(toast);
    live.add(dismiss);
    // Oldest first out when over the limit.
    if (live.size > max) live.values().next().value?.();
    requestAnimationFrame(() => toast.classList.add('is-in'));
    arm();
    return dismiss;
  }

  const clear = (): void => {
    for (const fn of [...live]) fn();
  };
  d.add(clear);

  return {
    el,
    show,
    clear,
    destroy() {
      d.dispose();
      el.remove();
    },
  };
}
