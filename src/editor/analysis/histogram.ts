/**
 * 256-bin RGB + luma histogram of an 8-bit sRGB buffer (what the UI shows over
 * the rendered image). DOM-free.
 *
 * - `lum` bins the Rec.709 luma Y' of the ENCODED values (the video-scope
 *   convention, same as the waveform), computed in integer math.
 * - `clip.r/g/b` are `[fraction at 0, fraction at 255]` for each channel.
 * - `clippedHighlights` / `clippedShadows`: fraction of pixels with ANY channel
 *   at 255 / at 0 (per the contract).
 */
import type { Histogram, PixelBufferU8 } from '@/editor/types';

export function computeHistogram(px: PixelBufferU8): Histogram {
  const r = new Uint32Array(256);
  const g = new Uint32Array(256);
  const b = new Uint32Array(256);
  const lum = new Uint32Array(256);
  const d = px.data;
  const total = px.width * px.height;
  let anyHi = 0;
  let anyLo = 0;
  const n = Math.min(d.length, total * 4);
  for (let i = 0; i < n; i += 4) {
    const vr = d[i];
    const vg = d[i + 1];
    const vb = d[i + 2];
    r[vr]++;
    g[vg]++;
    b[vb]++;
    // Rec.709 luma weights ×256 (54 + 183 + 19 = 256), rounded.
    lum[(54 * vr + 183 * vg + 19 * vb + 128) >> 8]++;
    if (vr === 255 || vg === 255 || vb === 255) anyHi++;
    if (vr === 0 || vg === 0 || vb === 0) anyLo++;
  }
  const inv = total > 0 ? 1 / total : 0;
  return {
    r,
    g,
    b,
    lum,
    total,
    clippedHighlights: anyHi * inv,
    clippedShadows: anyLo * inv,
    clip: {
      r: [r[0] * inv, r[255] * inv],
      g: [g[0] * inv, g[255] * inv],
      b: [b[0] * inv, b[255] * inv],
    },
  };
}
