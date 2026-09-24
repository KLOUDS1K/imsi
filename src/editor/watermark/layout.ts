/**
 * Watermark geometry + drawing. Everything is expressed relative to the short
 * edge of the target, so the mark looks identical on a 400 px preview and a
 * 24 MP export (text stays vector until the canvas rasterizes it at the final
 * resolution).
 *
 *   size   % of short edge → cap height for text marks, width for logos
 *   margin % of short edge from the anchored edges
 *
 * House style (kind 'kloud' / 'kloud-photography', after the site sidebar):
 * "KLOUD" bold with slightly tight tracking; ".PHOTOGRAPHY" at ~34 % of the cap
 * height, uppercase, widely tracked (settings.letterSpacing em, default 0.32),
 * muted (60 % of the mark opacity), sharing the baseline.
 */
import type { WatermarkPosition, WatermarkSettings } from '@/editor/types';
import { fontStack } from './fonts';

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WatermarkLayout {
  /** Glyph/logo bounding box in target pixels. */
  box: Box;
  /** Extra pixels around `box` the shadow can reach. */
  bleed: number;
  draw(ctx: Ctx2D): void;
}

interface TextRun {
  text: string;
  font: string;
  /** letter spacing in px */
  spacing: number;
  /** alpha multiplier on top of the global opacity */
  alpha: number;
  /** measured */
  advance: number;
  ascent: number;
  descent: number;
  prefix: number[];
}

/** Cap-height / font-size ratio of the resolved font (measured on "H"; Inter ≈ 0.727). */
function capRatio(ctx: Ctx2D, family: string, weight: number): number {
  ctx.font = `${weight} 100px ${family}`;
  const m = ctx.measureText('H');
  const a = m.actualBoundingBoxAscent;
  return a > 10 && a < 100 ? a / 100 : 0.72;
}

function measureRun(ctx: Ctx2D, text: string, font: string, spacing: number, alpha: number): TextRun {
  ctx.font = font;
  const chars = Array.from(text);
  // Prefix widths keep the font's kerning while letter-spacing is added manually
  // (ctx.letterSpacing is not available everywhere and pads the last glyph too).
  const prefix: number[] = [];
  let acc = '';
  for (let i = 0; i < chars.length; i++) {
    prefix.push(i === 0 ? 0 : ctx.measureText(acc).width + i * spacing);
    acc += chars[i];
  }
  const m = ctx.measureText(text);
  return {
    text,
    font,
    spacing,
    alpha,
    advance: m.width + Math.max(0, chars.length - 1) * spacing,
    ascent: m.actualBoundingBoxAscent,
    descent: m.actualBoundingBoxDescent,
    prefix,
  };
}

function drawRun(ctx: Ctx2D, r: TextRun, x: number, baseline: number): void {
  ctx.font = r.font;
  if (!r.spacing) {
    ctx.fillText(r.text, x, baseline);
    return;
  }
  const chars = Array.from(r.text);
  for (let i = 0; i < chars.length; i++) ctx.fillText(chars[i], x + r.prefix[i], baseline);
}

function anchor(pos: WatermarkPosition, w: number, h: number, bw: number, bh: number, margin: number): { x: number; y: number } {
  const col = pos.endsWith('left') || pos === 'left' ? 0 : pos.endsWith('right') || pos === 'right' ? 2 : 1;
  const row = pos.startsWith('top') ? 0 : pos.startsWith('bottom') ? 2 : 1;
  const x = col === 0 ? margin : col === 2 ? w - margin - bw : (w - bw) / 2;
  const y = row === 0 ? margin : row === 2 ? h - margin - bh : (h - bh) / 2;
  return { x, y };
}

