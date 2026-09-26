import { describe, expect, it } from 'vitest';
import { createDefaultParams, createEmptyMeta } from '../../../src/editor/defaults';
import type { LensCorrection } from '../../../src/editor/contracts';
import type { EditParams, HealSpot } from '../../../src/editor/types';
import { MAX_SPOTS_PER_PASS, type PassContext, type PassDef } from '../../../src/editor/engine/pass-types';
import {
  DETAIL_STAGE,
  EFFECTS_STAGE,
  GEOMETRY_OVERLAY_PASS,
  GEOMETRY_PASS,
  HEAL_PASS,
  PATCH_COMPOSITE_PASS,
  grainCellsAcrossLongEdge,
  healUniforms,
} from '../../../src/editor/engine/fx';

const LENS: LensCorrection = { profile: null, k1: 0, k2: 0, k3: 0, v1: 0, v2: 0, v3: 0, caRed: 1, caBlue: 1 };

function ctx(o: Partial<PassContext> = {}): PassContext {
  return {
    width: 1200,
    height: 800,
    srcWidth: 1200,
    srcHeight: 800,
    fullWidth: 6000,
    fullHeight: 4000,
    scale: 1200 / 2560,
    quality: 'full',
    isRaw: false,
    meta: createEmptyMeta(),
    lens: LENS,
    ignoreCrop: false,
    outRect: { x: 0, y: 0, w: 1, h: 1 },
    outWidth: 1200,
    outHeight: 800,
    ...o,
  };
}

/** Every slider pushed to an extreme, to catch NaN/Infinity in uniform math. */
function extremeParams(): EditParams {
  const p = createDefaultParams(true);
  Object.assign(p.detail, { sharpenAmount: 150, sharpenRadius: 3, sharpenDetail: 100, sharpenMasking: 100 });
  Object.assign(p.noise, {
    luminance: 100, luminanceDetail: 0, luminanceContrast: 100, color: 100, colorDetail: 100, colorSmoothness: 100,
    aiDenoise: true, aiDenoiseStrength: 100, detailPreservation: 100,
  });
  Object.assign(p.effects, {
    vignetteAmount: -100, vignetteMidpoint: 0, vignetteRoundness: -100, vignetteFeather: 0, vignetteHighlights: 100,
    grainAmount: 100, grainSize: 100, grainRoughness: 100, bloom: 100, glow: 100, halation: 100,
  });
  Object.assign(p.transform, { vertical: 100, horizontal: -100, rotate: 10, aspect: -100, scale: 50, offsetX: 100, offsetY: -100 });
  Object.assign(p.crop, { angle: -45, orientation: 270, flipH: true, x: 0.1, y: 0.2, w: 0.5, h: 0.6 });
  p.retouch.removals = [{ id: 'r', kind: 'dust', bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, strokes: [], patchKey: 'k' }];
  return p;
}

const spot = (o: Partial<HealSpot> = {}): HealSpot => ({
  id: 's', kind: 'heal', x: 0.3, y: 0.4, sx: 0.6, sy: 0.4, radius: 0.02, feather: 50, opacity: 100, ...o,
});

const prepasses = (passes: PassDef[]) => passes.flatMap((p) => (p.blurs ?? []).flatMap((b) => (b.prepass ? [b.prepass] : [])));
const ALL: PassDef[] = [...DETAIL_STAGE, ...EFFECTS_STAGE, HEAL_PASS, PATCH_COMPOSITE_PASS, GEOMETRY_PASS, GEOMETRY_OVERLAY_PASS];
const EVERY = [...ALL, ...prepasses(ALL)];

const declared = (frag: string) => {
  const names = new Map<string, string>();
  for (const m of frag.matchAll(/uniform\s+(\w+)\s+(\w+)(\s*\[[^\]]+\])?\s*;/g)) names.set(m[2], m[1]);
  return names;
};

