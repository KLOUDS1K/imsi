/**
 * Built-in KLOUD presets.
 *
 * "Look" presets fully specify every group they list (starting from neutral
 * values), so applying one look after another replaces the look instead of
 * stacking leftovers. Utility presets (Detail, Optics) are sparse: they only
 * carry the few fields they change, leaving the rest of the group alone.
 * None of them touch exposure or white balance, which are per-photo decisions.
 */
import { createDefaultParams } from '@/editor/defaults';
import { deepMerge, pickGroups } from '@/editor/state';
import type { CurvePoint, PartialParams, Preset, PresetConditions, SettingsGroup } from '@/editor/types';

/** Stable timestamp for built-ins (they never change identity between releases). */
const BUILTIN_TIME = Date.UTC(2026, 0, 1);
const NEUTRAL = createDefaultParams(false);

/** Point curve from 0..255 pairs. */
const curve = (...pts: [number, number][]): CurvePoint[] => pts.map(([x, y]) => ({ x: x / 255, y: y / 255 }));

/** A look: every listed group starts neutral, then the overrides apply. */
function look(id: string, name: string, group: string, groups: SettingsGroup[], overrides: PartialParams, conditions?: PresetConditions): Preset {
  return make(id, name, group, groups, deepMerge(pickGroups(NEUTRAL, groups), overrides), conditions);
}

/** A sparse utility preset: only the given fields. */
function sparse(id: string, name: string, group: string, groups: SettingsGroup[], params: PartialParams, conditions?: PresetConditions): Preset {
  return make(id, name, group, groups, params, conditions);
}

function make(id: string, name: string, group: string, groups: SettingsGroup[], params: PartialParams, conditions?: PresetConditions): Preset {
  const p: Preset = { id, name, group, builtin: true, groups, params, created: BUILTIN_TIME, updated: BUILTIN_TIME };
  if (conditions) p.conditions = conditions;
  return p;
}

const SIGNATURE = 'KLOUD Signature';
const BW = 'B&W';
const COLOR = 'Color';
const DETAIL = 'Detail';
const OPTICS = 'Optics';

