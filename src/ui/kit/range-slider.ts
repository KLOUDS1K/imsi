/**
 * RangeSlider — two thumbs selecting [lo, hi] (luminance / depth range masks,
 * defringe hue ranges).
 *
 *   const hue = createRangeSlider({
 *     label: 'Purple hue', min: 0, max: 360, value: [270, 330], unit: '°',
 *     gradient: hueGradient(), onInput: ([lo, hi]) => …,
 *   });
 *
 * Drag a thumb, drag the filled segment to move the whole range, or click the
 * track to jump the nearest thumb. Shift = 10× finer. Each thumb is its own
 * role="slider" with arrow/Page/Home/End keys. Double-click resets.
 * Gesture callbacks behave like Slider's (lazy start, one commit per gesture).
 */
import { Disposer, h, on } from '../dom';
import './slider.css';
import { type Component, clamp, decimalsOf, formatNumber, kitId, onDoubleTap, roundTo, snapTo } from './util';

export type Range = [number, number];

export interface RangeSliderOptions {
  label?: string;
  min: number;
  max: number;
  value?: Range;
  /** Reset target. Default [min, max]. */
  defaultValue?: Range;
  step?: number;
  fineStep?: number;
  decimals?: number;
  unit?: string;
  /** Minimum distance between the thumbs. Default 0. */
  minGap?: number;
  /** CSS gradient for the rail (the outside of the range is dimmed). */
  gradient?: string;
  format?: (v: number) => string;
  disabled?: boolean;
  /** Accessible names of the two thumbs. Default "<label> minimum/maximum". */
  thumbLabels?: [string, string];
  id?: string;
  onInput?: (v: Range) => void;
  onChange?: (v: Range) => void;
  onGestureStart?: () => void;
  onGestureEnd?: () => void;
}

export interface RangeSlider extends Component<HTMLDivElement> {
  setValue(v: Range, silent?: boolean): void;
  getValue(): Range;
  setDisabled(disabled: boolean): void;
  setDefault(v: Range): void;
  reset(): void;
}

type Target = 0 | 1 | 'both';

