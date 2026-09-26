/**
 * Human-readable labels for parameter paths and history entries.
 *   labelForPath('basic.exposure')                  → 'Exposure'
 *   labelForPath('masks.0.adjustments.exposure')    → 'Mask 1: Exposure'
 *   changeLabel('basic.exposure', 0.35)             → 'Exposure +0.35'
 */
import type { HslChannel } from '@/editor/types';
import { specForPath } from './specs';

const LABELS: Record<string, string> = {
  version: 'Version',
  basic: 'Basic',
  'basic.exposure': 'Exposure',
  'basic.contrast': 'Contrast',
  'basic.highlights': 'Highlights',
  'basic.shadows': 'Shadows',
  'basic.whites': 'Whites',
  'basic.blacks': 'Blacks',
  whiteBalance: 'White Balance',
  'whiteBalance.mode': 'White Balance',
  'whiteBalance.temperature': 'Temp',
  'whiteBalance.tint': 'Tint',
  color: 'Color',
  'color.vibrance': 'Vibrance',
  'color.saturation': 'Saturation',
  hsl: 'HSL / Color',
  toneCurve: 'Tone Curve',
  'toneCurve.rgb': 'Tone Curve',
  'toneCurve.red': 'Tone Curve (Red)',
  'toneCurve.green': 'Tone Curve (Green)',
  'toneCurve.blue': 'Tone Curve (Blue)',
  'toneCurve.parametric': 'Parametric Curve',
  'toneCurve.parametric.highlights': 'Curve Highlights',
  'toneCurve.parametric.lights': 'Curve Lights',
  'toneCurve.parametric.darks': 'Curve Darks',
  'toneCurve.parametric.shadows': 'Curve Shadows',
  'toneCurve.parametric.split1': 'Curve Shadow Split',
  'toneCurve.parametric.split2': 'Curve Midtone Split',
  'toneCurve.parametric.split3': 'Curve Highlight Split',
  colorGrading: 'Color Grading',
  'colorGrading.blending': 'Grading Blending',
  'colorGrading.balance': 'Grading Balance',
  calibration: 'Calibration',
  'calibration.shadowsTint': 'Calibration Shadows Tint',
  'calibration.redHue': 'Red Primary Hue',
  'calibration.redSaturation': 'Red Primary Saturation',
  'calibration.greenHue': 'Green Primary Hue',
  'calibration.greenSaturation': 'Green Primary Saturation',
  'calibration.blueHue': 'Blue Primary Hue',
  'calibration.blueSaturation': 'Blue Primary Saturation',
  presence: 'Presence',
  'presence.texture': 'Texture',
  'presence.clarity': 'Clarity',
  'presence.dehaze': 'Dehaze',
  'presence.structure': 'Structure',
  'presence.localContrast': 'Local Contrast',
  detail: 'Sharpening',
  'detail.sharpenAmount': 'Sharpening',
  'detail.sharpenRadius': 'Sharpen Radius',
  'detail.sharpenDetail': 'Sharpen Detail',
  'detail.sharpenMasking': 'Sharpen Masking',
  noise: 'Noise Reduction',
  'noise.luminance': 'Noise Reduction',
  'noise.luminanceDetail': 'Noise Reduction Detail',
  'noise.luminanceContrast': 'Noise Reduction Contrast',
  'noise.color': 'Color Noise Reduction',
  'noise.colorDetail': 'Color Noise Detail',
  'noise.colorSmoothness': 'Color Noise Smoothness',
  'noise.aiDenoise': 'Smart Denoise',
  'noise.aiDenoiseStrength': 'Smart Denoise Strength',
  'noise.detailPreservation': 'Detail Preservation',
  lens: 'Lens Corrections',
  'lens.profileEnabled': 'Lens Profile Corrections',
  'lens.profileId': 'Lens Profile',
  'lens.profileDistortionScale': 'Profile Distortion',
  'lens.profileVignettingScale': 'Profile Vignetting',
  'lens.distortion': 'Distortion',
  'lens.vignetting': 'Lens Vignetting',
  'lens.vignettingMidpoint': 'Lens Vignetting Midpoint',
  'lens.removeCA': 'Remove Chromatic Aberration',
  'lens.defringe': 'Defringe',
  'lens.defringe.purpleAmount': 'Purple Amount',
  'lens.defringe.purpleHueMin': 'Purple Hue Min',
  'lens.defringe.purpleHueMax': 'Purple Hue Max',
  'lens.defringe.greenAmount': 'Green Amount',
  'lens.defringe.greenHueMin': 'Green Hue Min',
  'lens.defringe.greenHueMax': 'Green Hue Max',
  transform: 'Transform',
  'transform.upright': 'Upright',
  'transform.vertical': 'Vertical',
  'transform.horizontal': 'Horizontal',
  'transform.rotate': 'Rotate',
  'transform.aspect': 'Aspect',
  'transform.scale': 'Scale',
  'transform.offsetX': 'X Offset',
  'transform.offsetY': 'Y Offset',
  crop: 'Crop',
  'crop.x': 'Crop',
  'crop.y': 'Crop',
  'crop.w': 'Crop',
  'crop.h': 'Crop',
  'crop.angle': 'Straighten',
  'crop.aspect': 'Crop Aspect',
  'crop.customAspect': 'Crop Aspect',
  'crop.orientation': 'Rotate',
  'crop.flipH': 'Flip Horizontal',
  'crop.flipV': 'Flip Vertical',
  'crop.constrainToImage': 'Constrain to Image',
  'crop.overlay': 'Crop Overlay',
  effects: 'Effects',
  'effects.vignetteAmount': 'Vignette',
  'effects.vignetteMidpoint': 'Vignette Midpoint',
  'effects.vignetteRoundness': 'Vignette Roundness',
  'effects.vignetteFeather': 'Vignette Feather',
  'effects.vignetteHighlights': 'Vignette Highlights',
  'effects.grainAmount': 'Grain',
  'effects.grainSize': 'Grain Size',
  'effects.grainRoughness': 'Grain Roughness',
  'effects.bloom': 'Bloom',
  'effects.glow': 'Glow',
  'effects.halation': 'Halation',
  masks: 'Masks',
  retouch: 'Retouch',
  'retouch.spots': 'Spot Removal',
  'retouch.removals': 'Remove',
};

