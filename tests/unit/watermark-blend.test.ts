import { describe, expect, it } from 'vitest';
import { blendWatermarkChannel } from '../../src/editor/watermark/blend';

describe('watermark blend modes', () => {
  it('keeps normal source values', () => {
    expect(blendWatermarkChannel('normal', 80, 200, 255)).toBe(80);
  });

  it('uses standard multiply, screen, overlay and difference maths', () => {
    expect(blendWatermarkChannel('multiply', 128, 128, 255)).toBeCloseTo(64.25, 1);
    expect(blendWatermarkChannel('screen', 128, 128, 255)).toBeCloseTo(191.75, 1);
    expect(blendWatermarkChannel('overlay', 128, 64, 255)).toBeCloseTo(64.25, 1);
    expect(blendWatermarkChannel('difference', 80, 200, 255)).toBe(120);
  });

  it('keeps values inside the target bit-depth range', () => {
    for (const mode of ['normal', 'multiply', 'screen', 'overlay', 'soft-light', 'difference'] as const) {
      const value = blendWatermarkChannel(mode, 65_535, 12_345, 65_535);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(65_535);
    }
  });
});
