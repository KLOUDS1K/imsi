import { describe, expect, it, vi } from 'vitest';
import type { MaskRasterContext } from '../../../src/editor/contracts';
import type { BrushStroke, Mask, MaskBitmap, MaskComponent, PixelBuffer } from '../../../src/editor/types';
import {
  BrushRaster,
  createAiMaskStore,
  createMaskProvider,
  deserializeMaskBitmap,
  masksModule,
  rasterizeMask,
  rasterizeStrokes,
  serializeMaskBitmap,
  strokesBounds,
} from '../../../src/editor/masks';

let idc = 0;
const comp = (c: Partial<MaskComponent> & Pick<MaskComponent, 'kind'>): MaskComponent => ({
  id: `c${++idc}`,
  mode: 'add',
  invert: false,
  ...c,
});

const mask = (components: MaskComponent[], invert = false): Mask => ({
  id: `m${++idc}`,
  name: 'm',
  visible: true,
  components,
  invert,
  amount: 100,
  adjustments: {
    exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, temperature: 0, tint: 0,
    saturation: 0, texture: 0, clarity: 0, dehaze: 0, sharpness: 0, noise: 0,
  },
});

function solid(w: number, h: number, fn: (x: number, y: number) => [number, number, number]): PixelBuffer {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fn(x, y);
      const i = (y * w + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  return { width: w, height: h, data, transfer: 'srgb' };
}

const ctx = (source?: PixelBuffer): MaskRasterContext => ({ source: source ?? solid(4, 4, () => [0, 0, 0]), aiStore: createAiMaskStore() });

const stroke = (points: [number, number][], o: Partial<BrushStroke> = {}): BrushStroke => ({
  points: points.map(([x, y]) => ({ x, y })),
  size: 0.05,
  feather: 0,
  flow: 100,
  density: 100,
  erase: false,
  ...o,
});

const at = (a: Uint8Array, w: number, x: number, y: number) => a[y * w + x]!;

describe('gradients', () => {
  it('linear: 1 at start, 0 at end, smoothstep midpoint', () => {
    const W = 101, H = 3;
    const m = mask([comp({ kind: 'linear', linear: { x0: 0.25, y0: 0.5, x1: 0.75, y1: 0.5 } })]);
    const a = rasterizeMask(m, ctx(), W, H);
    expect(at(a, W, 0, 1)).toBe(255);
    expect(at(a, W, 100, 1)).toBe(0);
    // pixel 50 centre is x = 50.5/101 ≈ 0.5 → t ≈ 0.5 → smoothstep 0.5
    expect(Math.abs(at(a, W, 50, 1) - 127.5)).toBeLessThan(3);
    // monotone decreasing
    for (let x = 1; x < W; x++) expect(at(a, W, x, 1)).toBeLessThanOrEqual(at(a, W, x - 1, 1));
  });

  it('radial: inner region solid, feather ring smoothstep, zero outside, rotation', () => {
    const W = 200, H = 200;
    const m = mask([comp({ kind: 'radial', radial: { cx: 0.5, cy: 0.5, rx: 0.25, ry: 0.25, angle: 0, feather: 50 } })]);
    const a = rasterizeMask(m, ctx(), W, H);
    expect(at(a, W, 100, 100)).toBe(255);
    // r = 0.4 (inside inner 0.5)
    expect(at(a, W, 100 + 20, 100)).toBe(255);
    // r ≈ 0.75 → t = 0.5 → 128
    expect(Math.abs(at(a, W, 137, 100) - 128)).toBeLessThan(10);
    expect(at(a, W, 100 + 52, 100)).toBe(0);
    // rotated narrow ellipse: 90° swaps the axes
    const e = mask([comp({ kind: 'radial', radial: { cx: 0.5, cy: 0.5, rx: 0.4, ry: 0.1, angle: 90, feather: 0 } })]);
    const b = rasterizeMask(e, ctx(), W, H);
    expect(at(b, W, 100, 100 + 60)).toBe(255); // along y (rotated long axis)
    expect(at(b, W, 100 + 60, 100)).toBe(0);
  });
});

describe('combination modes', () => {
  // A: left half = 255 (hard linear edge), B: top half = 255.
  const W = 64, H = 64;
  const A = () => comp({ kind: 'linear', linear: { x0: 0.49, y0: 0.5, x1: 0.51, y1: 0.5 } });
  const B = (mode: MaskComponent['mode'], invert = false) =>
    comp({ kind: 'linear', mode, invert, linear: { x0: 0.5, y0: 0.49, x1: 0.5, y1: 0.51 } });
  const q = (a: Uint8Array) => [at(a, W, 5, 5), at(a, W, 58, 5), at(a, W, 5, 58), at(a, W, 58, 58)]; // TL TR BL BR

  it('add = union', () => expect(q(rasterizeMask(mask([A(), B('add')]), ctx(), W, H))).toEqual([255, 255, 255, 0]));
  it('subtract = a·(1−b)', () => expect(q(rasterizeMask(mask([A(), B('subtract')]), ctx(), W, H))).toEqual([0, 0, 255, 0]));
  it('intersect = a·b', () => expect(q(rasterizeMask(mask([A(), B('intersect')]), ctx(), W, H))).toEqual([255, 0, 0, 0]));
  it('component invert', () => expect(q(rasterizeMask(mask([A(), B('intersect', true)]), ctx(), W, H))).toEqual([0, 0, 255, 0]));
  it('mask invert', () => expect(q(rasterizeMask(mask([A(), B('add')], true), ctx(), W, H))).toEqual([0, 0, 0, 255]));
  it('first component mode is treated as add', () => {
    const first = A();
    first.mode = 'subtract';
    expect(q(rasterizeMask(mask([first]), ctx(), W, H))).toEqual([255, 0, 255, 0]);
  });
  it('soft screen union', () => {
    const a = comp({ kind: 'linear', linear: { x0: 0, y0: 0, x1: 2, y1: 0 } }); // ~0.5 at x≈1? use values directly
    const r = rasterizeMask(mask([a, comp({ kind: 'linear', linear: { x0: 0, y0: 0, x1: 2, y1: 0 } })]), ctx(), W, H);
    const single = rasterizeMask(mask([comp({ kind: 'linear', linear: { x0: 0, y0: 0, x1: 2, y1: 0 } })]), ctx(), W, H);
    const s = at(single, W, 63, 10) / 255;
    expect(Math.abs(at(r, W, 63, 10) / 255 - (s + s - s * s))).toBeLessThan(2 / 255);
  });
});

describe('brush', () => {
  const W = 200, H = 100;
  it('single hard dab: flow 100 → full, density caps, flow scales', () => {
    const full = rasterizeStrokes([stroke([[0.5, 0.5]])], W, H);
    expect(at(full, W, 100, 50)).toBe(255);
    // radius = 0.05 * 200 = 10 px
    expect(at(full, W, 100 + 12, 50)).toBe(0);
    const dens = rasterizeStrokes([stroke([[0.5, 0.5]], { density: 50 })], W, H);
    expect(Math.abs(at(dens, W, 100, 50) - 128)).toBeLessThanOrEqual(1);
    const flow = rasterizeStrokes([stroke([[0.5, 0.5]], { flow: 25 })], W, H);
    expect(Math.abs(at(flow, W, 100, 50) - 64)).toBeLessThanOrEqual(1);
  });

  it('flow accumulates along a stroke but never exceeds density', () => {
    const s = rasterizeStrokes([stroke([[0.2, 0.5], [0.8, 0.5]], { flow: 20, density: 60 })], W, H);
    const mid = at(s, W, 100, 50);
    expect(mid).toBeGreaterThan(140);
    expect(mid).toBeLessThanOrEqual(153 + 1);
  });

  it('feather gives a soft edge', () => {
    const s = rasterizeStrokes([stroke([[0.5, 0.5]], { feather: 100 })], W, H);
    const c = at(s, W, 100, 50), mid = at(s, W, 105, 50), edge = at(s, W, 109, 50);
    expect(c).toBeGreaterThan(240);
    expect(mid).toBeGreaterThan(60);
    expect(mid).toBeLessThan(200);
    expect(edge).toBeLessThan(mid);
  });

  it('erase strokes subtract', () => {
    const s = rasterizeStrokes(
      [stroke([[0.2, 0.5], [0.8, 0.5]]), stroke([[0.5, 0.3], [0.5, 0.7]], { erase: true, size: 0.03 })],
      W,
      H,
    );
    expect(at(s, W, 60, 50)).toBe(255);
    expect(at(s, W, 100, 50)).toBe(0);
  });

  it('pressure scales size', () => {
    const lo = stroke([[0.5, 0.5]]);
    lo.points[0]!.pressure = 0;
    const s = rasterizeStrokes([lo], W, H);
    expect(at(s, W, 100 + 7, 50)).toBe(0); // radius halves to 5 px
    expect(at(s, W, 100 + 3, 50)).toBeGreaterThan(0);
  });

  it('incremental painting matches a full rebuild bit-for-bit', () => {
    const pts: [number, number][] = [];
    for (let i = 0; i < 40; i++) pts.push([0.1 + i * 0.02, 0.5 + 0.3 * Math.sin(i * 0.4)]);
    const opts = { flow: 35, density: 80, feather: 60, size: 0.04 };
    const r = new BrushRaster(W, H);
    const strokes: BrushStroke[] = [stroke([[0.2, 0.2], [0.9, 0.3]], { flow: 50 })];
    r.update(strokes);
    const live = stroke([], opts);
    for (let i = 0; i < pts.length; i++) {
      live.points = [...live.points, { x: pts[i]![0], y: pts[i]![1], pressure: 0.5 + 0.5 * Math.cos(i) }];
      const d = r.update([...strokes, { ...live }]);
      expect(d).not.toBeNull();
    }
    const erase = stroke([[0.3, 0.1], [0.5, 0.9]], { erase: true, feather: 40 });
    r.update([...strokes, { ...live }, erase]);
    const ref = rasterizeStrokes([...strokes, { ...live }, erase], W, H);
    expect(Buffer.from(r.out).equals(Buffer.from(ref))).toBe(true);
    // unchanged → null dirty
    expect(r.update([...strokes, { ...live }, erase])).toBeNull();
  });

  it('strokesBounds includes the radius (aspect-aware)', () => {
    const b = strokesBounds([stroke([[0.5, 0.5], [0.6, 0.55]], { size: 0.05 })]);
    expect(b.x).toBeCloseTo(0.45);
    expect(b.y).toBeCloseTo(0.45);
    expect(b.w).toBeCloseTo(0.2);
    expect(b.h).toBeCloseTo(0.15);
    const wide = strokesBounds([stroke([[0.5, 0.5]], { size: 0.05 })], 2);
    expect(wide.w).toBeCloseTo(0.1);
    expect(wide.h).toBeCloseTo(0.2);
    expect(strokesBounds([])).toEqual({ x: 0, y: 0, w: 0, h: 0 });
    expect(strokesBounds([stroke([[0.01, 0.99]])]).x).toBe(0);
  });
});

describe('range components', () => {
  it('color range selects the sampled hue family only', () => {
    // left third red, middle green, right blue; darker red at the bottom.
    const src = solid(90, 30, (x, y) => (x < 30 ? (y < 15 ? [220, 30, 30] : [170, 25, 25]) : x < 60 ? [30, 200, 40] : [30, 40, 210]));
    const m = mask([comp({ kind: 'color-range', colorRange: { samples: [[220 / 255, 30 / 255, 30 / 255]], range: 40 } })]);
    const a = rasterizeMask(m, ctx(src), 90, 30);
    expect(at(a, 90, 10, 5)).toBe(255);
    expect(at(a, 90, 10, 25)).toBeGreaterThan(40); // darker red partially selected (lightness weighted down)
    const wider = rasterizeMask(
      mask([comp({ kind: 'color-range', colorRange: { samples: [[220 / 255, 30 / 255, 30 / 255]], range: 60 } })]),
      ctx(src), 90, 30,
    );
    expect(at(wider, 90, 10, 25)).toBeGreaterThan(200);
    expect(at(wider, 90, 45, 10)).toBe(0);
    expect(at(a, 90, 45, 10)).toBe(0);
    expect(at(a, 90, 75, 10)).toBe(0);
    const tight = rasterizeMask(
      mask([comp({ kind: 'color-range', colorRange: { samples: [[220 / 255, 30 / 255, 30 / 255]], range: 0 } })]),
      ctx(src), 90, 30,
    );
    expect(at(tight, 90, 10, 5)).toBe(255);
    expect(at(tight, 90, 10, 25)).toBe(0);
    // resampled to a larger size still selects the same region
    const big = rasterizeMask(m, ctx(src), 180, 60);
    expect(at(big, 180, 20, 10)).toBe(255);
    expect(at(big, 180, 150, 20)).toBe(0);
  });

  it('luminance range with feathers', () => {
    // horizontal gray ramp 0..255
    const src = solid(256, 2, (x) => [x, x, x]);
    const m = mask([comp({ kind: 'luminance-range', luminanceRange: { min: 0.4, max: 0.6, featherLow: 0.1, featherHigh: 0 } })]);
    const a = rasterizeMask(m, ctx(src), 256, 2);
    // L* of sRGB gray v: 0.5 L* ≈ sRGB 119
    expect(at(a, 256, 119, 0)).toBe(255);
    expect(at(a, 256, 250, 0)).toBe(0);
    expect(at(a, 256, 20, 0)).toBe(0);
    // L* 0.35 (inside the low feather) ≈ sRGB 84 → partial
    const v = at(a, 256, 84, 0);
    expect(v).toBeGreaterThan(40);
    expect(v).toBeLessThan(220);
    // no high feather → hard edge above max: L* 0.62 ≈ sRGB 151
    expect(at(a, 256, 152, 0)).toBe(0);
  });

  it('depth range reads the depth map; missing depth is empty', () => {
    const depth: MaskBitmap = { width: 4, height: 1, data: new Uint8Array([0, 85, 170, 255]), key: 'd' };
    const m = mask([comp({ kind: 'depth-range', depthRange: { min: 0.6, max: 1, feather: 0 } })]);
    const a = rasterizeMask(m, { ...ctx(), depth }, 4, 1);
    expect([...a]).toEqual([0, 0, 255, 255]);
    expect([...rasterizeMask(m, ctx(), 4, 1)]).toEqual([0, 0, 0, 0]);
  });
});

describe('AI components & provider', () => {
  it('ai bitmap resampled; missing bitmap requests once and returns zeros', () => {
    const store = createAiMaskStore();
    const requestAi = vi.fn();
    const c = comp({ kind: 'ai', ai: { target: 'sky', bitmapKey: 'k1' } });
    const m = mask([c]);
    const p = createMaskProvider({ source: solid(2, 2, () => [0, 0, 0]), aiStore: store, requestAi });
    const changed = vi.fn();
    p.onChange(changed);
    expect(p.getMask(m, 8, 8)).toBeNull();
    expect(p.getMask(m, 8, 8)).toBeNull();
    expect(requestAi).toHaveBeenCalledTimes(1);
    expect(requestAi).toHaveBeenCalledWith(c.id, 'sky');
    store.set('k1', { width: 2, height: 2, data: new Uint8Array([255, 255, 0, 0]), key: 'sky-v1' });
    expect(changed).toHaveBeenCalledTimes(1);
    store.set('unrelated', { width: 1, height: 1, data: new Uint8Array([1]), key: 'x' });
    expect(changed).toHaveBeenCalledTimes(1);
    const bmp = p.getMask(m, 8, 8)!;
    expect(bmp).not.toBeNull();
    expect(bmp.data[0]).toBe(255);
    expect(bmp.data[63]).toBe(0);
    // stable key and object when unchanged
    const again = p.getMask(m, 8, 8)!;
    expect(again).toBe(bmp);
    // new content → new key
    store.set('k1', { width: 2, height: 2, data: new Uint8Array([0, 0, 255, 255]), key: 'sky-v2' });
    const b2 = p.getMask(m, 8, 8)!;
    expect(b2.key).not.toBe(bmp.key);
    expect(b2.data[0]).toBe(0);
  });

  it('AI edge shift expands/contracts coverage and feather softens the boundary', () => {
    const W = 101;
    const data = new Uint8Array(W * W);
    for (let y = 40; y <= 60; y++) for (let x = 40; x <= 60; x++) data[y * W + x] = 255;
    const store = createAiMaskStore();
    store.set('edge', { width: W, height: W, data, key: 'edge' });
    const render = (edgeShift: number, feather = 0) =>
      rasterizeMask(mask([comp({ kind: 'ai', ai: { target: 'subject', bitmapKey: 'edge', edgeShift, feather } })]), { ...ctx(), aiStore: store }, W, W);

    const expanded = render(100);
    expect(at(expanded, W, 38, 50)).toBe(255);
    const contracted = render(-100);
    expect(at(contracted, W, 41, 50)).toBe(0);
    expect(at(contracted, W, 50, 50)).toBe(255);
    const softened = render(0, 100);
    expect(at(softened, W, 39, 50)).toBeGreaterThan(0);
    expect(at(softened, W, 39, 50)).toBeLessThan(255);
  });

  it('depth changes notify; requestDepth fires once while missing', () => {
    const requestDepth = vi.fn();
    const p = createMaskProvider({ source: solid(2, 2, () => [0, 0, 0]), aiStore: createAiMaskStore(), requestDepth });
    const m = mask([comp({ kind: 'depth-range', depthRange: { min: 0, max: 0.5, feather: 0 } })]);
    const cb = vi.fn();
    p.onChange(cb);
    expect(p.getMask(m, 4, 4)).toBeNull();
    p.getMask(m, 4, 4);
    expect(requestDepth).toHaveBeenCalledTimes(1);
    p.setContext({ depth: { width: 1, height: 1, data: new Uint8Array([10]), key: 'd1' } });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(p.getMask(m, 4, 4)!.data[0]).toBe(255);
  });

  it('provider brush painting perf (2560×1707 incremental update)', () => {
    const W = 2560, H = 1707;
    const p = createMaskProvider({ source: solid(2, 2, () => [0, 0, 0]), aiStore: createAiMaskStore() });
    const c = comp({ kind: 'brush', brush: { strokes: [] } });
    const base = mask([c]);
    const live = stroke([], { size: 0.03, feather: 50, flow: 60 });
    const times: number[] = [];
    let last: MaskBitmap | null = null;
    for (let i = 0; i < 30; i++) {
      live.points = [...live.points, { x: 0.1 + i * 0.025, y: 0.5 + 0.1 * Math.sin(i / 3) }];
      const m: Mask = { ...base, components: [{ ...c, brush: { strokes: [{ ...live }] } }] };
      const t0 = performance.now();
      last = p.getMask(m, W, H);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const median = times[times.length >> 1]!;
    console.log(`[masks] incremental brush update 2560×1707: median ${median.toFixed(1)} ms, max ${times[times.length - 1]!.toFixed(1)} ms`);
    expect(last).not.toBeNull();
    expect(median).toBeLessThan(60); // target < 30 ms; generous for a loaded CI machine
    const ref = rasterizeStrokes([{ ...live }], W, H);
    expect(Buffer.from(last!.data).equals(Buffer.from(ref))).toBe(true);
  });

  it('empty mask → null; conformance object', () => {
    const p = masksModule.createMaskProvider(ctx());
    expect(p.getMask(mask([]), 10, 10)).toBeNull();
    expect(p.getMask(mask([comp({ kind: 'brush', brush: { strokes: [] } })]), 10, 10)).toBeNull();
  });
});

describe('serialization', () => {
  it('round-trips and compresses', () => {
    const w = 300, h = 200;
    const data = rasterizeStrokes([stroke([[0.2, 0.2], [0.8, 0.7]], { feather: 50 })], w, h);
    const bmp: MaskBitmap = { width: w, height: h, data, key: 'seg-sky-αβ' };
    const bytes = serializeMaskBitmap(bmp);
    expect(bytes.length).toBeLessThan(data.length / 5);
    const back = deserializeMaskBitmap(bytes);
    expect(back.width).toBe(w);
    expect(back.height).toBe(h);
    expect(back.key).toBe(bmp.key);
    expect(Buffer.from(back.data).equals(Buffer.from(data))).toBe(true);
    expect(() => deserializeMaskBitmap(new Uint8Array([1, 2, 3]))).toThrow();
  });
});
