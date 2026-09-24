import { describe, expect, it } from 'vitest';
import { createDefaultParams } from '../../../src/editor/defaults';
import type { EditParams, Point, Rect } from '../../../src/editor/types';
import type { LensCorrection } from '../../../src/editor/contracts';
import {
  aspectRatioOf,
  buildGeometryUniforms,
  createGeometryPlan,
  frameSizeOf,
  isGeometryIdentity,
  lensTermsFrom,
  mapOutToSource,
  mapSourceToOut,
  outputSizeOf,
  undistortRadius,
  type LensTerms,
} from '../../../src/editor/engine/fx/geometry-core';
import { rectValidInPlan, searchMaxValidCrop } from '../../../src/editor/engine/fx/crop-search';

const W = 1200;
const H = 800;

function params(mut?: (p: EditParams) => void): EditParams {
  const p = createDefaultParams();
  mut?.(p);
  return p;
}

const lensOf = (k1 = 0, k2 = 0, k3 = 0, caRed = 1, caBlue = 1): LensTerms => ({ k1, k2, k3, caRed, caBlue });

function o2s(p: EditParams, u: number, v: number, opts: { ignoreCrop?: boolean; lens?: LensTerms; w?: number; h?: number } = {}): Point {
  const plan = createGeometryPlan(p, opts.w ?? W, opts.h ?? H, opts.ignoreCrop ?? false, opts.lens);
  const out = { x: 0, y: 0 };
  mapOutToSource(plan, u, v, out);
  return out;
}

function s2o(p: EditParams, x: number, y: number, opts: { ignoreCrop?: boolean; lens?: LensTerms; w?: number; h?: number } = {}): Point {
  const plan = createGeometryPlan(p, opts.w ?? W, opts.h ?? H, opts.ignoreCrop ?? false, opts.lens);
  const out = { x: 0, y: 0 };
  mapSourceToOut(plan, x, y, out);
  return out;
}

function expectPoint(a: Point, x: number, y: number, digits = 9) {
  expect(a.x).toBeCloseTo(x, digits);
  expect(a.y).toBeCloseTo(y, digits);
}

const grid = (n: number) => {
  const pts: [number, number][] = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) pts.push([i / n, j / n]);
  return pts;
};

describe('geometry: defaults', () => {
  it('is the identity', () => {
    const p = params();
    for (const [u, v] of grid(8)) {
      expectPoint(o2s(p, u, v), u, v, 12);
      expectPoint(s2o(p, u, v), u, v, 12);
    }
    expect(frameSizeOf(p, W, H)).toEqual({ width: W, height: H });
    expect(outputSizeOf(p, W, H)).toEqual({ width: W, height: H });
  });

  it('uniforms describe an identity copy', () => {
    const u = buildGeometryUniforms(params(), {
      srcWidth: W,
      srcHeight: H,
      ignoreCrop: false,
      outRect: { x: 0, y: 0, w: 1, h: 1 },
      lens: null as unknown as LensCorrection,
      quality: 'full',
    });
    expect(isGeometryIdentity(u)).toBe(true);
    expect(u.uBicubic).toBe(1);
  });
});

