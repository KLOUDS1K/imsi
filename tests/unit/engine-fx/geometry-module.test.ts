/**
 * engine/geometry.ts (the public GeometryModule). It imports resolveLensCorrection
 * from '@/editor/lens' (io agent); the lens module is mocked here so the test
 * pins the geometry side only. Skipped while the lens module does not exist yet.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createDefaultParams, createEmptyMeta } from '../../../src/editor/defaults';
import type { LensCorrection } from '../../../src/editor/contracts';
import type { EditParams, PhotoMeta } from '../../../src/editor/types';

const lensIndex = fileURLToPath(new URL('../../../src/editor/lens/index.ts', import.meta.url));
// FX_FORCE_GEOMETRY_TEST=1 runs it against an aliased stub before the lens module lands.
const lensExists = existsSync(lensIndex) || process.env.FX_FORCE_GEOMETRY_TEST === '1';

// vi.mock is hoisted above the imports, so the mock must be created in vi.hoisted.
const { resolveMock } = vi.hoisted(() => ({
  resolveMock: vi.fn(
    (lens: EditParams['lens'], meta: PhotoMeta): LensCorrection => ({
      profile: null,
      k1: (-0.15 * lens.distortion) / 100 + (meta.lens === 'Wide 16mm' ? -0.05 : 0),
      k2: 0,
      k3: 0,
      v1: 0,
      v2: 0,
      v3: 0,
      caRed: 1.001,
      caBlue: 0.999,
    }),
  ),
}));
vi.mock('@/editor/lens', () => ({ resolveLensCorrection: resolveMock }));

describe.skipIf(!lensExists)('engine/geometry.ts', () => {
  const load = () => import('../../../src/editor/engine/geometry');

  it('exposes the GeometryModule contract', async () => {
    const g = await load();
    for (const k of ['frameSize', 'outputSize', 'outputToSource', 'sourceToOutput', 'maxValidCrop', 'isCropValid', 'aspectRatioValue'] as const) {
      expect(typeof g.geometryModule[k]).toBe('function');
    }
  });

  it('resolves the lens from params + the registered meta', async () => {
    const g = await load();
    const p = createDefaultParams();
    p.lens.distortion = 100;
    g.setGeometryMeta(null);
    const a = g.outputToSource(1, 1, p, 1000, 1000);
    expect(a.x).toBeCloseTo(0.5 + 0.5 * 0.85, 9);
    const meta = { ...createEmptyMeta('x.jpg'), lens: 'Wide 16mm' };
    g.setGeometryMeta(meta);
    const b = g.outputToSource(1, 1, p, 1000, 1000);
    expect(b.x).toBeCloseTo(0.5 + 0.5 * 0.8, 9);
    expect(resolveMock).toHaveBeenLastCalledWith(p.lens, meta);
    g.setGeometryMeta(null);
  });

  it('an explicit lens overrides the registered context', async () => {
    const g = await load();
    const p = createDefaultParams();
    p.lens.distortion = 100;
    const lens: LensCorrection = { profile: null, k1: 0, k2: 0, k3: 0, v1: 0, v2: 0, v3: 0, caRed: 1, caBlue: 1 };
    expect(g.outputToSource(1, 1, p, 1000, 1000, false, lens)).toEqual({ x: 1, y: 1 });
  });

  it('round-trips and keeps maxValidCrop valid', async () => {
    const g = await load();
    const p = createDefaultParams();
    p.lens.distortion = 40;
    p.crop.angle = 8;
    p.transform.vertical = -20;
    const s = g.outputToSource(0.3, 0.7, p, 1500, 1000);
    const o = g.sourceToOutput(s.x, s.y, p, 1500, 1000);
    expect(o.x).toBeCloseTo(0.3, 9);
    expect(o.y).toBeCloseTo(0.7, 9);
    const r = g.maxValidCrop(p, 1500, 1000, 1.5);
    expect(g.isCropValid(p, 1500, 1000, r)).toBe(true);
    expect(g.isCropValid(p, 1500, 1000, { x: 0, y: 0, w: 1, h: 1 })).toBe(false);
  });

  it('lensCorrectionFor delegates to the lens module', async () => {
    const g = await load();
    const p = createDefaultParams();
    const meta = createEmptyMeta('a.jpg');
    const c = g.lensCorrectionFor(p, meta);
    expect(resolveMock).toHaveBeenLastCalledWith(p.lens, meta);
    expect(c.caRed).toBe(1.001);
  });
});
