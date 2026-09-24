import type {
  EditParams,
  ExportSettings,
  GradeWheel,
  HslChannel,
  HslValue,
  LocalAdjustments,
  Mask,
  PhotoMeta,
  WatermarkSettings,
} from './types';
import { HSL_CHANNELS } from './types';

const wheel = (): GradeWheel => ({ hue: 0, saturation: 0, luminance: 0 });
const linearCurve = () => [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
];

/**
 * Neutral recipe. `isRaw` switches on the RAW-only defaults (capture sharpening
 * and color noise reduction), matching Lightroom's behaviour.
 */
export function createDefaultParams(isRaw = false): EditParams {
  const hsl = {} as Record<HslChannel, HslValue>;
  for (const c of HSL_CHANNELS) hsl[c] = { hue: 0, saturation: 0, luminance: 0 };
  return {
    version: 1,
    basic: { exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0 },
    whiteBalance: { mode: 'as-shot', temperature: 0, tint: 0 },
    color: { vibrance: 0, saturation: 0 },
    hsl,
    toneCurve: {
      rgb: linearCurve(),
      red: linearCurve(),
      green: linearCurve(),
      blue: linearCurve(),
      parametric: { highlights: 0, lights: 0, darks: 0, shadows: 0, split1: 25, split2: 50, split3: 75 },
    },
    colorGrading: {
      shadows: wheel(),
      midtones: wheel(),
      highlights: wheel(),
      global: wheel(),
      blending: 50,
      balance: 0,
    },
    calibration: {
      shadowsTint: 0,
      redHue: 0,
      redSaturation: 0,
      greenHue: 0,
      greenSaturation: 0,
      blueHue: 0,
      blueSaturation: 0,
    },
    presence: { texture: 0, clarity: 0, dehaze: 0, structure: 0, localContrast: 0 },
    detail: {
      sharpenAmount: isRaw ? 40 : 0,
      sharpenRadius: 1.0,
      sharpenDetail: 25,
      sharpenMasking: 0,
    },
    noise: {
      luminance: 0,
      luminanceDetail: 50,
      luminanceContrast: 0,
      color: isRaw ? 25 : 0,
      colorDetail: 50,
      colorSmoothness: 50,
      aiDenoise: false,
      aiDenoiseStrength: 50,
      detailPreservation: 50,
    },
    lens: {
      profileEnabled: false,
      profileId: null,
      profileDistortionScale: 100,
      profileVignettingScale: 100,
      distortion: 0,
      vignetting: 0,
      vignettingMidpoint: 50,
      removeCA: false,
      defringe: {
        purpleAmount: 0,
        purpleHueMin: 270,
        purpleHueMax: 330,
        greenAmount: 0,
        greenHueMin: 80,
        greenHueMax: 160,
      },
    },
    transform: {
      upright: 'off',
      vertical: 0,
      horizontal: 0,
      rotate: 0,
      aspect: 0,
      scale: 100,
      offsetX: 0,
      offsetY: 0,
    },
    crop: {
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      angle: 0,
      aspect: 'original',
      customAspect: [5, 7],
      orientation: 0,
      flipH: false,
      flipV: false,
      constrainToImage: true,
      overlay: 'thirds',
    },
    effects: {
      vignetteAmount: 0,
      vignetteMidpoint: 50,
      vignetteRoundness: 0,
      vignetteFeather: 50,
      vignetteHighlights: 0,
      grainAmount: 0,
      grainSize: 25,
      grainRoughness: 50,
      bloom: 0,
      glow: 0,
      halation: 0,
    },
    masks: [],
    retouch: { spots: [], removals: [] },
  };
}

export function createDefaultLocalAdjustments(): LocalAdjustments {
  return {
    exposure: 0,
    contrast: 0,
    highlights: 0,
    shadows: 0,
    whites: 0,
    blacks: 0,
    temperature: 0,
    tint: 0,
    saturation: 0,
    texture: 0,
    clarity: 0,
    dehaze: 0,
    sharpness: 0,
    noise: 0,
  };
}

export function createMask(name: string, id: string): Mask {
  return {
    id,
    name,
    visible: true,
    components: [],
    invert: false,
    amount: 100,
    adjustments: createDefaultLocalAdjustments(),
  };
}

