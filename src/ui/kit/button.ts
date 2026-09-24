/**
 * Buttons: Button (text ± icon), IconButton (icon-only with tooltip), and
 * SegmentedControl (the site's grid/list toggle).
 *
 *   createButton({ label: 'Export', variant: 'primary', onClick })
 *   createIconButton({ icon: 'undo', label: 'Undo', shortcut: 'Mod+Z', onClick })
 *   createIconButton({ icon: 'eye', label: 'Show mask', pressed: false, onToggle: (on) => … })
 *   createSegmentedControl({ ariaLabel: 'View', value: 'grid', options: [
 *     { value: 'grid', icon: 'grid', title: 'Grid' }, { value: 'list', icon: 'list', title: 'List' } ],
 *     onChange: (v) => … })
 */
import './button.css';
import { Disposer, h, on } from '../dom';
import { type IconName, icon, replaceIcon } from './icons';
import { createSpinner } from './progress';
import { attachTooltip, type TooltipHandle } from './tooltip';
import type { Component, Placement } from './util';

export type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonOptions {
  label?: string;
  icon?: IconName;
  iconRight?: IconName;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Tooltip text (uses the kit tooltip, not the native title). */
  title?: string;
  ariaLabel?: string;
  disabled?: boolean;
  type?: 'button' | 'submit' | 'reset';
  /** Stretch to the container width. */
  block?: boolean;
  class?: string;
  onClick?: (e: MouseEvent) => void;
}

export interface Button extends Component<HTMLButtonElement> {
  setLabel(text: string): void;
  setIcon(name: IconName | null): void;
  setDisabled(disabled: boolean): void;
  /** Shows a spinner and disables the button (e.g. while exporting). */
  setBusy(busy: boolean): void;
}

export function createButton(opts: ButtonOptions): Button {
  const d = new Disposer();
  const labelEl = h('span', { class: 'k-btn__label' }, opts.label ?? '');
  const el = h(
    'button',
    {
      type: opts.type ?? 'button',
      class: [
        'k-btn',
        `k-btn--${opts.variant ?? 'default'}`,
        opts.size === 'sm' && 'k-btn--sm',
        opts.block && 'k-btn--block',
        !opts.label && 'k-btn--icon-only',
        opts.class,
      ],
      disabled: !!opts.disabled,
      attrs: { 'aria-label': opts.ariaLabel ?? null },
    },
    opts.icon ? icon(opts.icon, opts.size === 'sm' ? 14 : 16) : null,
    opts.label ? labelEl : null,
    opts.iconRight ? icon(opts.iconRight, opts.size === 'sm' ? 14 : 16, { class: 'k-btn__icon-right' }) : null,
  );
  if (opts.onClick) d.add(on(el, 'click', opts.onClick));
  if (opts.title) {
    const tip = attachTooltip(el, opts.title);
    d.add(() => tip.destroy());
  }
  let disabled = !!opts.disabled;
  let spinner: ReturnType<typeof createSpinner> | null = null;

  return {
    el,
    setLabel(text) {
      labelEl.textContent = text;
      if (!labelEl.isConnected) el.append(labelEl);
      el.classList.toggle('k-btn--icon-only', !text);
    },
    setIcon(name) {
      const cur = el.querySelector(':scope > svg.k-icon:not(.k-btn__icon-right)');
      if (!name) cur?.remove();
      else replaceIcon(el, name, opts.size === 'sm' ? 14 : 16);
    },
    setDisabled(b) {
      disabled = b;
      el.disabled = b || !!spinner;
    },
    setBusy(busy) {
      if (busy && !spinner) {
        spinner = createSpinner({ size: opts.size === 'sm' ? 12 : 14 });
        el.prepend(spinner.el);
        el.classList.add('is-busy');
        el.setAttribute('aria-busy', 'true');
      } else if (!busy && spinner) {
        spinner.destroy();
        spinner = null;
        el.classList.remove('is-busy');
        el.removeAttribute('aria-busy');
      }
      el.disabled = disabled || busy;
    },
    destroy() {
      spinner?.destroy();
      d.dispose();
      el.remove();
    },
  };
}

/* ------------------------------------------------------------------ */

export interface IconButtonOptions {
  icon: IconName;
  /** Accessible name and tooltip text. */
  label: string;
  /** Shown in the tooltip as key caps. */
  shortcut?: string;
  /** Makes it a toggle button (aria-pressed). Clicking flips it unless `autoToggle` is false. */
  pressed?: boolean;
  autoToggle?: boolean;
  /** 24 / 28 (default) / 32 px square. */
  size?: 'sm' | 'md' | 'lg';
  iconSize?: number;
  /** 'ghost' (default, transparent) or 'raised' (surface pill). */
  variant?: 'ghost' | 'raised';
  disabled?: boolean;
  /** false disables the tooltip; a placement moves it. */
  tooltip?: boolean | Placement;
  class?: string;
  onClick?: (e: MouseEvent) => void;
  onToggle?: (pressed: boolean) => void;
}

export interface IconButton extends Component<HTMLButtonElement> {
  setPressed(pressed: boolean): void;
  isPressed(): boolean;
  setIcon(name: IconName): void;
  setLabel(label: string, shortcut?: string): void;
  setDisabled(disabled: boolean): void;
}

