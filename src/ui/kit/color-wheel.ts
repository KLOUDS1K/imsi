/**
 * ColorWheel — hue/saturation disc for color grading, plus GradeWheelControl
 * (wheel + luminance slider, value = GradeWheel from editor/types).
 *
 *   const shadows = createGradeWheelControl({
 *     label: 'Shadows', value: p.colorGrading.shadows,
 *     onGestureStart: () => store.beginGesture('Shadows'),
 *     onInput: (v) => store.set('colorGrading.shadows', v),
 *     onGestureEnd: () => store.endGesture(),
 *   });
 *
 * Geometry: hue 0° (red) at 3 o'clock, increasing counter-clockwise (60°
 * yellow at upper right, 240° blue at lower left); saturation 0 at the centre,
 * 100 at the rim. Clicking jumps the point there, dragging is relative with
 * Shift = 5× finer, double-click / double-tap resets. Keyboard on the focused
 * wheel: ←/→ hue, ↑/↓ saturation (Shift fine, Alt ×10), Delete resets.
 * The disc is rendered once per pixel size into a HiDPI canvas; the handle is
 * a DOM element moved with transforms (no canvas redraw while dragging).
 */
import './color-wheel.css';
import type { GradeWheel } from '../../editor/types';
import { Disposer, h, on } from '../dom';
import { createSlider, type Slider } from './slider';
import { onThemeChange, readToken } from './theme';
import { type Component, clamp, kitId, onDoubleTap, roundTo } from './util';

export interface HueSat {
  /** 0..360 */
  hue: number;
  /** 0..100 */
  saturation: number;
}

export interface ColorWheelOptions {
  /** CSS px diameter (default 148). */
  size?: number;
  value?: HueSat;
  defaultValue?: HueSat;
  disabled?: boolean;
  ariaLabel?: string;
  onInput?: (v: HueSat) => void;
  onChange?: (v: HueSat) => void;
  onGestureStart?: () => void;
  onGestureEnd?: () => void;
}

export interface ColorWheel extends Component<HTMLDivElement> {
  setValue(v: HueSat, silent?: boolean): void;
  getValue(): HueSat;
  setDisabled(disabled: boolean): void;
  setSize(px: number): void;
  reset(): void;
  focus(): void;
}

/** Hue (deg) + saturation (0..1) → sRGB 0..255 at the wheel's lightness. */
function wheelRgb(hue: number, sat: number, out: Uint8ClampedArray, o: number): void {
  // HSL(h, 100%, 50%) → pure hue, then mix with a mid grey by saturation.
  const hp = (((hue % 360) + 360) % 360) / 60;
  const x = 1 - Math.abs((hp % 2) - 1);
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [1, x, 0];
  else if (hp < 2) [r, g, b] = [x, 1, 0];
  else if (hp < 3) [r, g, b] = [0, 1, x];
  else if (hp < 4) [r, g, b] = [0, x, 1];
  else if (hp < 5) [r, g, b] = [x, 0, 1];
  else [r, g, b] = [1, 0, x];
  const grey = 0.56;
  // Slight ease so the centre region stays usable for subtle grades.
  const s = Math.pow(sat, 0.85);
  out[o] = (grey + (r * 0.92 + 0.04 - grey) * s) * 255;
  out[o + 1] = (grey + (g * 0.92 + 0.04 - grey) * s) * 255;
  out[o + 2] = (grey + (b * 0.92 + 0.04 - grey) * s) * 255;
}

/** CSS colour of a wheel position (for the handle fill). */
export function hueSatToCss(v: HueSat): string {
  const px = new Uint8ClampedArray(3);
  wheelRgb(v.hue, clamp(v.saturation / 100, 0, 1), px, 0);
  return `rgb(${px[0]} ${px[1]} ${px[2]})`;
}

const discCache = new Map<number, ImageData>();

/** Anti-aliased hue/saturation disc of `n` device pixels (cached per size). */
function discImage(n: number): ImageData {
  const hit = discCache.get(n);
  if (hit) return hit;
  const img = new ImageData(n, n);
  const data = img.data;
  const c = n / 2;
  const R = n / 2 - 1;
  for (let y = 0; y < n; y++) {
    const dy = (c - (y + 0.5)) / R;
    for (let x = 0; x < n; x++) {
      const dx = (x + 0.5 - c) / R;
      const r = Math.hypot(dx, dy);
      const o = (y * n + x) * 4;
      const alpha = clamp((1 - r) * R + 0.5, 0, 1);
      if (alpha <= 0) continue;
      const hue = (Math.atan2(dy, dx) * 180) / Math.PI;
      wheelRgb(hue, Math.min(1, r), data, o);
      data[o + 3] = alpha * 255;
    }
  }
  discCache.set(n, img);
  return img;
}

