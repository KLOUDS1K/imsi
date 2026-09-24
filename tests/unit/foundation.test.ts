import { describe, expect, it } from 'vitest';
import { tempTintFromNeutral, wbGains, linearToSrgb, srgbToLinear } from '../../src/editor/color/math';
import { buildCurveLut, createCurveEvaluator } from '../../src/editor/color/curves';
import { createDefaultParams } from '../../src/editor/defaults';

describe('color math', () => {
  it('wbGains round-trips through tempTintFromNeutral', () => {
    const cast: [number, number, number] = [0.3, 0.25, 0.18];
    const { temperature, tint } = tempTintFromNeutral(cast);
    const g = wbGains(temperature, tint);
    const out = cast.map((v, i) => v * g[i]);
    expect(Math.abs(out[0] - out[1])).toBeLessThan(1e-6);
    expect(Math.abs(out[2] - out[1])).toBeLessThan(1e-6);
  });
  it('srgb transfer is invertible', () => {
    for (const v of [0, 0.001, 0.2, 0.5, 1]) expect(linearToSrgb(srgbToLinear(v))).toBeCloseTo(v, 6);
  });
});

describe('curves', () => {
  it('default curve LUT is identity', () => {
    const lut = buildCurveLut(createDefaultParams().toneCurve, 256);
    for (let i = 0; i < 256; i++) expect(lut[i * 4]).toBeCloseTo(i / 255, 5);
  });
  it('monotone spline passes through points', () => {
    const f = createCurveEvaluator([{ x: 0, y: 0 }, { x: 0.25, y: 0.2 }, { x: 0.75, y: 0.85 }, { x: 1, y: 1 }]);
    expect(f(0.25)).toBeCloseTo(0.2, 6);
    expect(f(0.75)).toBeCloseTo(0.85, 6);
  });
});
