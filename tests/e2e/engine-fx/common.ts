/** Shared state and helpers of the engine-fx browser harness. */
import { createDefaultParams, createEmptyMeta } from '../../../src/editor/defaults';
import type { LensCorrection } from '../../../src/editor/contracts';
import type { EditParams, Point } from '../../../src/editor/types';
import type { PassContext } from '../../../src/editor/engine/pass-types';
import { createGeometryPlan, lensTermsFrom, mapSourceToOut } from '../../../src/editor/engine/fx/geometry-core';
import { MiniRunner, type Tex } from './runner';
import type { Img } from './scenes';

export const ZERO_LENS: LensCorrection = { profile: null, k1: 0, k2: 0, k3: 0, v1: 0, v2: 0, v3: 0, caRed: 1, caBlue: 1 };

export type SourceToOutput = (x: number, y: number, p: EditParams, w: number, h: number, ignoreCrop?: boolean, lens?: LensCorrection) => Point;

/** Prefer the public engine/geometry.ts; fall back to the core when @/editor/lens is not written yet. */
export const geometry: { sourceToOutput: SourceToOutput; source: string } = {
  source: 'fx/geometry-core',
  sourceToOutput: (x, y, p, w, h, ignoreCrop = false, lens = ZERO_LENS) => {
    const out = { x: 0, y: 0 };
    mapSourceToOut(createGeometryPlan(p, w, h, ignoreCrop, lensTermsFrom(p, lens)), x, y, out);
    return out;
  },
};

export const runner = new MiniRunner();

export function ctxFor(w: number, h: number, o: Partial<PassContext> = {}): PassContext {
  return {
    width: w,
    height: h,
    srcWidth: w,
    srcHeight: h,
    fullWidth: w,
    fullHeight: h,
    scale: 1,
    quality: 'full',
    isRaw: false,
    meta: createEmptyMeta('test'),
    lens: ZERO_LENS,
    ignoreCrop: false,
    outRect: { x: 0, y: 0, w: 1, h: 1 },
    outWidth: w,
    outHeight: h,
    ...o,
  };
}

export const params = (mut?: (p: EditParams) => void) => {
  const p = createDefaultParams();
  mut?.(p);
  return p;
};

export const upload = (img: Img): Tex => runner.createTexture(img.width, img.height, img.data);
export const download = (t: Tex): Img => ({ width: t.width, height: t.height, data: runner.read(t) });

