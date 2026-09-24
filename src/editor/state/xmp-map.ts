/**
 * Mapping between EditParams paths and Lightroom / Camera Raw `crs:` settings
 * (Process Version 2012+, "11.0"). Fields without a Lightroom equivalent are
 * written in the `kloud:` namespace so our own sidecars round-trip; Lightroom
 * ignores unknown namespaces.
 *
 * Special cases (white balance, tone curves, crop rect, legacy split toning,
 * grayscale mix, upright) are handled in xmp.ts.
 */
import type { SettingsGroup } from '@/editor/types';
import { HSL_CHANNELS } from '@/editor/types';

export type XmpNs = 'crs' | 'kloud';

export interface NumField {
  t: 'num';
  ns: XmpNs;
  key: string;
  path: string;
  group: SettingsGroup;
  /** Decimals written. */
  dec: number;
  /** Write a leading '+' for positive values (Lightroom style for ± sliders). */
  signed: boolean;
  /** ours → xmp / xmp → ours conversion (default identity). */
  to?: (v: number) => number;
  from?: (v: number) => number;
  /** Clamp range of the written xmp value. */
  range?: [number, number];
}

export interface BoolField {
  t: 'bool';
  ns: XmpNs;
  key: string;
  path: string;
  group: SettingsGroup;
  /** 'word' → True/False, 'digit' → 1/0 */
  style: 'word' | 'digit';
}

export interface StrField {
  t: 'str';
  ns: XmpNs;
  key: string;
  path: string;
  group: SettingsGroup;
}

export type Field = NumField | BoolField | StrField;

const num = (key: string, path: string, group: SettingsGroup, dec = 0, signed = true, extra: Partial<NumField> = {}): NumField => ({
  t: 'num',
  ns: 'crs',
  key,
  path,
  group,
  dec,
  signed,
  ...extra,
});
const knum = (key: string, path: string, group: SettingsGroup, dec = 0, signed = false): NumField => ({ ...num(key, path, group, dec, signed), ns: 'kloud' });
const bool = (key: string, path: string, group: SettingsGroup, style: 'word' | 'digit', ns: XmpNs = 'crs'): BoolField => ({ t: 'bool', ns, key, path, group, style });
const kstr = (key: string, path: string, group: SettingsGroup): StrField => ({ t: 'str', ns: 'kloud', key, path, group });

/** Lightroom's HSL / B&W channel names in our HSL_CHANNELS order. */
export const LR_CHANNELS = ['Red', 'Orange', 'Yellow', 'Green', 'Aqua', 'Blue', 'Purple', 'Magenta'] as const;

/*
 * Defringe hue ranges: Lightroom stores each colour's hue range on its own
 * 0..100 slider scale (defaults purple 30–70, green 40–60); we store degrees
 * (defaults 270–330 and 80–160). The linear maps below send LR defaults to our
 * defaults — an approximation, since Adobe does not document the scale.
 */
const PURPLE_TO = (h: number) => 30 + (h - 270) / 1.5;
const PURPLE_FROM = (v: number) => 270 + (v - 30) * 1.5;
const GREEN_TO = (h: number) => 40 + (h - 80) / 4;
const GREEN_FROM = (v: number) => 80 + (v - 40) * 4;

const hslFields: Field[] = [];
HSL_CHANNELS.forEach((ch, i) => {
  const lr = LR_CHANNELS[i];
  hslFields.push(num(`HueAdjustment${lr}`, `hsl.${ch}.hue`, 'hsl'));
  hslFields.push(num(`SaturationAdjustment${lr}`, `hsl.${ch}.saturation`, 'hsl'));
  hslFields.push(num(`LuminanceAdjustment${lr}`, `hsl.${ch}.luminance`, 'hsl'));
});

const gradeFields: Field[] = [];
for (const [lr, ours] of [
  ['Shadow', 'shadows'],
  ['Midtone', 'midtones'],
  ['Highlight', 'highlights'],
  ['Global', 'global'],
] as const) {
  gradeFields.push(num(`ColorGrade${lr}Hue`, `colorGrading.${ours}.hue`, 'colorGrading', 0, false, { range: [0, 359] }));
  gradeFields.push(num(`ColorGrade${lr}Sat`, `colorGrading.${ours}.saturation`, 'colorGrading', 0, false));
  gradeFields.push(num(`ColorGrade${lr}Lum`, `colorGrading.${ours}.luminance`, 'colorGrading'));
}