export function createRangeSlider(opts: RangeSliderOptions): RangeSlider {
  const d = new Disposer();
  const { min, max } = opts;
  const step = opts.step ?? 1;
  const decimals = opts.decimals ?? decimalsOf(step);
  const fineStep = opts.fineStep ?? Math.max(step / 10, 10 ** -decimals);
  const gap = opts.minGap ?? 0;
  const span = max - min || 1;
  let def: Range = opts.defaultValue ?? [min, max];
  let value: Range = normalize(opts.value ?? def);
  let disabled = !!opts.disabled;

  function normalize([a, b]: Range): Range {
    let lo = clamp(Math.min(a, b), min, max);
    let hi = clamp(Math.max(a, b), min, max);
    if (hi - lo < gap) {
      if (lo + gap <= max) hi = lo + gap;
      else lo = hi - gap;
    }
    return [roundTo(lo, decimals + 1), roundTo(hi, decimals + 1)];
  }

  const fmt = (v: number): string => opts.format?.(v) ?? formatNumber(v, decimals, min < 0) + (opts.unit ?? '');
  const labelId = kitId('k-range-label');
  const label = h('span', { class: 'k-range__label', id: labelId, title: 'Double-click to reset' }, opts.label ?? '');
  const readout = h('span', { class: 'k-range__value k-num', attrs: { 'aria-hidden': 'true' } });
  const rail = h('div', { class: 'k-range__rail' });
  const fill = h('div', { class: 'k-range__fill' });
  const names = opts.thumbLabels ?? [`${opts.label ?? 'Range'} minimum`, `${opts.label ?? 'Range'} maximum`];
  const mkThumb = (i: 0 | 1): HTMLDivElement =>
    h('div', {
      class: ['k-range__thumb', i === 0 ? 'k-range__thumb--lo' : 'k-range__thumb--hi'],
      attrs: { role: 'slider', tabindex: 0, 'aria-label': names[i], 'aria-orientation': 'horizontal' },
    });
  const thumbs = [mkThumb(0), mkThumb(1)] as const;
  const dims = [h('div', { class: 'k-range__dim k-range__dim--lo' }), h('div', { class: 'k-range__dim k-range__dim--hi' })];
  const track = h('div', { class: 'k-range__track' }, rail, ...(opts.gradient ? dims : []), fill, thumbs[0], thumbs[1]);
  const el = h(
    'div',
    {
      class: ['k-range', opts.gradient && 'has-gradient'],
      dataset: opts.id ? { id: opts.id } : undefined,
      attrs: { role: 'group', 'aria-labelledby': opts.label ? labelId : null },
    },
    opts.label !== undefined ? h('div', { class: 'k-range__head' }, label, readout) : null,
    track,
  );
  if (opts.gradient) rail.style.background = opts.gradient;

  const toT = (v: number): number => (v - min) / span;

  function render(): void {
    el.style.setProperty('--k-range-lo', String(toT(value[0])));
    el.style.setProperty('--k-range-hi', String(toT(value[1])));
    readout.textContent = `${fmt(value[0])} – ${fmt(value[1])}`;
    thumbs.forEach((t, i) => {
      t.setAttribute('aria-valuenow', String(value[i]));
      t.setAttribute('aria-valuetext', fmt(value[i]));
      t.setAttribute('aria-valuemin', String(i === 0 ? min : value[0] + gap));
      t.setAttribute('aria-valuemax', String(i === 0 ? value[1] - gap : max));
    });
    el.classList.toggle('is-modified', value[0] !== def[0] || value[1] !== def[1]);
  }

  function renderStatic(): void {
    el.classList.toggle('is-disabled', disabled);
    for (const t of thumbs) {
      t.tabIndex = disabled ? -1 : 0;
      t.setAttribute('aria-disabled', String(disabled));
    }
  }

  /* ---- gestures (same contract as Slider) ---- */
  let active = false;
  let started = false;
  let startValue: Range = value;
  let idle = 0;

  function begin(): void {
    if (active) return;
    active = true;
    started = false;
    startValue = value;
  }
  function commit(): void {
    window.clearTimeout(idle);
    if (!active) return;
    active = false;
    if (started) {
      started = false;
      if (value[0] !== startValue[0] || value[1] !== startValue[1]) opts.onChange?.(value);
      opts.onGestureEnd?.();
    }
  }
  function userSet(next: Range): void {
    const v = normalize(next);
    if (v[0] === value[0] && v[1] === value[1]) return;
    if (active && !started) {
      started = true;
      opts.onGestureStart?.();
    }
    value = v;
    render();
    opts.onInput?.(value);
  }

  /** Move one thumb without letting it cross the other. */
  function moveThumb(i: 0 | 1, v: number): Range {
    return i === 0 ? [Math.min(v, value[1] - gap), value[1]] : [value[0], Math.max(v, value[0] + gap)];
  }

  function reset(): void {
    if (disabled) return;
    begin();
    userSet(def);
    commit();
  }

  /* ---- pointer ---- */
  let dragId: number | null = null;
  let target: Target = 0;
  let lastX = 0;
  let raw: [number, number] = [0, 0];
  let left = 0;
  let inner = 1;

  d.add(
    on(track, 'pointerdown', (e) => {
      if (disabled || dragId !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
      const r = track.getBoundingClientRect();
      const thumbR = thumbs[0].offsetWidth / 2 || 6;
      left = r.left + thumbR;
      inner = Math.max(1, r.width - thumbR * 2);
      const t = clamp((e.clientX - left) / inner, 0, 1);
      const at = min + t * span;
      if (e.target === thumbs[0]) target = 0;
      else if (e.target === thumbs[1]) target = 1;
      else if (e.target === fill) target = 'both';
      else target = Math.abs(at - value[0]) <= Math.abs(at - value[1]) && !(at > value[1]) ? 0 : 1;
      dragId = e.pointerId;
      lastX = e.clientX;
      raw = [value[0], value[1]];
      begin();
      try {
        track.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic */
      }
      if (target === 'both') el.classList.add('is-moving');
      else thumbs[target].classList.add('is-dragging');
      const onThumbOrFill = e.target === thumbs[0] || e.target === thumbs[1] || e.target === fill;
      if (!onThumbOrFill && target !== 'both' && e.pointerType !== 'touch') {
        raw[target] = at;
        userSet(moveThumb(target, snapTo(at, step, min)));
      }
      if (e.pointerType !== 'touch') {
        e.preventDefault();
        (target === 'both' ? thumbs[0] : thumbs[target]).focus({ preventScroll: true });
      }
    }),
  );

  d.add(
    on(track, 'pointermove', (e) => {
      if (e.pointerId !== dragId) return;
      const dx = e.clientX - lastX;
      lastX = e.clientX;
      if (!dx) return;
      const dv = (dx / inner) * span * (e.shiftKey ? 0.1 : 1);
      const q = e.shiftKey ? fineStep : step;
      if (target === 'both') {
        const width = raw[1] - raw[0];
        const lo = clamp(raw[0] + dv, min, max - width);
        raw = [lo, lo + width];
        userSet([snapTo(raw[0], q, min), snapTo(raw[0], q, min) + (value[1] - value[0])]);
      } else {
        raw[target] = clamp(raw[target] + dv, min, max);
        userSet(moveThumb(target, snapTo(raw[target], q, min)));
      }
    }),
  );

  const end = (e: PointerEvent): void => {
    if (e.pointerId !== dragId) return;
    dragId = null;
    el.classList.remove('is-moving');
    for (const t of thumbs) t.classList.remove('is-dragging');
    commit();
  };
  d.add(on(track, 'pointerup', end));
  d.add(on(track, 'pointercancel', end));
  d.add(on(track, 'lostpointercapture', end));

  for (const t of [label, track]) {
    d.add(on(t, 'dblclick', reset));
    d.add(onDoubleTap(t, reset));
  }

  /* ---- keyboard ---- */
  thumbs.forEach((thumb, idx) => {
    const i = idx as 0 | 1;
    d.add(
      on(thumb, 'keydown', (e) => {
        if (disabled) return;
        const inc = e.shiftKey ? fineStep : e.altKey ? step * 10 : step;
        const cur = value[i];
        let next: number;
        switch (e.key) {
          case 'ArrowRight':
          case 'ArrowUp':
            next = cur + inc;
            break;
          case 'ArrowLeft':
          case 'ArrowDown':
            next = cur - inc;
            break;
          case 'PageUp':
            next = cur + step * 10;
            break;
          case 'PageDown':
            next = cur - step * 10;
            break;
          case 'Home':
            next = min;
            break;
          case 'End':
            next = max;
            break;
          default:
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        begin();
        userSet(moveThumb(i, next));
        window.clearTimeout(idle);
        idle = window.setTimeout(commit, 500);
      }),
    );
    d.add(on(thumb, 'blur', commit));
  });

  renderStatic();
  render();

  return {
    el,
    setValue(v: Range, silent = false) {
      const next = normalize(v);
      if (next[0] === value[0] && next[1] === value[1]) return;
      value = next;
      render();
      if (!silent) {
        opts.onInput?.(value);
        opts.onChange?.(value);
      }
    },
    getValue: () => [value[0], value[1]],
    setDisabled(b: boolean) {
      if (b) commit();
      disabled = b;
      renderStatic();
    },
    setDefault(v: Range) {
      def = normalize(v);
      render();
    },
    reset,
    destroy() {
      commit();
      d.dispose();
      el.remove();
    },
  };
}
