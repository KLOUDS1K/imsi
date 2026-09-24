import { describe, expect, it } from 'vitest';
import { hueDelta } from '../../../src/editor/color/math';
import { createDefaultParams, createEmptyMeta, createMask } from '../../../src/editor/defaults';
import {
  BLUR_SIGMAS,
  COLOR_PASSES,
  DETAIL_SOURCE_PASS,
  DEVELOP_PASS,
  FRINGE_SOURCE_PASS,
  GUIDE_DISPLAY_PASS,
  GUIDE_LINEAR_PASS,
  HSL_BANDS,
  LOCAL_PASS,
  PRE_PASS,
  blacksCurve,
  buildDevelopCurveLut,
  calibrationMatrix,
  contrastCurve,
  curveLutKey,
  developNeeds,
  gradeSplit,
  gradeWeights,
  highlightsDelta,
  hslHueShift,
  hslWeights,
  isCurveIdentity,
  isMaskIdentity,
  localNeeds,
  shadowsDelta,
  tintDirection,
  toneL,
  toneY,
  whitesCurve,
} from '../../../src/editor/engine/color';
import { applyMat3 } from '../../../src/editor/engine/color/calibration';
import { glslFloat } from '../../../src/editor/engine/color/constants';
import { CONTRAST_PIVOT } from '../../../src/editor/engine/color/tone';
import type { PassContext, PassDef, UniformMap } from '../../../src/editor/engine/pass-types';
import type { EditParams } from '../../../src/editor/types';
import { HSL_CENTERS, HSL_CHANNELS } from '../../../src/editor/types';

function ctx(over: Partial<PassContext> = {}): PassContext {
  return {
    width: 2560,
    height: 1707,
    srcWidth: 2560,
    srcHeight: 1707,
    fullWidth: 6000,
    fullHeight: 4000,
    scale: 1,
    quality: 'full',
    isRaw: false,
    meta: createEmptyMeta(),
    lens: { profile: null, k1: 0, k2: 0, k3: 0, v1: 0, v2: 0, v3: 0, caRed: 1, caBlue: 1 },
    ignoreCrop: false,
    outRect: { x: 0, y: 0, w: 1, h: 1 },
    outWidth: 2560,
    outHeight: 1707,
    ...over,
  };
}

const BUILTINS = new Set(['uResolution', 'uTexel', 'uInputTexel', 'uScale']);

function declaredUniforms(src: string): { samplers: string[]; values: string[] } {
  const samplers: string[] = [];
  const values: string[] = [];
  for (const m of src.matchAll(/^\s*uniform\s+(\w+)\s+(\w+)\s*;/gm)) (m[1].startsWith('sampler') ? samplers : values).push(m[2]);
  return { samplers, values };
}

function sigmaOf(pass: PassDef, uniform: string, p: EditParams): number {
  const req = pass.blurs!.find((b) => b.uniform === uniform)!;
  return typeof req.sigma === 'function' ? req.sigma(p, ctx()) : req.sigma;
}