describe('geometry: orientation and flips', () => {
  const cases: [string, (p: EditParams) => void, [number, number, number, number][]][] = [
    ['90', (p) => (p.crop.orientation = 90), [[0, 0, 0, 1], [1, 0, 0, 0], [1, 1, 1, 0], [0, 1, 1, 1]]],
    ['180', (p) => (p.crop.orientation = 180), [[0, 0, 1, 1], [1, 0, 0, 1]]],
    ['270', (p) => (p.crop.orientation = 270), [[0, 0, 1, 0], [1, 0, 1, 1], [0, 1, 0, 0]]],
    ['flipH', (p) => (p.crop.flipH = true), [[0, 0, 1, 0], [1, 1, 0, 1]]],
    ['flipV', (p) => (p.crop.flipV = true), [[0, 0, 0, 1], [1, 1, 1, 0]]],
    [
      '90 + flipH (flip applies in oriented space)',
      (p) => {
        p.crop.orientation = 90;
        p.crop.flipH = true;
      },
      [[0, 0, 0, 0], [1, 0, 0, 1], [0, 1, 1, 0]],
    ],
  ];
  for (const [name, mut, corners] of cases) {
    it(name, () => {
      const p = params(mut);
      for (const [u, v, x, y] of corners) {
        expectPoint(o2s(p, u, v), x, y, 12);
        expectPoint(s2o(p, x, y), u, v, 12);
      }
    });
  }

  it('90° swaps the frame size', () => {
    const p = params((q) => (q.crop.orientation = 270));
    expect(frameSizeOf(p, W, H)).toEqual({ width: H, height: W });
    expect(aspectRatioOf({ ...p, crop: { ...p.crop, aspect: 'original' } }, W, H)).toBeCloseTo(H / W, 12);
  });
});

describe('geometry: crop', () => {
  const crop = (p: EditParams) => Object.assign(p.crop, { x: 0.25, y: 0.1, w: 0.5, h: 0.6 });
  it('maps output corners to the crop rect', () => {
    const p = params(crop);
    expectPoint(o2s(p, 0, 0), 0.25, 0.1);
    expectPoint(o2s(p, 1, 1), 0.75, 0.7);
    expectPoint(o2s(p, 0.5, 0.5, { ignoreCrop: true }), 0.5, 0.5);
    expectPoint(o2s(p, 0.1, 0.9, { ignoreCrop: true }), 0.1, 0.9);
    expect(outputSizeOf(p, W, H)).toEqual({ width: 600, height: 480 });
  });
});

describe('geometry: sign conventions', () => {
  it('positive angle rotates content clockwise', () => {
    const p = params((q) => (q.crop.angle = 10));
    const right = s2o(p, 0.8, 0.5);
    expect(right.y).toBeGreaterThan(0.5); // right of centre moves down
    const top = s2o(p, 0.5, 0.2);
    expect(top.x).toBeGreaterThan(0.5); // above centre moves right
  });

  it('transform.rotate adds to crop.angle', () => {
    const a = params((q) => (q.crop.angle = 4));
    const b = params((q) => {
      q.crop.angle = 1.5;
      q.transform.rotate = 2.5;
    });
    for (const [u, v] of grid(4)) {
      const pa = o2s(a, u, v);
      expectPoint(o2s(b, u, v), pa.x, pa.y, 12);
    }
  });

  it('vertical keystone widens the top edge by (1+k) and narrows the bottom by (1-k)', () => {
    const p = params((q) => (q.transform.vertical = 50)); // k = 0.2
    expectPoint(s2o(p, 0, 0), 0.5 - 0.5 * 1.2, 0);
    expectPoint(s2o(p, 1, 0), 0.5 + 0.5 * 1.2, 0);
    expectPoint(s2o(p, 0, 1), 0.5 - 0.5 * 0.8, 1);
    expectPoint(s2o(p, 1, 1), 0.5 + 0.5 * 0.8, 1);
  });

  it('horizontal keystone scales the right edge height by (1+k), the left by (1-k)', () => {
    const p = params((q) => (q.transform.horizontal = 50));
    expectPoint(s2o(p, 1, 0), 1, 0.5 - 0.5 * 1.2);
    expectPoint(s2o(p, 1, 1), 1, 0.5 + 0.5 * 1.2);
    expectPoint(s2o(p, 0, 0), 0, 0.5 - 0.5 * 0.8);
  });

  it('aspect, scale and offsets', () => {
    const asp = params((q) => (q.transform.aspect = 100));
    expectPoint(s2o(asp, 1, 0.5), 0.5 + 0.5 * Math.SQRT2, 0.5);
    expectPoint(s2o(asp, 0.5, 1), 0.5, 0.5 + 0.5 / Math.SQRT2);
    const sc = params((q) => (q.transform.scale = 150));
    expectPoint(s2o(sc, 1, 1), 1.25, 1.25);
    const off = params((q) => {
      q.transform.offsetX = 100;
      q.transform.offsetY = -50;
    });
    expectPoint(s2o(off, 0.5, 0.5), 1.0, 0.25);
  });

  it('positive manual-distortion-style k1 < 0 pulls source samples inwards (removes barrel)', () => {
    const lens = lensOf(-0.15);
    // Along the diagonal the normalized radius at the corner is exactly 1.
    const c = o2s(params(), 1, 1, { lens });
    expectPoint(c, 0.5 + 0.5 * 0.85, 0.5 + 0.5 * 0.85, 12);
  });
});

