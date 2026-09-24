import { describe, expect, it } from 'vitest';
import {
  applyPartial,
  cloneParams,
  diffPaths,
  getPath,
  GROUP_PATHS,
  groupsForPath,
  isDefaultParams,
  labelForPath,
  lerpParams,
  modifiedGroups,
  normalizeParams,
  pickGroups,
  sanitizePartial,
  setIn,
  setPath,
  stateModule,
} from '@/editor/state';
import { createDefaultParams, createMask, PARAM_SPECS } from '@/editor/defaults';
import { HSL_CHANNELS, SETTINGS_GROUPS, type EditParams, type PartialParams, type SettingsGroup } from '@/editor/types';

/** Params with a non-default value in every group. */
function edited(): EditParams {
  const p = createDefaultParams();
  p.basic.exposure = 0.7;
  p.basic.contrast = 15;
  p.whiteBalance = { mode: 'custom', temperature: 12, tint: -4 };
  p.color.vibrance = 20;
  p.hsl.blue.luminance = -20;
  p.toneCurve.rgb = [{ x: 0, y: 0.1 }, { x: 0.5, y: 0.55 }, { x: 1, y: 0.95 }];
  p.colorGrading.shadows = { hue: 200, saturation: 25, luminance: -5 };
  p.calibration.blueSaturation = 10;
  p.presence.clarity = 18;
  p.detail.sharpenAmount = 50;
  p.noise.luminance = 20;
  p.lens.profileEnabled = true;
  p.transform.vertical = 12;
  p.crop = { ...p.crop, x: 0.1, y: 0.1, w: 0.8, h: 0.7, angle: 1.5 };
  p.effects.vignetteAmount = -20;
  p.masks.push(createMask('Mask 1', 'm1'));
  p.retouch.spots.push({ id: 's1', kind: 'heal', x: 0.5, y: 0.5, sx: 0.4, sy: 0.4, radius: 0.02, feather: 50, opacity: 100 });
  return p;
}

describe('module conformance', () => {
  it('exports the contract', () => {
    expect(typeof stateModule.EditorStore).toBe('function');
    expect(Object.keys(stateModule)).toHaveLength(17);
  });
});

describe('paths', () => {
  it('getPath / setPath handle array indices', () => {
    const p = createDefaultParams();
    p.masks.push(createMask('Mask 1', 'm1'));
    expect(getPath(p, 'masks.0.adjustments.exposure')).toBe(0);
    expect(getPath(p, 'masks.3.name')).toBeUndefined();
    expect(getPath(p, 'basic.nope.deeper')).toBeUndefined();
    setPath(p, 'masks.0.adjustments.exposure', 1.2);
    expect(p.masks[0].adjustments.exposure).toBe(1.2);
    const o = setPath({} as Record<string, unknown>, 'a.0.b', 5);
    expect(o).toEqual({ a: [{ b: 5 }] });
  });

  it('setIn is copy-on-write', () => {
    const p = createDefaultParams();
    const q = setIn(p, 'hsl.red.hue', 10)!;
    expect(p.hsl.red.hue).toBe(0);
    expect(q.hsl.red.hue).toBe(10);
    expect(q.hsl.orange).toBe(p.hsl.orange);
    expect(q.basic).toBe(p.basic);
    expect(setIn(p, 'masks.2.name', 'x')).toBeUndefined();
  });
});

describe('GROUP_PATHS', () => {
  it('covers every settings group and every top-level key of EditParams', () => {
    for (const g of SETTINGS_GROUPS) expect(GROUP_PATHS[g].length).toBeGreaterThan(0);
    const covered = new Set(SETTINGS_GROUPS.flatMap((g) => GROUP_PATHS[g].map((p) => p.split('.')[0])));
    for (const k of Object.keys(createDefaultParams())) if (k !== 'version') expect(covered.has(k)).toBe(true);
    expect(GROUP_PATHS.exposure).toEqual(['basic.exposure']);
    expect(GROUP_PATHS.tone).not.toContain('basic.exposure');
  });

  it('groupsForPath', () => {
    expect(groupsForPath('basic.exposure')).toEqual(['exposure']);
    expect(groupsForPath('basic.blacks')).toEqual(['tone']);
    expect(groupsForPath('basic')).toEqual(['exposure', 'tone']);
    expect(groupsForPath('crop.orientation')).toEqual(['crop']);
    expect(groupsForPath('masks.0.adjustments.exposure')).toEqual(['masks']);
  });
});