export const FIELDS: Field[] = [
  num('Exposure2012', 'basic.exposure', 'exposure', 2),
  num('Contrast2012', 'basic.contrast', 'tone'),
  num('Highlights2012', 'basic.highlights', 'tone'),
  num('Shadows2012', 'basic.shadows', 'tone'),
  num('Whites2012', 'basic.whites', 'tone'),
  num('Blacks2012', 'basic.blacks', 'tone'),
  num('Vibrance', 'color.vibrance', 'color'),
  num('Saturation', 'color.saturation', 'color'),
  num('Texture', 'presence.texture', 'presence'),
  num('Clarity2012', 'presence.clarity', 'presence'),
  num('Dehaze', 'presence.dehaze', 'presence'),
  knum('Structure', 'presence.structure', 'presence', 0, true),
  knum('LocalContrast', 'presence.localContrast', 'presence', 0, true),
  ...hslFields,
  num('ParametricShadows', 'toneCurve.parametric.shadows', 'toneCurve'),
  num('ParametricDarks', 'toneCurve.parametric.darks', 'toneCurve'),
  num('ParametricLights', 'toneCurve.parametric.lights', 'toneCurve'),
  num('ParametricHighlights', 'toneCurve.parametric.highlights', 'toneCurve'),
  num('ParametricShadowSplit', 'toneCurve.parametric.split1', 'toneCurve', 0, false),
  num('ParametricMidtoneSplit', 'toneCurve.parametric.split2', 'toneCurve', 0, false),
  num('ParametricHighlightSplit', 'toneCurve.parametric.split3', 'toneCurve', 0, false),
  ...gradeFields,
  num('ColorGradeBlending', 'colorGrading.blending', 'colorGrading', 0, false),
  num('ColorGradeBalance', 'colorGrading.balance', 'colorGrading'),
  num('ShadowTint', 'calibration.shadowsTint', 'calibration'),
  num('RedHue', 'calibration.redHue', 'calibration'),
  num('RedSaturation', 'calibration.redSaturation', 'calibration'),
  num('GreenHue', 'calibration.greenHue', 'calibration'),
  num('GreenSaturation', 'calibration.greenSaturation', 'calibration'),
  num('BlueHue', 'calibration.blueHue', 'calibration'),
  num('BlueSaturation', 'calibration.blueSaturation', 'calibration'),
  num('Sharpness', 'detail.sharpenAmount', 'detail', 0, false),
  num('SharpenRadius', 'detail.sharpenRadius', 'detail', 1, true),
  num('SharpenDetail', 'detail.sharpenDetail', 'detail', 0, false),
  num('SharpenEdgeMasking', 'detail.sharpenMasking', 'detail', 0, false),
  num('LuminanceSmoothing', 'noise.luminance', 'noise', 0, false),
  num('LuminanceNoiseReductionDetail', 'noise.luminanceDetail', 'noise', 0, false),
  num('LuminanceNoiseReductionContrast', 'noise.luminanceContrast', 'noise', 0, false),
  num('ColorNoiseReduction', 'noise.color', 'noise', 0, false),
  num('ColorNoiseReductionDetail', 'noise.colorDetail', 'noise', 0, false),
  num('ColorNoiseReductionSmoothness', 'noise.colorSmoothness', 'noise', 0, false),
  bool('AiDenoise', 'noise.aiDenoise', 'noise', 'word', 'kloud'),
  knum('AiDenoiseStrength', 'noise.aiDenoiseStrength', 'noise'),
  knum('DetailPreservation', 'noise.detailPreservation', 'noise'),
  bool('LensProfileEnable', 'lens.profileEnabled', 'lens', 'digit'),
  kstr('LensProfileId', 'lens.profileId', 'lens'),
  num('LensProfileDistortionScale', 'lens.profileDistortionScale', 'lens', 0, false),
  num('LensProfileVignettingScale', 'lens.profileVignettingScale', 'lens', 0, false),
  num('LensManualDistortionAmount', 'lens.distortion', 'lens'),
  num('VignetteAmount', 'lens.vignetting', 'lens'),
  num('VignetteMidpoint', 'lens.vignettingMidpoint', 'lens', 0, false),
  bool('AutoLateralCA', 'lens.removeCA', 'lens', 'digit'),
  num('DefringePurpleAmount', 'lens.defringe.purpleAmount', 'lens', 0, false),
  num('DefringePurpleHueLo', 'lens.defringe.purpleHueMin', 'lens', 0, false, { to: PURPLE_TO, from: PURPLE_FROM, range: [0, 100] }),
  num('DefringePurpleHueHi', 'lens.defringe.purpleHueMax', 'lens', 0, false, { to: PURPLE_TO, from: PURPLE_FROM, range: [0, 100] }),
  num('DefringeGreenAmount', 'lens.defringe.greenAmount', 'lens', 0, false),
  num('DefringeGreenHueLo', 'lens.defringe.greenHueMin', 'lens', 0, false, { to: GREEN_TO, from: GREEN_FROM, range: [0, 100] }),
  num('DefringeGreenHueHi', 'lens.defringe.greenHueMax', 'lens', 0, false, { to: GREEN_TO, from: GREEN_FROM, range: [0, 100] }),
  // Lightroom's Vertical slider is negative for "widen the top" (shooting up at a building);
  // ours is positive for that (see ARCHITECTURE sign conventions), hence the negation.
  num('PerspectiveVertical', 'transform.vertical', 'transform', 0, true, { to: (v) => -v, from: (v) => -v }),
  num('PerspectiveHorizontal', 'transform.horizontal', 'transform'),
  num('PerspectiveRotate', 'transform.rotate', 'transform', 1),
  num('PerspectiveAspect', 'transform.aspect', 'transform'),
  num('PerspectiveScale', 'transform.scale', 'transform', 0, false),
  num('PerspectiveX', 'transform.offsetX', 'transform', 1),
  num('PerspectiveY', 'transform.offsetY', 'transform', 1),
  knum('Orientation', 'crop.orientation', 'crop'),
  bool('FlipH', 'crop.flipH', 'crop', 'word', 'kloud'),
  bool('FlipV', 'crop.flipV', 'crop', 'word', 'kloud'),
  kstr('CropAspect', 'crop.aspect', 'crop'),
  kstr('CropOverlay', 'crop.overlay', 'crop'),
  bool('CropConstrainToWarp', 'crop.constrainToImage', 'crop', 'digit'),
  num('PostCropVignetteAmount', 'effects.vignetteAmount', 'effects'),
  num('PostCropVignetteMidpoint', 'effects.vignetteMidpoint', 'effects', 0, false),
  num('PostCropVignetteRoundness', 'effects.vignetteRoundness', 'effects'),
  num('PostCropVignetteFeather', 'effects.vignetteFeather', 'effects', 0, false),
  num('PostCropVignetteHighlightContrast', 'effects.vignetteHighlights', 'effects', 0, false),
  num('GrainAmount', 'effects.grainAmount', 'effects', 0, false),
  num('GrainSize', 'effects.grainSize', 'effects', 0, false),
  num('GrainFrequency', 'effects.grainRoughness', 'effects', 0, false),
  knum('Bloom', 'effects.bloom', 'effects'),
  knum('Glow', 'effects.glow', 'effects'),
  knum('Halation', 'effects.halation', 'effects'),
];