describe('geometry: round trips', () => {
  const complex = params((p) => {
    p.crop.angle = 7.3;
    p.transform.rotate = -2;
    p.transform.vertical = 30;
    p.transform.horizontal = -20;
    p.transform.aspect = 15;
    p.transform.scale = 110;
    p.transform.offsetX = 8;
    p.transform.offsetY = -5;
    p.crop.orientation = 90;
    p.crop.flipH = true;
    Object.assign(p.crop, { x: 0.12, y: 0.08, w: 0.7, h: 0.75 });
  });
  const lenses: [string, LensTerms][] = [
    ['no lens', lensOf()],
    ['barrel removal', lensOf(-0.08, 0.01, -0.002)],
    ['pincushion removal', lensOf(0.06, -0.01)],
  ];
  for (const [name, lens] of lenses) {
    it(`output → source → output (${name})`, () => {
      let maxErr = 0;
      for (const [u, v] of grid(10)) {
        const s = o2s(complex, u, v, { lens });
        const back = s2o(complex, s.x, s.y, { lens });
        maxErr = Math.max(maxErr, Math.abs(back.x - u), Math.abs(back.y - v));
      }
      expect(maxErr).toBeLessThan(1e-9);
    });
    it(`source → output → source (${name})`, () => {
      let maxErr = 0;
      for (const [x, y] of grid(10)) {
        const o = s2o(complex, x, y, { lens });
        const back = o2s(complex, o.x, o.y, { lens });
        maxErr = Math.max(maxErr, Math.abs(back.x - x), Math.abs(back.y - y));
      }
      expect(maxErr).toBeLessThan(1e-9);
    });
  }

  it('undistortRadius inverts r·g(r)', () => {
    const ks: [number, number, number][] = [
      [-0.15, 0, 0],
      [-0.3, 0.05, 0],
      [0.2, -0.02, 0.003],
      [-0.05, -0.02, -0.01],
    ];
    for (const [k1, k2, k3] of ks) {
      for (const r of [0.01, 0.3, 0.7, 1, 1.2]) {
        const rs = r * (1 + k1 * r * r + k2 * r ** 4 + k3 * r ** 6);
        expect(undistortRadius(rs, k1, k2, k3)).toBeCloseTo(r, 10);
      }
    }
    // Beyond the fold of a strong barrel term the source radius is unreachable.
    expect(undistortRadius(5, -0.3, 0, 0)).toBeNaN();
  });
});

describe('geometry: straighten symmetry', () => {
  it('a 90° straighten equals one clockwise orientation step (square image)', () => {
    const a = params((p) => (p.crop.angle = 90));
    const b = params((p) => (p.crop.orientation = 90));
    for (const [u, v] of grid(6)) {
      const pa = o2s(a, u, v, { w: 900, h: 900 });
      expectPoint(o2s(b, u, v, { w: 900, h: 900 }), pa.x, pa.y, 9);
    }
  });

  it('±angle are mirror images', () => {
    const plus = params((p) => (p.crop.angle = 12));
    const minus = params((p) => (p.crop.angle = -12));
    for (const [u, v] of grid(6)) {
      const a = o2s(plus, u, v);
      const b = o2s(minus, 1 - u, v);
      expectPoint(b, 1 - a.x, a.y, 12);
    }
  });
});