export function createColorWheel(opts: ColorWheelOptions = {}): ColorWheel {
  const d = new Disposer();
  let size = opts.size ?? 148;
  const def: HueSat = opts.defaultValue ?? { hue: 0, saturation: 0 };
  let value: HueSat = { ...(opts.value ?? def) };
  let disabled = !!opts.disabled;

  const canvas = h('canvas', { class: 'k-wheel__canvas', attrs: { 'aria-hidden': 'true' } });
  const spoke = h('div', { class: 'k-wheel__spoke' });
  const handle = h('div', { class: 'k-wheel__handle' });
  const el = h(
    'div',
    {
      class: 'k-wheel',
      tabIndex: 0,
      attrs: { role: 'slider', 'aria-label': opts.ariaLabel ?? 'Colour wheel', 'aria-valuemin': 0, 'aria-valuemax': 100 },
    },
    canvas,
    spoke,
    handle,
  );

  function paint(): void {
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const n = Math.round(size * dpr);
    canvas.width = n;
    canvas.height = n;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.putImageData(discImage(n), 0, 0);
    // Rim + centre cross in theme colours (read from tokens).
    ctx.lineWidth = Math.max(1, dpr);
    ctx.strokeStyle = readToken('--k-border-strong') || 'transparent';
    ctx.beginPath();
    ctx.arc(n / 2, n / 2, n / 2 - ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = readToken('--k-text-faint') || 'transparent';
    const k = 4 * dpr;
    ctx.beginPath();
    ctx.moveTo(n / 2 - k, n / 2);
    ctx.lineTo(n / 2 + k, n / 2);
    ctx.moveTo(n / 2, n / 2 - k);
    ctx.lineTo(n / 2, n / 2 + k);
    ctx.stroke();
  }

  function render(): void {
    const R = size / 2;
    const r = (clamp(value.saturation, 0, 100) / 100) * (R - 1);
    const a = (value.hue * Math.PI) / 180;
    const x = Math.cos(a) * r;
    const y = -Math.sin(a) * r;
    handle.style.transform = `translate(${(R + x).toFixed(2)}px, ${(R + y).toFixed(2)}px) translate(-50%, -50%)`;
    handle.style.background = hueSatToCss(value);
    spoke.style.width = `${r.toFixed(2)}px`;
    spoke.style.transform = `translate(${R}px, ${R}px) rotate(${-value.hue}deg)`;
    const txt = `Hue ${Math.round(value.hue)}°, saturation ${Math.round(value.saturation)}`;
    el.setAttribute('aria-valuenow', String(Math.round(value.saturation)));
    el.setAttribute('aria-valuetext', txt);
    el.classList.toggle('is-modified', value.hue !== def.hue || value.saturation !== def.saturation);
  }

  /* ---- gestures (same contract as Slider) ---- */
  let active = false;
  let started = false;
  let startValue = value;
  let idle = 0;
  const begin = (): void => {
    if (active) return;
    active = true;
    started = false;
    startValue = { ...value };
  };
  const commit = (): void => {
    window.clearTimeout(idle);
    if (!active) return;
    active = false;
    el.classList.remove('is-dragging');
    if (started) {
      started = false;
      if (startValue.hue !== value.hue || startValue.saturation !== value.saturation) opts.onChange?.({ ...value });
      opts.onGestureEnd?.();
    }
  };
  const userSet = (v: HueSat): void => {
    const next = { hue: roundTo(((v.hue % 360) + 360) % 360, 1), saturation: roundTo(clamp(v.saturation, 0, 100), 1) };
    if (next.hue === value.hue && next.saturation === value.saturation) return;
    if (active && !started) {
      started = true;
      opts.onGestureStart?.();
    }
    value = next;
    render();
    opts.onInput?.({ ...value });
  };
  const reset = (): void => {
    if (disabled) return;
    begin();
    userSet(def);
    commit();
  };

  /* ---- pointer: position in normalised disc coords (x right, y up, |p| ≤ 1) ---- */
  let dragId: number | null = null;
  let px = 0;
  let py = 0;
  let lastX = 0;
  let lastY = 0;
  let cx = 0;
  let cy = 0;
  let R = 1;

  const fromPoint = (x: number, y: number): HueSat => {
    const r = Math.hypot(x, y);
    // At the exact centre keep the previous hue so the colour doesn't jump to red.
    const hue = r < 1e-3 ? value.hue : (Math.atan2(y, x) * 180) / Math.PI;
    return { hue, saturation: Math.min(1, r) * 100 };
  };
  const clampDisc = (): void => {
    const r = Math.hypot(px, py);
    if (r > 1) {
      px /= r;
      py /= r;
    }
  };

  d.add(
    on(el, 'pointerdown', (e) => {
      if (disabled || dragId !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
      const rect = el.getBoundingClientRect();
      cx = rect.left + rect.width / 2;
      cy = rect.top + rect.height / 2;
      R = rect.width / 2 - 1;
      const a = (value.hue * Math.PI) / 180;
      const s = value.saturation / 100;
      px = Math.cos(a) * s;
      py = Math.sin(a) * s;
      dragId = e.pointerId;
      lastX = e.clientX;
      lastY = e.clientY;
      begin();
      el.classList.add('is-dragging');
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic */
      }
      if (e.target !== handle) {
        px = (e.clientX - cx) / R;
        py = (cy - e.clientY) / R;
        clampDisc();
        userSet(fromPoint(px, py));
      }
      e.preventDefault();
      el.focus({ preventScroll: true });
    }),
  );
  d.add(
    on(el, 'pointermove', (e) => {
      if (e.pointerId !== dragId) return;
      const f = e.shiftKey ? 0.2 : 1;
      px += ((e.clientX - lastX) / R) * f;
      py -= ((e.clientY - lastY) / R) * f;
      lastX = e.clientX;
      lastY = e.clientY;
      clampDisc();
      userSet(fromPoint(px, py));
    }),
  );
  const end = (e: PointerEvent): void => {
    if (e.pointerId !== dragId) return;
    dragId = null;
    commit();
  };
  d.add(on(el, 'pointerup', end));
  d.add(on(el, 'pointercancel', end));
  d.add(on(el, 'lostpointercapture', end));
  d.add(on(el, 'dblclick', reset));
  d.add(onDoubleTap(el, reset));

  d.add(
    on(el, 'keydown', (e) => {
      if (disabled) return;
      const k = e.shiftKey ? 0.2 : e.altKey ? 10 : 1;
      let next: HueSat | null = null;
      if (e.key === 'ArrowLeft') next = { hue: value.hue + k, saturation: value.saturation }; // counter-clockwise
      else if (e.key === 'ArrowRight') next = { hue: value.hue - k, saturation: value.saturation };
      else if (e.key === 'ArrowUp') next = { hue: value.hue, saturation: value.saturation + k };
      else if (e.key === 'ArrowDown') next = { hue: value.hue, saturation: value.saturation - k };
      else if (e.key === 'PageUp') next = { hue: value.hue, saturation: value.saturation + 10 };
      else if (e.key === 'PageDown') next = { hue: value.hue, saturation: value.saturation - 10 };
      else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        e.stopPropagation();
        reset();
        return;
      }
      if (!next) return;
      e.preventDefault();
      e.stopPropagation();
      begin();
      userSet(next);
      window.clearTimeout(idle);
      idle = window.setTimeout(commit, 500);
    }),
  );
  d.add(on(el, 'blur', commit));
  d.add(onThemeChange(paint));

  const applyDisabled = (): void => {
    el.classList.toggle('is-disabled', disabled);
    el.tabIndex = disabled ? -1 : 0;
    el.setAttribute('aria-disabled', String(disabled));
  };

  paint();
  render();
  applyDisabled();

  return {
    el,
    setValue(v, silent = false) {
      const next = { hue: ((v.hue % 360) + 360) % 360, saturation: clamp(v.saturation, 0, 100) };
      if (next.hue === value.hue && next.saturation === value.saturation) return;
      value = next;
      render();
      if (!silent) {
        opts.onInput?.({ ...value });
        opts.onChange?.({ ...value });
      }
    },
    getValue: () => ({ ...value }),
    setDisabled(b) {
      if (b) commit();
      disabled = b;
      applyDisabled();
    },
    setSize(px_: number) {
      size = px_;
      paint();
      render();
    },
    reset,
    focus: () => el.focus(),
    destroy() {
      commit();
      d.dispose();
      el.remove();
    },
  };
}

