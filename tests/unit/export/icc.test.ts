import { describe, expect, it } from 'vitest';
import exifr from 'exifr';
import { buildIccProfile, validateIccProfile } from '@/editor/export';
import { encodePng } from '@/editor/export/png';
import { synthImage } from './helpers';

const s15 = (p: Uint8Array, o: number) => new DataView(p.buffer, p.byteOffset).getInt32(o) / 65536;
function tag(p: Uint8Array, sig: string): { off: number; size: number } {
  const dv = new DataView(p.buffer, p.byteOffset);
  const n = dv.getUint32(128);
  for (let i = 0; i < n; i++) {
    const e = 132 + 12 * i;
    if (String.fromCharCode(...p.subarray(e, e + 4)) === sig) return { off: dv.getUint32(e + 4), size: dv.getUint32(e + 8) };
  }
  throw new Error(`no ${sig}`);
}

describe('buildIccProfile', () => {
  for (const space of ['srgb', 'display-p3', 'adobe-rgb'] as const) {
    it(`${space}: structurally valid v2 display profile`, () => {
      const p = buildIccProfile(space);
      expect(validateIccProfile(p)).toEqual([]);
      expect(String.fromCharCode(...p.subarray(12, 24))).toBe('mntrRGB XYZ ');
      expect(p[8]).toBe(2);
      // wtpt = D50
      const w = tag(p, 'wtpt').off;
      expect(s15(p, w + 8)).toBeCloseTo(0.9642, 3);
      expect(s15(p, w + 12)).toBeCloseTo(1.0, 3);
      expect(s15(p, w + 16)).toBeCloseTo(0.8249, 3);
      // primaries columns sum to D50 white
      const r = tag(p, 'rXYZ').off, g = tag(p, 'gXYZ').off, b = tag(p, 'bXYZ').off;
      for (let k = 0; k < 3; k++) {
        const sum = s15(p, r + 8 + 4 * k) + s15(p, g + 8 + 4 * k) + s15(p, b + 8 + 4 * k);
        expect(sum).toBeCloseTo([0.9642, 1.0, 0.8249][k], 3);
      }
    });
  }
  it('sRGB primaries match the published Bradford-adapted values', () => {
    const p = buildIccProfile('srgb');
    const r = tag(p, 'rXYZ').off, g = tag(p, 'gXYZ').off, b = tag(p, 'bXYZ').off;
    expect(s15(p, r + 8)).toBeCloseTo(0.4361, 3);
    expect(s15(p, r + 12)).toBeCloseTo(0.2225, 3);
    expect(s15(p, g + 12)).toBeCloseTo(0.7169, 3);
    expect(s15(p, b + 16)).toBeCloseTo(0.7141, 3);
  });
  it('TRCs: 1024-entry sRGB curve / single gamma 563/256', () => {
    const s = buildIccProfile('srgb');
    const t = tag(s, 'rTRC');
    expect(t).toEqual(tag(s, 'bTRC')); // shared data
    const dv = new DataView(s.buffer, s.byteOffset);
    expect(dv.getUint32(t.off + 8)).toBe(1024);
    expect(dv.getUint16(t.off + 12 + 2 * 1023)).toBe(65535);
    const a = buildIccProfile('adobe-rgb');
    const ta = tag(a, 'gTRC');
    const da = new DataView(a.buffer, a.byteOffset);
    expect(da.getUint32(ta.off + 8)).toBe(1);
    expect(da.getUint16(ta.off + 12) / 256).toBeCloseTo(2.19921875, 8);
  });
  it('exifr reads the embedded profile back from a PNG', async () => {
    const img = synthImage(8, 8, 8);
    const png = encodePng(img.data, 8, 8, 8, { icc: { name: 'Display P3', data: buildIccProfile('display-p3') } });
    const out = await exifr.parse(png, { icc: true, tiff: false, xmp: false });
    expect(out.ProfileClass).toBe('Monitor');
    expect(out.ColorSpaceData).toBe('RGB');
    expect(out.ProfileDescription).toBe('Display P3 (KLOUD Studio)');
    expect(out.ProfileConnectionSpace).toBe('XYZ');
  });
});