describe('geometry: valid crop', () => {
  const frameAspect = W / H;
  const planFor = (p: EditParams, lens?: LensTerms, w = W, h = H) => createGeometryPlan(p, w, h, true, lens);
  const scaleRect = (r: Rect, s: number): Rect => {
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    return { x: cx - (r.w * s) / 2, y: cy - (r.h * s) / 2, w: r.w * s, h: r.h * s };
  };

  it('defaults: the full frame', () => {
    const r = searchMaxValidCrop(planFor(params()), frameAspect);
    expect(r.x).toBeCloseTo(0, 9);
    expect(r.y).toBeCloseTo(0, 9);
    expect(r.w).toBeCloseTo(1, 9);
    expect(r.h).toBeCloseTo(1, 9);
    const sq = searchMaxValidCrop(planFor(params()), 1);
    expect(sq.h).toBeCloseTo(1, 6);
    expect(sq.w).toBeCloseTo(H / W, 6);
    expect(sq.x + sq.w / 2).toBeCloseTo(0.5, 6);
  });

  for (const angle of [1, 5, 10, 20, 33, 45, -17]) {
    it(`rotation ${angle}°: valid, maximal and matches the closed form`, () => {
      const p = params((q) => (q.crop.angle = angle));
      const plan = planFor(p);
      const r = searchMaxValidCrop(plan, frameAspect);
      expect(rectValidInPlan(plan, r)).toBe(true);
      expect(rectValidInPlan(plan, scaleRect(r, 1.002))).toBe(false);
      const t = (Math.abs(angle) * Math.PI) / 180;
      const s = Math.min(W / (W * Math.cos(t) + H * Math.sin(t)), H / (W * Math.sin(t) + H * Math.cos(t)));
      expect(r.w).toBeCloseTo(s, 5);
      expect(r.h).toBeCloseTo(s, 5);
      expect(r.x + r.w / 2).toBeCloseTo(0.5, 5);
      // Orientation 90 transposes the problem: same scale for the transposed aspect.
      const q = params((pp) => {
        pp.crop.angle = angle;
        pp.crop.orientation = 90;
      });
      const rq = searchMaxValidCrop(planFor(q), 1 / frameAspect);
      expect(rq.w).toBeCloseTo(s, 5);
      expect(rq.h).toBeCloseTo(s, 5);
    });
  }

  it('keystone + offsets + lens: result is valid and maximal (not centred)', () => {
    const p = params((q) => {
      q.transform.vertical = 40;
      q.transform.offsetX = 12;
      q.crop.angle = 4;
    });
    const lens = lensOf(-0.06, 0.01);
    const plan = planFor(p, lens);
    for (const aspect of [frameAspect, 1, 16 / 9, null]) {
      const r = searchMaxValidCrop(plan, aspect);
      expect(r.w * r.h).toBeGreaterThan(0.2);
      expect(rectValidInPlan(plan, r)).toBe(true);
      expect(rectValidInPlan(plan, scaleRect(r, 1.003))).toBe(false);
      if (aspect !== null) expect((r.w * W) / (r.h * H)).toBeCloseTo(aspect, 6);
    }
  });

  it('free aspect finds at least the area of the frame-aspect crop', () => {
    const p = params((q) => (q.crop.angle = 20));
    const plan = planFor(p);
    const fixed = searchMaxValidCrop(plan, frameAspect);
    const free = searchMaxValidCrop(plan, null);
    expect(rectValidInPlan(plan, free)).toBe(true);
    expect(free.w * free.h).toBeGreaterThanOrEqual(fixed.w * fixed.h * 0.999);
  });

  it('rects outside the frame or the image are invalid', () => {
    const plan = planFor(params((q) => (q.crop.angle = 10)));
    expect(rectValidInPlan(plan, { x: 0, y: 0, w: 1, h: 1 })).toBe(false);
    expect(rectValidInPlan(plan, { x: 0.3, y: 0.3, w: 0.4, h: 0.4 })).toBe(true);
    expect(rectValidInPlan(plan, { x: -0.1, y: 0.3, w: 0.4, h: 0.4 })).toBe(false);
  });
});