describe('shader contracts', () => {
  const passes: [PassDef, UniformMap][] = [
    [PRE_PASS, PRE_PASS.uniforms(createDefaultParams(), ctx())],
    [DEVELOP_PASS, DEVELOP_PASS.uniforms(createDefaultParams(), ctx())],
    [LOCAL_PASS, LOCAL_PASS.uniforms(createDefaultParams(), ctx(), { mask: createMask('m', 'm') })],
    [GUIDE_LINEAR_PASS, {}],
    [GUIDE_DISPLAY_PASS, {}],
    [FRINGE_SOURCE_PASS, {}],
    [DETAIL_SOURCE_PASS, {}],
  ];

  it.each(passes.map(([p, u]) => [p.name, p, u] as const))('%s: header, samplers and uniforms agree', (_n, pass, uniforms) => {
    expect(pass.fragment.startsWith('#version 300 es\n')).toBe(true);
    expect(pass.fragment).toContain('precision highp float;');
    expect(pass.fragment).toContain('in vec2 vUv;');
    expect(pass.fragment).toContain('out vec4 outColor;');
    const { samplers, values } = declaredUniforms(pass.fragment);
    const expectedSamplers = [...pass.inputs, ...(pass.blurs ?? []).map((b) => b.uniform)];
    expect(new Set(samplers)).toEqual(new Set(expectedSamplers));
    // Every declared value uniform is provided every frame (the orchestrator keeps stale values otherwise).
    for (const v of values) if (!BUILTINS.has(v)) expect(Object.keys(uniforms), `${pass.name} provides ${v}`).toContain(v);
    // …and nothing is returned that the shader does not declare (typos).
    for (const k of Object.keys(uniforms)) expect(values, `${pass.name} declares ${k}`).toContain(k);
  });

  it('unique pass names and prepass names', () => {
    const names = [...COLOR_PASSES.map((p) => p.name), GUIDE_LINEAR_PASS.name, GUIDE_DISPLAY_PASS.name, FRINGE_SOURCE_PASS.name, DETAIL_SOURCE_PASS.name];
    expect(new Set(names).size).toBe(names.length);
  });

  it('glslFloat always yields a float literal', () => {
    expect(glslFloat(2)).toMatch(/\./);
    expect(glslFloat(-0.5)).toBe('-0.500000000');
    expect(glslFloat(1e-12)).toMatch(/e-12$/);
    expect(() => glslFloat(Number.NaN)).toThrow();
  });
});

describe('identity reporting', () => {
  it('PRE is identity at defaults and not otherwise', () => {
    const p = createDefaultParams();
    expect(PRE_PASS.isIdentity!(p, ctx())).toBe(true);
    expect(PRE_PASS.isIdentity!(p, ctx({ lens: { ...ctx().lens, v1: -0.2 } }))).toBe(false);
    for (const mut of [
      (q: EditParams) => (q.basic.exposure = 0.1),
      (q: EditParams) => (q.whiteBalance.temperature = 5),
      (q: EditParams) => (q.whiteBalance.tint = -5),
      (q: EditParams) => (q.calibration.blueHue = 1),
      (q: EditParams) => (q.calibration.shadowsTint = 1),
      (q: EditParams) => (q.lens.vignetting = 10),
    ]) {
      const q = createDefaultParams();
      mut(q);
      expect(PRE_PASS.isIdentity!(q, ctx())).toBe(false);
    }
  });

  it('DEVELOP always runs (it encodes) but switches every stage off at defaults', () => {
    const p = createDefaultParams(true);
    expect(DEVELOP_PASS.isIdentity!(p, ctx())).toBe(false);
    const u = DEVELOP_PASS.uniforms(p, ctx());
    for (const flag of ['uDefringeOn', 'uToneOn', 'uCurveOn', 'uHslOn', 'uGradeOn']) expect(u[flag], flag).toBe(false);
    expect(u.uVibSat).toEqual([0, 0]);
    expect(u.uGlobalTone).toEqual([0, 0, 0]);
  });

  it('LOCAL is identity for missing / hidden / zero-amount / neutral masks', () => {
    const p = createDefaultParams();
    const m = createMask('m', 'm');
    expect(LOCAL_PASS.isIdentity!(p, ctx(), {})).toBe(true);
    expect(LOCAL_PASS.isIdentity!(p, ctx(), { mask: m })).toBe(true);
    m.adjustments.clarity = 20;
    expect(LOCAL_PASS.isIdentity!(p, ctx(), { mask: m })).toBe(false);
    expect(isMaskIdentity({ ...m, visible: false })).toBe(true);
    expect(isMaskIdentity({ ...m, amount: 0 })).toBe(true);
    const u = LOCAL_PASS.uniforms(p, ctx(), { mask: { ...m, amount: 50 } });
    expect(u.uLocalOn).toBe(true);
    expect(u.uAmount).toBe(0.5);
    expect((u.uLocPresence as number[])[1]).toBeCloseTo(0.2);
  });
});

