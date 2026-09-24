/**
 * Canvas plumbing shared by the scope renderers (DOM-only): HiDPI sizing,
 * theme colours read from the `--k-*` tokens, CSS colour parsing and the
 * per-pixel "light" compositing used for RGB traces.
 */
import type { ScopeOptions } from '@/editor/contracts';

export type Rgb255 = [number, number, number];

export interface ScopeTheme {
  dark: boolean;
  bg: Rgb255;
  bgCss: string;
  grid: string;
  label: string;
  /** Trace colour for monochrome (luma) traces. */
  trace: Rgb255;
  accent: string;
  clipHigh: string;
  clipLow: string;
  font: string;
  gain: number;
}

export interface PreparedCanvas {
  ctx: CanvasRenderingContext2D;
  /** Device-pixel size. */
  w: number;
  h: number;
  dpr: number;
}

/**
 * Size the backing store to CSS size × devicePixelRatio. When the canvas has
 * no CSS size of its own (its layout size follows the width/height
 * attributes), its current size is pinned with inline styles first, so
 * repeated draws do not grow it.
 */
export function prepareCanvas(canvas: HTMLCanvasElement): PreparedCanvas | null {
  const dpr = Math.max(1, Math.min(3, (typeof window !== 'undefined' && window.devicePixelRatio) || 1));
  let cssW = canvas.clientWidth;
  let cssH = canvas.clientHeight;
  const attrDriven = canvas.style.width === '' && cssW === canvas.width && cssH === canvas.height;
  if (!cssW || !cssH) {
    cssW = Number(canvas.dataset.kScopeW) || canvas.width;
    cssH = Number(canvas.dataset.kScopeH) || canvas.height;
  } else if (attrDriven && canvas.dataset.kScopeW) {
    cssW = Number(canvas.dataset.kScopeW);
    cssH = Number(canvas.dataset.kScopeH);
  }
  if (!cssW || !cssH) return null;
  if (attrDriven && dpr !== 1) {
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
  }
  canvas.dataset.kScopeW = String(cssW);
  canvas.dataset.kScopeH = String(cssH);
  const w = Math.max(1, Math.round(cssW * dpr));
  const h = Math.max(1, Math.round(cssH * dpr));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  return { ctx, w, h, dpr };
}

const colorCache = new Map<string, Rgb255>();
let probe: CanvasRenderingContext2D | null = null;

/** Resolve any CSS colour string to 8-bit RGB (alpha is composited over black/white is ignored). */
export function parseColor(css: string, fallback: Rgb255): Rgb255 {
  const key = css.trim();
  if (!key) return fallback;
  const hit = colorCache.get(key);
  if (hit) return hit;
  let out: Rgb255 | null = null;
  const hex = /^#([0-9a-f]{3,8})$/i.exec(key);
  if (hex) {
    const s = hex[1];
    if (s.length === 3 || s.length === 4) out = [0, 1, 2].map((i) => parseInt(s[i] + s[i], 16)) as Rgb255;
    else if (s.length === 6 || s.length === 8) out = [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16)) as Rgb255;
  }
  if (!out) {
    const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(key);
    if (m) out = [Number(m[1]), Number(m[2]), Number(m[3])].map((v) => Math.round(v)) as Rgb255;
  }
  if (!out && typeof document !== 'undefined') {
    // Named colours, hsl(), color(): let the browser resolve them.
    if (!probe) probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    if (probe) {
      probe.clearRect(0, 0, 1, 1);
      probe.fillStyle = '#000';
      probe.fillStyle = key;
      probe.fillRect(0, 0, 1, 1);
      const d = probe.getImageData(0, 0, 1, 1).data;
      out = [d[0], d[1], d[2]];
    }
  }
  const res = out ?? fallback;
  colorCache.set(key, res);
  return res;
}

const relLum = (c: Rgb255) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;

