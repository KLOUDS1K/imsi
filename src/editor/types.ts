/**
 * KLOUD Web Lightroom — shared data model.
 *
 * This file is the single source of truth for every data shape that crosses a
 * module boundary. Every module imports from here; nobody redefines these.
 *
 * Conventions
 * - All slider values use the Lightroom ranges noted next to each field.
 *   "±100" means -100..100 with 0 = neutral.
 * - Coordinates called "source-normalized" are 0..1 in the decoded SOURCE image
 *   (EXIF orientation already applied at decode time, before any crop/transform).
 *   Masks, heal spots and removal patches are stored in source-normalized space
 *   so they stay attached to the pixels when the user changes crop/transform.
 * - Pixel buffers are always RGBA interleaved (4 channels).
 */

/* ------------------------------------------------------------------ */
/* Primitive helpers                                                   */
/* ------------------------------------------------------------------ */

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type RGB = [number, number, number];
export type RGBA = [number, number, number, number];

/* ------------------------------------------------------------------ */
/* Pixel buffers & photos                                              */
/* ------------------------------------------------------------------ */

/**
 * RGBA interleaved pixel data.
 * - Uint8Array / Uint8ClampedArray: 0..255
 * - Uint16Array: 0..65535
 * - Float32Array: nominal 0..1 (may exceed for HDR/linear data)
 */
export type PixelData = Uint8Array | Uint8ClampedArray | Uint16Array | Float32Array;

export interface PixelBuffer {
  width: number;
  height: number;
  data: PixelData;
  /** Encoding of the values in `data`. */
  transfer: 'srgb' | 'linear';
}

/** 8-bit sRGB RGBA buffer (what readPixels / canvas getImageData return). */
export interface PixelBufferU8 extends PixelBuffer {
  data: Uint8ClampedArray;
  transfer: 'srgb';
}

/** Primaries of the pixel values (the engine converts to its working space). */
export type ColorPrimaries = 'srgb' | 'display-p3' | 'adobe-rgb' | 'prophoto';

export type PhotoFormat = 'jpeg' | 'png' | 'webp' | 'tiff' | 'raw' | 'heic' | 'avif' | 'gif' | 'bmp' | 'unknown';
export type RawFormat = 'ARW' | 'CR2' | 'CR3' | 'NEF' | 'DNG' | 'RAF' | 'ORF' | 'RW2' | 'PEF' | 'SRW' | 'OTHER';

export interface PhotoMeta {
  fileName: string;
  fileSize: number;
  mimeType: string;
  format: PhotoFormat;
  rawFormat?: RawFormat;
  /** Decoded dimensions (after EXIF orientation is applied). */
  width: number;
  height: number;
  /** EXIF orientation (1..8) of the original file. Already applied to the pixels. */
  orientation: number;
  /** Bit depth of the original file data (8, 12, 14, 16, 32). */
  bitDepth: number;
  make?: string;
  model?: string;
  /** Normalized display name, e.g. "Sony α7 IV (ILCE-7M4)". */
  camera?: string;
  lens?: string;
  lensMake?: string;
  /** mm */
  focalLength?: number;
  focalLength35?: number;
  /** f-number */
  aperture?: number;
  /** seconds, e.g. 0.004 for 1/250 */
  shutter?: number;
  iso?: number;
  exposureCompensation?: number;
  flash?: boolean;
  /** ISO-8601 string */
  dateTaken?: string;
  gps?: { lat: number; lon: number; alt?: number };
  artist?: string;
  copyright?: string;
  software?: string;
  colorSpace?: string;
  /** Free-form dump of every parsed tag, for the metadata panel. */
  exif?: Record<string, unknown>;
}

