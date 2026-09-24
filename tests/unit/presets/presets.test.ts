import { describe, expect, it } from 'vitest';
import {
  applyPreset,
  BUILTIN_PRESETS,
  createPreset,
  exportPresets,
  importPresetFile,
  matchConditionalPresets,
  parsePresetText,
  presetLabel,
  presetsModule,
  presetToXmp,
} from '@/editor/presets';
import { applyPartial, diffPaths, groupsForPath, groupsFromPartial, modifiedGroups, sanitizePartial } from '@/editor/state';
import { createDefaultParams, createEmptyMeta, createMask } from '@/editor/defaults';
import { SETTINGS_GROUPS, type EditParams, type PhotoMeta, type Preset } from '@/editor/types';

const byId = (id: string) => BUILTIN_PRESETS.find((p) => p.id === id)!;

function current(): EditParams {
  const p = createDefaultParams(true);
  p.basic.exposure = 0.4;
  p.basic.contrast = 20;
  p.hsl.orange.saturation = 10;
  p.effects.vignetteAmount = -30;
  p.masks.push(createMask('Sky', 'sky'));
  return p;
}

function meta(over: Partial<PhotoMeta>): PhotoMeta {
  return { ...createEmptyMeta('a.arw'), ...over };
}

describe('BUILTIN_PRESETS', () => {
  it('is a curated set with stable unique ids and the required members', () => {
    expect(presetsModule.BUILTIN_PRESETS).toBe(BUILTIN_PRESETS);
    expect(BUILTIN_PRESETS.length).toBeGreaterThanOrEqual(18);
    const ids = BUILTIN_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^kloud\.[a-z0-9-]+$/);
    const names = BUILTIN_PRESETS.map((p) => p.name);
    for (const n of ['KLOUD Clean', 'KLOUD Night Drive', 'KLOUD Matte', 'KLOUD Film Warm', 'KLOUD Cool Street', 'KLOUD Soft Portrait', 'KLOUD Punch', 'KLOUD Golden Hour', 'KLOUD Mono', 'Mono High Contrast', 'Mono Soft Matte', 'Teal & Orange', 'Pastel Fade', 'Faded Film', 'Deep Blue', 'Landscape Sharpen', 'High ISO Clean', 'Enable Lens Corrections'])
      expect(names).toContain(n);
    expect(new Set(BUILTIN_PRESETS.map((p) => p.group))).toEqual(new Set(['KLOUD Signature', 'B&W', 'Color', 'Detail', 'Optics']));
  });

  it.each(BUILTIN_PRESETS.map((p) => [p.id, p] as const))('%s is valid, in range and only touches its groups', (_id, p) => {
    expect(p.builtin).toBe(true);
    expect(p.groups.length).toBeGreaterThan(0);
    for (const g of p.groups) expect(SETTINGS_GROUPS).toContain(g);
    // Everything in range (sanitizing changes nothing).
    expect(sanitizePartial(p.params)).toEqual(p.params);
    // Only listed groups, never per-photo exposure / white balance.
    for (const g of groupsFromPartial(p.params)) expect(p.groups).toContain(g);
    expect(p.groups).not.toContain('exposure');
    expect(p.groups).not.toContain('whiteBalance');
    const out = applyPreset(current(), p);
    for (const d of diffPaths(current(), out)) for (const g of groupsForPath(d)) expect(p.groups).toContain(g);
  });

  it('Night Drive has teal shadows, amber highlights, lifted blacks, clarity and halation', () => {
    const out = applyPreset(createDefaultParams(), byId('kloud.night-drive'));
    const g = out.colorGrading;
    expect(g.shadows.hue).toBeGreaterThan(170);
    expect(g.shadows.hue).toBeLessThan(215);
    expect(g.highlights.hue).toBeGreaterThan(25);
    expect(g.highlights.hue).toBeLessThan(50);
    expect(out.toneCurve.rgb[0].y).toBeGreaterThan(0.04);
    expect(out.presence.clarity).toBeGreaterThan(10);
    expect(out.effects.halation).toBeGreaterThan(20);
  });

  it('B&W presets desaturate fully and mix with HSL luminance', () => {
    for (const id of ['kloud.mono', 'kloud.mono-high-contrast', 'kloud.mono-soft-matte']) {
      const out = applyPreset(createDefaultParams(), byId(id));
      expect(out.color.saturation).toBe(-100);
      expect(Object.values(out.hsl).some((v) => v.luminance !== 0)).toBe(true);
    }
  });

  it('looks replace each other instead of stacking; sparse presets keep the rest', () => {
    const a = applyPreset(createDefaultParams(), byId('kloud.night-drive'));
    const b = applyPreset(a, byId('kloud.clean'));
    expect(b.toneCurve).toEqual(applyPreset(createDefaultParams(), byId('kloud.clean')).toneCurve);
    expect(b.presence.structure).toBe(0);
    const c = applyPreset(a, byId('kloud.landscape-sharpen'));
    expect(c.presence.texture).toBe(14);
    expect(c.presence.clarity).toBe(a.presence.clarity);
    const d = applyPreset(current(), byId('kloud.lens-corrections'));
    expect(d.lens.profileEnabled).toBe(true);
    expect(d.lens.removeCA).toBe(true);
    expect(d.lens.distortion).toBe(0);
  });
});

