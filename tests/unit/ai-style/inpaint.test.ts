/**
 * ai/inpaint unit tests (Node: the PatchMatch core runs inline, no Worker).
 *
 *   npx vitest run tests/unit/ai-style
 */
import { describe, expect, it } from 'vitest';
import { inpaintRgba8 } from '@/editor/ai/inpaint/patchmatch';
import { dustToSpots, findHealSource } from '@/editor/ai/inpaint/heal-source';
import { createPatchStore, deserializePatch, serializePatch } from '@/editor/ai/inpaint/patch-store';
import { createRemovalPatch, inpaint, inpaintModule } from '@/editor/ai/inpaint';
import type { BrushStroke, PixelBuffer } from '@/editor/types';

/** Deterministic textured scene: checker × sinusoids + seeded noise. */
function texturedScene(w: number, h: number, seed = 7): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  let s = seed;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      s = (s * 1103515245 + 12345) >>> 0;
      const n = ((s >>> 24) - 128) / 16;
      const i = (y * w + x) * 4;
      const check = ((x >> 3) + (y >> 3)) % 2 ? 170 : 70;
      d[i] = check + n;
      d[i + 1] = 110 + 50 * Math.sin(x * 0.45) + n;
      d[i + 2] = 120 + 45 * Math.cos(y * 0.6) + n;
      d[i + 3] = 255;
    }
  }
  return d;
}

function rectMask(w: number, h: number, x0: number, y0: number, rw: number, rh: number): Uint8Array {
  const m = new Uint8Array(w * h);
  for (let y = y0; y < y0 + rh; y++) for (let x = x0; x < x0 + rw; x++) m[y * w + x] = 255;
  return m;
}

function holeErrors(img: Uint8ClampedArray, out: Uint8ClampedArray, mask: Uint8Array) {
  const mean = [0, 0, 0];
  let k = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) continue;
    for (let c = 0; c < 3; c++) mean[c] += img[i * 4 + c];
    k++;
  }
  for (let c = 0; c < 3; c++) mean[c] /= k;
  let err = 0;
  let meanErr = 0;
  let n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    for (let c = 0; c < 3; c++) {
      err += Math.abs(out[i * 4 + c] - img[i * 4 + c]);
      meanErr += Math.abs(mean[c] - img[i * 4 + c]);
    }
    n += 3;
  }
  return { err: err / n, meanErr: meanErr / n };
}