describe('normalizeParams', () => {
  it('returns defaults for non-objects', () => {
    for (const v of [null, undefined, 42, 'abc', [], true]) expect(normalizeParams(v)).toEqual(createDefaultParams());
    expect(normalizeParams(null, true)).toEqual(createDefaultParams(true));
  });

  it('is idempotent and leaves valid params unchanged', () => {
    const p = edited();
    expect(normalizeParams(p)).toEqual(p);
    const garbage = { basic: { exposure: 99 }, toneCurve: { rgb: [{ x: 2, y: -1 }, { x: 0.5, y: 0.5 }] }, crop: { x: 0.9, w: 0.5 } };
    const once = normalizeParams(garbage);
    expect(normalizeParams(once)).toEqual(once);
  });

  it('clamps, fixes types, drops unknown keys', () => {
    const p = normalizeParams({
      version: 1,
      basic: { exposure: 12, contrast: -500, highlights: '25', shadows: NaN, whites: Infinity, blacks: null, bogus: 3 },
      whiteBalance: { mode: 'weird', temperature: 101 },
      hsl: { red: { hue: 300 }, pink: { hue: 1 } },
      colorGrading: { shadows: { hue: 725, saturation: 150, luminance: -300 } },
      toneCurve: { rgb: [{ x: 1, y: 1 }, { x: 0.5, y: 2 }, { x: 0, y: 0 }, 'x', { x: 0.50001, y: 0.1 }], red: 'nope', parametric: { split1: 80, split2: 20, split3: 50 } },
      crop: { x: 0.9, y: -1, w: 0.5, h: 3, orientation: 450, aspect: '7:3', customAspect: [0, 2], flipH: 'yes' },
      transform: { upright: 'guided', scale: 1000 },
      lens: { profileId: 42, defringe: { purpleHueMin: 350, purpleHueMax: 300 } },
      extra: { a: 1 },
    });
    expect(p.basic).toEqual({ exposure: 5, contrast: -100, highlights: 25, shadows: 0, whites: 0, blacks: 0 });
    expect(p.whiteBalance).toEqual({ mode: 'as-shot', temperature: 100, tint: 0 });
    expect(p.hsl.red.hue).toBe(100);
    expect((p.hsl as Record<string, unknown>).pink).toBeUndefined();
    expect(p.colorGrading.shadows).toEqual({ hue: 5, saturation: 100, luminance: -100 });
    expect(p.toneCurve.rgb).toEqual([{ x: 0, y: 0 }, { x: 0.5, y: 1 }, { x: 1, y: 1 }]);
    expect(p.toneCurve.red).toEqual([{ x: 0, y: 0 }, { x: 1, y: 1 }]);
    expect([p.toneCurve.parametric.split1, p.toneCurve.parametric.split2, p.toneCurve.parametric.split3]).toEqual([20, 50, 80]);
    expect(p.crop.orientation).toBe(90);
    expect(p.crop.aspect).toBe('original');
    expect(p.crop.customAspect).toEqual([5, 7]);
    expect(p.crop.flipH).toBe(false);
    expect(p.crop.x + p.crop.w).toBeLessThanOrEqual(1);
    expect(p.crop.h).toBe(1);
    expect(p.crop.y).toBe(0);
    expect(p.transform.upright).toBe('off');
    expect(p.transform.scale).toBe(150);
    expect(p.lens.profileId).toBeNull();
    expect(p.lens.defringe.purpleHueMin).toBeLessThanOrEqual(p.lens.defringe.purpleHueMax);
    expect((p as unknown as Record<string, unknown>).extra).toBeUndefined();
  });

  it('sanitizes masks and retouch', () => {
    const p = normalizeParams({
      version: 1,
      masks: [
        null,
        { id: 'a', name: '', amount: 300, adjustments: { exposure: 9, bogus: 1 }, components: [{ kind: 'laser' }, { kind: 'radial', radial: { rx: -1 } }, { kind: 'brush', brush: { strokes: [{ points: [] }, { points: [{ x: 0.1, y: 'q' }, { x: 0.2, y: 0.3, pressure: 4 }], size: 9 }] } }] },
        { id: 'a', components: 'x' },
      ],
      retouch: { spots: [{ x: 2, y: 0.5, kind: 'zap' }, { y: 1 }], removals: [{ bbox: { x: 0, y: 0, w: 1, h: 1 } }, { patchKey: 'k', bbox: { x: 0.2, y: 0.2, w: 2, h: 0.1 } }] },
    });
    expect(p.masks).toHaveLength(2);
    const [m1, m2] = p.masks;
    expect(m1.name).toBe('Mask 1');
    expect(m1.amount).toBe(100);
    expect(m1.adjustments.exposure).toBe(4);
    expect(m1.components.map((c) => c.kind)).toEqual(['radial', 'brush']);
    expect(m1.components[0].radial!.rx).toBe(0.001);
    expect(m1.components[1].brush!.strokes).toHaveLength(1);
    expect(m1.components[1].brush!.strokes[0]).toEqual({ points: [{ x: 0.2, y: 0.3, pressure: 1 }], size: 1, feather: 50, flow: 100, density: 100, erase: false });
    expect(m2.id).not.toBe(m1.id);
    expect(m2.components).toEqual([]);
    expect(p.retouch.spots).toHaveLength(1);
    expect(p.retouch.spots[0]).toMatchObject({ x: 1, kind: 'heal', sx: 1 });
    expect(p.retouch.removals).toHaveLength(1);
    expect(p.retouch.removals[0].bbox.x + p.retouch.removals[0].bbox.w).toBeLessThanOrEqual(1);
  });

  it('migrates flat version-0 layouts', () => {
    const p = normalizeParams({ exposure: 1.5, temperature: 20, clarity: 30, basic: { vibrance: 10 }, toneCurve: [[0, 0.1], [1, 0.9]], hsl: [{ hue: 5 }], crop: { left: 0.1, top: 0.2, right: 0.9, bottom: 1 } });
    expect(p.basic.exposure).toBe(1.5);
    expect(p.whiteBalance.temperature).toBe(20);
    expect(p.presence.clarity).toBe(30);
    expect(p.color.vibrance).toBe(10);
    expect(p.toneCurve.rgb).toEqual([{ x: 0, y: 0.1 }, { x: 1, y: 0.9 }]);
    expect(p.hsl.red.hue).toBe(5);
    expect(p.crop).toMatchObject({ x: 0.1, y: 0.2 });
    expect(p.crop.w).toBeCloseTo(0.8);
    expect(p.crop.h).toBeCloseTo(0.8);
  });
});