describe('createPreset', () => {
  it('stores only the chosen groups', () => {
    const src = current();
    const p = createPreset('  My Look ', src, ['tone', 'hsl', 'tone', 'bogus' as never], { group: 'Mine', conditions: { camera: 'ILCE', autoApply: true } });
    expect(p.name).toBe('My Look');
    expect(p.group).toBe('Mine');
    expect(p.builtin).toBe(false);
    expect(p.groups).toEqual(['tone', 'hsl']);
    expect(Object.keys(p.params).sort()).toEqual(['basic', 'hsl']);
    expect((p.params.basic as Record<string, unknown>).exposure).toBeUndefined();
    expect(p.params.basic?.contrast).toBe(20);
    expect(p.conditions).toEqual({ camera: 'ILCE', autoApply: true });
    expect(createPreset('', src, ['color']).group).toBe('User Presets');
    expect(createPreset('x', src, ['color']).id).not.toBe(createPreset('x', src, ['color']).id);
  });
});

describe('applyPreset amount', () => {
  const preset = createPreset('Test', (() => {
    const p = createDefaultParams();
    p.basic.contrast = 60;
    p.basic.highlights = -80;
    p.color.vibrance = 40;
    p.crop.flipH = true;
    p.colorGrading.shadows = { hue: 200, saturation: 40, luminance: 0 };
    return p;
  })(), ['tone', 'color', 'colorGrading']);

  it('100 = as authored, 0 = unchanged', () => {
    const cur = current();
    expect(applyPreset(cur, preset, 100)).toEqual(applyPartial(cur, preset.params, preset.groups));
    expect(applyPreset(cur, preset)).toEqual(applyPreset(cur, preset, 100));
    expect(applyPreset(cur, preset, 0)).toEqual(cur);
  });

  it('50 blends from the current look', () => {
    const out = applyPreset(current(), preset, 50);
    expect(out.basic.contrast).toBeCloseTo(40);
    expect(out.basic.highlights).toBeCloseTo(-40);
    expect(out.color.vibrance).toBeCloseTo(20);
    expect(out.colorGrading.shadows.saturation).toBeCloseTo(20);
    expect(out.basic.exposure).toBe(0.4);
  });

  it('200 extrapolates with clamping, and only preset groups change', () => {
    const cur = current();
    const out = applyPreset(cur, preset, 200);
    expect(out.basic.contrast).toBeCloseTo(100);
    expect(out.basic.highlights).toBe(-100);
    expect(out.color.vibrance).toBeCloseTo(80);
    expect(out.colorGrading.shadows.saturation).toBeCloseTo(80);
    expect(modifiedGroups(out, true).filter((g) => !modifiedGroups(cur, true).includes(g))).toEqual(['color', 'colorGrading']);
    for (const d of diffPaths(cur, out)) expect(['tone', 'color', 'colorGrading']).toEqual(expect.arrayContaining(groupsForPath(d)));
    expect(applyPreset(cur, preset, 999)).toEqual(out);
  });

  it('labels history entries', () => {
    expect(presetLabel(byId('kloud.night-drive'), 80)).toBe('Preset: KLOUD Night Drive (80%)');
    expect(presetLabel(byId('kloud.night-drive'))).toBe('Preset: KLOUD Night Drive');
  });
});

describe('matchConditionalPresets', () => {
  const mk = (id: string, conditions?: Preset['conditions']): Preset => ({ ...createPreset(id, createDefaultParams(), ['detail']), id, conditions });
  const presets = [
    mk('none'),
    mk('sony', { camera: 'ilce-7m4' }),
    mk('sony-auto', { camera: '/ILCE-7M[34]/', autoApply: true }),
    mk('nikon', { camera: 'Nikon' }),
    mk('high-iso', { isoMin: 3200 }),
    mk('low-iso', { isoMax: 400 }),
    mk('sony-85', { camera: 'Sony', lens: '/85mm F1\\.8/', isoMin: 100, isoMax: 6400 }),
    mk('bad-regex', { camera: '/ILCE[/' }),
  ];

  it('matches camera substrings / regexes, lenses and ISO ranges, auto-apply first', () => {
    const m = meta({ make: 'Sony', model: 'ILCE-7M4', camera: 'Sony α7 IV (ILCE-7M4)', lens: 'FE 85mm F1.8', iso: 6400 });
    expect(matchConditionalPresets(presets, m).map((p) => p.id)).toEqual(['sony-auto', 'sony-85', 'sony', 'high-iso']);
  });

  it('requires ISO metadata for ISO conditions and ignores unconditioned presets', () => {
    expect(matchConditionalPresets(presets, meta({ model: 'Z 8', make: 'Nikon' })).map((p) => p.id)).toEqual(['nikon']);
    expect(matchConditionalPresets(presets, meta({ iso: 200 })).map((p) => p.id)).toEqual(['low-iso']);
    expect(matchConditionalPresets(presets, meta({ camera: 'ILCE[/x' })).map((p) => p.id)).toEqual(['bad-regex']);
  });

  it('suggests High ISO Clean for high-ISO shots', () => {
    expect(matchConditionalPresets(BUILTIN_PRESETS, meta({ iso: 12800 })).map((p) => p.id)).toEqual(['kloud.high-iso-clean']);
    expect(matchConditionalPresets(BUILTIN_PRESETS, meta({ iso: 100 }))).toEqual([]);
  });
});