describe('fx passes: shader contract', () => {
  it('fragments follow the GLSL ES 3.00 header contract', () => {
    for (const p of EVERY) {
      expect(p.fragment.startsWith('#version 300 es\n'), p.name).toBe(true);
      expect(p.fragment).toContain('precision highp float;');
      expect(p.fragment).toContain('in vec2 vUv;');
      expect(p.fragment).toContain('out vec4 outColor;');
      expect(p.fragment).toMatch(/void main\(\)/);
    }
  });

  it('pass names are unique per fragment', () => {
    const byName = new Map<string, string>();
    for (const p of EVERY) {
      const prev = byName.get(p.name);
      if (prev !== undefined) expect(prev, p.name).toBe(p.fragment);
      byName.set(p.name, p.fragment);
    }
  });

  it('inputs and blur uniforms are declared sampler2D uniforms', () => {
    for (const p of EVERY) {
      const u = declared(p.fragment);
      for (const s of [...p.inputs, ...(p.blurs ?? []).map((b) => b.uniform)]) expect(u.get(s), `${p.name}.${s}`).toBe('sampler2D');
      for (const b of p.blurs ?? []) expect(p.inputs, `${p.name} blur source`).toContain(b.source);
    }
  });

  it('uniform values are finite and every returned uniform is declared', () => {
    const extra = { spots: [spot(), spot({ kind: 'clone' })], iteration: 0 };
    for (const params of [createDefaultParams(), createDefaultParams(true), extremeParams()]) {
      for (const c of [ctx(), ctx({ quality: 'draft', ignoreCrop: true, outRect: { x: 0.25, y: 0.5, w: 0.25, h: 0.25 } })]) {
        for (const p of EVERY) {
          const u = declared(p.fragment);
          const values = p.uniforms(params, c, extra);
          for (const [k, v] of Object.entries(values)) {
            expect(u.has(k), `${p.name}: ${k} not declared`).toBe(true);
            const arr = typeof v === 'number' || typeof v === 'boolean' ? [Number(v)] : Array.from(v as ArrayLike<number>);
            for (const x of arr) expect(Number.isFinite(x), `${p.name}.${k}`).toBe(true);
          }
          for (const b of p.blurs ?? []) {
            const s = typeof b.sigma === 'function' ? b.sigma(params, c) : b.sigma;
            expect(s > 0 && Number.isFinite(s), `${p.name}.${b.uniform} sigma`).toBe(true);
          }
        }
      }
    }
  });
});

describe('fx passes: identity at defaults', () => {
  it('JPEG defaults skip every pass', () => {
    const p = createDefaultParams();
    for (const pass of [...DETAIL_STAGE, ...EFFECTS_STAGE]) expect(pass.isIdentity?.(p, ctx()), pass.name).toBe(true);
    expect(HEAL_PASS.isIdentity?.(p, ctx(), { spots: [] })).toBe(true);
    expect(HEAL_PASS.isIdentity?.(p, ctx())).toBe(true);
    expect(PATCH_COMPOSITE_PASS.isIdentity?.(p, ctx(), { iteration: 0 })).toBe(true);
    expect(GEOMETRY_PASS.isIdentity?.(p, ctx())).toBe(true);
  });

  it('RAW defaults enable capture sharpening and colour NR only', () => {
    const p = createDefaultParams(true);
    const active = DETAIL_STAGE.filter((d) => !d.isIdentity?.(p, ctx())).map((d) => d.name);
    expect(active.sort()).toEqual(['fx-detail-color-nr', 'fx-detail-sharpen']);
  });

  it('geometry is not an identity when resizing, tiling, warping or correcting the lens', () => {
    const p = createDefaultParams();
    expect(GEOMETRY_PASS.isIdentity?.(p, ctx({ width: 600, height: 400 }))).toBe(false);
    expect(GEOMETRY_PASS.isIdentity?.(p, ctx({ outRect: { x: 0, y: 0, w: 0.5, h: 1 } }))).toBe(false);
    expect(GEOMETRY_PASS.isIdentity?.(p, ctx({ lens: { ...LENS, k1: -0.01 } }))).toBe(false);
    const rot = createDefaultParams();
    rot.crop.angle = 0.1;
    expect(GEOMETRY_PASS.isIdentity?.(rot, ctx())).toBe(false);
  });

  it('smart denoise passes only run when enabled, and never in draft', () => {
    const smart = DETAIL_STAGE.filter((d) => d.name.startsWith('fx-detail-ai-denoise'));
    expect(smart).toHaveLength(2);
    const p = createDefaultParams();
    for (const pass of smart) expect(pass.isIdentity?.(p, ctx())).toBe(true);
    p.noise.aiDenoise = true;
    for (const pass of smart) {
      expect(pass.isIdentity?.(p, ctx())).toBe(false);
      expect(pass.skipInDraft).toBe(true);
    }
  });

  it('luma NR and its contrast restore agree on when the residual is carried in alpha', () => {
    const nr = DETAIL_STAGE.find((d) => d.name === 'fx-detail-luma-nr')!;
    const lc = DETAIL_STAGE.find((d) => d.name === 'fx-detail-luma-contrast')!;
    for (const [lum, con] of [[0, 0], [0, 50], [40, 0], [40, 60]]) {
      const p = createDefaultParams();
      p.noise.luminance = lum;
      p.noise.luminanceContrast = con;
      const stores = !nr.isIdentity!(p, ctx()) && nr.uniforms(p, ctx()).uLnrStoreLuma === 1;
      expect(stores).toBe(!lc.isIdentity!(p, ctx()));
    }
  });
});