describe('blur requests', () => {
  it('collapse to the tiny shared sigma when nothing reads them', () => {
    const p = createDefaultParams();
    for (const b of DEVELOP_PASS.blurs!) expect(sigmaOf(DEVELOP_PASS, b.uniform, p)).toBe(BLUR_SIGMAS.collapsed);
    for (const b of LOCAL_PASS.blurs!) expect(sigmaOf(LOCAL_PASS, b.uniform, p)).toBe(BLUR_SIGMAS.collapsed);
  });

  it('request the documented radii when needed', () => {
    const p = createDefaultParams();
    p.basic.shadows = 30;
    expect(developNeeds(p)).toEqual({ small: true, medium: true, large: true, fringe: false });
    expect(sigmaOf(DEVELOP_PASS, 'uGuideS', p)).toBe(BLUR_SIGMAS.small);
    expect(sigmaOf(DEVELOP_PASS, 'uGuideM', p)).toBe(BLUR_SIGMAS.medium);
    expect(sigmaOf(DEVELOP_PASS, 'uGuideL', p)).toBe(BLUR_SIGMAS.large);
    expect(sigmaOf(DEVELOP_PASS, 'uFringeBlur', p)).toBe(BLUR_SIGMAS.collapsed);
    const q = createDefaultParams();
    q.lens.defringe.purpleAmount = 5;
    expect(developNeeds(q)).toEqual({ small: true, medium: false, large: false, fringe: true });
    expect(sigmaOf(DEVELOP_PASS, 'uFringeBlur', q)).toBe(BLUR_SIGMAS.fringe);
  });

  it('LOCAL blurs follow the visible masks', () => {
    const p = createDefaultParams();
    const m = createMask('m', 'm');
    m.adjustments.sharpness = 40;
    p.masks = [m];
    expect(localNeeds(p)).toEqual({ small: true, medium: false, large: false, detail: true });
    m.visible = false;
    expect(localNeeds(p).detail).toBe(false);
  });

  it('every blur has a uniquely named prepass (blur sharing key)', () => {
    const all = [...DEVELOP_PASS.blurs!, ...LOCAL_PASS.blurs!];
    expect(all.every((b) => b.prepass)).toBe(true);
    const pre = new Set(all.map((b) => b.prepass!.name));
    expect(pre).toEqual(new Set([GUIDE_LINEAR_PASS.name, GUIDE_DISPLAY_PASS.name, FRINGE_SOURCE_PASS.name, DETAIL_SOURCE_PASS.name]));
    expect(new Set(DEVELOP_PASS.blurs!.map((b) => b.prepass!.name))).not.toContain(GUIDE_DISPLAY_PASS.name);
  });
});