export function createIconButton(opts: IconButtonOptions): IconButton {
  const d = new Disposer();
  const size = opts.size ?? 'md';
  const iconSize = opts.iconSize ?? (size === 'sm' ? 14 : 16);
  const toggle = opts.pressed !== undefined;
  let pressed = !!opts.pressed;
  const el = h(
    'button',
    {
      type: 'button',
      class: ['k-iconbtn', `k-iconbtn--${size}`, opts.variant === 'raised' && 'k-iconbtn--raised', opts.class],
      disabled: !!opts.disabled,
      attrs: { 'aria-label': opts.label, 'aria-pressed': toggle ? String(pressed) : null },
    },
    icon(opts.icon, iconSize),
  );
  let tip: TooltipHandle | null = null;
  if (opts.tooltip !== false) {
    tip = attachTooltip(el, opts.label, {
      shortcut: opts.shortcut,
      placement: typeof opts.tooltip === 'string' ? opts.tooltip : 'bottom',
    });
    d.add(() => tip?.destroy());
  }
  const setPressed = (b: boolean): void => {
    pressed = b;
    if (toggle) el.setAttribute('aria-pressed', String(b));
  };
  d.add(
    on(el, 'click', (e) => {
      if (toggle && opts.autoToggle !== false) {
        setPressed(!pressed);
        opts.onToggle?.(pressed);
      }
      opts.onClick?.(e);
    }),
  );
  return {
    el,
    setPressed,
    isPressed: () => pressed,
    setIcon: (name) => void replaceIcon(el, name, iconSize),
    setLabel(label, shortcut) {
      el.setAttribute('aria-label', label);
      tip?.update(label, shortcut);
    },
    setDisabled(b) {
      el.disabled = b;
    },
    destroy() {
      d.dispose();
      el.remove();
    },
  };
}

/* ------------------------------------------------------------------ */

export interface SegmentOption<T extends string> {
  value: T;
  label?: string;
  icon?: IconName;
  /** Tooltip / accessible name when the segment is icon-only. */
  title?: string;
  disabled?: boolean;
}

export interface SegmentedControlOptions<T extends string> {
  options: SegmentOption<T>[];
  value: T;
  ariaLabel: string;
  size?: 'sm' | 'md';
  /** Stretch segments to fill the width. */
  block?: boolean;
  onChange?: (value: T) => void;
}

export interface SegmentedControl<T extends string> extends Component<HTMLDivElement> {
  setValue(value: T, silent?: boolean): void;
  getValue(): T;
  setDisabled(disabled: boolean): void;
}

/** Radio-group semantics: one tab stop, arrow keys move and select. */
export function createSegmentedControl<T extends string>(opts: SegmentedControlOptions<T>): SegmentedControl<T> {
  const d = new Disposer();
  let value = opts.value;
  const buttons = opts.options.map((o) => {
    const b = h(
      'button',
      {
        type: 'button',
        class: 'k-seg__btn',
        disabled: !!o.disabled,
        dataset: { value: o.value },
        attrs: { role: 'radio', 'aria-label': o.label ? null : (o.title ?? o.value) },
      },
      o.icon ? icon(o.icon, opts.size === 'sm' ? 14 : 15) : null,
      o.label ? h('span', null, o.label) : null,
    );
    if (o.title && !o.label) {
      const tip = attachTooltip(b, o.title);
      d.add(() => tip.destroy());
    }
    return b;
  });
  const el = h(
    'div',
    {
      class: ['k-seg', opts.size === 'sm' && 'k-seg--sm', opts.block && 'k-seg--block'],
      attrs: { role: 'radiogroup', 'aria-label': opts.ariaLabel },
    },
    ...buttons,
  );

  const render = (): void => {
    buttons.forEach((b, i) => {
      const on_ = opts.options[i].value === value;
      b.setAttribute('aria-checked', String(on_));
      b.tabIndex = on_ ? 0 : -1;
    });
  };
  const select = (v: T, focus = false): void => {
    const i = opts.options.findIndex((o) => o.value === v);
    if (i < 0) return;
    if (focus) buttons[i].focus();
    if (v === value) return;
    value = v;
    render();
    opts.onChange?.(v);
  };

  buttons.forEach((b, i) => {
    d.add(on(b, 'click', () => select(opts.options[i].value)));
    d.add(
      on(b, 'keydown', (e) => {
        const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
        if (!dir) return;
        e.preventDefault();
        e.stopPropagation();
        const n = opts.options.length;
        for (let k = 1; k <= n; k++) {
          const j = (i + dir * k + n) % n;
          if (!opts.options[j].disabled) {
            select(opts.options[j].value, true);
            break;
          }
        }
      }),
    );
  });
  render();

  return {
    el,
    setValue(v, silent = false) {
      if (v === value) return;
      value = v;
      render();
      if (!silent) opts.onChange?.(v);
    },
    getValue: () => value,
    setDisabled(b) {
      buttons.forEach((btn, i) => (btn.disabled = b || !!opts.options[i].disabled));
      el.classList.toggle('is-disabled', b);
    },
    destroy() {
      d.dispose();
      el.remove();
    },
  };
}