describe('pickGroups / applyPartial', () => {
  it('pickGroups returns only the chosen groups', () => {
    const p = edited();
    expect(pickGroups(p, ['exposure'])).toEqual({ basic: { exposure: 0.7 } });
    const tone = pickGroups(p, ['tone']) as { basic: Record<string, number> };
    expect(Object.keys(tone)).toEqual(['basic']);
    expect(tone.basic.exposure).toBeUndefined();
    expect(tone.basic.contrast).toBe(15);
    const crop = pickGroups(p, ['crop']);
    expect(crop).toEqual({ crop: p.crop });
    expect(crop.crop).not.toBe(p.crop);
  });

  it.each(SETTINGS_GROUPS.map((g) => [g]))('applies only group %s', (g) => {
    const src = edited();
    const base = createDefaultParams();
    const out = applyPartial(base, pickGroups(src, SETTINGS_GROUPS as unknown as SettingsGroup[]), [g as SettingsGroup]);
    expect(modifiedGroups(out)).toEqual([g]);
    for (const path of GROUP_PATHS[g as SettingsGroup]) expect(getPath(out, path)).toEqual(getPath(src, path));
    expect(base).toEqual(createDefaultParams());
  });

  it('deep merges sparse partials and replaces arrays', () => {
    const base = edited();
    const out = applyPartial(base, { hsl: { red: { hue: 12 } }, toneCurve: { rgb: [{ x: 0, y: 0 }, { x: 1, y: 0.8 }] } });
    expect(out.hsl.red).toEqual({ hue: 12, saturation: 0, luminance: 0 });
    expect(out.hsl.blue.luminance).toBe(-20);
    expect(out.toneCurve.rgb).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0.8 }]);
    expect(out.basic).toEqual(base.basic);
    expect(out.basic).not.toBe(base.basic);
  });

  it('sanitizes untrusted partials', () => {
    const out = applyPartial(createDefaultParams(), { basic: { exposure: 99, contrast: 'x' }, crop: 5, nonsense: { a: 1 } } as unknown as PartialParams);
    expect(out.basic.exposure).toBe(5);
    expect(out.basic.contrast).toBe(0);
    expect(out.crop).toEqual(createDefaultParams().crop);
    expect(sanitizePartial({ basic: { contrast: 'x', whites: 12 }, crop: 5 })).toEqual({ basic: { whites: 12 } });
  });
});