const WHEEL_NAMES: Record<string, string> = {
  shadows: 'Shadows',
  midtones: 'Midtones',
  highlights: 'Highlights',
  global: 'Global',
};

const COMPONENT_LABELS: Record<string, string> = {
  brush: 'Brush',
  linear: 'Linear Gradient',
  radial: 'Radial Gradient',
  colorRange: 'Color Range',
  luminanceRange: 'Luminance Range',
  depthRange: 'Depth Range',
  ai: 'AI Mask',
};

const MASK_FIELD_LABELS: Record<string, string> = {
  name: 'Rename',
  visible: 'Visibility',
  invert: 'Invert',
  amount: 'Amount',
  components: 'Edit',
  adjustments: 'Adjustments',
  id: 'Edit',
};

const ADJ_LABELS: Record<string, string> = {
  exposure: 'Exposure',
  contrast: 'Contrast',
  highlights: 'Highlights',
  shadows: 'Shadows',
  whites: 'Whites',
  blacks: 'Blacks',
  temperature: 'Temp',
  tint: 'Tint',
  saturation: 'Saturation',
  texture: 'Texture',
  clarity: 'Clarity',
  dehaze: 'Dehaze',
  sharpness: 'Sharpness',
  noise: 'Noise',
};

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** "localContrast" → "Local Contrast", "profileId" → "Profile Id". */
export function humanize(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map(cap)
    .join(' ');
}