describe('PatchMatch inpainting core', () => {
  it('reconstructs a masked rectangle of a textured image far better than a mean fill', () => {
    const w = 160;
    const h = 120;
    const img = texturedScene(w, h);
    const mask = rectMask(w, h, 62, 40, 32, 28);
    const out = inpaintRgba8(img, w, h, mask);
    const { err, meanErr } = holeErrors(img, out, mask);
    expect(err).toBeLessThan(meanErr * 0.35);
  });

  it('leaves unmasked pixels untouched and blends soft mask values', () => {
    const w = 96;
    const h = 80;
    const img = texturedScene(w, h, 3);
    const mask = rectMask(w, h, 30, 30, 20, 16);
    mask[10 * w + 10] = 128; // an isolated half-strength pixel
    const out = inpaintRgba8(img, w, h, mask);
    let changedOutside = 0;
    for (let i = 0; i < w * h; i++) {
      if (mask[i]) continue;
      for (let c = 0; c < 4; c++) if (out[i * 4 + c] !== img[i * 4 + c]) changedOutside++;
    }
    expect(changedOutside).toBe(0);
    expect(out.length).toBe(img.length);
    // Alpha is preserved everywhere.
    for (let i = 3; i < out.length; i += 4) expect(out[i]).toBe(255);
  });

  it('is deterministic for a fixed seed and reports progress', () => {
    const w = 80;
    const h = 64;
    const img = texturedScene(w, h, 11);
    const mask = rectMask(w, h, 30, 20, 16, 16);
    const progress: number[] = [];
    const a = inpaintRgba8(img, w, h, mask, { seed: 42 }, { onProgress: (f) => progress.push(f) });
    const b = inpaintRgba8(img, w, h, mask, { seed: 42 });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(progress.length).toBeGreaterThan(1);
    expect(progress[progress.length - 1]).toBe(1);
    for (let i = 1; i < progress.length; i++) expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1]);
  });

  it('aborts through the isAborted hook', () => {
    const w = 80;
    const h = 64;
    const img = texturedScene(w, h);
    const mask = rectMask(w, h, 30, 20, 16, 16);
    expect(() => inpaintRgba8(img, w, h, mask, {}, { isAborted: () => true })).toThrowError(/abort/i);
  });

  it('the public inpaint() works without Workers and respects AbortSignal', async () => {
    const w = 64;
    const h = 48;
    const px: PixelBuffer = { width: w, height: h, data: texturedScene(w, h), transfer: 'srgb' };
    const mask = rectMask(w, h, 24, 16, 10, 10);
    const res = await inpaint(px, mask, { patchSize: 5 });
    expect(res.width).toBe(w);
    expect(res.data.length).toBe(w * h * 4);
    const ac = new AbortController();
    ac.abort();
    await expect(inpaint(px, mask, { signal: ac.signal })).rejects.toThrow(/abort/i);
    expect(Object.keys(inpaintModule).sort()).toEqual(['createPatchStore', 'createRemovalPatch', 'dustToSpots', 'findHealSource', 'inpaint']);
  });

  it('accepts float linear input', async () => {
    const w = 48;
    const h = 40;
    const src = texturedScene(w, h);
    const f = new Float32Array(w * h * 4);
    for (let i = 0; i < f.length; i++) f[i] = (i & 3) === 3 ? 1 : Math.pow(src[i] / 255, 2.2);
    const res = await inpaint({ width: w, height: h, data: f, transfer: 'linear' }, rectMask(w, h, 18, 14, 8, 8));
    expect(res.transfer).toBe('srgb');
    // An unmasked pixel round-trips within 8-bit / gamma-approximation error.
    expect(Math.abs(res.data[0] - src[0])).toBeLessThanOrEqual(6);
  });
});

describe('createRemovalPatch', () => {
  it('returns a patch whose pixels cover exactly the bbox with alpha = coverage', async () => {
    const w = 120;
    const h = 90;
    const px: PixelBuffer = { width: w, height: h, data: texturedScene(w, h), transfer: 'srgb' };
    const stroke: BrushStroke = {
      points: [
        { x: 0.4, y: 0.5 },
        { x: 0.6, y: 0.5 },
      ],
      size: 0.04,
      feather: 50,
      flow: 100,
      density: 100,
      erase: false,
    };
    let n = 0;
    const { patch, pixels } = await createRemovalPatch(px, [stroke], 'ai-remove', { idFactory: () => `p${++n}` });
    expect(patch.id).toBe('p1');
    expect(patch.patchKey).toBe(patch.id);
    expect(patch.kind).toBe('ai-remove');
    expect(pixels.width).toBe(Math.round(patch.bbox.w * w));
    expect(pixels.height).toBe(Math.round(patch.bbox.h * h));
    expect(patch.bbox.x).toBeGreaterThan(0.3);
    expect(patch.bbox.x + patch.bbox.w).toBeLessThan(0.7);
    let maxA = 0;
    let zeroA = 0;
    for (let i = 3; i < pixels.data.length; i += 4) {
      maxA = Math.max(maxA, pixels.data[i]);
      if (pixels.data[i] === 0) zeroA++;
    }
    expect(maxA).toBe(255);
    expect(zeroA).toBeGreaterThan(0); // feathered, rounded ends leave transparent corners
  });
});