describe('export / import', () => {
  it('round-trips .kloudpreset files with fresh ids', async () => {
    const list = [byId('kloud.night-drive'), createPreset('Mine', current(), ['tone', 'masks'], { conditions: { lens: '85mm' } })];
    const blob = exportPresets(list);
    const text = await blob.text();
    expect(JSON.parse(text)).toMatchObject({ format: 'kloud-presets', version: 1 });
    const imported = await importPresetFile(new File([text], 'looks.kloudpreset'));
    expect(imported).toHaveLength(2);
    imported.forEach((p, i) => {
      expect(p.id).not.toBe(list[i].id);
      expect(p.builtin).toBe(false);
      expect(p.group).toBe('Imported');
      expect(p.name).toBe(list[i].name);
      expect(p.groups).toEqual(list[i].groups);
      expect(p.params).toEqual(list[i].params);
    });
    expect(imported[1].conditions).toEqual({ lens: '85mm' });
    expect(imported[1].params.masks?.[0].name).toBe('Sky');
  });

  it('imports a single-preset JSON, sanitizing values and inferring groups', async () => {
    const [p] = await importPresetFile(new File([JSON.stringify({ name: '', params: { basic: { contrast: 400, whites: 'x' }, color: { vibrance: 10 }, junk: 1 } })], 'Punchy.json'));
    expect(p.name).toBe('Punchy');
    expect(p.groups).toEqual(['tone', 'color']);
    expect(p.params).toEqual({ basic: { contrast: 100 }, color: { vibrance: 10 } });
  });

  it('imports Lightroom XMP presets and our own XMP export', async () => {
    const xmp = presetToXmp(byId('kloud.teal-orange'));
    const [p] = await importPresetFile(new File([xmp], 'teal.xmp'));
    expect(p.name).toBe('Teal & Orange');
    expect(p.group).toBe('Imported');
    expect(p.groups).toEqual(['tone', 'color', 'hsl', 'colorGrading']);
    const a = applyPreset(createDefaultParams(), byId('kloud.teal-orange'));
    const b = applyPreset(createDefaultParams(), p);
    expect(b.hsl).toEqual(a.hsl);
    expect(b.colorGrading).toEqual(a.colorGrading);
    expect(b.basic).toEqual(a.basic);
  });

  it('imports legacy .lrtemplate presets', () => {
    const lua = `s = {
	id = "0A1B2C3D-0000-0000-0000-000000000000",
	internalName = "Old Film",
	title = ZSTR "$$$/Presets/OldFilm=Old Film",
	type = "Develop",
	value = {
		settings = {
			Contrast2012 = 25,
			Exposure2012 = -0.3,
			ConvertToGrayscale = false,
			ToneCurvePV2012 = {
				0,
				15,
				128,
				130,
				255,
				240,
			},
			WhiteBalance = "As Shot", -- comment
			ParametricDarks = -10,
		},
		uuid = "0A1B2C3D",
	},
	version = 0,
}`;
    const [p] = parsePresetText(lua, 'Old Film.lrtemplate');
    expect(p.name).toBe('Old Film');
    expect(p.params.basic).toEqual({ exposure: -0.3, contrast: 25 });
    expect(p.params.toneCurve?.rgb).toEqual([{ x: 0, y: 15 / 255 }, { x: 128 / 255, y: 130 / 255 }, { x: 1, y: 240 / 255 }]);
    expect(p.params.toneCurve?.parametric?.darks).toBe(-10);
    expect(p.groups).toEqual(['exposure', 'tone', 'whiteBalance', 'toneCurve']);
  });

  it('rejects files without presets', async () => {
    await expect(importPresetFile(new File(['hello'], 'x.txt'))).rejects.toThrow(/Unrecognised/);
    await expect(importPresetFile(new File(['{"presets":[]}'], 'x.json'))).rejects.toThrow(/No valid presets/);
    await expect(importPresetFile(new File(['<x/>'], 'x.xmp'))).rejects.toThrow(/No Lightroom develop settings/);
    await expect(importPresetFile(new File([''], 'x.json'))).rejects.toThrow(/empty/);
  });
});
