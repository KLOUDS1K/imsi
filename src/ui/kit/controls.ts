/**
 * Form controls: Toggle (switch), Checkbox, RadioGroup, Select, NumberInput,
 * TextInput and SearchInput (the site's "Search by name" pill).
 *
 * All wrap native elements where possible (checkbox, radio, select, input) so
 * keyboard and assistive-tech behaviour is the browser's own; only the look is
 * custom. `setX(v, silent?)` never fires callbacks when `silent` is true.
 */
import './controls.css';
import { Disposer, h, on } from '../dom';
import { icon } from './icons';
import { type Component, clamp, decimalsOf, formatNumber, kitId, parseNumber, roundTo } from './util';

/* ------------------------------------------------------------------ */
/* Toggle (switch)                                                     */
/* ------------------------------------------------------------------ */

export interface ToggleOptions {
  checked?: boolean;
  /** Visible label to the right of the switch. */
  label?: string;
  /** Accessible name when there is no visible label. */
  ariaLabel?: string;
  size?: 'sm' | 'md';
  disabled?: boolean;
  onChange?: (checked: boolean) => void;
}

export interface Toggle extends Component<HTMLElement> {
  /** The role="switch" button (focus target). */
  readonly button: HTMLButtonElement;
  setChecked(checked: boolean, silent?: boolean): void;
  isChecked(): boolean;
  setDisabled(disabled: boolean): void;
}

