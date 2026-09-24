/**
 * Scope renderers (DOM-only): histogram, waveform, RGB parade, vectorscope.
 *
 * Every scope is rasterised per device pixel into an ImageData (fast, crisp on
 * HiDPI) and the graticule is stroked on top with the 2D API. Colours come
 * from the theme tokens (see scope-canvas.ts) so the scopes read correctly in
 * light and dark themes; `opts.background/grid/gain` override them.
 */
import type { ScopeOptions } from '@/editor/contracts';
import type { Histogram, PixelBufferU8 } from '@/editor/types';
import {
  backgroundImage,
  channelColors,
  compositeMono,
  compositeRgb,
  hairline,
  prepareCanvas,
  readTheme,
  sampleStride,
  type Rgb255,
  type ScopeTheme,
} from './scope-canvas';

export type HistogramScale = 'linear' | 'sqrt' | 'log';

export interface HistogramDrawOptions extends ScopeOptions {
  mode?: 'rgb' | 'luminance' | 'both';
  showClipping?: boolean;
  /** Vertical scaling of the bin counts. Default 'linear' (normalised to a robust peak). */
  scale?: HistogramScale;
}

/* ------------------------------------------------------------------ */
/* Histogram                                                           */
/* ------------------------------------------------------------------ */

/** [1,2,1] smoothing that leaves the end bins (clipping spikes) untouched. */
function smoothBins(src: Uint32Array): Float32Array {
  const out = new Float32Array(256);
  out[0] = src[0];
  out[255] = src[255];
  for (let i = 1; i < 255; i++) {
    const a = i > 1 ? src[i - 1] : src[i];
    const b = i < 254 ? src[i + 1] : src[i];
    out[i] = (a + 2 * src[i] + b) * 0.25;
  }
  return out;
}

function scaleFn(scale: HistogramScale): (v: number) => number {
  if (scale === 'sqrt') return Math.sqrt;
  if (scale === 'log') return (v) => Math.log1p(v);
  return (v) => v;
}

export function drawHistogram(canvas: HTMLCanvasElement, hist: Histogram, opts: HistogramDrawOptions = {}): void {
  const prep = prepareCanvas(canvas);
  if (!prep) return;
  const { ctx, w, h, dpr } = prep;
  const theme = readTheme(opts);
  const mode = opts.mode ?? 'rgb';
  const f = scaleFn(opts.scale ?? 'linear');
  const bins = mode === 'luminance' ? [smoothBins(hist.lum)] : [smoothBins(hist.r), smoothBins(hist.g), smoothBins(hist.b)];
  const lumBins = mode === 'both' ? smoothBins(hist.lum) : null;

  // Normalise to the tallest interior peak so clipping spikes at 0/255 do not flatten the rest.
  let peak = 0;
  for (const b of lumBins ? [...bins, lumBins] : bins) for (let i = 1; i < 255; i++) if (b[i] > peak) peak = b[i];
  if (peak <= 0) for (const b of bins) peak = Math.max(peak, b[0], b[255]);
  const norm = peak > 0 ? f(peak) / theme.gain : 1;

  const top = Math.round(3 * dpr);
  const plotH = h - top;
  const heightAt = (b: Float32Array, x: number): number => {
    const t = ((x + 0.5) / w) * 256 - 0.5;
    const i0 = Math.max(0, Math.min(255, Math.floor(t)));
    const i1 = Math.min(255, i0 + 1);
    const fr = Math.max(0, Math.min(1, t - i0));
    const v = b[i0] + (b[i1] - b[i0]) * fr;
    return Math.min(1, f(v) / norm) * plotH;
  };

  const img = backgroundImage(ctx, w, h, theme.bg);
  const d = img.data;
  const cols = channelColors(theme.dark);
  const heights = bins.map(() => new Float32Array(w));
  for (let x = 0; x < w; x++) for (let c = 0; c < bins.length; c++) heights[c][x] = heightAt(bins[c], x);
  const alpha = theme.dark ? 0.78 : 0.62;
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < plotH; y++) {
      const fromBottom = plotH - y; // distance of this pixel's top edge from the baseline
      // Fractional coverage of the top pixel gives an anti-aliased edge.
      const cov = (hc: number) => Math.max(0, Math.min(1, hc - (fromBottom - 1)));
      const o = ((y + top) * w + x) * 4;
      if (bins.length === 1) {
        const a = cov(heights[0][x]);
        if (a > 0) compositeMono(d, o, theme.bg, theme.trace, a * (theme.dark ? 0.55 : 0.45));
      } else {
        const aR = cov(heights[0][x]) * alpha;
        const aG = cov(heights[1][x]) * alpha;
        const aB = cov(heights[2][x]) * alpha;
        if (aR + aG + aB > 0) compositeRgb(d, o, theme.bg, cols, theme.dark, aR, aG, aB);
      }
    }
  }
  ctx.putImageData(img, 0, 0);

  // Graticule: quarter lines.
  ctx.lineWidth = 1;
  ctx.strokeStyle = theme.grid;
  ctx.globalAlpha = 0.9;
  for (let q = 1; q < 4; q++) hairline(ctx, (q * w) / 4, top, (q * w) / 4, h);
  ctx.globalAlpha = 1;

  // Outline of the luminance (mode 'both' / 'luminance').
  const outline = lumBins ?? (mode === 'luminance' ? bins[0] : null);
  if (outline) {
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const y = top + plotH - heightAt(outline, x);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = `rgb(${theme.trace.join(',')})`;
    ctx.lineWidth = Math.max(1, dpr);
    ctx.globalAlpha = 0.85;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  if (opts.showClipping ?? true) drawClipTriangles(ctx, w, dpr, hist, theme);
}

