/**
 * Non-modal batch progress card (bottom of the screen) with a Cancel button,
 * mirrored into ctx.busy so the shell's busy line shows it too.
 */
import type { AppContext } from '@/app/context';
import { Disposer, h, on } from '@/ui/dom';
import { createButton, createProgressBar, portalRoot } from '@/ui/kit';
import './batch.css';

export interface BatchProgress {
  readonly signal: AbortSignal;
  update(done: number, total: number, detail?: string): void;
  /** Remove the card and clear ctx.busy. */
  finish(): void;
}

export function startBatchProgress(ctx: AppContext, title: string, opts: { cancellable?: boolean } = {}): BatchProgress {
  const d = new Disposer();
  const ac = new AbortController();
  const bar = createProgressBar({ value: 0, size: 'sm' });
  const countEl = h('span', { class: 'k-batch-progress__count k-num' }, '');
  const detailEl = h('span', { class: 'k-batch-progress__detail k-truncate' }, '');
  const cancel = createButton({
    label: 'Cancel',
    size: 'sm',
    variant: 'ghost',
    onClick: () => {
      ac.abort();
      cancel.setDisabled(true);
      cancel.setLabel('Cancelling…');
    },
  });
  const el = h(
    'div',
    { class: 'k-batch-progress', attrs: { role: 'status', 'aria-live': 'polite', 'aria-label': title } },
    h('div', { class: 'k-batch-progress__row' }, h('span', { class: 'k-batch-progress__title' }, title), countEl, opts.cancellable === false ? null : cancel.el),
    bar.el,
    detailEl,
  );
  portalRoot().append(el);
  ctx.busy.set({ active: true, label: title, progress: 0 });
  d.add(on(el, 'keydown', (e) => e.key === 'Escape' && !ac.signal.aborted && cancel.el.click()));

  let finished = false;
  return {
    signal: ac.signal,
    update(done, total, detail) {
      const p = total > 0 ? done / total : 0;
      bar.set(p);
      countEl.textContent = `${done} / ${total}`;
      if (detail !== undefined) detailEl.textContent = detail;
      ctx.busy.set({ active: true, label: `${title} ${done}/${total}`, progress: p });
    },
    finish() {
      if (finished) return;
      finished = true;
      d.dispose();
      cancel.destroy();
      bar.destroy();
      el.remove();
      ctx.busy.set({ active: false });
    },
  };
}