describe('tone math', () => {
  it('toneL / toneY invert each other and centre on middle grey', () => {
    expect(toneL(0.18)).toBeCloseTo(0, 9);
    for (const y of [0, 1e-4, 0.01, 0.18, 1, 4]) expect(toneY(toneL(y))).toBeCloseTo(y, 9);
  });

  it('whites / blacks / contrast are identity at 0 and monotone for every amount', () => {
    for (let i = 0; i <= 150; i++) {
      const p = i / 100;
      expect(whitesCurve(p, 0)).toBe(p);
      expect(blacksCurve(p, 0)).toBe(p);
      expect(contrastCurve(p, 0)).toBe(p);
    }
    for (const a of [-1, -0.5, -0.1, 0.1, 0.5, 1]) {
      let pw = -Infinity;
      let pb = -Infinity;
      let pc = -Infinity;
      for (let i = 0; i <= 1500; i++) {
        const p = i / 1000;
        const w = whitesCurve(p, a);
        const b = blacksCurve(p, a);
        const c = contrastCurve(p, a);
        expect(w).toBeGreaterThanOrEqual(pw);
        expect(b).toBeGreaterThanOrEqual(pb);
        expect(c).toBeGreaterThanOrEqual(pc);
        pw = w;
        pb = b;
        pc = c;
      }
      // Contrast pins black, middle grey and white.
      expect(contrastCurve(0, a)).toBe(0);
      expect(contrastCurve(CONTRAST_PIVOT, a)).toBeCloseTo(CONTRAST_PIVOT, 9);
      expect(contrastCurve(1, a)).toBe(1);
      // Blacks never produce negative values.
      expect(blacksCurve(0, a)).toBeGreaterThanOrEqual(0);
    }
  });

  it('highlights / shadows keep the base mapping monotone (no tone reversal)', () => {
    for (const a of [-1, -0.5, 0.5, 1]) {
      let prevS = -Infinity;
      let prevH = -Infinity;
      for (let x = -8; x <= 6; x += 0.01) {
        const s = x + shadowsDelta(x, a);
        const h = x + highlightsDelta(x, a);
        expect(s).toBeGreaterThan(prevS);
        expect(h).toBeGreaterThan(prevH);
        prevS = s;
        prevH = h;
      }
    }
  });

  it('shadows act below middle grey, highlights above it', () => {
    expect(shadowsDelta(-3.5, 1)).toBeGreaterThan(1.5);
    expect(Math.abs(shadowsDelta(1.5, 1))).toBeLessThan(1e-9);
    expect(highlightsDelta(2, -1)).toBeLessThan(-0.5);
    expect(Math.abs(highlightsDelta(-1.5, -1))).toBeLessThan(1e-9);
    // Recovery compresses super-whites harder (−100 on +3 EV above white).
    expect(highlightsDelta(5.5, -1)).toBeLessThan(-2);
  });
});

describe('HSL bands', () => {
  it('uses the shared centres', () => {
    expect(HSL_BANDS.map((b) => b.centre)).toEqual(HSL_CHANNELS.map((c) => HSL_CENTERS[c]));
    for (const b of HSL_BANDS) {
      expect(b.gapPrev).toBeGreaterThan(0);
      expect(b.gapNext).toBeGreaterThan(0);
    }
  });

  it('weights are a smooth partition of unity, 1 at the centre, 0 at the neighbours', () => {
    const w = new Float32Array(8);
    let prev = hslWeights(0);
    for (let h = 0; h < 360; h += 0.25) {
      hslWeights(h, w);
      expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
      for (let i = 0; i < 8; i++) expect(Math.abs(w[i] - prev[i])).toBeLessThan(0.05);
      prev = Float32Array.from(w);
    }
    HSL_BANDS.forEach((b, i) => {
      hslWeights(b.centre, w);
      expect(w[i]).toBe(1);
      hslWeights(b.centre + b.gapNext, w);
      expect(w[i]).toBe(0);
    });
  });

  it('hue sliders shift towards the neighbours, at most 30° and never past them', () => {
    const red = HSL_BANDS[0];
    expect(hslHueShift(red, 100)).toBe(30);
    expect(hslHueShift(red, -100)).toBe(-30);
    for (const b of HSL_BANDS) {
      expect(hslHueShift(b, 100)).toBeLessThanOrEqual(b.gapNext);
      expect(-hslHueShift(b, -100)).toBeLessThanOrEqual(b.gapPrev);
    }
    const u = DEVELOP_PASS.uniforms({ ...createDefaultParams(), hsl: { ...createDefaultParams().hsl, blue: { hue: 50, saturation: -100, luminance: 20 } } }, ctx());
    expect(u.uHslOn).toBe(true);
    expect((u.uHslHueB as number[])[1]).toBe(15);
    expect((u.uHslSatB as number[])[1]).toBe(-1);
  });
});

