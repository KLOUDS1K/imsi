/**
 * White-balance eyedropper (active while ctx.wbPickerActive).
 *
 * A loupe follows the pointer: the pixels under it magnified (copied from the
 * engine canvas, nearest-neighbour) plus the rendered RGB. A click samples the
 * LINEAR source (before WB/exposure) with engine.sampleSourceLinear over a
 * 3 px radius, converts it with tempTintFromNeutral and stores
 * whiteBalance { mode: 'custom', temperature, tint } as one history entry.
 * The picker then closes (Lightroom's auto-dismiss); Shift+click keeps it open
 * for another try. Escape closes it without sampling.
 */
import type { AppContext } from '@/app/context';
import { tempTintFromNeutral } from '@/editor/color/math';
import type { Point } from '@/editor/types';
import { h } from '@/ui/dom';
import type { ToolCommand, ViewerHost, ViewerTool } from './host';

const CELLS = 11;
const ZOOM = 9;

export function createWbTool(host: ViewerHost): ViewerTool {
  const ctx: AppContext = host.ctx;
  const size = CELLS * ZOOM;
  const canvas = h('canvas', { class: 'k-loupe__px', width: size, height: size, attrs: { 'aria-hidden': 'true' } });
  const rgbText = h('span', { class: 'k-loupe__rgb' }, '—');
  const loupe = h('div', { class: 'k-loupe', attrs: { role: 'status', 'aria-live': 'off' } }, canvas, h('div', { class: 'k-loupe__row' }, h('span', { class: 'k-loupe__cap' }, 'Neutral picker'), rgbText));
  host.stage.appendChild(loupe);
  const g2 = canvas.getContext('2d');
  let hover: Point | null = null;
  let down: Point | null = null;

  function place(p: Point): void {
    const vw = host.stage.clientWidth;
    const vh = host.stage.clientHeight;
    const w = loupe.offsetWidth || size + 12;
    const hh = loupe.offsetHeight || size + 36;
    // Up-right of the pointer, flipped near the edges; never under the finger.
    let x = p.x + 24;
    let y = p.y - hh - 24;
    if (x + w > vw - 4) x = p.x - w - 24;
    if (y < 4) y = p.y + 24;
    loupe.style.transform = `translate(${Math.max(4, Math.min(vw - w - 4, x)).toFixed(0)}px, ${Math.max(4, Math.min(vh - hh - 4, y)).toFixed(0)}px)`;
  }

  function update(): void {
    const m = host.mapping();
    const e = ctx.engine;
    if (!hover || !m || !e) {
      loupe.classList.remove('is-on');
      return;
    }
    const o = m.toOutput(hover.x, hover.y);
    const inside = o.x >= 0 && o.x <= 1 && o.y >= 0 && o.y <= 1;
    loupe.classList.toggle('is-on', inside);
    if (!inside) return;
    place(hover);
    if (g2) {
      const dpr = e.canvas.width / Math.max(1, e.canvas.clientWidth || m.t.viewportWidth);
      const sx = Math.round(hover.x * dpr) - (CELLS >> 1);
      const sy = Math.round(hover.y * dpr) - (CELLS >> 1);
      g2.imageSmoothingEnabled = false;
      g2.clearRect(0, 0, size, size);
      try {
        g2.drawImage(e.canvas, sx, sy, CELLS, CELLS, 0, 0, size, size);
      } catch {
        /* canvas not readable yet */
      }
    }
    try {
      const rgb = e.samplePixel(o.x, o.y);
      rgbText.textContent = rgb.map((v) => String(Math.round(Math.min(1, Math.max(0, v)) * 255)).padStart(3, ' ')).join(' ');
    } catch {
      rgbText.textContent = '—';
    }
  }

  function pick(p: Point, keepOpen: boolean): void {
    const m = host.mapping();
    const e = ctx.engine;
    const doc = ctx.doc.value;
    if (!m || !e || !doc) return;
    const o = m.toOutput(p.x, p.y);
    if (!(o.x >= 0 && o.x <= 1 && o.y >= 0 && o.y <= 1)) return;
    const rgb = e.sampleSourceLinear(o.x, o.y, doc.store.params, 3);
    if (!rgb.every((v) => Number.isFinite(v)) || Math.max(...rgb) <= 1e-5) {
      ctx.toast('That spot is too dark to judge white balance — pick a neutral grey.', 'info');
      return;
    }
    const { temperature, tint } = tempTintFromNeutral(rgb);
    doc.store.update(
      'White Balance: picker',
      (d) => {
        d.whiteBalance.mode = 'custom';
        d.whiteBalance.temperature = Math.round(temperature);
        d.whiteBalance.tint = Math.round(tint);
      },
      { coalesceKey: null },
    );
    if (!keepOpen) ctx.wbPickerActive.set(false);
  }

  return {
    name: 'wb',
    onPointerDown(e, p) {
      if (e.button !== 0) return false;
      down = p;
      return true;
    },
    onPointerMove(_e, p) {
      hover = p;
      host.requestDraw();
    },
    onPointerUp(e, p) {
      const d = down;
      down = null;
      if (d && Math.hypot(p.x - d.x, p.y - d.y) < 8) pick(p, e.shiftKey);
    },
    onCancel() {
      down = null;
    },
    onHover(p) {
      hover = p;
      host.requestDraw();
    },
    cursor: () => 'crosshair',
    command(cmd: ToolCommand) {
      if (cmd === 'escape') {
        ctx.wbPickerActive.set(false);
        return true;
      }
      return false;
    },
    draw() {
      update();
    },
    dispose() {
      loupe.remove();
    },
  };
}