export const BUILTIN_PRESETS: Preset[] = [
  /* ------------------------------ KLOUD Signature ------------------------------ */
  look('kloud.clean', 'KLOUD Clean', SIGNATURE, ['tone', 'color', 'presence', 'toneCurve'], {
    basic: { contrast: 8, highlights: -28, shadows: 20, whites: 12, blacks: -8 },
    color: { vibrance: 14 },
    presence: { texture: 8, clarity: 6, dehaze: 4 },
    toneCurve: { rgb: curve([0, 0], [64, 60], [192, 198], [255, 255]) },
  }),

  // Night car / motorcycle: teal shadows, amber highlights (tail lights, sodium lamps),
  // lifted blue-ish blacks, crisp clarity, and halation/bloom around light sources.
  look('kloud.night-drive', 'KLOUD Night Drive', SIGNATURE, ['tone', 'color', 'hsl', 'toneCurve', 'colorGrading', 'presence', 'effects'], {
    basic: { contrast: 16, highlights: -40, shadows: 24, whites: 10, blacks: -6 },
    color: { vibrance: 12, saturation: -6 },
    hsl: {
      red: { hue: 4, saturation: 10, luminance: -4 },
      orange: { hue: -4, saturation: 12, luminance: 6 },
      yellow: { hue: -14, saturation: -18, luminance: 0 },
      green: { hue: 30, saturation: -45, luminance: -10 },
      aqua: { hue: -12, saturation: 14, luminance: -6 },
      blue: { hue: -16, saturation: 8, luminance: -14 },
      purple: { hue: -10, saturation: -35, luminance: -8 },
      magenta: { hue: -6, saturation: -30, luminance: -6 },
    },
    toneCurve: {
      rgb: curve([0, 18], [60, 58], [128, 128], [196, 204], [255, 246]),
      blue: curve([0, 8], [255, 252]),
    },
    colorGrading: {
      shadows: { hue: 195, saturation: 30, luminance: -4 },
      midtones: { hue: 200, saturation: 6, luminance: 0 },
      highlights: { hue: 38, saturation: 28, luminance: 4 },
      blending: 60,
      balance: -12,
    },
    presence: { texture: 10, clarity: 18, dehaze: 10, structure: 8, localContrast: 6 },
    effects: {
      vignetteAmount: -18,
      vignetteMidpoint: 40,
      vignetteFeather: 65,
      vignetteHighlights: 30,
      grainAmount: 12,
      grainSize: 20,
      grainRoughness: 45,
      bloom: 14,
      glow: 6,
      halation: 38,
    },
  }),

  look('kloud.matte', 'KLOUD Matte', SIGNATURE, ['tone', 'color', 'toneCurve', 'presence', 'effects'], {
    basic: { contrast: -8, highlights: -20, shadows: 12, whites: -6, blacks: 10 },
    color: { vibrance: 6, saturation: -12 },
    toneCurve: { rgb: curve([0, 30], [70, 74], [180, 184], [255, 238]) },
    presence: { clarity: -4, dehaze: -4 },
    effects: { vignetteAmount: -6, vignetteFeather: 70, grainAmount: 10, grainSize: 25 },
  }),

  look('kloud.film-warm', 'KLOUD Film Warm', SIGNATURE, ['tone', 'color', 'hsl', 'toneCurve', 'colorGrading', 'effects'], {
    basic: { contrast: 6, highlights: -24, shadows: 14, whites: -4, blacks: 6 },
    color: { vibrance: 8, saturation: -8 },
    hsl: {
      red: { hue: 6, saturation: -4 },
      orange: { hue: 4, saturation: 6, luminance: 4 },
      yellow: { hue: -10, saturation: -12, luminance: 2 },
      green: { hue: -20, saturation: -30, luminance: -6 },
      aqua: { hue: -8, saturation: -20 },
      blue: { hue: -6, saturation: -24, luminance: -4 },
      purple: { saturation: -20 },
      magenta: { saturation: -15 },
    },
    toneCurve: {
      rgb: curve([0, 16], [64, 66], [128, 132], [192, 196], [255, 242]),
      red: curve([0, 4], [128, 132], [255, 255]),
      blue: curve([0, 6], [128, 122], [255, 236]),
    },
    colorGrading: {
      shadows: { hue: 32, saturation: 12 },
      midtones: { hue: 40, saturation: 8 },
      highlights: { hue: 45, saturation: 16, luminance: 2 },
      blending: 55,
      balance: 8,
    },
    effects: { vignetteAmount: -10, vignetteMidpoint: 45, vignetteFeather: 70, grainAmount: 20, grainSize: 30, grainRoughness: 55, glow: 4, halation: 10 },
  }),

  look('kloud.cool-street', 'KLOUD Cool Street', SIGNATURE, ['tone', 'color', 'hsl', 'toneCurve', 'colorGrading', 'presence'], {
    basic: { contrast: 22, highlights: -30, shadows: 12, whites: 8, blacks: -14 },
    color: { vibrance: 4, saturation: -18 },
    hsl: {
      red: { saturation: -6 },
      orange: { saturation: -10, luminance: 4 },
      yellow: { hue: -6, saturation: -30, luminance: -4 },
      green: { hue: 24, saturation: -40, luminance: -10 },
      aqua: { hue: -8, saturation: 6 },
      blue: { hue: -10, saturation: 4, luminance: -6 },
      purple: { saturation: -30 },
      magenta: { saturation: -30 },
    },
    toneCurve: { rgb: curve([0, 6], [64, 56], [128, 128], [192, 200], [255, 250]) },
    colorGrading: {
      shadows: { hue: 210, saturation: 18, luminance: -2 },
      midtones: { hue: 205, saturation: 6 },
      highlights: { hue: 190, saturation: 6 },
      balance: -8,
    },
    presence: { texture: 14, clarity: 16, dehaze: 6, structure: 10, localContrast: 8 },
  }),

  look('kloud.soft-portrait', 'KLOUD Soft Portrait', SIGNATURE, ['tone', 'color', 'hsl', 'toneCurve', 'colorGrading', 'presence', 'effects'], {
    basic: { contrast: -10, highlights: -32, shadows: 22, whites: 6, blacks: 4 },
    color: { vibrance: 8, saturation: -4 },
    hsl: {
      red: { hue: 2, saturation: -6, luminance: 4 },
      orange: { hue: 2, saturation: -8, luminance: 10 },
      yellow: { saturation: -10, luminance: 4 },
      green: { hue: -6, saturation: -20 },
      aqua: { saturation: -10 },
      blue: { saturation: -10 },
      purple: { saturation: -10 },
      magenta: { saturation: -12, luminance: 2 },
    },
    toneCurve: { rgb: curve([0, 10], [64, 68], [192, 196], [255, 250]) },
    colorGrading: {
      shadows: { hue: 220, saturation: 4 },
      midtones: { hue: 30, saturation: 3 },
      highlights: { hue: 35, saturation: 8, luminance: 2 },
      blending: 60,
    },
    presence: { texture: -18, clarity: -10, dehaze: -2 },
    effects: { vignetteAmount: -8, vignetteMidpoint: 55, vignetteFeather: 80, bloom: 4, glow: 10 },
  }),

  look('kloud.punch', 'KLOUD Punch', SIGNATURE, ['tone', 'color', 'toneCurve', 'presence', 'effects'], {
    basic: { contrast: 32, highlights: -22, shadows: 16, whites: 20, blacks: -22 },
    color: { vibrance: 28, saturation: 6 },
    toneCurve: { rgb: curve([0, 0], [64, 54], [128, 128], [192, 206], [255, 255]) },
    presence: { texture: 16, clarity: 22, dehaze: 10, structure: 10, localContrast: 10 },
    effects: { vignetteAmount: -12, vignetteMidpoint: 45, vignetteFeather: 60 },
  }),

  look('kloud.golden-hour', 'KLOUD Golden Hour', SIGNATURE, ['tone', 'color', 'hsl', 'toneCurve', 'colorGrading', 'presence', 'effects'], {
    basic: { contrast: 10, highlights: -34, shadows: 18, whites: 6, blacks: -4 },
    color: { vibrance: 20 },
    hsl: {
      red: { saturation: 6 },
      orange: { hue: -2, saturation: 14, luminance: 6 },
      yellow: { hue: -10, saturation: 10, luminance: 4 },
      green: { hue: -16, saturation: -18, luminance: -6 },
      aqua: { saturation: -12 },
      blue: { hue: -4, saturation: -12, luminance: -4 },
      purple: { saturation: -16 },
      magenta: { saturation: -10 },
    },
    toneCurve: { rgb: curve([0, 8], [64, 64], [128, 132], [192, 200], [255, 250]) },
    colorGrading: {
      shadows: { hue: 25, saturation: 8 },
      midtones: { hue: 35, saturation: 10 },
      highlights: { hue: 42, saturation: 24, luminance: 3 },
      blending: 55,
      balance: 10,
    },
    presence: { texture: 4, clarity: 6, dehaze: 4 },
    effects: { vignetteAmount: -10, vignetteMidpoint: 45, vignetteFeather: 70, bloom: 10, glow: 16, halation: 6 },
  }),

  /* ------------------------------------ B&W ------------------------------------ */
  // Saturation −100 with per-band HSL luminance acting as the B&W channel mixer.
  look('kloud.mono', 'KLOUD Mono', BW, ['tone', 'color', 'hsl', 'toneCurve', 'presence', 'effects'], {
    basic: { contrast: 22, highlights: -18, shadows: 12, whites: 16, blacks: -14 },
    color: { saturation: -100 },
    hsl: {
      red: { luminance: 10 },
      orange: { luminance: 16 },
      yellow: { luminance: 8 },
      green: { luminance: -8 },
      aqua: { luminance: -14 },
      blue: { luminance: -22 },
      purple: { luminance: -6 },
      magenta: { luminance: 6 },
    },
    toneCurve: { rgb: curve([0, 4], [64, 58], [128, 128], [192, 200], [255, 252]) },
    presence: { texture: 8, clarity: 12, dehaze: 4 },
    effects: { vignetteAmount: -10, vignetteFeather: 65, grainAmount: 14, grainSize: 22 },
  }),

  look('kloud.mono-high-contrast', 'Mono High Contrast', BW, ['tone', 'color', 'hsl', 'toneCurve', 'presence', 'effects'], {
    basic: { contrast: 48, highlights: -12, shadows: -8, whites: 30, blacks: -32 },
    color: { saturation: -100 },
    hsl: {
      red: { luminance: 20 },
      orange: { luminance: 12 },
      yellow: { luminance: 14 },
      green: { luminance: -18 },
      aqua: { luminance: -30 },
      blue: { luminance: -42 },
      purple: { luminance: -12 },
      magenta: { luminance: 10 },
    },
    toneCurve: { rgb: curve([0, 0], [56, 40], [128, 128], [200, 218], [255, 255]) },
    presence: { texture: 18, clarity: 28, dehaze: 12, structure: 12, localContrast: 10 },
    effects: { vignetteAmount: -16, vignetteMidpoint: 40, vignetteFeather: 60, grainAmount: 20, grainSize: 18, grainRoughness: 60 },
  }),

  look('kloud.mono-soft-matte', 'Mono Soft Matte', BW, ['tone', 'color', 'hsl', 'toneCurve', 'presence', 'effects'], {
    basic: { contrast: -16, highlights: -30, shadows: 26, whites: -6, blacks: 12 },
    color: { saturation: -100 },
    hsl: {
      red: { luminance: 12 },
      orange: { luminance: 22 },
      yellow: { luminance: 8 },
      green: { luminance: 4 },
      blue: { luminance: -6 },
      purple: { luminance: 2 },
      magenta: { luminance: 8 },
    },
    toneCurve: { rgb: curve([0, 34], [64, 78], [128, 134], [192, 190], [255, 234]) },
    presence: { texture: -6, clarity: -8, dehaze: -4 },
    effects: { vignetteAmount: -6, vignetteFeather: 80, grainAmount: 22, grainSize: 32, grainRoughness: 55 },
  }),

  /* ----------------------------------- Color ----------------------------------- */
  look('kloud.teal-orange', 'Teal & Orange', COLOR, ['tone', 'color', 'hsl', 'colorGrading'], {
    basic: { contrast: 14, highlights: -24, shadows: 14, whites: 6, blacks: -8 },
    color: { vibrance: 12, saturation: -4 },
    hsl: {
      red: { hue: 6, saturation: 4 },
      orange: { hue: -4, saturation: 16, luminance: 6 },
      yellow: { hue: -26, saturation: -12, luminance: -2 },
      green: { hue: 45, saturation: -38, luminance: -10 },
      aqua: { hue: -18, saturation: 22, luminance: -6 },
      blue: { hue: -26, saturation: 14, luminance: -12 },
      purple: { hue: -20, saturation: -30 },
      magenta: { saturation: -30 },
    },
    colorGrading: {
      shadows: { hue: 190, saturation: 32, luminance: -2 },
      highlights: { hue: 34, saturation: 22, luminance: 2 },
      blending: 55,
      balance: -4,
    },
  }),

  look('kloud.pastel-fade', 'Pastel Fade', COLOR, ['tone', 'color', 'hsl', 'toneCurve', 'colorGrading'], {
    basic: { contrast: -24, highlights: -22, shadows: 28, whites: 10, blacks: 18 },
    color: { vibrance: -6, saturation: -22 },
    hsl: {
      red: { saturation: -8, luminance: 6 },
      orange: { saturation: -6, luminance: 10 },
      yellow: { saturation: -14, luminance: 12 },
      green: { hue: 10, saturation: -28, luminance: 14 },
      aqua: { saturation: -6, luminance: 14 },
      blue: { hue: -6, saturation: -8, luminance: 16 },
      purple: { luminance: 10 },
      magenta: { saturation: -6, luminance: 10 },
    },
    toneCurve: { rgb: curve([0, 40], [64, 86], [128, 146], [192, 204], [255, 244]) },
    colorGrading: {
      shadows: { hue: 200, saturation: 10, luminance: 2 },
      midtones: { hue: 330, saturation: 4 },
      highlights: { hue: 340, saturation: 8, luminance: 2 },
      blending: 60,
    },
  }),

  look('kloud.faded-film', 'Faded Film', COLOR, ['tone', 'color', 'hsl', 'toneCurve', 'effects'], {
    basic: { contrast: 4, highlights: -18, shadows: 10, whites: -8, blacks: 4 },
    color: { vibrance: 4, saturation: -18 },
    hsl: {
      orange: { saturation: -4 },
      yellow: { hue: -6, saturation: -16 },
      green: { hue: -12, saturation: -26 },
      aqua: { saturation: -14 },
      blue: { hue: -8, saturation: -14 },
    },
    toneCurve: {
      rgb: curve([0, 24], [64, 70], [128, 130], [192, 190], [255, 238]),
      red: curve([0, 6], [128, 130], [255, 250]),
      green: curve([0, 2], [128, 128], [255, 252]),
      blue: curve([0, 18], [128, 122], [255, 232]),
    },
    effects: { vignetteAmount: -8, vignetteFeather: 75, grainAmount: 26, grainSize: 30, grainRoughness: 62, halation: 8 },
  }),

  look('kloud.deep-blue', 'Deep Blue', COLOR, ['tone', 'color', 'hsl', 'colorGrading', 'presence'], {
    basic: { contrast: 16, highlights: -22, shadows: 8, whites: 4, blacks: -16 },
    color: { vibrance: 8, saturation: -4 },
    hsl: {
      orange: { saturation: -4 },
      yellow: { saturation: -16 },
      green: { hue: 20, saturation: -26, luminance: -8 },
      aqua: { hue: 8, saturation: 10, luminance: -16 },
      blue: { hue: -10, saturation: 24, luminance: -26 },
      purple: { hue: -12, saturation: -20 },
      magenta: { saturation: -20 },
    },
    colorGrading: {
      shadows: { hue: 225, saturation: 22, luminance: -6 },
      midtones: { hue: 215, saturation: 6 },
      highlights: { hue: 200, saturation: 6 },
      balance: -10,
    },
    presence: { texture: 6, clarity: 10, dehaze: 14 },
  }),

  /* ----------------------------------- Detail ---------------------------------- */
  sparse('kloud.landscape-sharpen', 'Landscape Sharpen', DETAIL, ['detail', 'presence'], {
    detail: { sharpenAmount: 60, sharpenRadius: 1.0, sharpenDetail: 35, sharpenMasking: 25 },
    presence: { texture: 14 },
  }),

  sparse(
    'kloud.high-iso-clean',
    'High ISO Clean',
    DETAIL,
    ['noise', 'detail'],
    {
      noise: { luminance: 35, luminanceDetail: 45, luminanceContrast: 10, color: 35, colorDetail: 50, colorSmoothness: 60 },
      // Sharpen edges only so the smoothed noise is not re-amplified.
      detail: { sharpenAmount: 30, sharpenRadius: 1.2, sharpenDetail: 15, sharpenMasking: 45 },
    },
    // Suggested (not auto-applied) for high-ISO shots.
    { isoMin: 3200 },
  ),

  /* ----------------------------------- Optics ---------------------------------- */
  sparse('kloud.lens-corrections', 'Enable Lens Corrections', OPTICS, ['lens'], {
    lens: { profileEnabled: true, removeCA: true },
  }),
];

/** Folder order for the presets panel. */
export const BUILTIN_GROUP_ORDER = [SIGNATURE, BW, COLOR, DETAIL, OPTICS] as const;