const clampNum = (v: number, lo: number, hi: number, d: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

function applyStyle(ctx: Ctx2D, wm: WatermarkSettings, sizePx: number): void {
  ctx.globalAlpha = clampNum(wm.opacity, 0, 100, 70) / 100;
  ctx.fillStyle = wm.color || '#ffffff';
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (wm.shadow) {
    ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
    ctx.shadowBlur = Math.max(1, sizePx * 0.35);
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = Math.max(0.5, sizePx * 0.06);
  } else {
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
  }
}

const shadowBleed = (wm: WatermarkSettings, sizePx: number) => (wm.shadow ? Math.ceil(sizePx * 0.35 * 2 + sizePx * 0.06 + 2) : 2);

/** Text marks: 'text', 'kloud', 'kloud-photography'. Returns null for empty text. */
export function layoutText(ctx: Ctx2D, w: number, h: number, wm: WatermarkSettings): WatermarkLayout | null {
  const short = Math.min(w, h);
  const sizePx = (clampNum(wm.size, 0.1, 50, 2.2) / 100) * short;
  const margin = (clampNum(wm.margin, 0, 20, 3) / 100) * short;
  const family = fontStack(wm.fontFamily || 'Inter');
  const weight = clampNum(wm.fontWeight, 100, 900, 700);
  const ls = clampNum(wm.letterSpacing, -0.2, 2, 0);

  const runs: TextRun[] = [];
  let gap = 0;
  if (wm.kind === 'text') {
    const text = (wm.text ?? '').replace(/\s+/g, ' ').trim();
    if (!text) return null;
    const px = sizePx / capRatio(ctx, family, weight);
    runs.push(measureRun(ctx, text, `${weight} ${px}px ${family}`, ls * px, 1));
  } else {
    const wBold = Math.max(weight, 700);
    const px = sizePx / capRatio(ctx, family, wBold);
    runs.push(measureRun(ctx, 'KLOUD', `${wBold} ${px}px ${family}`, 0.02 * px, 1));
    if (wm.kind === 'kloud-photography') {
      const smallCap = sizePx * 0.34;
      const spx = smallCap / capRatio(ctx, family, 500);
      gap = sizePx * 0.16;
      runs.push(measureRun(ctx, '.PHOTOGRAPHY', `500 ${spx}px ${family}`, (ls || 0.32) * spx, 0.6));
    }
  }

  const advance = runs.reduce((s, r) => s + r.advance, 0) + gap * (runs.length - 1);
  const ascent = Math.max(...runs.map((r) => r.ascent));
  const descent = Math.max(0, ...runs.map((r) => r.descent));
  const bh = ascent + descent;
  const { x, y } = anchor(wm.position, w, h, advance, bh, margin);
  const baseline = y + ascent;

  return {
    box: { x, y, width: advance, height: bh },
    bleed: shadowBleed(wm, sizePx),
    draw(c: Ctx2D) {
      c.save();
      applyStyle(c, wm, sizePx);
      const base = c.globalAlpha;
      let cx = x;
      for (const r of runs) {
        c.globalAlpha = base * r.alpha;
        drawRun(c, r, cx, baseline);
        cx += r.advance + gap;
      }
      c.restore();
    },
  };
}

/** Logo marks: width = size % of the short edge, aspect preserved. */
export function layoutImage(w: number, h: number, wm: WatermarkSettings, logo: CanvasImageSource, lw: number, lh: number): WatermarkLayout | null {
  if (!(lw > 0 && lh > 0)) return null;
  const short = Math.min(w, h);
  const bw = (clampNum(wm.size, 0.1, 50, 10) / 100) * short;
  const bh = (bw * lh) / lw;
  const margin = (clampNum(wm.margin, 0, 20, 3) / 100) * short;
  const { x, y } = anchor(wm.position, w, h, bw, bh, margin);
  return {
    box: { x, y, width: bw, height: bh },
    bleed: shadowBleed(wm, Math.min(bw, bh)),
    draw(c: Ctx2D) {
      c.save();
      applyStyle(c, wm, Math.min(bw, bh) * 0.5);
      c.drawImage(logo, x, y, bw, bh);
      c.restore();
    },
  };
}