/** Lightroom PerspectiveUpright codes. 5 = Guided, which we treat as Full. */
export const UPRIGHT_CODES: Record<string, string> = { off: '0', auto: '1', level: '2', vertical: '3', full: '4' };
export const UPRIGHT_FROM_CODE: Record<string, 'off' | 'auto' | 'level' | 'vertical' | 'full'> = {
  '0': 'off',
  '1': 'auto',
  '2': 'level',
  '3': 'vertical',
  '4': 'full',
  '5': 'full',
};

/** Kelvin of Lightroom's named white-balance presets (used when only the name is given). */
export const WB_PRESET_KELVIN: Record<string, number> = {
  Daylight: 5500,
  Cloudy: 6500,
  Shade: 7500,
  Tungsten: 2850,
  Fluorescent: 3800,
  Flash: 5500,
};

/** Point sets of Lightroom's named PV2012 tone curves (0..255). */
export const NAMED_CURVES: Record<string, [number, number][]> = {
  Linear: [
    [0, 0],
    [255, 255],
  ],
  'Medium Contrast': [
    [0, 0],
    [32, 22],
    [64, 56],
    [128, 128],
    [192, 196],
    [255, 255],
  ],
  'Strong Contrast': [
    [0, 0],
    [32, 16],
    [64, 50],
    [128, 128],
    [192, 202],
    [255, 255],
  ],
};