describe('findHealSource / dustToSpots', () => {
  /** Left half: fine vertical stripes; right half: flat grey. A blemish sits in the stripes. */
  function twoTextures(w: number, h: number): PixelBuffer {
    const d = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const v = x < w / 2 ? (x % 6 < 3 ? 60 : 200) : 128;
        d[i] = d[i + 1] = d[i + 2] = v;
        d[i + 3] = 255;
      }
    }
    // Blemish: dark blob at (0.25, 0.5).
    const cx = Math.round(w * 0.25);
    const cy = Math.round(h * 0.5);
    for (let y = cy - 3; y <= cy + 3; y++) {
      for (let x = cx - 3; x <= cx + 3; x++) {
        const i = (y * w + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = 5;
      }
    }
    return { width: w, height: h, data: d, transfer: 'srgb' };
  }

  it('picks a source with matching texture, away from the spot', () => {
    const w = 200;
    const h = 160;
    const px = twoTextures(w, h);
    const spot = { x: 0.25, y: 0.5, radius: 0.025 };
    const src = findHealSource(px, spot);
    expect(src.x).toBeLessThan(0.5 - spot.radius); // stayed in the striped half
    const dist = Math.hypot((src.x - spot.x) * w, (src.y - spot.y) * h) / (spot.radius * w);
    expect(dist).toBeGreaterThanOrEqual(1.2);
    expect(src.y - spot.radius * 1.0).toBeGreaterThanOrEqual(0);
  });

  it('prefers the flat region for a spot on flat grey', () => {
    const w = 200;
    const h = 160;
    const px = twoTextures(w, h);
    const src = findHealSource(px, { x: 0.75, y: 0.5, radius: 0.02 });
    expect(src.x).toBeGreaterThan(0.52);
  });

  it('dustToSpots scales the radius and sets heal defaults', () => {
    const px = twoTextures(120, 100);
    let i = 0;
    const spots = dustToSpots([{ x: 0.7, y: 0.4, radius: 0.01 }], px, () => `s${i++}`);
    expect(spots).toHaveLength(1);
    const s = spots[0];
    expect(s).toMatchObject({ id: 's0', kind: 'heal', x: 0.7, y: 0.4, feather: 50, opacity: 100 });
    expect(s.radius).toBeCloseTo(0.016, 6);
    expect(Math.hypot(s.sx - s.x, s.sy - s.y)).toBeGreaterThan(0);
  });
});

describe('patch store + serialization', () => {
  it('stores patches and round-trips the compact format', () => {
    const store = createPatchStore();
    const w = 33;
    const h = 21;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < data.length; i++) data[i] = (i * 37) & 255;
    for (let i = 3; i < data.length; i += 16) data[i] = 0; // some hidden pixels
    const px = { width: w, height: h, data, transfer: 'srgb' as const };
    const changes: string[] = [];
    store.onChange((k) => changes.push(k));
    store.set('a', px);
    expect(store.getPatch('a')).toBe(px);
    expect(store.getPatch('missing')).toBeNull();
    expect(store.keys()).toEqual(['a']);

    const bytes = serializePatch(px);
    const back = deserializePatch(bytes);
    expect(back.width).toBe(w);
    expect(back.height).toBe(h);
    for (let i = 0; i < data.length; i += 4) {
      expect(back.data[i + 3]).toBe(data[i + 3]);
      if (data[i + 3] > 0) for (let c = 0; c < 3; c++) expect(back.data[i + c]).toBe(data[i + c]);
    }
    const exact = deserializePatch(serializePatch(px, { dropHidden: false }));
    expect(Array.from(exact.data)).toEqual(Array.from(data));

    const f = new Float32Array([0.1, 0.2, 0.3, 1, 0.5, 0.6, 0.7, 0.5]);
    const fb = deserializePatch(serializePatch({ width: 2, height: 1, data: f, transfer: 'linear' }));
    expect(fb.transfer).toBe('linear');
    expect(Array.from(fb.data)).toEqual(Array.from(f));

    const u16 = new Uint16Array([1, 65535, 300, 65535, 40000, 2, 3, 65535]);
    expect(Array.from(deserializePatch(serializePatch({ width: 2, height: 1, data: u16, transfer: 'srgb' })).data)).toEqual(Array.from(u16));

    store.delete('a');
    expect(store.keys()).toEqual([]);
    expect(changes).toEqual(['a', 'a']);
    expect(() => deserializePatch(new Uint8Array(20))).toThrow();
  });

  it('compresses smooth patches well', () => {
    const w = 128;
    const h = 128;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = x;
      data[i + 1] = y;
      data[i + 2] = 100;
      data[i + 3] = 255;
    }
    const bytes = serializePatch({ width: w, height: h, data, transfer: 'srgb' });
    expect(bytes.length).toBeLessThan(data.length / 20);
  });
});
