/**
 * Swatch (a clickable colour chip) and ColorInput (swatch + native picker +
 * hex field) — for watermark colours, mask overlay colour, etc.
 *
 *   createSwatch({ color: '#ff4040', label: 'Overlay colour', selected: true, onClick })
 *   createColorInput({ value: '#ffffff', ariaLabel: 'Watermark colour', onChange: (hex) => … })
 */
import './swatch.css';
import { Disposer, h, on } from '../dom';
import type { Component } from './util';

export interface SwatchOptions {
  /** Any CSS colour. */
  color: string;
  label: string;
  size?: number;
  shape?: 'square' | 'circle';
  selected?: boolean;
  onClick?: (e: MouseEvent) => void;
}

export interface Swatch extends Component<HTMLButtonElement> {
  setColor(color: string): void;
  setSelected(selected: boolean): void;
}

export function createSwatch(opts: SwatchOptions): Swatch {
  const d = new Disposer();
  const chip = h('span', { class: 'k-swatch__chip' });
  const el = h(
    'button',
    {
      type: 'button',
      class: ['k-swatch', opts.shape === 'circle' && 'k-swatch--circle'],
      style: opts.size ? { width: `${opts.size}px`, height: `${opts.size}px` } : undefined,
      attrs: { 'aria-label': opts.label, 'aria-pressed': opts.selected === undefined ? null : String(opts.selected) },
      title: opts.label,
    },
    chip,
  );
  chip.style.background = opts.color;
  if (opts.onClick) d.add(on(el, 'click', opts.onClick));
  return {
    el,
    setColor: (c) => void (chip.style.background = c),
    setSelected: (b) => el.setAttribute('aria-pressed', String(b)),
    destroy() {
      d.dispose();
      el.remove();
    },
  };
}

/** Normalise "#abc" / "abc" / "#aabbcc" → "#aabbcc" (lowercase), or null if invalid. */
export function normalizeHex(input: string): string | null {
  const s = input.trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{3}$/.test(s)) return '#' + [...s].map((c) => c + c).join('');
  if (/^[0-9a-f]{6}$/.test(s)) return '#' + s;
  return null;
}

export interface ColorInputOptions {
  /** #rrggbb */
  value: string;
  ariaLabel: string;
  /** Show the hex text field (default true). */
  showHex?: boolean;
  /** While the native picker is being dragged. */
  onInput?: (hex: string) => void;
  /** Committed value. */
  onChange?: (hex: string) => void;
}

export interface ColorInput extends Component<HTMLDivElement> {
  setValue(hex: string, silent?: boolean): void;
  getValue(): string;
}

export function createColorInput(opts: ColorInputOptions): ColorInput {
  const d = new Disposer();
  let value = normalizeHex(opts.value) ?? '#000000';
  const picker = h('input', { type: 'color', class: 'k-colorinput__native', value, attrs: { 'aria-label': opts.ariaLabel } });
  const chip = h('span', { class: 'k-swatch__chip' });
  const swatch = h('label', { class: 'k-swatch k-colorinput__swatch' }, chip, picker);
  const hex = h('input', {
    type: 'text',
    class: 'k-input k-input--sm k-colorinput__hex k-mono',
    value: value.slice(1).toUpperCase(),
    maxLength: 7,
    attrs: { 'aria-label': `${opts.ariaLabel} hex`, spellcheck: 'false', autocomplete: 'off' },
  });
  const el = h('div', { class: 'k-colorinput' }, swatch, opts.showHex === false ? null : h('span', { class: 'k-colorinput__hash' }, '#'), opts.showHex === false ? null : hex);

  const show = (): void => {
    chip.style.background = value;
    picker.value = value;
    if (document.activeElement !== hex) hex.value = value.slice(1).toUpperCase();
  };
  const set = (v: string, kind: 'input' | 'change' | 'silent'): void => {
    const n = normalizeHex(v);
    if (!n) return;
    const changed = n !== value;
    value = n;
    show();
    if (kind === 'input' && changed) opts.onInput?.(value);
    if (kind === 'change') opts.onChange?.(value);
  };
  d.add(on(picker, 'input', () => set(picker.value, 'input')));
  d.add(on(picker, 'change', () => set(picker.value, 'change')));
  d.add(
    on(hex, 'keydown', (e) => {
      if (e.key === 'Enter') {
        set(hex.value, 'change');
        hex.select();
      } else if (e.key === 'Escape') {
        hex.value = value.slice(1).toUpperCase();
        hex.blur();
      }
    }),
  );
  d.add(
    on(hex, 'blur', () => {
      if (normalizeHex(hex.value) && normalizeHex(hex.value) !== value) set(hex.value, 'change');
      hex.value = value.slice(1).toUpperCase();
    }),
  );
  show();
  return {
    el,
    setValue: (v, silent = false) => set(v, silent ? 'silent' : 'change'),
    getValue: () => value,
    destroy() {
      d.dispose();
      el.remove();
    },
  };
}
