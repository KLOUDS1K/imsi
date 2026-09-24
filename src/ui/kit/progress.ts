/**
 * Progress indicators: ProgressBar (determinate / indeterminate), Spinner,
 * and BusyLine — the thin top-of-app progress line fed by ctx.busy.
 *
 *   const bar = createProgressBar({ label: 'Exporting', showValue: true });
 *   bar.set(0.4);  bar.set(null) // indeterminate
 *   const busy = createBusyLine(); ctx.busy.subscribe((b) => busy.set(b), true);
 */
import './progress.css';
import { h, svg } from '../dom';
import { type Component, clamp } from './util';

export interface ProgressBarOptions {
  /** 0..1, or null for indeterminate. */
  value?: number | null;
  label?: string;
  /** Show the percentage next to the label. */
  showValue?: boolean;
  size?: 'sm' | 'md';
}

export interface ProgressBar extends Component<HTMLDivElement> {
  set(value: number | null, label?: string): void;
}

export function createProgressBar(opts: ProgressBarOptions = {}): ProgressBar {
  const labelEl = h('span', { class: 'k-progress__label' }, opts.label ?? '');
  const valueEl = h('span', { class: 'k-progress__value k-num' });
  const fill = h('div', { class: 'k-progress__fill' });
  const bar = h('div', { class: 'k-progress__bar', attrs: { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100 } }, fill);
  const head = h('div', { class: 'k-progress__head' }, labelEl, opts.showValue ? valueEl : null);
  const el = h('div', { class: ['k-progress', opts.size === 'sm' && 'k-progress--sm'] }, opts.label || opts.showValue ? head : null, bar);

  function set(value: number | null, label?: string): void {
    if (label !== undefined) {
      labelEl.textContent = label;
      if (!head.isConnected) el.prepend(head);
    }
    if (labelEl.textContent) bar.setAttribute('aria-label', labelEl.textContent);
    if (value === null || !Number.isFinite(value)) {
      el.classList.add('is-indeterminate');
      bar.removeAttribute('aria-valuenow');
      fill.style.transform = '';
      valueEl.textContent = '';
      return;
    }
    const v = clamp(value, 0, 1);
    el.classList.remove('is-indeterminate');
    fill.style.transform = `scaleX(${v})`;
    const pct = Math.round(v * 100);
    bar.setAttribute('aria-valuenow', String(pct));
    valueEl.textContent = `${pct}%`;
  }
  set(opts.value === undefined ? 0 : opts.value);

  return { el, set, destroy: () => el.remove() };
}

export interface SpinnerOptions {
  size?: number;
  /** Accessible label; omit for decorative spinners inside labelled controls. */
  label?: string;
}

/** Circular spinner (currentColor). */
export function createSpinner(opts: SpinnerOptions = {}): Component<HTMLSpanElement> {
  const size = opts.size ?? 16;
  const stroke = size <= 14 ? 1.75 : 2;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const el = h(
    'span',
    {
      class: 'k-spinner',
      style: { width: `${size}px`, height: `${size}px` },
      attrs: opts.label ? { role: 'status', 'aria-label': opts.label } : { 'aria-hidden': 'true' },
    },
    svg(
      'svg',
      { width: size, height: size, viewBox: `0 0 ${size} ${size}`, fill: 'none' },
      svg('circle', { cx: size / 2, cy: size / 2, r, stroke: 'currentColor', 'stroke-width': stroke, opacity: 0.2 }),
      svg('circle', {
        class: 'k-spinner__arc',
        cx: size / 2,
        cy: size / 2,
        r,
        stroke: 'currentColor',
        'stroke-width': stroke,
        'stroke-linecap': 'round',
        'stroke-dasharray': `${(circ * 0.28).toFixed(2)} ${circ.toFixed(2)}`,
      }),
    ),
  );
  return { el, destroy: () => el.remove() };
}

export interface BusyLine extends Component<HTMLDivElement> {
  /** Same shape as AppContext.busy. `progress` 0..1 → determinate, else indeterminate. */
  set(state: { active: boolean; label?: string; progress?: number }): void;
}

/** Thin accent line pinned to the top of its (position: relative) container. */
export function createBusyLine(): BusyLine {
  const fill = h('div', { class: 'k-busy__fill' });
  const el = h('div', { class: 'k-busy', attrs: { role: 'progressbar', 'aria-hidden': 'true' } }, fill);
  let hideTimer = 0;
  return {
    el,
    set(state) {
      window.clearTimeout(hideTimer);
      if (state.label) el.setAttribute('aria-label', state.label);
      if (!state.active) {
        // Run to 100% then fade, so short tasks still read as "done".
        if (el.classList.contains('is-active')) {
          el.classList.remove('is-indeterminate');
          fill.style.transform = 'scaleX(1)';
          hideTimer = window.setTimeout(() => el.classList.remove('is-active'), 220);
        }
        el.setAttribute('aria-hidden', 'true');
        return;
      }
      el.removeAttribute('aria-hidden');
      el.classList.add('is-active');
      if (state.progress === undefined || !Number.isFinite(state.progress)) {
        el.classList.add('is-indeterminate');
        fill.style.transform = '';
        el.removeAttribute('aria-valuenow');
      } else {
        el.classList.remove('is-indeterminate');
        const v = clamp(state.progress, 0, 1);
        fill.style.transform = `scaleX(${v})`;
        el.setAttribute('aria-valuenow', String(Math.round(v * 100)));
      }
    },
    destroy() {
      window.clearTimeout(hideTimer);
      el.remove();
    },
  };
}
