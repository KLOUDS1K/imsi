/**
 * Slider — Lightroom-grade single-value slider.
 *
 *   const exposure = createSlider({
 *     label: 'Exposure', min: -5, max: 5, step: 0.05, fineStep: 0.01, decimals: 2,
 *     value: store.get('basic.exposure'),
 *     onGestureStart: () => store.beginGesture('Exposure'),
 *     onInput: (v) => store.set('basic.exposure', v),
 *     onGestureEnd: () => store.endGesture(),
 *   });
 *   panel.append(exposure.el);
 *   store.subscribe((p) => exposure.setValue(p.basic.exposure, true));
 *
 * Interaction
 * - Drag (pointer capture, relative): clicking the track jumps there first
 *   (mouse/pen; touch only drags so vertical panel scrolling is safe).
 *   Hold Shift while dragging for 10× finer movement.
 * - Wheel while hovered: one step per notch; Shift = fine, Alt = ×10. The page
 *   keeps scrolling if a scroll was in progress and the pointer has not moved.
 * - Keyboard on the thumb: ←/→/↑/↓ = step (Shift fine, Alt ×10), PageUp/Down
 *   = ×10, Home/End = min/max, Enter = type a value, Delete/Backspace = reset.
 * - Double-click (or double-tap) the label, track or thumb to reset to default.
 * - Click the value readout to type (Enter commits, Escape cancels, ↑/↓ step).
 *
 * Callbacks: every user interaction is wrapped as a gesture. onGestureStart
 * fires lazily on the first actual value change, onInput for every change,
 * then onChange(final) + onGestureEnd when the interaction ends (pointer up,
 * wheel/keyboard idle, Enter). A click that changes nothing fires nothing.
 */
import './slider.css';
import { Disposer, h, on } from '../dom';
import {
  type Component,
  clamp,
  decimalsOf,
  formatNumber,
  kitId,
  onDoubleTap,
  parseNumber,
  roundTo,
  snapTo,
} from './util';

/** Optional non-linear mapping between value and track position (0..1). */
export interface SliderScale {
  toT(value: number, min: number, max: number): number;
  fromT(t: number, min: number, max: number): number;
}

export interface SliderOptions {
  label: string;
  min: number;
  max: number;
  /** Initial value (defaults to `defaultValue`). */
  value?: number;
  /** Reset target and fill origin. Default: 0 clamped into [min, max]. */
  defaultValue?: number;
  /** Drag snap + keyboard/wheel increment. Default 1. */
  step?: number;
  /** Increment with Shift (and Shift-drag snap). Default max(step/10, 10^-decimals). */
  fineStep?: number;
  /** Readout decimals. Default derived from `step`. */
  decimals?: number;
  /** Appended to the readout: '%', '°', ' EV', 'K'… */
  unit?: string;
  /** Show '+' on positive values. Default: true when min < 0. */
  signed?: boolean;
  /** Where the accent fill starts: the default value (bipolar), min, or no fill. Default 'default'. */
  fill?: 'default' | 'min' | 'none';
  /** CSS gradient painted on the track (temperature, tint, HSL bars). Hides the fill. */
  gradient?: string;
  /** Custom readout formatter (overrides decimals/unit/signed). */
  format?: (v: number) => string;
  /** Custom parser for typed values. Return null to reject. */
  parse?: (text: string) => number | null;
  /** 'row' = label | track | value (default); 'stacked' = label + value above the track. */
  layout?: 'row' | 'stacked';
  scale?: SliderScale;
  disabled?: boolean;
  /** Mouse-wheel adjustment while hovered. Default true. */
  wheel?: boolean;
  /** Accessible name if different from `label`. */
  ariaLabel?: string;
  /** Tooltip on the label. Default "Double-click to reset". */
  title?: string;
  /** Stored in data-id (handy for tests and delegation). */
  id?: string;
  onInput?: (v: number) => void;
  onChange?: (v: number) => void;
  onGestureStart?: () => void;
  onGestureEnd?: () => void;
}

export interface Slider extends Component<HTMLDivElement> {
  /** Set from outside. `silent` (recommended for store sync) fires no callbacks; otherwise onInput + onChange fire. */
  setValue(v: number, silent?: boolean): void;
  getValue(): number;
  setDisabled(disabled: boolean): void;
  setDefault(v: number): void;
  setRange(min: number, max: number): void;
  setLabel(text: string): void;
  setGradient(css: string | null): void;
  /** Reset to default as a user action (fires the gesture callbacks). */
  reset(): void;
  isModified(): boolean;
  focus(): void;
}

/** Logarithmic scale helper for sliders like brush size or zoom (min must be > 0). */
export const logScale: SliderScale = {
  toT: (v, min, max) => Math.log(v / min) / Math.log(max / min),
  fromT: (t, min, max) => min * Math.pow(max / min, t),
};