/** A decoded image ready to be uploaded to the GPU. */
export interface SourceImage extends PixelBuffer {
  id: string;
  meta: PhotoMeta;
  isRaw: boolean;
  /** Effective precision of `data`. */
  bitDepth: 8 | 16 | 32;
  primaries: ColorPrimaries;
  /**
   * If this buffer is a reduced-size proxy of a larger original, the size of the
   * original. The engine uses it for export (it asks for the full decode via
   * `DecodedPhoto.loadFull`).
   */
  fullWidth: number;
  fullHeight: number;
}

/** Result of rendering the edit pipeline for export. */
export interface RenderedImage {
  width: number;
  height: number;
  /** RGBA, encoded with the transfer curve of `colorSpace`. */
  data: Uint8ClampedArray | Uint16Array;
  bitDepth: 8 | 16;
  colorSpace: ExportColorSpace;
}

export type ExportColorSpace = 'srgb' | 'display-p3' | 'adobe-rgb';

/* ------------------------------------------------------------------ */
/* Edit parameters (the non-destructive recipe)                        */
/* ------------------------------------------------------------------ */

export interface CurvePoint {
  /** input 0..1 */
  x: number;
  /** output 0..1 */
  y: number;
}

export interface ParametricCurve {
  /** ±100 each region */
  highlights: number;
  lights: number;
  darks: number;
  shadows: number;
  /** Region split points 0..100 (defaults 25 / 50 / 75). split1 < split2 < split3. */
  split1: number;
  split2: number;
  split3: number;
}

export interface ToneCurveParams {
  /** Point curves. Always at least two points, sorted by x, endpoints may move. */
  rgb: CurvePoint[];
  red: CurvePoint[];
  green: CurvePoint[];
  blue: CurvePoint[];
  /** Applied before the point curves (Lightroom order). */
  parametric: ParametricCurve;
}

export const HSL_CHANNELS = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'] as const;
export type HslChannel = (typeof HSL_CHANNELS)[number];
/** Center hue (degrees) of each HSL band — shared by the engine, analysis and UI. */
export const HSL_CENTERS: Record<HslChannel, number> = {
  red: 0,
  orange: 30,
  yellow: 60,
  green: 120,
  aqua: 180,
  blue: 240,
  purple: 275,
  magenta: 315,
};

export interface HslValue {
  /** ±100 each */
  hue: number;
  saturation: number;
  luminance: number;
}

export interface GradeWheel {
  /** 0..360 */
  hue: number;
  /** 0..100 */
  saturation: number;
  /** ±100 */
  luminance: number;
}

export type AspectPreset = 'free' | 'original' | '1:1' | '3:2' | '4:3' | '5:4' | '16:9' | '4:5' | '2:3' | 'custom';
export type CropOverlay = 'none' | 'thirds' | 'golden-ratio' | 'golden-spiral' | 'grid' | 'diagonal';
export type UprightMode = 'off' | 'auto' | 'level' | 'vertical' | 'full';

export interface BasicParams {
  /** EV, -5..5 */
  exposure: number;
  /** ±100 */
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
}

export interface WhiteBalanceParams {
  mode: 'as-shot' | 'auto' | 'custom';
  /** ±100 relative, positive = warmer. See color/math.ts `wbGains`. */
  temperature: number;
  /** ±100 relative, positive = magenta. */
  tint: number;
}

export interface ColorParams {
  /** ±100 */
  vibrance: number;
  saturation: number;
}

export interface ColorGradingParams {
  shadows: GradeWheel;
  midtones: GradeWheel;
  highlights: GradeWheel;
  global: GradeWheel;
  /** 0..100, default 50 */
  blending: number;
  /** ±100, default 0 */
  balance: number;
}

export interface CalibrationParams {
  /** ±100 each */
  shadowsTint: number;
  redHue: number;
  redSaturation: number;
  greenHue: number;
  greenSaturation: number;
  blueHue: number;
  blueSaturation: number;
}

export interface PresenceParams {
  /** ±100 each */
  texture: number;
  clarity: number;
  dehaze: number;
  structure: number;
  localContrast: number;
}

