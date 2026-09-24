/**
 * Library metadata controls: RatingStars (0–5), ColorLabelPicker and
 * FlagToggle (pick / reject).
 *
 *   createRatingStars({ value: rec.rating, onChange: (r) => library.setRating([id], r) })
 *   createColorLabelPicker({ value: rec.label, onChange: (l) => … })
 *   createFlagToggle({ value: rec.flag, onChange: (f) => … })
 *
 * Clicking the current value clears it (rating → 0, label → none, flag → none).
 */
import './rating.css';
import type { ColorLabel, PickFlag } from '../../editor/types';
import { Disposer, h, on } from '../dom';
import { createIconButton } from './button';
import { icon } from './icons';
import type { Component } from './util';

/* ------------------------------------------------------------------ */
/* RatingStars                                                         */
/* ------------------------------------------------------------------ */

export interface RatingStarsOptions {
  value?: number;
  /** Star size in px (default 14). */
  size?: number;
  readonly?: boolean;
  ariaLabel?: string;
  onChange?: (value: number) => void;
}

export interface RatingStars extends Component<HTMLDivElement> {
  setValue(value: number, silent?: boolean): void;
  getValue(): number;
}

export function createRatingStars(opts: RatingStarsOptions = {}): RatingStars {
  const d = new Disposer();
  const size = opts.size ?? 14;
  let value = Math.max(0, Math.min(5, Math.round(opts.value ?? 0)));
  const stars = [1, 2, 3, 4, 5].map((n) =>
    h(
      opts.readonly ? 'span' : 'button',
      opts.readonly
        ? { class: 'k-rating__star' }
        : { type: 'button', class: 'k-rating__star', dataset: { value: String(n) }, attrs: { role: 'radio', 'aria-label': `${n} star${n > 1 ? 's' : ''}` } },
      icon('star', size, { class: 'k-rating__outline' }),
      icon('star-filled', size, { class: 'k-rating__fill' }),
    ),
  );
  const el = h(
    'div',
    {
      class: ['k-rating', opts.readonly && 'is-readonly'],
      attrs: opts.readonly ? { role: 'img' } : { role: 'radiogroup', 'aria-label': opts.ariaLabel ?? 'Rating' },
    },
    ...stars,
  );

  const render = (preview = 0): void => {
    stars.forEach((s, i) => {
      s.classList.toggle('is-on', i < value);
      s.classList.toggle('is-preview', preview > 0 && i < preview);
      if (!opts.readonly) {
        s.setAttribute('aria-checked', String(i + 1 === value));
        (s as HTMLButtonElement).tabIndex = (value ? i + 1 === value : i === 0) ? 0 : -1;
      }
    });
    el.classList.toggle('is-previewing', preview > 0);
    if (opts.readonly) el.setAttribute('aria-label', `${value} of 5 stars`);
  };
  const set = (v: number, silent: boolean, focus = false): void => {
    v = Math.max(0, Math.min(5, Math.round(v)));
    if (focus) (stars[Math.max(0, v - 1)] as HTMLElement).focus();
    if (v === value) return;
    value = v;
    render();
    if (!silent) opts.onChange?.(v);
  };

  if (!opts.readonly) {
    stars.forEach((s, i) => {
      d.add(on(s as HTMLElement, 'click', () => set(value === i + 1 ? 0 : i + 1, false)));
      d.add(on(s as HTMLElement, 'pointerenter', (e) => e.pointerType !== 'touch' && render(i + 1)));
    });
    d.add(on(el, 'pointerleave', () => render()));
    d.add(
      on(el, 'keydown', (e) => {
        let next: number | null = null;
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = value + 1;
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = value - 1;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = 5;
        else if (/^[0-5]$/.test(e.key)) next = Number(e.key);
        if (next === null) return;
        e.preventDefault();
        e.stopPropagation();
        set(next, false, true);
      }),
    );
  }
  render();
  return {
    el,
    setValue: (v, silent = false) => set(v, silent),
    getValue: () => value,
    destroy() {
      d.dispose();
      el.remove();
    },
  };
}

/* ------------------------------------------------------------------ */
/* ColorLabelPicker                                                    */
/* ------------------------------------------------------------------ */

export const COLOR_LABELS: readonly ColorLabel[] = ['red', 'yellow', 'green', 'blue', 'purple'];