const linearScale: SliderScale = {
  toT: (v, min, max) => (max === min ? 0 : (v - min) / (max - min)),
  fromT: (t, min, max) => min + t * (max - min),
};

/* ---- page-scroll guard shared by all sliders ---- */
let lastPageWheelAt = -1e9;
let wheelGuard = false;
function installWheelGuard(): void {
  if (wheelGuard || typeof window === 'undefined') return;
  wheelGuard = true;
  // Runs after the slider handlers (bubble phase on window): anything not
  // consumed by a slider is page scrolling.
  window.addEventListener('wheel', (e) => {
    if (!e.defaultPrevented) lastPageWheelAt = e.timeStamp;
  }, { passive: true });
}

type GestureKind = 'drag' | 'wheel' | 'key' | 'once';

export function createSlider(opts: SliderOptions): Slider {
  const d = new Disposer();
  let min = opts.min;
  let max = opts.max;
  const step = opts.step ?? 1;
  const decimals = opts.decimals ?? decimalsOf(step);
  const fineStep = opts.fineStep ?? Math.max(step / 10, 10 ** -decimals);
  const signed = opts.signed ?? min < 0;
  const scale = opts.scale ?? linearScale;
  let def = clamp(opts.defaultValue ?? 0, min, max);
  let value = clamp(opts.value ?? def, min, max);
  let disabled = !!opts.disabled;

  const labelId = kitId('k-slider-label');
  const label = h('span', { class: 'k-slider__label', id: labelId, title: opts.title ?? 'Double-click to reset' }, opts.label);
  const rail = h('div', { class: 'k-slider__rail' });
  const tick = h('div', { class: 'k-slider__tick', attrs: { 'aria-hidden': 'true' } });
  const fill = h('div', { class: 'k-slider__fill' });
  const thumb = h('div', {
    class: 'k-slider__thumb',
    attrs: {
      role: 'slider',
      tabindex: disabled ? -1 : 0,
      'aria-labelledby': opts.ariaLabel ? null : labelId,
      'aria-label': opts.ariaLabel ?? null,
      'aria-orientation': 'horizontal',
    },
  });
  const track = h('div', { class: 'k-slider__track' }, rail, tick, fill, thumb);
  const readout = h('button', {
    class: 'k-slider__value k-num',
    type: 'button',
    tabIndex: -1,
    attrs: { 'aria-label': `Edit ${opts.ariaLabel ?? opts.label} value` },
  });
  const input = h('input', {
    class: 'k-slider__input k-num',
    type: 'text',
    hidden: true,
    attrs: { inputmode: 'decimal', autocomplete: 'off', spellcheck: 'false', 'aria-label': `${opts.ariaLabel ?? opts.label} value` },
  });
  const row = h('div', { class: 'k-slider__row' }, label, track, readout, input);
  const el = h(
    'div',
    {
      class: ['k-slider', opts.layout === 'stacked' && 'k-slider--stacked', opts.fill === 'none' && 'k-slider--nofill'],
      dataset: opts.id ? { id: opts.id } : undefined,
    },
    row,
  );

  /* ---- formatting ---- */
  const format = (v: number): string => opts.format?.(v) ?? formatNumber(v, decimals, signed) + (opts.unit ?? '');
  const quantize = (v: number): number => roundTo(clamp(v, min, max), decimals + 1);
  const toT = (v: number): number => clamp(scale.toT(v, min, max), 0, 1);
  const eps = 10 ** -(decimals + 1);
  const isModified = (): boolean => Math.abs(value - def) > eps;

  function render(): void {
    const t = toT(value);
    const origin = opts.fill === 'min' ? 0 : toT(def);
    el.style.setProperty('--k-slider-t', String(t));
    el.style.setProperty('--k-slider-a', String(Math.min(origin, t)));
    el.style.setProperty('--k-slider-b', String(Math.max(origin, t)));
    el.style.setProperty('--k-slider-d', String(toT(def)));
    const text = format(value);
    if (!input.hidden) {
      /* editing — keep the field untouched */
    } else if (readout.textContent !== text) readout.textContent = text;
    thumb.setAttribute('aria-valuenow', String(roundTo(value, decimals)));
    thumb.setAttribute('aria-valuetext', text);
    el.classList.toggle('is-modified', isModified());
  }

  function renderStatic(): void {
    thumb.setAttribute('aria-valuemin', String(min));
    thumb.setAttribute('aria-valuemax', String(max));
    // Default tick only makes sense for an interior default (bipolar sliders).
    updateTick();
    el.classList.toggle('is-disabled', disabled);
    thumb.setAttribute('aria-disabled', String(disabled));
    thumb.tabIndex = disabled ? -1 : 0;
    readout.disabled = disabled;
  }

  function updateTick(): void {
    const t = toT(def);
    tick.hidden = el.classList.contains('has-gradient') || t <= 0.001 || t >= 0.999;
  }

  function setGradient(css: string | null): void {
    rail.style.background = css ?? '';
    el.classList.toggle('has-gradient', !!css);
    updateTick();
  }

  /* ---- gesture state ---- */
  let gesture: GestureKind | null = null;
  let started = false; // onGestureStart already fired for this gesture
  let startValue = value;
  let idleTimer = 0;

  function begin(kind: GestureKind): void {
    if (gesture && gesture !== kind) commit();
    if (!gesture) {
      gesture = kind;
      started = false;
      startValue = value;
    }
  }

  function commit(): void {
    window.clearTimeout(idleTimer);
    idleTimer = 0;
    if (!gesture) return;
    gesture = null;
    el.classList.remove('is-dragging');
    if (started) {
      started = false;
      if (value !== startValue) opts.onChange?.(value);
      opts.onGestureEnd?.();
    }
  }

  /** Commit after a quiet period (wheel / keyboard bursts become one history step). */
  function commitSoon(ms: number): void {
    window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(commit, ms);
  }

  /** Apply a user-originated value. */
  function userSet(v: number): void {
    const next = quantize(v);
    if (next === value) return;
    if (gesture && !started) {
      started = true;
      opts.onGestureStart?.();
    }
    value = next;
    render();
    opts.onInput?.(value);
  }

  function oneShot(v: number): void {
    begin('once');
    userSet(v);
    commit();
  }

  const reset = (): void => {
    if (!disabled) oneShot(def);
  };

  /* ---- pointer drag ---- */
  let dragId: number | null = null;
  let lastX = 0;
  let rawT = 0;
  let trackLeft = 0;
  let trackInner = 1;

  d.add(
    on(track, 'pointerdown', (e) => {
      if (disabled || dragId !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
      // Layout is read once per gesture, never in pointermove.
      const r = track.getBoundingClientRect();
      const thumbR = thumb.offsetWidth / 2 || 6; // 6px, or 8px on coarse pointers
      trackLeft = r.left + thumbR;
      trackInner = Math.max(1, r.width - thumbR * 2);
      dragId = e.pointerId;
      lastX = e.clientX;
      rawT = toT(value);
      begin('drag');
      el.classList.add('is-dragging');
      try {
        track.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic events in tests */
      }
      const onThumb = e.target === thumb;
      if (!onThumb && e.pointerType !== 'touch') {
        rawT = clamp((e.clientX - trackLeft) / trackInner, 0, 1);
        userSet(snapTo(scale.fromT(rawT, min, max), e.shiftKey ? fineStep : step, min));
      }
      if (e.pointerType !== 'touch') {
        e.preventDefault(); // no text selection; keep focus handling below
        thumb.focus({ preventScroll: true });
      }
    }),
  );

  d.add(
    on(track, 'pointermove', (e) => {
      if (e.pointerId !== dragId) return;
      const dx = e.clientX - lastX;
      lastX = e.clientX;
      if (!dx) return;
      // Relative drag in track space; Shift = 10× finer. Clamping the
      // accumulator makes reversal at the ends respond immediately.
      rawT = clamp(rawT + (dx / trackInner) * (e.shiftKey ? 0.1 : 1), 0, 1);
      userSet(snapTo(scale.fromT(rawT, min, max), e.shiftKey ? fineStep : step, min));
    }),
  );

  const endDrag = (e: PointerEvent): void => {
    if (e.pointerId !== dragId) return;
    dragId = null;
    commit();
  };
  d.add(on(track, 'pointerup', endDrag));
  d.add(on(track, 'pointercancel', endDrag));
  d.add(on(track, 'lostpointercapture', endDrag));

  /* ---- reset: double-click / double-tap ---- */
  for (const target of [label, track]) {
    d.add(on(target, 'dblclick', reset));
    d.add(onDoubleTap(target, reset));
  }

  /* ---- wheel ---- */
  let lastMoveAt = -1e9;
  let lastMX = NaN;
  let lastMY = NaN;
  let wheelAcc = 0;
  if (opts.wheel !== false) {
    installWheelGuard();
    d.add(
      on(row, 'pointermove', (e) => {
        // Only real movement counts (browsers may re-dispatch after scrolling).
        if (e.clientX !== lastMX || e.clientY !== lastMY) {
          lastMX = e.clientX;
          lastMY = e.clientY;
          lastMoveAt = e.timeStamp;
        }
      }),
    );
    d.add(
      on(
        row,
        'wheel',
        (e) => {
          if (disabled || !input.hidden) return;
          // Page was being scrolled and the slider slid under a still pointer: let it scroll.
          if (e.timeStamp - lastPageWheelAt < 350 && lastMoveAt < lastPageWheelAt) return;
          // Shift+wheel arrives as deltaX on macOS — use the dominant axis.
          const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
          if (!delta) return;
          e.preventDefault();
          let notches = 0;
          if (e.deltaMode !== 0 || Math.abs(delta) >= 50) notches = Math.sign(delta);
          else {
            // Trackpads send many small deltas: accumulate ~one notch worth.
            wheelAcc += delta;
            if (Math.abs(wheelAcc) >= 50) {
              notches = Math.sign(wheelAcc);
              wheelAcc = 0;
            }
          }
          if (!notches) return;
          const inc = e.shiftKey ? fineStep : e.altKey ? step * 10 : step;
          begin('wheel');
          userSet(value - notches * inc);
          commitSoon(400);
        },
        { passive: false },
      ),
    );
    d.add(
      on(row, 'pointerleave', () => {
        wheelAcc = 0;
        if (gesture === 'wheel') commit();
      }),
    );
  }

  /* ---- keyboard ---- */
  d.add(
    on(thumb, 'keydown', (e) => {
      if (disabled) return;
      const inc = e.shiftKey ? fineStep : e.altKey ? step * 10 : step;
      let next: number | null = null;
      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowUp':
          next = value + inc;
          break;
        case 'ArrowLeft':
        case 'ArrowDown':
          next = value - inc;
          break;
        case 'PageUp':
          next = value + step * 10;
          break;
        case 'PageDown':
          next = value - step * 10;
          break;
        case 'Home':
          next = min;
          break;
        case 'End':
          next = max;
          break;
        case 'Delete':
        case 'Backspace':
          e.preventDefault();
          e.stopPropagation();
          reset();
          return;
        case 'Enter':
          e.preventDefault();
          e.stopPropagation();
          startEditing();
          return;
        default:
          return;
      }
      // Keep app shortcuts (arrow = next photo…) from firing while a slider has focus.
      e.preventDefault();
      e.stopPropagation();
      begin('key');
      userSet(next);
      commitSoon(500);
    }),
  );
  d.add(on(thumb, 'blur', () => gesture === 'key' && commit()));

  /* ---- typed value ---- */
  function startEditing(): void {
    if (disabled) return;
    input.value = opts.format ? format(value) : formatNumber(value, decimals, false).replace('−', '-');
    readout.hidden = true;
    input.hidden = false;
    input.focus();
    input.select();
  }

  function stopEditing(apply: boolean): void {
    if (input.hidden) return;
    const parsed = apply ? (opts.parse ? opts.parse(input.value) : parseNumber(input.value)) : null;
    input.hidden = true;
    readout.hidden = false;
    if (parsed !== null && Number.isFinite(parsed)) oneShot(parsed);
    render();
  }

  d.add(on(readout, 'click', startEditing));
  d.add(
    on(input, 'keydown', (e) => {
      e.stopPropagation(); // typing digits must not trigger app shortcuts
      if (e.key === 'Enter') {
        e.preventDefault();
        stopEditing(true);
        thumb.focus({ preventScroll: true });
      } else if (e.key === 'Escape') {
        e.preventDefault();
        stopEditing(false);
        thumb.focus({ preventScroll: true });
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const cur = (opts.parse ? opts.parse(input.value) : parseNumber(input.value)) ?? value;
        const inc = (e.shiftKey ? fineStep : e.altKey ? step * 10 : step) * (e.key === 'ArrowUp' ? 1 : -1);
        input.value = formatNumber(quantize(cur + inc), decimals, false).replace('−', '-');
      }
    }),
  );
  d.add(on(input, 'blur', () => stopEditing(true)));

  if (opts.gradient) setGradient(opts.gradient);
  renderStatic();
  render();

  return {
    el,
    setValue(v: number, silent = false) {
      const next = clamp(v, min, max);
      if (!Number.isFinite(next) || next === value) return;
      value = next;
      render();
      if (!silent) {
        opts.onInput?.(value);
        opts.onChange?.(value);
      }
    },
    getValue: () => value,
    setDisabled(b: boolean) {
      if (b === disabled) return;
      if (b) {
        commit();
        stopEditing(false);
      }
      disabled = b;
      renderStatic();
    },
    setDefault(v: number) {
      def = clamp(v, min, max);
      renderStatic();
      render();
    },
    setRange(lo: number, hi: number) {
      min = lo;
      max = hi;
      def = clamp(def, min, max);
      value = clamp(value, min, max);
      renderStatic();
      render();
    },
    setLabel(text: string) {
      label.textContent = text;
    },
    setGradient,
    reset,
    isModified,
    focus: () => thumb.focus(),
    destroy() {
      commit();
      d.dispose();
      el.remove();
    },
  };
}