describe('lerpParams', () => {
  const a = createDefaultParams();
  const b = edited();
  b.basic.contrast = 80;
  b.crop.flipH = true;
  b.colorGrading.highlights = { hue: 40, saturation: 30, luminance: 10 };

  it('t = 0 and t = 1 return the endpoints', () => {
    expect(lerpParams(a, b, 0)).toEqual(a);
    expect(lerpParams(a, b, 1)).toEqual(b);
  });

  it('t = 0.5 interpolates numbers, curves and wheels; switches enums at 0.5', () => {
    const m = lerpParams(a, b, 0.5);
    expect(m.basic.exposure).toBeCloseTo(0.35);
    expect(m.basic.contrast).toBeCloseTo(40);
    expect(m.whiteBalance.temperature).toBeCloseTo(6);
    expect(m.crop.flipH).toBe(true);
    expect(m.whiteBalance.mode).toBe('custom');
    const mid = m.toneCurve.rgb.find((p) => Math.abs(p.x - 0.5) < 1e-6)!;
    expect(mid.y).toBeCloseTo(0.525);
    expect(m.toneCurve.rgb[0].y).toBeCloseTo(0.05);
    expect(m.colorGrading.highlights.hue).toBeCloseTo(40);
    expect(m.colorGrading.highlights.saturation).toBeCloseTo(15);
    expect(m.colorGrading.highlights.luminance).toBeCloseTo(5);
    expect(m.masks.map((x) => x.id)).toEqual(['m1']);
    expect(m.retouch).toEqual(b.retouch);
    expect(lerpParams(a, b, 0.49).crop.flipH).toBe(false);
  });

  it('t = 2 extrapolates with clamping', () => {
    const m = lerpParams(a, b, 2);
    expect(m.basic.exposure).toBeCloseTo(1.4);
    expect(m.basic.contrast).toBe(100);
    expect(m.presence.clarity).toBeCloseTo(36);
    expect(m.effects.vignetteAmount).toBeCloseTo(-40);
    expect(m.colorGrading.highlights.saturation).toBeCloseTo(60);
    expect(m.toneCurve.rgb[0].y).toBeCloseTo(0.2);
    for (const pt of m.toneCurve.rgb) expect(pt.y).toBeLessThanOrEqual(1);
    expect(m.crop.x + m.crop.w).toBeLessThanOrEqual(1 + 1e-9);
    expect(lerpParams(a, b, 5)).toEqual(m);
  });

  it('interpolates wheel hue through the colour plane, not around it', () => {
    const x = createDefaultParams();
    const y = createDefaultParams();
    x.colorGrading.shadows = { hue: 350, saturation: 40, luminance: 0 };
    y.colorGrading.shadows = { hue: 10, saturation: 40, luminance: 0 };
    const m = lerpParams(x, y, 0.5).colorGrading.shadows;
    expect(m.hue).toBeCloseTo(0, 6);
    expect(m.saturation).toBeCloseTo(40 * Math.cos((10 * Math.PI) / 180), 6);
  });

  it('fades new masks in from neutral and lerps shared masks', () => {
    const x = createDefaultParams();
    const y = createDefaultParams();
    const shared = createMask('Sky', 'sky');
    shared.adjustments.exposure = -1;
    x.masks.push(structuredClone(shared));
    const ys = structuredClone(shared);
    ys.adjustments.exposure = -2;
    const fresh = createMask('Subject', 'subj');
    fresh.adjustments.exposure = 0.8;
    y.masks.push(ys, fresh);
    const m = lerpParams(x, y, 0.5);
    expect(m.masks.map((q) => q.adjustments.exposure)).toEqual([-1.5, 0.4]);
  });
});