describe('calibration', () => {
  it('is the identity matrix at defaults and always preserves white', () => {
    const p = createDefaultParams();
    calibrationMatrix(p.calibration).forEach((v, i) => expect(v).toBeCloseTo([1, 0, 0, 0, 1, 0, 0, 0, 1][i], 12));
    const cal = { shadowsTint: 0, redHue: 80, redSaturation: -60, greenHue: -40, greenSaturation: 100, blueHue: 100, blueSaturation: -100 };
    const m = calibrationMatrix(cal);
    applyMat3(m, [1, 1, 1]).forEach((v) => expect(v).toBeCloseTo(1, 9));
    applyMat3(m, [0.2, 0.2, 0.2]).forEach((v) => expect(v).toBeCloseTo(0.2, 9));
  });

  it('red hue + moves red towards yellow, saturation − makes it duller', () => {
    const base = createDefaultParams().calibration;
    const [, g] = applyMat3(calibrationMatrix({ ...base, redHue: 100 }), [1, 0, 0]);
    const [, g0] = applyMat3(calibrationMatrix({ ...base, redHue: -100 }), [1, 0, 0]);
    expect(g).toBeGreaterThan(g0);
    const dull = applyMat3(calibrationMatrix({ ...base, redSaturation: -100 }), [1, 0, 0]);
    expect(Math.max(...dull) - Math.min(...dull)).toBeLessThan(1);
  });
});

describe('color grading', () => {
  it('region weights sum to 1 for every blending / balance', () => {
    for (const blending of [0, 25, 50, 100])
      for (const balance of [-100, 0, 100]) {
        const s = gradeSplit({ blending, balance });
        for (let y = 0; y <= 1; y += 0.01) {
          const w = gradeWeights(y, s);
          expect(w[0] + w[1] + w[2]).toBeCloseTo(1, 9);
          w.forEach((v) => expect(v).toBeGreaterThanOrEqual(0));
        }
      }
  });

  it('balance favours the highlights wheel when positive', () => {
    const wPos = gradeWeights(0.5, gradeSplit({ blending: 50, balance: 100 }));
    const wNeg = gradeWeights(0.5, gradeSplit({ blending: 50, balance: -100 }));
    expect(wPos[2]).toBeGreaterThan(wNeg[2]);
    expect(wNeg[0]).toBeGreaterThan(wPos[0]);
  });

  it('tint directions are luminance-neutral and point at the hue', () => {
    for (let h = 0; h < 360; h += 15) {
      const [r, g, b] = tintDirection(h);
      expect(0.2126 * r + 0.7152 * g + 0.0722 * b).toBeCloseTo(0, 9);
      const hue = (Math.atan2(Math.sqrt(3) * (g - b), 2 * r - g - b) * 180) / Math.PI;
      expect(Math.abs(hueDelta(h, (hue + 360) % 360))).toBeLessThan(8);
    }
  });
});

describe('curve LUT helpers', () => {
  it('key changes with any curve change and identity is detected', () => {
    const a = createDefaultParams();
    const b = createDefaultParams();
    expect(curveLutKey(a)).toBe(curveLutKey(b));
    expect(isCurveIdentity(a)).toBe(true);
    b.toneCurve.red = [{ x: 0, y: 0 }, { x: 0.5, y: 0.55 }, { x: 1, y: 1 }];
    expect(curveLutKey(b)).not.toBe(curveLutKey(a));
    expect(isCurveIdentity(b)).toBe(false);
    const c = createDefaultParams();
    c.toneCurve.parametric.darks = 10;
    expect(curveLutKey(c)).not.toBe(curveLutKey(a));
    expect(DEVELOP_PASS.uniforms(c, ctx()).uCurveOn).toBe(true);
  });

  it('LUT is 1024 RGBA texels, identity at defaults', () => {
    const lut = buildDevelopCurveLut(createDefaultParams());
    expect(lut.length).toBe(1024 * 4);
    for (let i = 0; i < 1024; i++) expect(lut[i * 4 + 3]).toBeCloseTo(i / 1023, 5);
  });
});