describe('geometry: aspect ratio values', () => {
  it('maps presets literally', () => {
    const p = params();
    const v = (a: EditParams['crop']['aspect'], custom?: [number, number]) =>
      aspectRatioOf({ ...p, crop: { ...p.crop, aspect: a, customAspect: custom ?? p.crop.customAspect } }, W, H);
    expect(v('free')).toBeNull();
    expect(v('original')).toBeCloseTo(1.5, 12);
    expect(v('16:9')).toBeCloseTo(16 / 9, 12);
    expect(v('4:5')).toBeCloseTo(0.8, 12);
    expect(v('custom', [5, 7])).toBeCloseTo(5 / 7, 12);
    expect(v('custom', [0, 7])).toBeNull();
  });
});

describe('geometry: GPU uniforms mirror the CPU mapping', () => {
  it('rows + lens formula reproduce mapOutToSource for an outRect tile', () => {
    const p = params((q) => {
      q.crop.angle = -6;
      q.transform.vertical = -25;
      q.crop.orientation = 180;
      Object.assign(q.crop, { x: 0.1, y: 0.2, w: 0.6, h: 0.5 });
      q.lens.removeCA = true;
    });
    const lens = { k1: -0.05, k2: 0.004, k3: 0, caRed: 1.001, caBlue: 0.999 } as LensCorrection;
    const outRect = { x: 0.25, y: 0.5, w: 0.5, h: 0.25 };
    const u = buildGeometryUniforms(p, { srcWidth: W, srcHeight: H, ignoreCrop: false, outRect, lens, quality: 'draft' });
    expect(u.uUseCA).toBe(1);
    expect(u.uBicubic).toBe(0);
    const plan = createGeometryPlan(p, W, H, false, lensTermsFrom(p, lens));
    for (const [tx, ty] of grid(5)) {
      const hx = u.uGeoRow0[0] * tx + u.uGeoRow0[1] * ty + u.uGeoRow0[2];
      const hy = u.uGeoRow1[0] * tx + u.uGeoRow1[1] * ty + u.uGeoRow1[2];
      const hz = u.uGeoRow2[0] * tx + u.uGeoRow2[1] * ty + u.uGeoRow2[2];
      const lx = hx / hz;
      const ly = hy / hz;
      const dx = lx - 0.5;
      const dy = ly - 0.5;
      const ex = dx * u.uLensAxis[0];
      const ey = dy * u.uLensAxis[1];
      const r2 = ex * ex + ey * ey;
      const g = 1 + r2 * (u.uLensK[0] + r2 * (u.uLensK[1] + r2 * u.uLensK[2]));
      const cpu = { x: 0, y: 0 };
      mapOutToSource(plan, outRect.x + tx * outRect.w, outRect.y + ty * outRect.h, cpu);
      expect(0.5 + dx * g).toBeCloseTo(cpu.x, 10);
      expect(0.5 + dy * g).toBeCloseTo(cpu.y, 10);
    }
  });

  it('CA is gated by params.lens.removeCA', () => {
    const lens = { k1: 0, k2: 0, k3: 0, caRed: 1.002, caBlue: 0.998 } as LensCorrection;
    const u = buildGeometryUniforms(params(), {
      srcWidth: W,
      srcHeight: H,
      ignoreCrop: false,
      outRect: { x: 0, y: 0, w: 1, h: 1 },
      lens,
      quality: 'full',
    });
    expect(u.uUseCA).toBe(0);
    expect(isGeometryIdentity(u)).toBe(true);
  });
});