export function labelForPath(path: string): string {
  if (path === '' || path === '*') return 'All Settings';
  const direct = LABELS[path];
  if (direct) return direct;
  const seg = path.split('.');
  switch (seg[0]) {
    case 'hsl': {
      const ch = cap(seg[1] as HslChannel);
      if (seg.length === 2) return `HSL ${ch}`;
      return `${ch} ${cap(seg[2])}`;
    }
    case 'colorGrading': {
      const wheel = WHEEL_NAMES[seg[1]];
      if (wheel) return seg.length === 2 ? `Color Grade ${wheel}` : `Color Grade ${wheel} ${cap(seg[2])}`;
      break;
    }
    case 'toneCurve':
      // Individual points: 'toneCurve.rgb.2.y'
      if (seg.length > 2 && LABELS[`toneCurve.${seg[1]}`]) return LABELS[`toneCurve.${seg[1]}`];
      break;
    case 'crop':
      if (seg[1] === 'customAspect') return 'Crop Aspect';
      break;
    case 'masks':
      return maskLabel(seg);
    case 'retouch':
      if (seg[1] === 'spots') return 'Spot Removal';
      if (seg[1] === 'removals') return 'Remove';
      return 'Retouch';
  }
  // Nested unknown leaf of a known parent: fall back to the nearest labelled ancestor.
  for (let i = seg.length - 1; i > 0; i--) {
    const parent = LABELS[seg.slice(0, i).join('.')];
    if (parent && i >= 2) return parent;
  }
  return humanize(seg[seg.length - 1]);
}

function maskLabel(seg: string[], maskName?: string): string {
  if (seg.length === 1) return 'Masks';
  const idx = Number(seg[1]);
  const name = maskName ?? (Number.isInteger(idx) ? `Mask ${idx + 1}` : 'Mask');
  if (seg.length === 2) return name;
  const field = seg[2];
  if (field === 'adjustments' && seg[3]) return `${name}: ${ADJ_LABELS[seg[3]] ?? humanize(seg[3])}`;
  if (field === 'components' && seg.length >= 5) {
    const comp = COMPONENT_LABELS[seg[4]];
    if (comp) return `${name}: ${comp}`;
    if (seg[4] === 'invert') return `${name}: Invert Component`;
    if (seg[4] === 'mode') return `${name}: Component Mode`;
  }
  return `${name}: ${MASK_FIELD_LABELS[field] ?? humanize(field)}`;
}

/** Same as labelForPath but uses the mask's actual name ("Sky: Exposure"). */
export function labelForPathWithMaskName(path: string, maskName: string | undefined): string {
  const seg = path.split('.');
  if (seg[0] === 'masks' && seg.length >= 2 && maskName) return maskLabel(seg, maskName);
  return labelForPath(path);
}

const trimZeros = (s: string) => (s.includes('.') ? s.replace(/\.?0+$/, '') : s);

/** Short value string for history labels ('' when not meaningful, e.g. objects). */
export function formatValue(path: string, value: unknown): string {
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (typeof value === 'string') return value.split('-').map(cap).join(' ');
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  if (path === 'crop.orientation') return `${value}°`;
  if (/^crop\.[xywh]$/.test(path)) return '';
  const spec = specForPath(path);
  const signed = !!spec && spec.min < 0;
  let decimals = 0;
  if (spec?.unit === 'EV') decimals = 2;
  else if (spec && spec.step < 1) decimals = spec.step < 0.1 ? 2 : 1;
  let s = value.toFixed(decimals);
  if (decimals > 0 && spec?.unit !== 'EV') s = trimZeros(s);
  if (Number(s) === 0) s = decimals && spec?.unit === 'EV' ? (0).toFixed(decimals) : '0';
  else if (signed && value > 0) s = `+${s}`;
  return spec?.unit === '°' ? `${s}°` : s;
}

/** "Exposure +0.35", "Tone Curve", "Mask 1: Brush". */
export function changeLabel(path: string, value: unknown, maskName?: string): string {
  const base = labelForPathWithMaskName(path, maskName);
  const v = formatValue(path, value);
  return v ? `${base} ${v}` : base;
}