export interface DetailParams {
  /** 0..150, default 40 for RAW, 0 for JPEG */
  sharpenAmount: number;
  /** 0.5..3.0 px, default 1.0 */
  sharpenRadius: number;
  /** 0..100, default 25 */
  sharpenDetail: number;
  /** 0..100, default 0 */
  sharpenMasking: number;
}

export interface NoiseParams {
  /** 0..100 */
  luminance: number;
  /** 0..100, default 50 */
  luminanceDetail: number;
  /** 0..100, default 0 */
  luminanceContrast: number;
  /** 0..100, default 25 for RAW, 0 for JPEG */
  color: number;
  /** 0..100, default 50 */
  colorDetail: number;
  /** 0..100, default 50 */
  colorSmoothness: number;
  /** Heavier multi-scale edge-aware denoiser (stored under the legacy AI key). */
  aiDenoise: boolean;
  /** 0..100, default 50 */
  aiDenoiseStrength: number;
  /** 0..100, default 50 — how much fine detail the smart denoiser keeps. */
  detailPreservation: number;
}

export interface DefringeParams {
  /** 0..20 */
  purpleAmount: number;
  /** hue degrees, defaults 270..330 */
  purpleHueMin: number;
  purpleHueMax: number;
  /** 0..20 */
  greenAmount: number;
  /** hue degrees, defaults 80..160 */
  greenHueMin: number;
  greenHueMax: number;
}

export interface LensParams {
  /** Apply the (auto-detected or chosen) lens profile. */
  profileEnabled: boolean;
  /** Lens profile id from lens/profiles.ts, or null = auto-detect from metadata. */
  profileId: string | null;
  /** 0..200, default 100 — scales the profile's distortion correction. */
  profileDistortionScale: number;
  /** 0..200, default 100 — scales the profile's vignetting correction. */
  profileVignettingScale: number;
  /** Manual distortion ±100 (positive removes barrel distortion). */
  distortion: number;
  /** Manual lens vignetting correction ±100 (positive brightens corners). */
  vignetting: number;
  /** 0..100, default 50 */
  vignettingMidpoint: number;
  /** Lateral chromatic aberration removal. */
  removeCA: boolean;
  defringe: DefringeParams;
}

export interface TransformParams {
  upright: UprightMode;
  /** ±100 keystone (vertical perspective) */
  vertical: number;
  /** ±100 keystone (horizontal perspective) */
  horizontal: number;
  /** -10..10 degrees fine rotation */
  rotate: number;
  /** ±100 */
  aspect: number;
  /** 50..150, default 100 */
  scale: number;
  /** ±100 */
  offsetX: number;
  offsetY: number;
}

export interface CropParams {
  /**
   * Crop rectangle, normalized 0..1, in the "frame" space: the image after
   * lens correction, 90° orientation, flips, straighten angle and transform —
   * i.e. the uncropped output. Default {0,0,1,1}.
   */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Straighten angle, degrees, -45..45 */
  angle: number;
  aspect: AspectPreset;
  /** Used when aspect === 'custom', e.g. [5, 7] */
  customAspect: [number, number];
  /** Clockwise 90° steps */
  orientation: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
  /** Keep the crop inside the valid image area when rotating/transforming. */
  constrainToImage: boolean;
  /** UI preference persisted with the edit. */
  overlay: CropOverlay;
}

export interface EffectsParams {
  /** Post-crop vignette ±100 */
  vignetteAmount: number;
  /** 0..100, default 50 */
  vignetteMidpoint: number;
  /** ±100, default 0 */
  vignetteRoundness: number;
  /** 0..100, default 50 */
  vignetteFeather: number;
  /** 0..100, default 0 — protects highlights when darkening */
  vignetteHighlights: number;
  /** 0..100 */
  grainAmount: number;
  /** 0..100, default 25 */
  grainSize: number;
  /** 0..100, default 50 */
  grainRoughness: number;
  /** Bloom amount, 0..100. */
  bloom: number;
  /** Brightness gate for bloom, 0 = midtones, 100 = only the hottest highlights. */
  bloomThreshold: number;
  /** Bloom spread, 0 = tight, 100 = very wide. */
  bloomRadius: number;
  /** 0..100 each */
  glow: number;
  halation: number;
}