/* ------------------------------------------------------------------ */
/* GradeWheelControl                                                   */
/* ------------------------------------------------------------------ */

export interface GradeWheelControlOptions {
  /** 'Shadows', 'Midtones', 'Highlights', 'Global'. */
  label: string;
  value?: GradeWheel;
  defaultValue?: GradeWheel;
  size?: number;
  /** Show the luminance slider (default true). */
  luminance?: boolean;
  disabled?: boolean;
  onInput?: (v: GradeWheel) => void;
  onChange?: (v: GradeWheel) => void;
  onGestureStart?: () => void;
  onGestureEnd?: () => void;
}

export interface GradeWheelControl extends Component<HTMLDivElement> {
  readonly wheel: ColorWheel;
  readonly luminance: Slider | null;
  setValue(v: GradeWheel, silent?: boolean): void;
  getValue(): GradeWheel;
  setDisabled(disabled: boolean): void;
  reset(): void;
}

export function createGradeWheelControl(opts: GradeWheelControlOptions): GradeWheelControl {
  const def: GradeWheel = opts.defaultValue ?? { hue: 0, saturation: 0, luminance: 0 };
  let value: GradeWheel = { ...(opts.value ?? def) };
  const labelId = kitId('k-grade-label');
  const readout = h('span', { class: 'k-grade__readout k-num' });
  const emit = (kind: 'input' | 'change'): void => {
    const v = { ...value };
    if (kind === 'input') opts.onInput?.(v);
    else opts.onChange?.(v);
  };
  const renderReadout = (): void => {
    readout.textContent = value.saturation ? `H ${Math.round(value.hue)}°  S ${Math.round(value.saturation)}` : '—';
    el.classList.toggle('is-modified', value.hue !== def.hue || value.saturation !== def.saturation || value.luminance !== def.luminance);
  };

  const wheel = createColorWheel({
    size: opts.size,
    value: { hue: value.hue, saturation: value.saturation },
    defaultValue: { hue: def.hue, saturation: def.saturation },
    ariaLabel: `${opts.label} hue and saturation`,
    disabled: opts.disabled,
    onGestureStart: opts.onGestureStart,
    onGestureEnd: opts.onGestureEnd,
    onInput: (hs) => {
      value = { ...value, ...hs };
      renderReadout();
      emit('input');
    },
    onChange: () => emit('change'),
  });
  const lum =
    opts.luminance === false
      ? null
      : createSlider({
          label: 'Luminance',
          min: -100,
          max: 100,
          value: value.luminance,
          defaultValue: def.luminance,
          ariaLabel: `${opts.label} luminance`,
          disabled: opts.disabled,
          onGestureStart: opts.onGestureStart,
          onGestureEnd: opts.onGestureEnd,
          onInput: (l) => {
            value = { ...value, luminance: l };
            renderReadout();
            emit('input');
          },
          onChange: () => emit('change'),
        });

  const el = h(
    'div',
    { class: 'k-grade', attrs: { role: 'group', 'aria-labelledby': labelId } },
    h('div', { class: 'k-grade__head' }, h('span', { class: 'k-label', id: labelId }, opts.label), readout),
    h('div', { class: 'k-grade__wheel' }, wheel.el),
    lum?.el ?? null,
  );
  renderReadout();

  return {
    el,
    wheel,
    luminance: lum,
    setValue(v, silent = false) {
      value = { ...v };
      wheel.setValue({ hue: v.hue, saturation: v.saturation }, true);
      lum?.setValue(v.luminance, true);
      renderReadout();
      if (!silent) {
        emit('input');
        emit('change');
      }
    },
    getValue: () => ({ ...value }),
    setDisabled(b) {
      wheel.setDisabled(b);
      lum?.setDisabled(b);
    },
    reset() {
      opts.onGestureStart?.();
      value = { ...def };
      wheel.setValue({ hue: def.hue, saturation: def.saturation }, true);
      lum?.setValue(def.luminance, true);
      renderReadout();
      emit('input');
      emit('change');
      opts.onGestureEnd?.();
    },
    destroy() {
      wheel.destroy();
      lum?.destroy();
      el.remove();
    },
  };
}