function drawClipTriangles(ctx: CanvasRenderingContext2D, w: number, dpr: number, hist: Histogram, theme: ScopeTheme): void {
  const s = Math.round(7 * dpr);
  const m = Math.round(3 * dpr);
  const thr = 0.0005;
  const lowClip = Math.max(hist.clip.r[0], hist.clip.g[0], hist.clip.b[0]) > thr;
  const highClip = Math.max(hist.clip.r[1], hist.clip.g[1], hist.clip.b[1]) > thr;
  const tri = (pts: [number, number][], on: boolean, color: string) => {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    ctx.lineTo(pts[1][0], pts[1][1]);
    ctx.lineTo(pts[2][0], pts[2][1]);
    ctx.closePath();
    if (on) {
      ctx.fillStyle = color;
      ctx.fill();
    } else {
      ctx.strokeStyle = theme.label;
      ctx.lineWidth = Math.max(1, dpr * 0.75);
      ctx.globalAlpha = 0.7;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  };
  tri(
    [
      [m, m + s / 2],
      [m + s, m],
      [m + s, m + s],
    ],
    lowClip,
    theme.clipLow,
  );
  tri(
    [
      [w - m, m + s / 2],
      [w - m - s, m],
      [w - m - s, m + s],
    ],
    highClip,
    theme.clipHigh,
  );
}

/* ------------------------------------------------------------------ */
/* Waveform & parade                                                   */
/* ------------------------------------------------------------------ */

type WaveChannel = 'luma' | 0 | 1 | 2;

/** Column-wise accumulation of value occurrences: grid gw × gh, row 0 = value 255. */
function accumulateWave(px: PixelBufferU8, stride: number, gw: number, gh: number, ch: WaveChannel): { grid: Uint32Array; perCol: number } {
  const grid = new Uint32Array(gw * gh);
  const { width: iw, height: ih, data } = px;
  const vScale = (gh - 1) / 255;
  let samples = 0;
  for (let y = 0; y < ih; y += stride) {
    const row = y * iw * 4;
    for (let x = 0; x < iw; x += stride) {
      const i = row + x * 4;
      const v = ch === 'luma' ? (54 * data[i] + 183 * data[i + 1] + 19 * data[i + 2] + 128) >> 8 : data[i + ch];
      const col = Math.min(gw - 1, ((x * gw) / iw) | 0);
      const r = gh - 1 - Math.round(v * vScale);
      grid[r * gw + col]++;
      samples++;
    }
  }
  return { grid, perCol: samples / gw };
}

/** Maps a cell count to trace intensity with a soft exponential response. */
function intensityK(perCol: number, rows: number, gain: number): number {
  // A column whose samples spread evenly over all rows gives ≈ 0.4 intensity.
  return (gain * 0.5 * rows) / Math.max(1, perCol);
}

function graticule(ctx: CanvasRenderingContext2D, x0: number, x1: number, top: number, bottom: number, theme: ScopeTheme, dpr: number, labels: boolean): void {
  ctx.strokeStyle = theme.grid;
  ctx.lineWidth = 1;
  for (let q = 0; q <= 4; q++) {
    const y = bottom - ((bottom - top) * q) / 4;
    ctx.globalAlpha = q === 0 || q === 4 ? 0.95 : 0.6;
    hairline(ctx, x0, y, x1, y);
  }
  ctx.globalAlpha = 1;
  if (!labels) return;
  ctx.fillStyle = theme.label;
  ctx.font = `${Math.round(8.5 * dpr)}px ${theme.font}`;
  ctx.textBaseline = 'middle';
  for (const q of [0, 2, 4]) {
    const y = bottom - ((bottom - top) * q) / 4;
    ctx.fillText(String(q * 25), x0 + 3 * dpr, Math.min(bottom - 5 * dpr, Math.max(top + 5 * dpr, y + (q === 4 ? 6 : q === 0 ? -6 : -5) * dpr)));
  }
}

interface WaveLayout {
  x0: number;
  width: number;
  top: number;
  rows: number;
}

function renderWaveInto(
  d: Uint8ClampedArray,
  w: number,
  lay: WaveLayout,
  grids: { grid: Uint32Array; perCol: number; gw: number }[],
  theme: ScopeTheme,
  colors: [Rgb255, Rgb255, Rgb255] | null,
  mono: Rgb255 | null,
): void {
  const ks = grids.map((g) => intensityK(g.perCol, lay.rows, theme.gain));
  for (let x = 0; x < lay.width; x++) {
    const cols = grids.map((g) => Math.min(g.gw - 1, ((x * g.gw) / lay.width) | 0));
    for (let r = 0; r < lay.rows; r++) {
      const o = ((lay.top + r) * w + lay.x0 + x) * 4;
      if (mono) {
        const n = grids[0].grid[r * grids[0].gw + cols[0]];
        if (n > 0) compositeMono(d, o, theme.bg, mono, 1 - Math.exp(-n * ks[0]));
      } else if (colors) {
        const a = [0, 0, 0];
        let any = false;
        for (let c = 0; c < grids.length; c++) {
          const n = grids[c].grid[r * grids[c].gw + cols[c]];
          if (n > 0) {
            a[c] = (1 - Math.exp(-n * ks[c])) * 0.9;
            any = true;
          }
        }
        if (any) compositeRgb(d, o, theme.bg, colors, theme.dark, a[0], a[1], a[2]);
      }
    }
  }
}

export function drawWaveform(canvas: HTMLCanvasElement, px: PixelBufferU8, opts: ScopeOptions & { mode?: 'luma' | 'rgb' } = {}): void {
  const prep = prepareCanvas(canvas);
  if (!prep) return;
  const { ctx, w, h, dpr } = prep;
  const theme = readTheme(opts);
  const pad = Math.round(5 * dpr);
  const rows = Math.max(2, h - 2 * pad);
  const stride = sampleStride(px.width, px.height, 400_000);
  const gw = Math.max(1, Math.min(w, Math.ceil(px.width / stride)));
  const img = backgroundImage(ctx, w, h, theme.bg);
  const lay: WaveLayout = { x0: 0, width: w, top: pad, rows };
  if ((opts.mode ?? 'luma') === 'rgb') {
    const grids = ([0, 1, 2] as const).map((c) => ({ ...accumulateWave(px, stride, gw, rows, c), gw }));
    renderWaveInto(img.data, w, lay, grids, theme, channelColors(theme.dark), null);
  } else {
    const g = { ...accumulateWave(px, stride, gw, rows, 'luma'), gw };
    renderWaveInto(img.data, w, lay, [g], theme, null, theme.trace);
  }
  ctx.putImageData(img, 0, 0);
  graticule(ctx, 0, w, pad, pad + rows - 1, theme, dpr, true);
}

export function drawParade(canvas: HTMLCanvasElement, px: PixelBufferU8, opts: ScopeOptions = {}): void {
  const prep = prepareCanvas(canvas);
  if (!prep) return;
  const { ctx, w, h, dpr } = prep;
  const theme = readTheme(opts);
  const pad = Math.round(5 * dpr);
  const gap = Math.round(4 * dpr);
  const rows = Math.max(2, h - 2 * pad);
  const pw = Math.max(1, Math.floor((w - 2 * gap) / 3));
  const stride = sampleStride(px.width, px.height, 300_000);
  const gw = Math.max(1, Math.min(pw, Math.ceil(px.width / stride)));
  const img = backgroundImage(ctx, w, h, theme.bg);
  const cols = channelColors(theme.dark);
  for (let c = 0 as 0 | 1 | 2; c < 3; c = (c + 1) as 0 | 1 | 2) {
    const g = { ...accumulateWave(px, stride, gw, rows, c), gw };
    // Each panel is a single-channel trace in its own ink colour (only slot 0 is used).
    const ink: [Rgb255, Rgb255, Rgb255] = [cols[c], cols[c], cols[c]];
    const lay: WaveLayout = { x0: c * (pw + gap), width: pw, top: pad, rows };
    renderWaveInto(img.data, w, lay, [g], theme, ink, null);
  }
  ctx.putImageData(img, 0, 0);
  for (let c = 0; c < 3; c++) graticule(ctx, c * (pw + gap), c * (pw + gap) + pw, pad, pad + rows - 1, theme, dpr, c === 0);
  // Channel captions.
  ctx.font = `${Math.round(8.5 * dpr)}px ${theme.font}`;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'right';
  ['R', 'G', 'B'].forEach((t, c) => {
    ctx.fillStyle = `rgb(${cols[c].join(',')})`;
    ctx.fillText(t, c * (pw + gap) + pw - 3 * dpr, pad + 2 * dpr);
  });
  ctx.textAlign = 'left';
}

/* ------------------------------------------------------------------ */
/* Vectorscope                                                         */
/* ------------------------------------------------------------------ */

/** BT.709 chroma of encoded R'G'B' (0..1): Cb, Cr in [-0.5, 0.5]. */
function cbcr(r: number, g: number, b: number): [number, number] {
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return [(b - y) / 1.8556, (r - y) / 1.5748];
}

/** Angle of the classic skin-tone ("I") line, measured counter-clockwise from +Cb. */
const SKIN_LINE_DEG = 123;

export function drawVectorscope(canvas: HTMLCanvasElement, px: PixelBufferU8, opts: ScopeOptions = {}): void {
  const prep = prepareCanvas(canvas);
  if (!prep) return;
  const { ctx, w, h, dpr } = prep;
  const theme = readTheme(opts);
  const size = Math.min(w, h);
  const cx = w / 2;
  const cy = h / 2;
  const radius = size / 2 - Math.round(6 * dpr);
  if (radius < 4) return;
  const grid = Math.max(8, Math.min(512, Math.round(radius * 2)));
  const counts = new Uint32Array(grid * grid);
  const sums = new Float32Array(grid * grid * 3);
  const stride = sampleStride(px.width, px.height, 300_000);
  const { width: iw, height: ih, data } = px;
  let samples = 0;
  const half = grid / 2;
  for (let y = 0; y < ih; y += stride) {
    const row = y * iw * 4;
    for (let x = 0; x < iw; x += stride) {
      const i = row + x * 4;
      const r = data[i] / 255;
      const g = data[i + 1] / 255;
      const b = data[i + 2] / 255;
      const [u, v] = cbcr(r, g, b);
      const gx = Math.min(grid - 1, Math.max(0, (half + u * 2 * half) | 0));
      const gy = Math.min(grid - 1, Math.max(0, (half - v * 2 * half) | 0));
      const k = gy * grid + gx;
      counts[k]++;
      sums[k * 3] += r;
      sums[k * 3 + 1] += g;
      sums[k * 3 + 2] += b;
      samples++;
    }
  }
  const img = backgroundImage(ctx, w, h, theme.bg);
  const d = img.data;
  // Evenly spread samples over the disc would give ≈ 0.3 intensity per cell.
  const k = (theme.gain * 0.35 * (Math.PI * half * half)) / Math.max(1, samples);
  const x0 = Math.round(cx - radius);
  const y0 = Math.round(cy - radius);
  const span = Math.round(radius * 2);
  const col: Rgb255 = [0, 0, 0];
  for (let py = 0; py < span; py++) {
    const gy = Math.min(grid - 1, ((py * grid) / span) | 0);
    for (let pxl = 0; pxl < span; pxl++) {
      const gx = Math.min(grid - 1, ((pxl * grid) / span) | 0);
      const c = gy * grid + gx;
      const n = counts[c];
      if (!n) continue;
      const X = x0 + pxl;
      const Y = y0 + py;
      if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
      // Colour the trace with the average colour of the pixels landing there,
      // pushed to full value so hues are legible; near-neutral cells use the
      // monochrome trace colour.
      const r = sums[c * 3] / n;
      const g = sums[c * 3 + 1] / n;
      const b = sums[c * 3 + 2] / n;
      const mx = Math.max(r, g, b, 1e-3);
      const mn = Math.min(r, g, b);
      const chroma = Math.min(1, ((mx - mn) / mx) * 3);
      const lift = theme.dark ? 255 : 200;
      col[0] = theme.trace[0] + ((r / mx) * lift - theme.trace[0]) * chroma;
      col[1] = theme.trace[1] + ((g / mx) * lift - theme.trace[1]) * chroma;
      col[2] = theme.trace[2] + ((b / mx) * lift - theme.trace[2]) * chroma;
      compositeMono(d, (Y * w + X) * 4, theme.bg, col, (1 - Math.exp(-n * k)) * 0.95);
    }
  }
  ctx.putImageData(img, 0, 0);
  drawVectorGraticule(ctx, cx, cy, radius, dpr, theme);
}

function drawVectorGraticule(ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number, dpr: number, theme: ScopeTheme): void {
  const toXY = (u: number, v: number): [number, number] => [cx + u * 2 * radius, cy - v * 2 * radius];
  ctx.strokeStyle = theme.grid;
  ctx.lineWidth = 1;
  for (const f of [1, 0.75, 0.5, 0.25]) {
    ctx.globalAlpha = f === 1 ? 0.95 : 0.5;
    ctx.beginPath();
    ctx.arc(cx, cy, radius * f, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 0.6;
  hairline(ctx, cx - radius, cy, cx + radius, cy);
  hairline(ctx, cx, cy - radius, cx, cy + radius);
  ctx.globalAlpha = 1;

  // Skin-tone line.
  const a = (SKIN_LINE_DEG * Math.PI) / 180;
  ctx.strokeStyle = theme.accent;
  ctx.globalAlpha = 0.8;
  ctx.lineWidth = Math.max(1, dpr);
  ctx.setLineDash([4 * dpr, 3 * dpr]);
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(a) * radius, cy - Math.sin(a) * radius);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  // 75 % colour-bar targets.
  const targets: [string, number, number, number][] = [
    ['R', 0.75, 0, 0],
    ['Yl', 0.75, 0.75, 0],
    ['G', 0, 0.75, 0],
    ['Cy', 0, 0.75, 0.75],
    ['B', 0, 0, 0.75],
    ['Mg', 0.75, 0, 0.75],
  ];
  const box = Math.round(5 * dpr);
  ctx.font = `${Math.round(8 * dpr)}px ${theme.font}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const [label, r, g, b] of targets) {
    const [u, v] = cbcr(r, g, b);
    const [x, y] = toXY(u, v);
    ctx.strokeStyle = theme.label;
    ctx.lineWidth = Math.max(1, dpr * 0.75);
    ctx.strokeRect(Math.round(x - box / 2) + 0.5, Math.round(y - box / 2) + 0.5, box, box);
    const len = Math.hypot(x - cx, y - cy) || 1;
    ctx.fillStyle = theme.label;
    ctx.fillText(label, x + ((x - cx) / len) * 9 * dpr, y + ((y - cy) / len) * 9 * dpr);
  }
  ctx.textAlign = 'left';
}