/** Read the theme tokens (document root) merged with explicit options. */
export function readTheme(opts: ScopeOptions | undefined): ScopeTheme {
  const cs = typeof document !== 'undefined' ? getComputedStyle(document.documentElement) : null;
  const tok = (name: string, fb: string) => (cs?.getPropertyValue(name).trim() || fb);
  const bgCss = opts?.background ?? tok('--k-bg', '#0e0e10');
  const bg = parseColor(bgCss, [14, 14, 16]);
  const dark = relLum(bg) < 0.45;
  const text = parseColor(tok('--k-text', dark ? '#f2f2f3' : '#1b1b1c'), dark ? [242, 242, 243] : [27, 27, 28]);
  return {
    dark,
    bg,
    bgCss,
    grid: opts?.grid ?? tok('--k-border-strong', dark ? '#2f2f34' : '#d4d1ca'),
    label: tok('--k-text-muted', dark ? '#8b8b91' : '#77766f'),
    trace: text,
    accent: tok('--k-accent-strong', '#e0aa14'),
    clipHigh: tok('--k-clip-high', '#ff3b30'),
    clipLow: tok('--k-clip-low', '#2f7dff'),
    font: tok('--k-font-mono', 'ui-monospace, monospace'),
    gain: opts?.gain && opts.gain > 0 ? opts.gain : 1,
  };
}

/**
 * Channel ink colours. On a dark background the traces ADD light (R+G+B
 * overlap → white, like a hardware scope); on a light background they act as
 * inks that MULTIPLY the paper (overlap → dark), which reads the same way.
 */
export function channelColors(dark: boolean): [Rgb255, Rgb255, Rgb255] {
  return dark
    ? [
        [235, 55, 50],
        [45, 205, 70],
        [45, 105, 255],
      ]
    : [
        [226, 58, 52],
        [42, 160, 66],
        [48, 98, 226],
      ];
}

/**
 * Composite up to three channel traces of coverage aR/aG/aB (0..1) over the
 * background into `out[o..o+3]`.
 */
export function compositeRgb(
  out: Uint8ClampedArray,
  o: number,
  bg: Rgb255,
  cols: [Rgb255, Rgb255, Rgb255],
  dark: boolean,
  aR: number,
  aG: number,
  aB: number,
): void {
  if (dark) {
    for (let c = 0; c < 3; c++) {
      out[o + c] = bg[c] + aR * cols[0][c] + aG * cols[1][c] + aB * cols[2][c];
    }
  } else {
    for (let c = 0; c < 3; c++) {
      const m = (1 - aR * (1 - cols[0][c] / 255)) * (1 - aG * (1 - cols[1][c] / 255)) * (1 - aB * (1 - cols[2][c] / 255));
      out[o + c] = bg[c] * m;
    }
  }
  out[o + 3] = 255;
}

/** Blend a single colour with coverage a over the background. */
export function compositeMono(out: Uint8ClampedArray, o: number, bg: Rgb255, col: Rgb255, a: number): void {
  out[o] = bg[0] + (col[0] - bg[0]) * a;
  out[o + 1] = bg[1] + (col[1] - bg[1]) * a;
  out[o + 2] = bg[2] + (col[2] - bg[2]) * a;
  out[o + 3] = 255;
}

/** ImageData pre-filled with the background colour. */
export function backgroundImage(ctx: CanvasRenderingContext2D, w: number, h: number, bg: Rgb255): ImageData {
  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = bg[0];
    d[i + 1] = bg[1];
    d[i + 2] = bg[2];
    d[i + 3] = 255;
  }
  return img;
}

/** Crisp hairline at device pixel position (0.5 offset). */
export function hairline(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
  ctx.beginPath();
  ctx.moveTo(Math.round(x0) + 0.5, Math.round(y0) + 0.5);
  ctx.lineTo(Math.round(x1) + 0.5, Math.round(y1) + 0.5);
  ctx.stroke();
}

/** Sampling stride so that a scope never touches more than ~maxSamples image pixels. */
export function sampleStride(w: number, h: number, maxSamples: number): number {
  return Math.max(1, Math.ceil(Math.sqrt((w * h) / maxSamples)));
}
