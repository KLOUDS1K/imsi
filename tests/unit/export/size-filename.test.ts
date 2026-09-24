import { describe, expect, it } from 'vitest';
import { buildFileName, computeExportSize, fileExtension, sanitizeFileStem } from '@/editor/export';
import type { ExportSettings } from '@/editor/types';
import { fullMeta } from './helpers';

type R = ExportSettings['resize'];
const r = (p: Partial<R>): R => ({ mode: 'none', value: 2048, width: 2048, height: 2048, dontEnlarge: true, ...p });

describe('computeExportSize', () => {
  it('none keeps the source size', () => {
    expect(computeExportSize(6000, 4000, r({}))).toEqual({ width: 6000, height: 4000 });
  });
  it('long / short edge', () => {
    expect(computeExportSize(6000, 4000, r({ mode: 'long-edge', value: 2048 }))).toEqual({ width: 2048, height: 1365 });
    expect(computeExportSize(4000, 6000, r({ mode: 'long-edge', value: 2048 }))).toEqual({ width: 1365, height: 2048 });
    expect(computeExportSize(6000, 4000, r({ mode: 'short-edge', value: 1080 }))).toEqual({ width: 1620, height: 1080 });
  });
  it('width / height', () => {
    expect(computeExportSize(6000, 4000, r({ mode: 'width', width: 1200 }))).toEqual({ width: 1200, height: 800 });
    expect(computeExportSize(6000, 4000, r({ mode: 'height', height: 1000 }))).toEqual({ width: 1500, height: 1000 });
  });
  it('dimensions fits inside W×H', () => {
    expect(computeExportSize(6000, 4000, r({ mode: 'dimensions', width: 1000, height: 1000 }))).toEqual({ width: 1000, height: 667 });
    expect(computeExportSize(4000, 6000, r({ mode: 'dimensions', width: 1920, height: 1080 }))).toEqual({ width: 720, height: 1080 });
  });
  it('megapixels stays within budget', () => {
    const s = computeExportSize(6000, 4000, r({ mode: 'megapixels', value: 2 }));
    expect(s.width * s.height).toBeLessThanOrEqual(2e6);
    expect(s.width * s.height).toBeGreaterThan(1.99e6);
    expect(Math.abs(s.width / s.height - 1.5)).toBeLessThan(0.01);
  });
  it('dontEnlarge caps at the source size; enlarge allowed otherwise', () => {
    expect(computeExportSize(800, 600, r({ mode: 'long-edge', value: 2048 }))).toEqual({ width: 800, height: 600 });
    expect(computeExportSize(800, 600, r({ mode: 'long-edge', value: 1600, dontEnlarge: false }))).toEqual({ width: 1600, height: 1200 });
  });
  it('never returns less than 1 px and ignores invalid values', () => {
    expect(computeExportSize(10000, 10, r({ mode: 'long-edge', value: 50 }))).toEqual({ width: 50, height: 1 });
    expect(computeExportSize(600, 400, r({ mode: 'long-edge', value: 0 }))).toEqual({ width: 600, height: 400 });
    expect(computeExportSize(600, 400, r({ mode: 'megapixels', value: NaN }))).toEqual({ width: 600, height: 400 });
  });
});

describe('buildFileName', () => {
  const meta = fullMeta();
  it('expands all tokens', () => {
    const name = buildFileName(
      '{name}_{seq}_{date}_{camera}_{lens}_{iso}_{rating}_{width}x{height}_{preset}',
      { name: 'DSC01234', seq: 7, meta, width: 2048, height: 1365, preset: 'Seoul Night', seqWidth: 3, rating: 4 },
      'jpg',
    );
    expect(name).toBe('DSC01234_007_20260501_Sony α7 IV_FE 35mm F1.4 GM_400_4_2048x1365_Seoul Night.jpg');
  });
  it('sanitizes illegal characters, reserved names and trailing dots', () => {
    expect(buildFileName('{name}', { name: 'a/b:c*d?"e<f>|g', seq: 1, meta, width: 1, height: 1 }, 'png')).toBe('a_b_c_d_e_f_g.png');
    expect(buildFileName('{name}', { name: 'CON', seq: 1, meta, width: 1, height: 1 }, '.tif')).toBe('_CON.tif');
    expect(sanitizeFileStem('photo. . ')).toBe('photo');
    expect(sanitizeFileStem('')).toBe('untitled');
    expect(sanitizeFileStem('x'.repeat(400)).length).toBeLessThanOrEqual(180);
  });
  it('collapses separators left by empty tokens and pads seq', () => {
    const m = { ...meta, lens: undefined };
    expect(buildFileName('{name}_{lens}_{seq}', { name: 'img', seq: 12, meta: m, width: 1, height: 1, seqWidth: 4 }, 'webp')).toBe(
      'img_0012.webp',
    );
  });
  it('date falls back to today, rating to meta.exif.Rating', () => {
    const m = { ...meta, dateTaken: undefined, exif: { Rating: 3 } };
    const out = buildFileName('{date}-{rating}', { name: 'x', seq: 1, meta: m, width: 1, height: 1 }, 'jpg');
    expect(out).toMatch(/^\d{8}-3\.jpg$/);
  });
  it('fileExtension', () => {
    expect(fileExtension('jpeg')).toBe('jpg');
    expect(fileExtension('tiff')).toBe('tif');
    expect(fileExtension('dng')).toBe('dng');
    expect(fileExtension('webp')).toBe('webp');
    expect(fileExtension('png')).toBe('png');
  });
});