export function createDefaultWatermark(): WatermarkSettings {
  return {
    enabled: false,
    kind: 'kloud-photography',
    text: '© KLOUD.PHOTOGRAPHY',
    fontFamily: 'Syncopate, Manrope, system-ui, sans-serif',
    fontWeight: 700,
    color: '#ffffff',
    letterSpacing: 0.32,
    imageDataUrl: null,
    position: 'bottom-right',
    size: 2.2,
    opacity: 70,
    margin: 3,
    shadow: true,
  };
}

export function createDefaultExportSettings(): ExportSettings {
  return {
    format: 'jpeg',
    quality: 90,
    bitDepth: 8,
    resize: { mode: 'none', value: 2048, width: 2048, height: 2048, dontEnlarge: true },
    dpi: 300,
    colorSpace: 'srgb',
    metadata: 'copyright',
    removeLocation: true,
    copyright: '© KLOUD.PHOTOGRAPHY',
    artist: 'KLOUD',
    watermark: createDefaultWatermark(),
    outputSharpening: { enabled: false, target: 'screen', amount: 'standard' },
    fileNameTemplate: '{name}_kloud',
    sequenceStart: 1,
  };
}

export function createEmptyMeta(fileName = 'untitled'): PhotoMeta {
  return {
    fileName,
    fileSize: 0,
    mimeType: '',
    format: 'unknown',
    width: 0,
    height: 0,
    orientation: 1,
    bitDepth: 8,
  };
}

/** Slider ranges and defaults for UI/validation. Paths are dot paths into EditParams. */
export interface ParamSpec {
  min: number;
  max: number;
  step: number;
  /** Default when neither RAW nor JPEG specific. */
  def: number;
  /** Fine step used with Shift/Alt. */
  fine?: number;
  unit?: string;
}

