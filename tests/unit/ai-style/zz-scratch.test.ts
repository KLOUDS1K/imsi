import { describe, it } from 'vitest';
import { inpaintRgba8 } from '@/editor/ai/inpaint/patchmatch';
describe('perf', () => {
  for (const [w, h, hw, hh] of [[1200, 900, 400, 300], [1800, 1200, 1000, 700]]) it(`perf ${w}x${h} hole ${hw}x${hh}`, () => {
    const d = new Uint8ClampedArray(w * h * 4);
    let s = 1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      s = (s * 1103515245 + 12345) >>> 0;
      const i = (y * w + x) * 4; const n = (s >>> 24) / 8;
      d[i] = 100 + 60 * Math.sin(x * 0.05) + n; d[i + 1] = 90 + 40 * Math.sin((x + y) * 0.03) + n; d[i + 2] = 80 + y * 0.1 + n; d[i + 3] = 255;
    }
    const mask = new Uint8Array(w * h);
    const x0 = (w - hw) >> 1, y0 = (h - hh) >> 1;
    for (let y = y0; y < y0 + hh; y++) for (let x = x0; x < x0 + hw; x++) mask[y * w + x] = 255;
    const t0 = performance.now();
    inpaintRgba8(d, w, h, mask);
    console.log(w, h, hw, hh, 'ms', Math.round(performance.now() - t0));
  }, 120000);
});