export interface ColorLabelPickerOptions {
  value?: ColorLabel | null;
  /** Hide the explicit "none" swatch (clicking the current colour still clears). */
  hideNone?: boolean;
  ariaLabel?: string;
  onChange?: (value: ColorLabel | null) => void;
}

export interface ColorLabelPicker extends Component<HTMLDivElement> {
  setValue(value: ColorLabel | null, silent?: boolean): void;
  getValue(): ColorLabel | null;
}

export function createColorLabelPicker(opts: ColorLabelPickerOptions = {}): ColorLabelPicker {
  const d = new Disposer();
  let value: ColorLabel | null = opts.value ?? null;
  const choices: (ColorLabel | null)[] = opts.hideNone ? [...COLOR_LABELS] : [null, ...COLOR_LABELS];
  const dots = choices.map((c) =>
    h(
      'button',
      {
        type: 'button',
        class: ['k-labels__dot', c ? `k-labels__dot--${c}` : 'k-labels__dot--none'],
        dataset: { label: c ?? 'none' },
        title: c ? c[0].toUpperCase() + c.slice(1) : 'No label',
        attrs: { role: 'radio', 'aria-label': c ? `${c[0].toUpperCase()}${c.slice(1)} label` : 'No label' },
      },
      c ? null : icon('x', 10, { strokeWidth: 1.25 }),
    ),
  );
  const el = h('div', { class: 'k-labels', attrs: { role: 'radiogroup', 'aria-label': opts.ariaLabel ?? 'Colour label' } }, ...dots);
  const render = (): void =>
    dots.forEach((b, i) => {
      const sel = choices[i] === value;
      b.setAttribute('aria-checked', String(sel));
      b.tabIndex = sel || (value === null && i === 0) ? 0 : -1;
    });
  const set = (v: ColorLabel | null, silent: boolean): void => {
    if (v === value) return;
    value = v;
    render();
    if (!silent) opts.onChange?.(v);
  };
  dots.forEach((b, i) => {
    d.add(on(b, 'click', () => set(choices[i] === value ? null : choices[i], false)));
    d.add(
      on(b, 'keydown', (e) => {
        const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
        if (!dir) return;
        e.preventDefault();
        e.stopPropagation();
        const j = (i + dir + dots.length) % dots.length;
        set(choices[j], false);
        dots[j].focus();
      }),
    );
  });
  render();
  return {
    el,
    setValue: (v, silent = false) => set(v, silent),
    getValue: () => value,
    destroy() {
      d.dispose();
      el.remove();
    },
  };
}

/* ------------------------------------------------------------------ */
/* FlagToggle                                                          */
/* ------------------------------------------------------------------ */

export interface FlagToggleOptions {
  value?: PickFlag;
  size?: 'sm' | 'md';
  onChange?: (value: PickFlag) => void;
}

export interface FlagToggle extends Component<HTMLDivElement> {
  setValue(value: PickFlag, silent?: boolean): void;
  getValue(): PickFlag;
}

export function createFlagToggle(opts: FlagToggleOptions = {}): FlagToggle {
  let value: PickFlag = opts.value ?? 'none';
  const set = (v: PickFlag, silent: boolean): void => {
    if (v === value) return;
    value = v;
    pick.setPressed(v === 'pick');
    reject.setPressed(v === 'reject');
    el.dataset.flag = v;
    if (!silent) opts.onChange?.(v);
  };
  const pick = createIconButton({
    icon: 'flag',
    label: 'Flag as pick',
    shortcut: 'P',
    size: opts.size ?? 'sm',
    pressed: value === 'pick',
    autoToggle: false,
    class: 'k-flags__pick',
    onClick: () => set(value === 'pick' ? 'none' : 'pick', false),
  });
  const reject = createIconButton({
    icon: 'flag-x',
    label: 'Flag as rejected',
    shortcut: 'X',
    size: opts.size ?? 'sm',
    pressed: value === 'reject',
    autoToggle: false,
    class: 'k-flags__reject',
    onClick: () => set(value === 'reject' ? 'none' : 'reject', false),
  });
  const el = h('div', { class: 'k-flags', dataset: { flag: value }, attrs: { role: 'group', 'aria-label': 'Pick flag' } }, pick.el, reject.el);
  return {
    el,
    setValue: (v, silent = false) => set(v, silent),
    getValue: () => value,
    destroy() {
      pick.destroy();
      reject.destroy();
      el.remove();
    },
  };
}