export const PARAM_SPECS: Record<string, ParamSpec> = {
  'basic.exposure': { min: -5, max: 5, step: 0.01, def: 0, fine: 0.005, unit: 'EV' },
  'basic.contrast': { min: -100, max: 100, step: 1, def: 0 },
  'basic.highlights': { min: -100, max: 100, step: 1, def: 0 },
  'basic.shadows': { min: -100, max: 100, step: 1, def: 0 },
  'basic.whites': { min: -100, max: 100, step: 1, def: 0 },
  'basic.blacks': { min: -100, max: 100, step: 1, def: 0 },
  'whiteBalance.temperature': { min: -100, max: 100, step: 1, def: 0 },
  'whiteBalance.tint': { min: -100, max: 100, step: 1, def: 0 },
  'color.vibrance': { min: -100, max: 100, step: 1, def: 0 },
  'color.saturation': { min: -100, max: 100, step: 1, def: 0 },
  'presence.texture': { min: -100, max: 100, step: 1, def: 0 },
  'presence.clarity': { min: -100, max: 100, step: 1, def: 0 },
  'presence.dehaze': { min: -100, max: 100, step: 1, def: 0 },
  'presence.structure': { min: -100, max: 100, step: 1, def: 0 },
  'presence.localContrast': { min: -100, max: 100, step: 1, def: 0 },
  'colorGrading.blending': { min: 0, max: 100, step: 1, def: 50 },
  'colorGrading.balance': { min: -100, max: 100, step: 1, def: 0 },
  'calibration.shadowsTint': { min: -100, max: 100, step: 1, def: 0 },
  'calibration.redHue': { min: -100, max: 100, step: 1, def: 0 },
  'calibration.redSaturation': { min: -100, max: 100, step: 1, def: 0 },
  'calibration.greenHue': { min: -100, max: 100, step: 1, def: 0 },
  'calibration.greenSaturation': { min: -100, max: 100, step: 1, def: 0 },
  'calibration.blueHue': { min: -100, max: 100, step: 1, def: 0 },
  'calibration.blueSaturation': { min: -100, max: 100, step: 1, def: 0 },
  'detail.sharpenAmount': { min: 0, max: 150, step: 1, def: 0 },
  'detail.sharpenRadius': { min: 0.5, max: 3, step: 0.1, def: 1, fine: 0.05 },
  'detail.sharpenDetail': { min: 0, max: 100, step: 1, def: 25 },
  'detail.sharpenMasking': { min: 0, max: 100, step: 1, def: 0 },
  'noise.luminance': { min: 0, max: 100, step: 1, def: 0 },
  'noise.luminanceDetail': { min: 0, max: 100, step: 1, def: 50 },
  'noise.luminanceContrast': { min: 0, max: 100, step: 1, def: 0 },
  'noise.color': { min: 0, max: 100, step: 1, def: 0 },
  'noise.colorDetail': { min: 0, max: 100, step: 1, def: 50 },
  'noise.colorSmoothness': { min: 0, max: 100, step: 1, def: 50 },
  'noise.aiDenoiseStrength': { min: 0, max: 100, step: 1, def: 50 },
  'noise.detailPreservation': { min: 0, max: 100, step: 1, def: 50 },
  'lens.profileDistortionScale': { min: 0, max: 200, step: 1, def: 100 },
  'lens.profileVignettingScale': { min: 0, max: 200, step: 1, def: 100 },
  'lens.distortion': { min: -100, max: 100, step: 1, def: 0 },
  'lens.vignetting': { min: -100, max: 100, step: 1, def: 0 },
  'lens.vignettingMidpoint': { min: 0, max: 100, step: 1, def: 50 },
  'lens.defringe.purpleAmount': { min: 0, max: 20, step: 1, def: 0 },
  'lens.defringe.purpleHueMin': { min: 0, max: 360, step: 1, def: 270 },
  'lens.defringe.purpleHueMax': { min: 0, max: 360, step: 1, def: 330 },
  'lens.defringe.greenAmount': { min: 0, max: 20, step: 1, def: 0 },
  'lens.defringe.greenHueMin': { min: 0, max: 360, step: 1, def: 80 },
  'lens.defringe.greenHueMax': { min: 0, max: 360, step: 1, def: 160 },
  'transform.vertical': { min: -100, max: 100, step: 1, def: 0 },
  'transform.horizontal': { min: -100, max: 100, step: 1, def: 0 },
  'transform.rotate': { min: -10, max: 10, step: 0.1, def: 0, fine: 0.01, unit: '°' },
  'transform.aspect': { min: -100, max: 100, step: 1, def: 0 },
  'transform.scale': { min: 50, max: 150, step: 1, def: 100 },
  'transform.offsetX': { min: -100, max: 100, step: 0.1, def: 0 },
  'transform.offsetY': { min: -100, max: 100, step: 0.1, def: 0 },
  'crop.angle': { min: -45, max: 45, step: 0.1, def: 0, fine: 0.01, unit: '°' },
  'effects.vignetteAmount': { min: -100, max: 100, step: 1, def: 0 },
  'effects.vignetteMidpoint': { min: 0, max: 100, step: 1, def: 50 },
  'effects.vignetteRoundness': { min: -100, max: 100, step: 1, def: 0 },
  'effects.vignetteFeather': { min: 0, max: 100, step: 1, def: 50 },
  'effects.vignetteHighlights': { min: 0, max: 100, step: 1, def: 0 },
  'effects.grainAmount': { min: 0, max: 100, step: 1, def: 0 },
  'effects.grainSize': { min: 0, max: 100, step: 1, def: 25 },
  'effects.grainRoughness': { min: 0, max: 100, step: 1, def: 50 },
  'effects.bloom': { min: 0, max: 100, step: 1, def: 0 },
  'effects.glow': { min: 0, max: 100, step: 1, def: 0 },
  'effects.halation': { min: 0, max: 100, step: 1, def: 0 },
};

/** Specs for LocalAdjustments keys (mask adjustment sliders). */
export const LOCAL_SPECS: Record<keyof LocalAdjustments, ParamSpec> = {
  exposure: { min: -4, max: 4, step: 0.01, def: 0, fine: 0.005, unit: 'EV' },
  contrast: { min: -100, max: 100, step: 1, def: 0 },
  highlights: { min: -100, max: 100, step: 1, def: 0 },
  shadows: { min: -100, max: 100, step: 1, def: 0 },
  whites: { min: -100, max: 100, step: 1, def: 0 },
  blacks: { min: -100, max: 100, step: 1, def: 0 },
  temperature: { min: -100, max: 100, step: 1, def: 0 },
  tint: { min: -100, max: 100, step: 1, def: 0 },
  saturation: { min: -100, max: 100, step: 1, def: 0 },
  texture: { min: -100, max: 100, step: 1, def: 0 },
  clarity: { min: -100, max: 100, step: 1, def: 0 },
  dehaze: { min: -100, max: 100, step: 1, def: 0 },
  sharpness: { min: -100, max: 100, step: 1, def: 0 },
  noise: { min: -100, max: 100, step: 1, def: 0 },
};