export function createToggle(opts: ToggleOptions = {}): Toggle {
  const d = new Disposer();
  let checked = !!opts.checked;
  const button = h(
    'button',
    {
      type: 'button',
      class: ['k-switch', opts.size === 'sm' && 'k-switch--sm'],
      disabled: !!opts.disabled,
      attrs: { role: 'switch', 'aria-checked': String(checked), 'aria-label': opts.label ? null : (opts.ariaLabel ?? null) },
    },
    h('span', { class: 'k-switch__knob' }),
  );
  const el: HTMLElement = opts.label
    ? h('label', { class: 'k-switch-field' }, button, h('span', { class: 'k-switch-field__label' }, opts.label))
    : button;
  const set = (b: boolean, silent: boolean): void => {
    if (b === checked) return;
    checked = b;
    button.setAttribute('aria-checked', String(b));
    if (!silent) opts.onChange?.(b);
  };
  d.add(on(button, 'click', () => set(!checked, false)));
  return {
    el,
    button,
    setChecked: (b, silent = false) => set(b, silent),
    isChecked: () => checked,
    setDisabled: (b) => void (button.disabled = b),
    destroy() {
      d.dispose();
      el.remove();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Checkbox                                                            */
/* ------------------------------------------------------------------ */

export interface CheckboxOptions {
  checked?: boolean;
  indeterminate?: boolean;
  label?: string;
  ariaLabel?: string;
  disabled?: boolean;
  onChange?: (checked: boolean) => void;
}

export interface Checkbox extends Component<HTMLLabelElement> {
  readonly input: HTMLInputElement;
  setChecked(checked: boolean, silent?: boolean): void;
  isChecked(): boolean;
  setIndeterminate(b: boolean): void;
  setDisabled(disabled: boolean): void;
}

export function createCheckbox(opts: CheckboxOptions = {}): Checkbox {
  const d = new Disposer();
  const input = h('input', {
    type: 'checkbox',
    class: 'k-check__input',
    checked: !!opts.checked,
    indeterminate: !!opts.indeterminate,
    disabled: !!opts.disabled,
    attrs: { 'aria-label': opts.label ? null : (opts.ariaLabel ?? null) },
  });
  const box = h('span', { class: 'k-check__box', attrs: { 'aria-hidden': 'true' } }, icon('check', 12, { strokeWidth: 2, class: 'k-check__tick' }), icon('minus', 12, { strokeWidth: 2, class: 'k-check__dash' }));
  const el = h('label', { class: 'k-check' }, input, box, opts.label ? h('span', { class: 'k-check__label' }, opts.label) : null);
  d.add(on(input, 'change', () => opts.onChange?.(input.checked)));
  return {
    el,
    input,
    setChecked(b, silent = false) {
      if (input.checked === b && !input.indeterminate) return;
      input.checked = b;
      input.indeterminate = false;
      if (!silent) opts.onChange?.(b);
    },
    isChecked: () => input.checked,
    setIndeterminate: (b) => void (input.indeterminate = b),
    setDisabled: (b) => void (input.disabled = b),
    destroy() {
      d.dispose();
      el.remove();
    },
  };
}

/* ------------------------------------------------------------------ */
/* RadioGroup                                                          */
/* ------------------------------------------------------------------ */

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export interface RadioGroupOptions<T extends string> {
  options: ChoiceOption<T>[];
  value: T;
  ariaLabel: string;
  orientation?: 'vertical' | 'horizontal';
  onChange?: (value: T) => void;
}

export interface RadioGroup<T extends string> extends Component<HTMLDivElement> {
  setValue(value: T, silent?: boolean): void;
  getValue(): T;
  setDisabled(disabled: boolean): void;
}

export function createRadioGroup<T extends string>(opts: RadioGroupOptions<T>): RadioGroup<T> {
  const d = new Disposer();
  const name = kitId('k-radio');
  let value = opts.value;
  const inputs = opts.options.map((o) =>
    h('input', { type: 'radio', class: 'k-radio__input', name, value: o.value, checked: o.value === value, disabled: !!o.disabled }),
  );
  const el = h(
    'div',
    {
      class: ['k-radio-group', opts.orientation === 'horizontal' && 'k-radio-group--h'],
      attrs: { role: 'radiogroup', 'aria-label': opts.ariaLabel },
    },
    ...opts.options.map((o, i) =>
      h('label', { class: 'k-radio' }, inputs[i], h('span', { class: 'k-radio__dot', attrs: { 'aria-hidden': 'true' } }), h('span', { class: 'k-radio__label' }, o.label)),
    ),
  );
  inputs.forEach((inp, i) =>
    d.add(
      on(inp, 'change', () => {
        if (!inp.checked) return;
        value = opts.options[i].value;
        opts.onChange?.(value);
      }),
    ),
  );
  return {
    el,
    setValue(v, silent = false) {
      if (v === value) return;
      value = v;
      inputs.forEach((inp, i) => (inp.checked = opts.options[i].value === v));
      if (!silent) opts.onChange?.(v);
    },
    getValue: () => value,
    setDisabled: (b) => inputs.forEach((inp, i) => (inp.disabled = b || !!opts.options[i].disabled)),
    destroy() {
      d.dispose();
      el.remove();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Select (styled native)                                              */
/* ------------------------------------------------------------------ */

export interface SelectGroup<T extends string> {
  group: string;
  options: ChoiceOption<T>[];
}

export interface SelectOptions<T extends string> {
  options: (ChoiceOption<T> | SelectGroup<T>)[];
  value: T;
  ariaLabel: string;
  size?: 'sm' | 'md';
  /** Stretch to the container width. */
  block?: boolean;
  disabled?: boolean;
  onChange?: (value: T) => void;
}

export interface Select<T extends string> extends Component<HTMLDivElement> {
  readonly select: HTMLSelectElement;
  setValue(value: T, silent?: boolean): void;
  getValue(): T;
  setOptions(options: (ChoiceOption<T> | SelectGroup<T>)[]): void;
  setDisabled(disabled: boolean): void;
}

export function createSelect<T extends string>(opts: SelectOptions<T>): Select<T> {
  const d = new Disposer();
  const select = h('select', { class: 'k-select__native', disabled: !!opts.disabled, attrs: { 'aria-label': opts.ariaLabel } });
  const el = h(
    'div',
    { class: ['k-select', opts.size === 'sm' && 'k-select--sm', opts.block && 'k-select--block'] },
    select,
    icon('chevron-down', 14, { class: 'k-select__chevron' }),
  );
  const fill = (list: (ChoiceOption<T> | SelectGroup<T>)[]): void => {
    select.replaceChildren(
      ...list.map((o) =>
        'group' in o
          ? h('optgroup', { label: o.group }, ...o.options.map((c) => h('option', { value: c.value, disabled: !!c.disabled }, c.label)))
          : h('option', { value: o.value, disabled: !!o.disabled }, o.label),
      ),
    );
  };
  fill(opts.options);
  select.value = opts.value;
  let value = opts.value;
  d.add(
    on(select, 'change', () => {
      value = select.value as T;
      opts.onChange?.(value);
    }),
  );
  return {
    el,
    select,
    setValue(v, silent = false) {
      if (v === value) return;
      value = v;
      select.value = v;
      if (!silent) opts.onChange?.(v);
    },
    getValue: () => value,
    setOptions(list) {
      fill(list);
      select.value = value;
    },
    setDisabled: (b) => void (select.disabled = b),
    destroy() {
      d.dispose();
      el.remove();
    },
  };
}

/* ------------------------------------------------------------------ */
/* NumberInput                                                         */
/* ------------------------------------------------------------------ */

export interface NumberInputOptions {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  decimals?: number;
  unit?: string;
  ariaLabel: string;
  /** CSS width of the whole control (default 96px). */
  width?: string;
  disabled?: boolean;
  /** Fires on commit (Enter, blur, stepper, arrow keys). */
  onChange?: (value: number) => void;
}

export interface NumberInput extends Component<HTMLDivElement> {
  readonly input: HTMLInputElement;
  setValue(value: number, silent?: boolean): void;
  getValue(): number;
  setDisabled(disabled: boolean): void;
  setRange(min: number, max: number): void;
}

/**
 * Numeric field with a stepper. ↑/↓ = step, Shift = ×10 (dimension-field
 * convention), Enter/blur commits, Escape reverts. Invalid text reverts.
 */
export function createNumberInput(opts: NumberInputOptions): NumberInput {
  const d = new Disposer();
  let min = opts.min ?? -Infinity;
  let max = opts.max ?? Infinity;
  const step = opts.step ?? 1;
  const decimals = opts.decimals ?? decimalsOf(step);
  let value = clamp(opts.value, min, max);
  const input = h('input', {
    class: 'k-number__input k-num',
    type: 'text',
    disabled: !!opts.disabled,
    attrs: { inputmode: decimals ? 'decimal' : 'numeric', autocomplete: 'off', spellcheck: 'false', 'aria-label': opts.ariaLabel, role: 'spinbutton' },
  });
  const up = h('button', { type: 'button', class: 'k-number__step', tabIndex: -1, attrs: { 'aria-label': 'Increase' } }, icon('chevron-up', 10, { strokeWidth: 1.5 }));
  const down = h('button', { type: 'button', class: 'k-number__step', tabIndex: -1, attrs: { 'aria-label': 'Decrease' } }, icon('chevron-down', 10, { strokeWidth: 1.5 }));
  const el = h(
    'div',
    { class: 'k-number', style: { width: opts.width ?? '96px' } },
    input,
    opts.unit ? h('span', { class: 'k-number__unit' }, opts.unit) : null,
    h('div', { class: 'k-number__stepper' }, up, down),
  );
  const show = (): void => {
    input.value = formatNumber(value, decimals).replace('−', '-');
    input.setAttribute('aria-valuenow', String(value));
    if (Number.isFinite(min)) input.setAttribute('aria-valuemin', String(min));
    if (Number.isFinite(max)) input.setAttribute('aria-valuemax', String(max));
  };
  const commit = (v: number, silent = false): void => {
    const next = roundTo(clamp(v, min, max), decimals);
    const changed = next !== value;
    value = next;
    show();
    if (changed && !silent) opts.onChange?.(value);
  };
  const parseField = (): number | null => parseNumber(input.value);
  d.add(
    on(input, 'keydown', (e) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        const base = parseField() ?? value;
        commit(base + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1));
        input.select();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const p = parseField();
        if (p === null) show();
        else commit(p);
        input.select();
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        show();
        input.blur();
      }
    }),
  );
  d.add(
    on(input, 'blur', () => {
      const p = parseField();
      if (p === null) show();
      else commit(p);
    }),
  );
  d.add(on(input, 'focus', () => input.select()));
  // Stepper buttons auto-repeat while held.
  for (const [btn, dir] of [
    [up, 1],
    [down, -1],
  ] as const) {
    let repeat = 0;
    const stop = (): void => {
      window.clearTimeout(repeat);
      window.clearInterval(repeat);
      repeat = 0;
    };
    d.add(
      on(btn, 'pointerdown', (e) => {
        if (input.disabled) return;
        e.preventDefault();
        commit(value + dir * step * (e.shiftKey ? 10 : 1));
        stop();
        repeat = window.setTimeout(() => {
          repeat = window.setInterval(() => commit(value + dir * step), 60);
        }, 380);
      }),
    );
    d.add(on(btn, 'pointerup', stop));
    d.add(on(btn, 'pointerleave', stop));
    d.add(on(btn, 'pointercancel', stop));
    d.add(stop);
  }
  show();
  return {
    el,
    input,
    setValue: (v, silent = false) => commit(v, silent),
    getValue: () => value,
    setDisabled(b) {
      input.disabled = b;
      up.disabled = b;
      down.disabled = b;
      el.classList.toggle('is-disabled', b);
    },
    setRange(lo, hi) {
      min = lo;
      max = hi;
      commit(value, true);
    },
    destroy() {
      d.dispose();
      el.remove();
    },
  };
}

/* ------------------------------------------------------------------ */
/* TextInput                                                           */
/* ------------------------------------------------------------------ */

export interface TextInputOptions {
  value?: string;
  placeholder?: string;
  type?: 'text' | 'email' | 'url' | 'password' | 'tel';
  ariaLabel?: string;
  /** Visible label above the field. */
  label?: string;
  size?: 'sm' | 'md';
  maxLength?: number;
  disabled?: boolean;
  /** Every keystroke. */
  onInput?: (value: string) => void;
  /** Commit (Enter or blur after editing). */
  onChange?: (value: string) => void;
}

export interface TextInput extends Component<HTMLElement> {
  readonly input: HTMLInputElement;
  setValue(value: string): void;
  getValue(): string;
  focus(select?: boolean): void;
  setDisabled(disabled: boolean): void;
}

export function createTextInput(opts: TextInputOptions = {}): TextInput {
  const d = new Disposer();
  const id = kitId('k-input');
  const input = h('input', {
    id,
    class: ['k-input', opts.size === 'sm' && 'k-input--sm'],
    type: opts.type ?? 'text',
    value: opts.value ?? '',
    placeholder: opts.placeholder ?? '',
    disabled: !!opts.disabled,
    attrs: { 'aria-label': opts.label ? null : (opts.ariaLabel ?? opts.placeholder ?? null), maxlength: opts.maxLength ?? null, autocomplete: 'off' },
  });
  const el: HTMLElement = opts.label
    ? h('div', { class: 'k-field' }, h('label', { class: 'k-field__label', htmlFor: id }, opts.label), input)
    : input;
  let committed = input.value;
  d.add(on(input, 'input', () => opts.onInput?.(input.value)));
  const commit = (): void => {
    if (input.value === committed) return;
    committed = input.value;
    opts.onChange?.(committed);
  };
  d.add(on(input, 'change', commit));
  d.add(
    on(input, 'keydown', (e) => {
      if (e.key === 'Enter') commit();
    }),
  );
  return {
    el,
    input,
    setValue(v) {
      input.value = v;
      committed = v;
    },
    getValue: () => input.value,
    focus(select = false) {
      input.focus();
      if (select) input.select();
    },
    setDisabled: (b) => void (input.disabled = b),
    destroy() {
      d.dispose();
      el.remove();
    },
  };
}

/* ------------------------------------------------------------------ */
/* SearchInput — "Search by name" pill                                 */
/* ------------------------------------------------------------------ */

export interface SearchInputOptions {
  value?: string;
  placeholder?: string;
  ariaLabel?: string;
  /** Debounce for onInput in ms (default 120; 0 = every keystroke). */
  debounce?: number;
  /** CSS width (default 200px; the pill shrinks on narrow screens). */
  width?: string;
  onInput?: (value: string) => void;
  onSubmit?: (value: string) => void;
}

export interface SearchInput extends Component<HTMLDivElement> {
  readonly input: HTMLInputElement;
  setValue(value: string, silent?: boolean): void;
  getValue(): string;
  clear(): void;
  focus(): void;
}

export function createSearchInput(opts: SearchInputOptions = {}): SearchInput {
  const d = new Disposer();
  const input = h('input', {
    class: 'k-search__input',
    type: 'search',
    value: opts.value ?? '',
    placeholder: opts.placeholder ?? 'Search by name',
    attrs: { 'aria-label': opts.ariaLabel ?? opts.placeholder ?? 'Search by name', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'search' },
  });
  const clearBtn = h('button', { type: 'button', class: 'k-search__clear', tabIndex: -1, attrs: { 'aria-label': 'Clear search' } }, icon('x', 12, { strokeWidth: 1.75 }));
  const el = h('div', { class: 'k-search', style: opts.width ? { width: opts.width } : undefined }, icon('search', 13, { class: 'k-search__icon', strokeWidth: 1.4 }), input, clearBtn);
  const wait = opts.debounce ?? 120;
  let timer = 0;
  const sync = (): void => void el.classList.toggle('has-value', input.value.length > 0);
  const emit = (): void => {
    window.clearTimeout(timer);
    if (!wait) opts.onInput?.(input.value);
    else timer = window.setTimeout(() => opts.onInput?.(input.value), wait);
  };
  d.add(
    on(input, 'input', () => {
      sync();
      emit();
    }),
  );
  const clear = (): void => {
    if (!input.value) return;
    input.value = '';
    sync();
    window.clearTimeout(timer);
    opts.onInput?.('');
  };
  d.add(
    on(input, 'keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (input.value) {
          e.stopPropagation();
          clear();
        } else input.blur();
      } else if (e.key === 'Enter') {
        window.clearTimeout(timer);
        opts.onInput?.(input.value);
        opts.onSubmit?.(input.value);
      }
    }),
  );
  d.add(
    on(clearBtn, 'click', () => {
      clear();
      input.focus();
    }),
  );
  d.add(() => window.clearTimeout(timer));
  sync();
  return {
    el,
    input,
    setValue(v, silent = false) {
      input.value = v;
      sync();
      if (!silent) opts.onInput?.(v);
    },
    getValue: () => input.value,
    clear,
    focus: () => input.focus(),
    destroy() {
      d.dispose();
      el.remove();
    },
  };
}
