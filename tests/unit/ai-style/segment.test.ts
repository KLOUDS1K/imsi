import { describe, expect, it } from 'vitest';
import { segmentHeuristic } from '@/editor/ai/segment';
import type { PixelBuffer } from '@/editor/types';

function image(w: number, h: number, color: (x: number, y: number) => [number, number, number]): PixelBuffer {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = color(x, y);
      const i = (y * w + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  return { width: w, height: h, data, transfer: 'srgb' };
}

const sample = (mask: Awaited<ReturnType<typeof segmentHeuristic>>, x: number, y: number) =>
  mask.data[Math.min(mask.height - 1, Math.floor(y * mask.height)) * mask.width + Math.min(mask.width - 1, Math.floor(x * mask.width))]!;

describe('enhanced segmentation fallback', () => {
  it('keeps a distinct central subject and rejects the border', async () => {
    const px = image(128, 96, (x, y) => (x >= 38 && x <= 91 && y >= 18 && y <= 84 ? [218, 72, 42] : [42, 48, 55]));
    const mask = await segmentHeuristic('subject', px);
    expect(sample(mask, 0.5, 0.5)).toBeGreaterThan(180);
    expect(sample(mask, 0.03, 0.03)).toBeLessThan(40);
  });

  it('finds top-connected blue sky without leaking into the ground', async () => {
    const px = image(160, 100, (_x, y) => (y < 58 ? [92, 158, 225] : [46, 76, 42]));
    const mask = await segmentHeuristic('sky', px);
    expect(sample(mask, 0.5, 0.15)).toBeGreaterThan(220);
    expect(sample(mask, 0.5, 0.85)).toBeLessThan(30);
  });
});