describe('fx passes: retouch uniforms', () => {
  it('heal uniforms are padded, scaled to pixels and clamped', () => {
    const u = healUniforms([spot({ radius: 0.05, feather: 150, opacity: -5 }), spot({ kind: 'clone' }), spot({ kind: 'content-aware' })], ctx());
    expect(u.uSpotCount).toBe(3);
    expect((u.uSpotDst as Float32Array).length).toBe(MAX_SPOTS_PER_PASS * 2);
    expect((u.uSpotSrc as Float32Array).length).toBe(MAX_SPOTS_PER_PASS * 2);
    const shape = u.uSpotShape as Float32Array;
    expect(shape.length).toBe(MAX_SPOTS_PER_PASS * 4);
    expect(shape[0]).toBeCloseTo(0.05 * 1200, 4);
    expect(shape[1]).toBe(1);
    expect(shape[2]).toBe(0);
    expect([shape[3], shape[7], shape[11]]).toEqual([1, 0, 1]);
  });

  it('more than MAX_SPOTS_PER_PASS spots are truncated', () => {
    const many = Array.from({ length: MAX_SPOTS_PER_PASS + 5 }, (_, i) => spot({ id: String(i) }));
    expect(healUniforms(many, ctx()).uSpotCount).toBe(MAX_SPOTS_PER_PASS);
  });

  it('patch pass reads removals[extra.iteration]', () => {
    const p = extremeParams();
    expect(PATCH_COMPOSITE_PASS.isIdentity?.(p, ctx(), { iteration: 0 })).toBe(false);
    expect(PATCH_COMPOSITE_PASS.isIdentity?.(p, ctx(), { iteration: 1 })).toBe(true);
    expect(PATCH_COMPOSITE_PASS.uniforms(p, ctx(), { iteration: 0 }).uPatchRect).toEqual([0.1, 0.1, 0.2, 0.2]);
  });
});

describe('fx passes: geometry + effects', () => {
  it('overlay pass switches the shader mode; main pass bicubic only in full quality', () => {
    const p = createDefaultParams();
    expect(GEOMETRY_OVERLAY_PASS.uniforms(p, ctx()).uOverlayMode).toBe(1);
    expect(GEOMETRY_PASS.uniforms(p, ctx()).uOverlayMode).toBe(0);
    expect(GEOMETRY_PASS.uniforms(p, ctx()).uBicubic).toBe(1);
    expect(GEOMETRY_PASS.uniforms(p, ctx({ quality: 'draft' })).uBicubic).toBe(0);
  });

  it('grain gets coarser with grainSize and is defined relative to the output', () => {
    let prev = Infinity;
    for (let s = 0; s <= 100; s += 10) {
      const c = grainCellsAcrossLongEdge(s);
      expect(c).toBeLessThan(prev);
      prev = c;
    }
    const grain = EFFECTS_STAGE.find((e) => e.name === 'fx-grain')!;
    const p = createDefaultParams();
    p.effects.grainAmount = 40;
    // Same output aspect at preview and export resolution → identical grain lattice.
    const preview = grain.uniforms(p, ctx({ outWidth: 1200, outHeight: 800 })).uGrainCells;
    const exportU = grain.uniforms(p, ctx({ outWidth: 6000, outHeight: 4000, scale: 6000 / 2560 })).uGrainCells;
    expect(preview).toEqual(exportU);
  });
});
