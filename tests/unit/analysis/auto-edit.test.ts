import { describe, expect, it } from 'vitest';
import { analyzeImage, classifyScene, generateAutoEdit, recommendNoiseReduction } from '@/editor/analysis';
import type { PhotoMeta, PixelBuffer } from '@/editor/types';

/** Linear RGBA scene: a flat base level with deterministic grain and a few bright points. */
function scene(w: number, h: number, base: number, lights = 0): PixelBuffer {
  const data = new Float32Array(w * h * 4);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < w * h; i++) {
    const v = base * (0.8 + 0.4 * rnd()) * (0.6 + (0.8 * (i % w)) / w);
    const lit = lights > 0 && rnd() < lights;
    data[i * 4] = lit ? 0.85 : v * 1.05;
    data[i * 4 + 1] = lit ? 0.7 : v;
    data[i * 4 + 2] = lit ? 0.4 : v * 0.95;
    data[i * 4 + 3] = 1;
  }
  return { width: w, height: h, data, transfer: 'linear' };
}

/** Paint a smooth skin-toned ellipse (linear sRGB of roughly #e0ac8c) into a scene. */
function skinDisc(px: PixelBuffer, cx: number, cy: number, rx: number, ry: number): PixelBuffer {
  const d = px.data as Float32Array;
  for (let y = 0; y < px.height; y++)
    for (let x = 0; x < px.width; x++) {
      if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 > 1) continue;
      const i = (y * px.width + x) * 4;
      d[i] = 0.745;
      d[i + 1] = 0.412;
      d[i + 2] = 0.262;
    }
  return px;
}

const meta = (m: Partial<PhotoMeta>): PhotoMeta => ({ fileName: 'test.jpg', ...m }) as PhotoMeta;

describe('AI Auto Edit exposure handling', () => {
  it('treats a dark high-ISO frame as a low-key night scene, not as underexposed', () => {
    const a = analyzeImage(scene(160, 107, 0.008, 0.006), meta({ iso: 6400, shutter: 1 / 15 }));
    expect(a.scene.label).toBe('night');
    expect(a.exposure.verdict).toBe('ok');
    expect(a.notes.some((n) => /low-key/i.test(n))).toBe(true);
    expect(a.notes.some((n) => /underexposed/i.test(n))).toBe(false);
    const edit = generateAutoEdit(a, undefined, { idFactory: () => 'id' });
    expect(edit.basic?.exposure ?? 0).toBeLessThanOrEqual(0.8);
    expect(edit.basic?.shadows ?? 0).toBeLessThanOrEqual(25);
    expect(edit.basic?.blacks ?? 0).toBeLessThanOrEqual(0);
  });

  it('still lifts an underexposed daylight frame', () => {
    const a = analyzeImage(scene(160, 107, 0.05), meta({ iso: 100, shutter: 1 / 500 }));
    expect(a.scene.label).not.toBe('night');
    expect(a.exposure.verdict).toBe('under');
    const edit = generateAutoEdit(a, undefined, { idFactory: () => 'id' });
    expect(edit.basic?.exposure ?? 0).toBeGreaterThan(0.8);
  });

  it('does not call a night street a portrait because of one small warm lamp halo', () => {
    type Args = Parameters<typeof classifyScene>;
    const skin = (area: number) => ({ blobs: [{ box: { x: 0.88, y: 0.26, w: 0.05, h: 0.11 }, area, fill: 0.67, faceLike: true }], fraction: 0.04 }) as unknown as Args[3];
    const sky = { present: false, kind: 'none', fraction: 0 } as unknown as Args[2];
    const col = { all: { green: 0, white: 0, sand: 0, warm: 0.2 } } as unknown as Args[4];
    const dark = { medianLum: 0.02, meanLum: 0.025 } as unknown as Args[1];
    // ~0.4% of the frame, face-shaped: the Seoul Dusk street-lamp case.
    expect(classifyScene(meta({ iso: 1600, shutter: 1 / 60 }), dark, sky, skin(0.0039), col, 60).label).toBe('night');
    // A face that fills a real part of the frame still makes it a portrait.
    expect(classifyScene(meta({ iso: 1600, shutter: 1 / 60 }), dark, sky, skin(0.03), col, 60).label).toBe('portrait');
  });

  it('still recognises a portrait when a face fills a real part of the frame', () => {
    const px = skinDisc(scene(256, 170, 0.18), 128, 80, 26, 34);
    const a = analyzeImage(px, meta({ iso: 200, shutter: 1 / 250 }));
    expect(a.scene.label).toBe('portrait');
  });
});

describe('automatic noise reduction', () => {
  it('keeps clean photos on the lightweight filters', () => {
    const p = recommendNoiseReduction(12);
    expect(p.aiDenoise).toBe(false);
    expect(p.luminance).toBe(0);
    expect(p.color).toBeGreaterThan(0);
  });

  it('uses smart denoise without stacking excessive manual luma NR', () => {
    const p = recommendNoiseReduction(84);
    expect(p.aiDenoise).toBe(true);
    expect(p.aiDenoiseStrength).toBeGreaterThan(60);
    expect(p.luminance).toBeLessThan(20);
    expect(p.detailPreservation).toBeGreaterThanOrEqual(45);
  });

  it('clamps invalid and out-of-range measurements', () => {
    expect(recommendNoiseReduction(Number.NaN)).toEqual(recommendNoiseReduction(0));
    expect(recommendNoiseReduction(200)).toEqual(recommendNoiseReduction(100));
  });
});