/* ---------------------------- Masks -------------------------------- */

export type MaskComponentKind = 'brush' | 'linear' | 'radial' | 'color-range' | 'luminance-range' | 'depth-range' | 'ai';
export type MaskMode = 'add' | 'subtract' | 'intersect';

export const AI_MASK_TARGETS = [
  'subject',
  'background',
  'sky',
  'person',
  'face',
  'skin',
  'hair',
  'clothes',
  'object',
  'motorcycle',
  'car',
] as const;
export type AiMaskTarget = (typeof AI_MASK_TARGETS)[number];

export interface BrushPoint {
  /** source-normalized */
  x: number;
  y: number;
  /** 0..1, default 1 */
  pressure?: number;
}

export interface BrushStroke {
  points: BrushPoint[];
  /** Brush radius as a fraction of the source image's long edge (e.g. 0.02). */
  size: number;
  /** 0..100 */
  feather: number;
  /** 0..100 — per-dab opacity */
  flow: number;
  /** 0..100 — max accumulated opacity of this stroke */
  density: number;
  /** Eraser stroke (subtracts from the brush component). */
  erase: boolean;
}

export interface LinearGradientParams {
  /** source-normalized: mask = 1 at (x0,y0) fading to 0 at (x1,y1) */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface RadialGradientParams {
  /** source-normalized center */
  cx: number;
  cy: number;
  /** radii as a fraction of the source image's width (rx) and height (ry) */
  rx: number;
  ry: number;
  /** rotation in degrees */
  angle: number;
  /** 0..100 */
  feather: number;
}

export interface ColorRangeParams {
  /** sampled colors, sRGB 0..1 */
  samples: RGB[];
  /** 0..100, default 50 */
  range: number;
}

export interface LuminanceRangeParams {
  /** 0..1 luminance bounds of full coverage */
  min: number;
  max: number;
  /** 0..1 feather below min / above max */
  featherLow: number;
  featherHigh: number;
}

export interface DepthRangeParams {
  /** 0..1 (0 = near, 1 = far) */
  min: number;
  max: number;
  /** 0..1 */
  feather: number;
}

export interface AiMaskParams {
  target: AiMaskTarget;
  /** Expand (+) or contract (-) the detected boundary, -100..100. */
  edgeShift?: number;
  /** Additional edge softness, 0..100. */
  feather?: number;
  /** For target 'object': a click point or a box, source-normalized. */
  point?: Point;
  box?: Rect;
  /**
   * Key into the AI mask bitmap store (see contracts.AiMaskStore). The bitmap
   * is recomputed on demand when missing, so the key may be regenerated.
   */
  bitmapKey?: string;
}

export interface MaskComponent {
  id: string;
  kind: MaskComponentKind;
  mode: MaskMode;
  invert: boolean;
  brush?: { strokes: BrushStroke[] };
  linear?: LinearGradientParams;
  radial?: RadialGradientParams;
  colorRange?: ColorRangeParams;
  luminanceRange?: LuminanceRangeParams;
  depthRange?: DepthRangeParams;
  ai?: AiMaskParams;
}

export interface LocalAdjustments {
  /** EV -4..4 */
  exposure: number;
  /** ±100 each */
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  temperature: number;
  tint: number;
  saturation: number;
  texture: number;
  clarity: number;
  dehaze: number;
  sharpness: number;
  /** ±100 (positive = denoise) */
  noise: number;
}

export interface Mask {
  id: string;
  name: string;
  visible: boolean;
  /** Combined in order with each component's mode. The first component's mode is treated as 'add'. */
  components: MaskComponent[];
  /** Global invert of the combined mask. */
  invert: boolean;
  /** 0..100, default 100 — scales every adjustment of this mask. */
  amount: number;
  adjustments: LocalAdjustments;
}

/* --------------------------- Retouch ------------------------------- */

export type HealKind = 'heal' | 'clone' | 'content-aware';

export interface HealSpot {
  id: string;
  kind: HealKind;
  /** Destination center, source-normalized */
  x: number;
  y: number;
  /** Source center, source-normalized (auto-picked for 'content-aware') */
  sx: number;
  sy: number;
  /** Radius as a fraction of the source image's long edge */
  radius: number;
  /** 0..100 */
  feather: number;
  /** 0..100 */
  opacity: number;
}

export type RemovalKind = 'ai-remove' | 'generative' | 'dust';

/**
 * A region filled by the inpainting module. The filled pixels live in the
 * PatchStore under `patchKey` (RGBA, alpha = coverage) covering `bbox`.
 */
export interface RemovalPatch {
  id: string;
  kind: RemovalKind;
  /** source-normalized bounding box of the patch */
  bbox: Rect;
  /** The user's brush strokes that defined the region (for recompute). */
  strokes: BrushStroke[];
  patchKey: string;
}

export interface RetouchParams {
  spots: HealSpot[];
  removals: RemovalPatch[];
}

/* ---------------------------- Root --------------------------------- */

export interface EditParams {
  version: 1;
  basic: BasicParams;
  whiteBalance: WhiteBalanceParams;
  color: ColorParams;
  hsl: Record<HslChannel, HslValue>;
  toneCurve: ToneCurveParams;
  colorGrading: ColorGradingParams;
  calibration: CalibrationParams;
  presence: PresenceParams;
  detail: DetailParams;
  noise: NoiseParams;
  lens: LensParams;
  transform: TransformParams;
  crop: CropParams;
  effects: EffectsParams;
  masks: Mask[];
  retouch: RetouchParams;
}

/**
 * Setting groups used by partial presets, copy/paste, sync and "selective sync".
 * Each maps to one top-level key of EditParams except 'exposure' (basic.exposure
 * only) and 'tone' (basic minus exposure) which exist for the "Exposure Sync" use case.
 */
export const SETTINGS_GROUPS = [
  'exposure',
  'tone',
  'whiteBalance',
  'color',
  'hsl',
  'toneCurve',
  'colorGrading',
  'calibration',
  'presence',
  'detail',
  'noise',
  'lens',
  'transform',
  'crop',
  'effects',
  'masks',
  'retouch',
] as const;
export type SettingsGroup = (typeof SETTINGS_GROUPS)[number];

/** Recursive partial used by presets and AI outputs. */
export type DeepPartial<T> = T extends (infer U)[]
  ? U[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

export type PartialParams = DeepPartial<EditParams>;

/* ------------------------------------------------------------------ */
/* History / snapshots                                                 */
/* ------------------------------------------------------------------ */

export interface HistoryEntry {
  id: number;
  label: string;
  params: EditParams;
  time: number;
}

export interface Snapshot {
  id: string;
  name: string;
  params: EditParams;
  created: number;
}

/** What gets persisted per photo (IndexedDB 'edits' store / sidecar file). */
export interface SerializedEditState {
  format: 'kloud-edit';
  version: 1;
  params: EditParams;
  /** Trimmed history (most recent N entries). */
  history: HistoryEntry[];
  historyIndex: number;
  snapshots: Snapshot[];
  updated: number;
}

/* ------------------------------------------------------------------ */
/* Presets                                                             */
/* ------------------------------------------------------------------ */

export interface PresetConditions {
  /** case-insensitive substring or /regex/ matched against meta.camera/model */
  camera?: string;
  lens?: string;
  isoMin?: number;
  isoMax?: number;
  /** auto-apply on import when conditions match */
  autoApply?: boolean;
}

export interface Preset {
  id: string;
  name: string;
  /** Folder name in the presets panel, e.g. "KLOUD", "User Presets". */
  group: string;
  builtin: boolean;
  /** Which setting groups this preset touches (partial preset). */
  groups: SettingsGroup[];
  params: PartialParams;
  conditions?: PresetConditions;
  created: number;
  updated: number;
}

/* ------------------------------------------------------------------ */
/* Library                                                             */
/* ------------------------------------------------------------------ */

export type ColorLabel = 'red' | 'yellow' | 'green' | 'blue' | 'purple';
export type PickFlag = 'none' | 'pick' | 'reject';

export interface PhotoRecord {
  id: string;
  name: string;
  /** Virtual folder path, e.g. "2026/Seoul Night" (from webkitRelativePath or user). */
  folder: string;
  size: number;
  type: string;
  added: number;
  modified: number;
  meta: PhotoMeta;
  /** 0..5 */
  rating: number;
  flag: PickFlag;
  label: ColorLabel | null;
  favorite: boolean;
  albumIds: string[];
  hasEdits: boolean;
  editedAt?: number;
}

export interface Album {
  id: string;
  name: string;
  created: number;
  coverId?: string;
}

export type LibrarySort =
  | 'date-taken'
  | 'date-added'
  | 'edited'
  | 'name'
  | 'rating'
  | 'size'
  | 'camera'
  | 'iso'
  | 'focal-length';

export interface LibraryQuery {
  text?: string;
  albumId?: string;
  folder?: string;
  favorite?: boolean;
  minRating?: number;
  flag?: PickFlag | 'any';
  labels?: ColorLabel[];
  camera?: string;
  lens?: string;
  isoRange?: [number, number];
  apertureRange?: [number, number];
  /** seconds */
  shutterRange?: [number, number];
  focalRange?: [number, number];
  /** ISO date strings (inclusive) */
  dateRange?: [string, string];
  /** 'recent' = edited in the last 7 days */
  edited?: 'edited' | 'unedited' | 'recent';
  sort?: LibrarySort;
  order?: 'asc' | 'desc';
}

/* ------------------------------------------------------------------ */
/* Export & watermark                                                  */
/* ------------------------------------------------------------------ */

export type WatermarkPosition =
  | 'top-left'
  | 'top'
  | 'top-right'
  | 'left'
  | 'center'
  | 'right'
  | 'bottom-left'
  | 'bottom'
  | 'bottom-right';

export type WatermarkBlendMode = 'normal' | 'multiply' | 'screen' | 'overlay' | 'soft-light' | 'difference';

export interface WatermarkSettings {
  enabled: boolean;
  /** 'kloud' renders "KLOUD", 'kloud-photography' renders "KLOUD.PHOTOGRAPHY" in the house style. */
  kind: 'text' | 'image' | 'kloud' | 'kloud-photography';
  text: string;
  fontFamily: string;
  fontWeight: number;
  /** CSS color */
  color: string;
  /** letter spacing in em */
  letterSpacing: number;
  /** Logo image as a data: URL (persistable). */
  imageDataUrl: string | null;
  position: WatermarkPosition;
  /** Size as % of the image's short edge (1..50). For text: cap height; for images: width. */
  size: number;
  /** 0..100 */
  opacity: number;
  blendMode: WatermarkBlendMode;
  /** Margin as % of the image's short edge (0..20). */
  margin: number;
  shadow: boolean;
}

export type ResizeMode = 'none' | 'long-edge' | 'short-edge' | 'width' | 'height' | 'dimensions' | 'megapixels';

export interface ExportSettings {
  format: 'jpeg' | 'png' | 'webp' | 'tiff' | 'dng';
  /** 1..100 (jpeg/webp) */
  quality: number;
  /** png/tiff/dng may be 16 */
  bitDepth: 8 | 16;
  resize: {
    mode: ResizeMode;
    /** px for edge modes, MP for 'megapixels' */
    value: number;
    width: number;
    height: number;
    dontEnlarge: boolean;
  };
  dpi: number;
  colorSpace: ExportColorSpace;
  metadata: 'all' | 'copyright' | 'copyright-contact' | 'none';
  removeLocation: boolean;
  copyright: string;
  artist: string;
  watermark: WatermarkSettings;
  outputSharpening: {
    enabled: boolean;
    target: 'screen' | 'matte' | 'glossy';
    amount: 'low' | 'standard' | 'high';
  };
  /** Tokens: {name} {seq} {date} {camera} {lens} {iso} {rating} {width} {height} {preset} */
  fileNameTemplate: string;
  sequenceStart: number;
}

/* ------------------------------------------------------------------ */
/* Analysis                                                            */
/* ------------------------------------------------------------------ */

export interface Histogram {
  /** 256 bins each */
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  lum: Uint32Array;
  total: number;
  /** fraction 0..1 of pixels with any channel at 255 / at 0 */
  clippedHighlights: number;
  clippedShadows: number;
  clip: { r: [number, number]; g: [number, number]; b: [number, number] };
}

export type SceneLabel =
  | 'portrait'
  | 'group'
  | 'landscape'
  | 'cityscape'
  | 'night'
  | 'sunset'
  | 'street'
  | 'architecture'
  | 'vehicle'
  | 'food'
  | 'macro'
  | 'indoor'
  | 'snow'
  | 'beach'
  | 'general';

export interface ImageAnalysis {
  exposure: { meanLum: number; medianLum: number; p01: number; p99: number; evOffset: number; verdict: 'under' | 'ok' | 'over' };
  dynamicRange: { stops: number; clippedHighlights: number; clippedShadows: number; contrast: number };
  whiteBalance: { temperature: number; tint: number; confidence: number; castDescription: string };
  color: { colorfulness: number; meanSaturation: number; dominantHues: { hue: number; weight: number }[] };
  noise: { level: number; sigma: number };
  sharpness: { score: number; blurry: boolean };
  subject: { box: Rect; confidence: number };
  background: { clutter: number; brightnessDelta: number };
  sky: { fraction: number; present: boolean; box: Rect | null };
  scene: { label: SceneLabel; confidence: number; tags: string[] };
  /** Human-readable findings for the AI panel. */
  notes: string[];
}

export interface DetectedObject {
  label: string;
  score: number;
  /** source-normalized */
  box: Rect;
}

/** Single-channel coverage bitmap (0..255) in SOURCE space. */
export interface MaskBitmap {
  width: number;
  height: number;
  data: Uint8Array;
  /** Stable content key (used as a GPU texture cache key). */
  key: string;
}

/* ------------------------------------------------------------------ */
/* Personal style (KLOUD Style)                                        */
/* ------------------------------------------------------------------ */

export interface StylePair {
  id: string;
  modelId: string;
  name: string;
  /** Small JPEG thumbnails for the dataset browser. */
  originalThumb: Blob | null;
  editedThumb: Blob | null;
  /** Feature vector of the ORIGINAL image (analysis/style features). */
  features: number[];
  /** Estimated (external pair) or exact (in-app edit) parameters. */
  params: PartialParams;
  source: 'pair' | 'app-edit' | 'feedback';
  weight: number;
  created: number;
}

export interface StyleModel {
  id: string;
  name: string;
  builtin: boolean;
  created: number;
  trained: number;
  pairCount: number;
  /** Ordered parameter paths predicted by this model (e.g. "basic.exposure"). */
  paramPaths: string[];
  /** Ridge-regression weights: paramPaths.length rows × (features+1) cols, row-major. */
  weights: number[];
  featureMean: number[];
  featureStd: number[];
  /** Fallback mean parameter vector (used when there are too few pairs). */
  baseline: number[];
  /** Which aspects the user enabled for learning. */
  learn: { exposure: boolean; color: boolean; toneCurve: boolean; hsl: boolean; masks: boolean };
}