describe('diff / defaults / modified groups', () => {
  it('diffPaths lists leaf changes', () => {
    const x = createDefaultParams();
    const y = cloneParams(x);
    y.basic.exposure = 1;
    y.hsl.aqua.saturation = 5;
    y.masks.push(createMask('M', 'm'));
    expect(diffPaths(x, y).sort()).toEqual(['basic.exposure', 'hsl.aqua.saturation', 'masks']);
    expect(diffPaths(x, cloneParams(x))).toEqual([]);
  });

  it('isDefaultParams / modifiedGroups ignore cosmetic crop-tool settings', () => {
    const p = createDefaultParams();
    expect(isDefaultParams(p)).toBe(true);
    p.crop.overlay = 'grid';
    p.crop.aspect = '16:9';
    expect(isDefaultParams(p)).toBe(true);
    expect(isDefaultParams(createDefaultParams(true), true)).toBe(true);
    expect(isDefaultParams(createDefaultParams(true), false)).toBe(false);
    expect(modifiedGroups(edited())).toEqual([...SETTINGS_GROUPS]);
  });
});

describe('labelForPath', () => {
  it('labels every slider path and common nested paths', () => {
    for (const path of Object.keys(PARAM_SPECS)) {
      const label = labelForPath(path);
      expect(label.length).toBeGreaterThan(1);
      expect(label).not.toMatch(/undefined/);
    }
    expect(labelForPath('basic.exposure')).toBe('Exposure');
    expect(labelForPath('whiteBalance.temperature')).toBe('Temp');
    expect(labelForPath('hsl.orange.luminance')).toBe('Orange Luminance');
    expect(labelForPath('colorGrading.midtones.hue')).toBe('Color Grade Midtones Hue');
    expect(labelForPath('toneCurve.rgb.2.y')).toBe('Tone Curve');
    expect(labelForPath('toneCurve.blue')).toBe('Tone Curve (Blue)');
    expect(labelForPath('crop.x')).toBe('Crop');
    expect(labelForPath('crop.angle')).toBe('Straighten');
    expect(labelForPath('masks.0.adjustments.exposure')).toBe('Mask 1: Exposure');
    expect(labelForPath('masks.1.components.0.brush.strokes')).toBe('Mask 2: Brush');
    expect(labelForPath('masks.0.name')).toBe('Mask 1: Rename');
    expect(labelForPath('retouch.spots.3.x')).toBe('Spot Removal');
    expect(labelForPath('lens.defringe.purpleAmount')).toBe('Purple Amount');
    for (const ch of HSL_CHANNELS) expect(labelForPath(`hsl.${ch}.hue`)).toMatch(/Hue$/);
  });
});
