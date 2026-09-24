/**
 * Module contracts. Each module's index.ts must export the named members listed
 * in its interface below and end with a compile-time conformance check, e.g.
 *
 *   export const ioModule = { decodeFile, readMetadata, ... } satisfies IoModule;
 *
 * Callers import the named functions directly from the module index
 * (`import { decodeFile } from '@/editor/io'`). If a contract turns out to be
 * wrong, change it HERE (and tell the other owners in ARCHITECTURE.md), never
 * silently diverge.
 */
import type {
  Album,
  AiMaskTarget,
  BrushStroke,
  ColorLabel,
  DetectedObject,
  EditParams,
  ExportColorSpace,
  ExportSettings,
  HealSpot,
  Histogram,
  ImageAnalysis,
  LibraryQuery,
  Mask,
  MaskBitmap,
  PartialParams,
  PhotoMeta,
  PhotoRecord,
  PixelBuffer,
  PixelBufferU8,
  Point,
  Preset,
  Rect,
  RemovalPatch,
  RenderedImage,
  RGB,
  SerializedEditState,
  SettingsGroup,
  Snapshot,
  HistoryEntry,
  SourceImage,
  StyleModel,
  StylePair,
  WatermarkSettings,
} from './types';

/* ================================================================== */
/* state/ — EditorStore, params math, serialization, presets           */
/* ================================================================== */

export interface SetOptions {
  /** History label, defaults to a readable name derived from the path. */
  label?: string;
  /**
   * Merge into the previous history entry when it has the same coalesce key
   * and was created < 1.2 s ago (slider drags, wheel ticks). Defaults to the path.
   */
  coalesceKey?: string | null;
  /** Update params without creating a history entry. */
  transient?: boolean;
}

export interface ChangeInfo {
  label: string;
  /** Dot paths that changed ('*' for whole-object replace/undo/redo). */
  paths: string[];
  source: 'set' | 'update' | 'replace' | 'undo' | 'redo' | 'history' | 'snapshot' | 'reset' | 'load';
  /** True while a gesture (drag) is in progress: listeners may render in draft quality. */
  interactive: boolean;
}

/** src/editor/state/store.ts → `export class EditorStore implements EditorStoreApi` */
export interface EditorStoreApi {
  readonly params: EditParams;
  get<T = unknown>(path: string): T;
  set(path: string, value: unknown, opts?: SetOptions): void;
  update(label: string, mutator: (draft: EditParams) => void, opts?: SetOptions): void;
  replace(params: EditParams, label: string): void;
  /** Group everything until endGesture() into ONE history entry; marks changes interactive. */
  beginGesture(label: string): void;
  endGesture(): void;
  readonly gestureActive: boolean;
  undo(): boolean;
  redo(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  readonly history: readonly HistoryEntry[];
  readonly historyIndex: number;
  goToHistory(index: number): void;
  clearHistory(): void;
  readonly snapshots: readonly Snapshot[];
  createSnapshot(name: string): Snapshot;
  applySnapshot(id: string): void;
  deleteSnapshot(id: string): void;
  renameSnapshot(id: string, name: string): void;
  /** "Original Reset": back to createDefaultParams(isRaw) (history keeps the step). */
  reset(label?: string): void;
  subscribe(fn: (params: EditParams, info: ChangeInfo) => void): () => void;
  serialize(): SerializedEditState;
  load(state: SerializedEditState): void;
}

/** src/editor/state/index.ts */
export interface StateModule {
  EditorStore: new (initial?: EditParams, opts?: { isRaw?: boolean; maxHistory?: number }) => EditorStoreApi;
  /** Group → dot paths it owns. */
  GROUP_PATHS: Record<SettingsGroup, string[]>;
  cloneParams(p: EditParams): EditParams;
  getPath(obj: unknown, path: string): unknown;
  setPath<T extends object>(obj: T, path: string, value: unknown): T;
  /** Fill missing fields with defaults, clamp ranges, migrate old versions. */
  normalizeParams(input: unknown, isRaw?: boolean): EditParams;
  /** Deep-merge a partial on top of base (arrays replace). Optionally only for `groups`. */
  applyPartial(base: EditParams, partial: PartialParams, groups?: SettingsGroup[]): EditParams;
  pickGroups(params: EditParams, groups: SettingsGroup[]): PartialParams;
  /** Interpolate numeric fields a→b (t may exceed 1 for "strength" up to 2). Curves and wheels interpolate too. */
  lerpParams(a: EditParams, b: EditParams, t: number): EditParams;
  diffPaths(a: EditParams, b: EditParams): string[];
  isDefaultParams(p: EditParams, isRaw?: boolean): boolean;
  /** Which groups differ from defaults (for "Copy Settings" defaults). */
  modifiedGroups(p: EditParams, isRaw?: boolean): SettingsGroup[];
  /** Human label for a path, e.g. 'basic.exposure' → 'Exposure'. */
  labelForPath(path: string): string;
  /** Lightroom Classic/CC compatibility (crs: namespace). */
  paramsToXmp(params: EditParams, meta?: Partial<PhotoMeta>): string;
  xmpToParams(xml: string): { params: PartialParams; groups: SettingsGroup[]; name?: string };
  serializeEditFile(state: SerializedEditState): Blob;
  parseEditFile(text: string): SerializedEditState;
}

/** src/editor/presets/index.ts */
export interface PresetsModule {
  BUILTIN_PRESETS: Preset[];
  createPreset(name: string, params: EditParams, groups: SettingsGroup[], opts?: { group?: string; conditions?: Preset['conditions'] }): Preset;
  /** amount 0..200 (%), 100 = as authored. Only the preset's groups change. */
  applyPreset(current: EditParams, preset: Preset, amount?: number): EditParams;
  matchConditionalPresets(presets: Preset[], meta: PhotoMeta): Preset[];
  exportPresets(presets: Preset[]): Blob;
  /** Accepts .kloudpreset/.json (ours) and Lightroom .xmp presets. */
  importPresetFile(file: File): Promise<Preset[]>;
}

/* ================================================================== */
/* io/ — decoding, metadata, thumbnails;  lens/ — lens profiles        */
/* ================================================================== */

export interface DecodeOptions {
  /** Decode (or downscale) so the long edge is ≤ maxSize. Omit for full size. */
  maxSize?: number;
  /** For RAW: use the embedded JPEG preview instead of demosaicing (fast path). */
  preferEmbeddedPreview?: boolean;
  /** For RAW: 'libraw' (WASM, default), 'builtin' (our bilinear/AHD-lite demosaic of the mosaic). */
  demosaic?: 'libraw' | 'builtin';
  signal?: AbortSignal;
  onProgress?: (fraction: number, stage: string) => void;
}

export interface DecodedPhoto {
  source: SourceImage;
  meta: PhotoMeta;
  /** Full-resolution loader when `source` is a proxy (same pipeline, no maxSize). */
  loadFull(): Promise<SourceImage>;
}

/** src/editor/io/index.ts */
export interface IoModule {
  SUPPORTED_EXTENSIONS: string[];
  /** For <input accept>. */
  ACCEPT_ATTRIBUTE: string;
  isSupportedFile(file: { name: string; type?: string }): boolean;
  isRawFileName(name: string): boolean;
  decodeFile(file: Blob, name: string, opts?: DecodeOptions): Promise<DecodedPhoto>;
  readMetadata(file: Blob, name: string): Promise<PhotoMeta>;
  /** Fast thumbnail (embedded preview for RAW), JPEG blob, long edge ≤ maxSize. Runs off the main thread when possible. */
  makeThumbnail(file: Blob, name: string, maxSize?: number): Promise<Blob>;
  /** Area-average downscale of any PixelBuffer; keeps type/transfer. */
  downscale(src: PixelBuffer, maxSize: number): PixelBuffer;
  /** Convert any PixelBuffer to 8-bit sRGB (for analysis, thumbnails, canvas). */
  toSrgb8(src: PixelBuffer): PixelBufferU8;
  /** Convert any PixelBuffer to Float32 LINEAR RGBA. */
  toLinearFloat(src: PixelBuffer): PixelBuffer;
  pixelBufferToBlob(px: PixelBuffer, type?: string, quality?: number): Promise<Blob>;
  blobToPixelBuffer(blob: Blob, maxSize?: number): Promise<PixelBufferU8>;
}

export interface LensProfile {
  id: string;
  make: string;
  model: string;
  /** Regex sources (case-insensitive) matched against meta.lens. */
  match: string[];
  mount?: string;
  focalMin: number;
  focalMax: number;
  /** Brown–Conrady radial terms at given focal lengths (radius normalized to half-diagonal = 1). Interpolate by focal. */
  distortion: { focal: number; k1: number; k2: number; k3: number }[];
  /** Vignetting falloff gain = 1 + v1 r² + v2 r⁴ + v3 r⁶ (to divide out). */
  vignetting: { focal: number; aperture: number; v1: number; v2: number; v3: number }[];
  /** Lateral CA: radial scale of red and blue relative to green (e.g. 1.0003). */
  ca: { focal: number; red: number; blue: number }[];
  /** Coefficients are approximations (not measured calibration data). */
  approximate: boolean;
}

export interface LensCorrection {
  profile: LensProfile | null;
  /** Effective radial distortion to REMOVE (after scaling by profileDistortionScale + manual slider). */
  k1: number;
  k2: number;
  k3: number;
  /** Effective vignetting gain polynomial (1 + v1 r² + v2 r⁴ + v3 r⁶) to divide out; zeros = none. */
  v1: number;
  v2: number;
  v3: number;
  /** Lateral CA radial scales (1 = none). */
  caRed: number;
  caBlue: number;
}

/** src/editor/lens/index.ts (owned by the io agent) */
export interface LensModule {
  LENS_PROFILES: LensProfile[];
  getLensProfile(id: string): LensProfile | null;
  detectLensProfile(meta: PhotoMeta): LensProfile | null;
  /** Combine profile (auto or params.lens.profileId) + manual sliders into shader-ready numbers. */
  resolveLensCorrection(lens: EditParams['lens'], meta: PhotoMeta): LensCorrection;
}

/* ================================================================== */
/* engine/ — WebGL2 renderer                                           */
/* ================================================================== */

export interface EngineCaps {
  webgl2: boolean;
  /** navigator.gpu present and an adapter was obtained (reported; WebGL2 does the rendering). */
  webgpu: boolean;
  /** Can render to RGBA16F. */
  halfFloatRender: boolean;
  floatLinearFilter: boolean;
  maxTextureSize: number;
  renderer: string;
}

export type CompareMode = 'off' | 'before' | 'side-by-side' | 'split-vertical' | 'split-horizontal' | 'reference';

export interface ViewState {
  /** Output pixels per CSS pixel; 'fit' fits the output into the viewport. 1 = 100%. */
  zoom: number | 'fit';
  /** Normalized output coords (0..1) shown at the viewport centre. */
  center: Point;
  compare: CompareMode;
  /** 0..1 divider position for split modes. */
  splitPosition: number;
  clipping: { highlights: boolean; shadows: boolean };
  /** Mask overlay tint (shown in the 'main' render). */
  maskOverlay: { maskId: string; color: [number, number, number, number] } | null;
  /** Image drawn in the left/top half in 'reference' mode. */
  reference: ImageBitmap | HTMLCanvasElement | null;
  /** CSS color for the letterbox around the image. */
  background: string;
}

export interface RenderOptions {
  /** Which output slot: 'main' = current edit, 'compare' = before/snapshot. */
  target?: 'main' | 'compare';
  /** Render the uncropped frame (crop tool active). */
  ignoreCrop?: boolean;
  /** 'draft' while dragging: lower resolution and skip expensive passes (AI denoise, big blurs). */
  quality?: 'draft' | 'full';
}

/** Maps a view to canvas CSS pixels: canvasX = offsetX + outX * scale (outX in output pixels). */
export interface DisplayTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
  outWidth: number;
  outHeight: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface FullRenderOptions {
  /** Target output size (after crop); the engine renders at exactly this size. */
  width: number;
  height: number;
  bitDepth: 8 | 16;
  colorSpace: ExportColorSpace;
  /** Full-resolution source to use instead of the current proxy. */
  source?: SourceImage;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/** Produces per-mask coverage bitmaps in SOURCE space. */
export interface MaskProvider {
  /** Coverage for `mask` at the given source resolution; null when the mask is empty. Cached by content. */
  getMask(mask: Mask, width: number, height: number): MaskBitmap | null;
  /** Called when async content (AI masks) becomes available → re-render. */
  onChange(cb: () => void): () => void;
}

/** Filled pixels for RemovalPatch.patchKey (RGBA8, alpha = coverage), covering patch.bbox. */
export interface PatchProvider {
  getPatch(key: string): PixelBuffer | null;
}

/** src/editor/engine/index.ts → `export function createEngine(canvas): Engine` */
export interface Engine {
  readonly canvas: HTMLCanvasElement;
  readonly caps: EngineCaps;
  setSource(src: SourceImage): Promise<void>;
  getSource(): SourceImage | null;
  setMaskProvider(p: MaskProvider | null): void;
  setPatchProvider(p: PatchProvider | null): void;
  /** Size of the uncropped frame / cropped output, in source-proxy pixels. */
  getOutputSize(params: EditParams, ignoreCrop?: boolean): { width: number; height: number };
  /** Run the pipeline into the output slot (synchronous GPU submit). */
  render(params: EditParams, opts?: RenderOptions): void;
  /** Draw the output slot(s) to the canvas using the view. */
  present(view: ViewState): void;
  /** Canvas CSS size + devicePixelRatio. */
  resize(cssWidth: number, cssHeight: number, dpr: number): void;
  getDisplayTransform(view: ViewState): DisplayTransform;
  /** Downscaled 8-bit sRGB copy of an output slot (histogram, scopes, thumbnails, AI). */
  readPixels(maxSize: number, target?: 'main' | 'compare'): PixelBufferU8;
  /** Rendered sRGB value 0..1 at normalized output coords (pixel readout). */
  samplePixel(u: number, v: number): RGB;
  /** LINEAR source RGB (before WB/exposure) at normalized OUTPUT coords (WB eyedropper). */
  sampleSourceLinear(u: number, v: number, params: EditParams, radiusPx?: number): RGB;
  /** Full-quality render for export; tiles internally when larger than maxTextureSize. */
  renderFull(params: EditParams, opts: FullRenderOptions): Promise<RenderedImage>;
  /** Quick JPEG of the current edit (library thumbnails, preset previews). */
  renderThumbnail(params: EditParams, maxSize: number): Promise<Blob>;
  /** Fired after each render with the timing in ms. */
  onRendered(cb: (ms: number, target: 'main' | 'compare') => void): () => void;
  dispose(): void;
}

/** src/editor/engine/geometry.ts — coordinate mapping shared with the UI. */
export interface GeometryModule {
  /** Pixel size of the uncropped frame for a source of srcW×srcH. */
  frameSize(params: EditParams, srcW: number, srcH: number): { width: number; height: number };
  /** Pixel size of the cropped output. */
  outputSize(params: EditParams, srcW: number, srcH: number): { width: number; height: number };
  /** Normalized output (or frame, when ignoreCrop) coords → source-normalized coords. */
  outputToSource(u: number, v: number, params: EditParams, srcW: number, srcH: number, ignoreCrop?: boolean): Point;
  /** Inverse of outputToSource (iterative). */
  sourceToOutput(x: number, y: number, params: EditParams, srcW: number, srcH: number, ignoreCrop?: boolean): Point;
  /** Largest crop rect (frame-normalized) with the given aspect that stays inside valid image data. */
  maxValidCrop(params: EditParams, srcW: number, srcH: number, aspect: number | null): Rect;
  /** Whether a frame-normalized rect lies fully on valid image data. */
  isCropValid(params: EditParams, srcW: number, srcH: number, rect: Rect): boolean;
  /** Numeric aspect (w/h) for params.crop.aspect, or null for 'free'. */
  aspectRatioValue(params: EditParams, srcW: number, srcH: number): number | null;
}

/* ================================================================== */
/* export/ & watermark/                                                */
/* ================================================================== */

export interface ExportJob {
  params: EditParams;
  meta: PhotoMeta;
  settings: ExportSettings;
  /** Photo name without extension. */
  baseName: string;
  /** 0-based index within a batch (for {seq}). */
  index: number;
  /** Renders the pipeline at an exact output size. */
  render(width: number, height: number, bitDepth: 8 | 16, colorSpace: ExportColorSpace): Promise<RenderedImage>;
  /** Source dimensions of the cropped output at full resolution. */
  fullOutputSize: { width: number; height: number };
  presetName?: string;
}

export interface ExportResult {
  blob: Blob;
  fileName: string;
  width: number;
  height: number;
}

/** src/editor/export/index.ts */
export interface ExportModule {
  computeExportSize(srcW: number, srcH: number, resize: ExportSettings['resize']): { width: number; height: number };
  buildFileName(template: string, ctx: { name: string; seq: number; meta: PhotoMeta; width: number; height: number; preset?: string }, ext: string): string;
  fileExtension(format: ExportSettings['format']): string;
  /** Output sharpening in place (CPU). */
  applyOutputSharpening(img: RenderedImage, settings: ExportSettings['outputSharpening']): void;
  /** Encode to the requested format with ICC profile, EXIF (per metadata policy) and DPI. */
  encodeImage(img: RenderedImage, settings: ExportSettings, meta: PhotoMeta): Promise<Blob>;
  /** Full job: size → render → sharpen → watermark → encode → name. */
  exportPhoto(job: ExportJob): Promise<ExportResult>;
  zipResults(results: ExportResult[]): Promise<Blob>;
  downloadBlob(blob: Blob, fileName: string): void;
  /** Minimal ICC v2 profile bytes for the color space. */
  buildIccProfile(space: ExportColorSpace): Uint8Array;
}

/** src/editor/watermark/index.ts */
export interface WatermarkModule {
  /** Draw onto a 2D context of an image of size w×h. */
  drawWatermark(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, w: number, h: number, wm: WatermarkSettings): Promise<void>;
  /** Composite onto a RenderedImage in place (handles 16-bit). */
  applyWatermark(img: RenderedImage, wm: WatermarkSettings): Promise<void>;
  /** Live preview into a canvas (used by the export dialog). */
  renderWatermarkPreview(canvas: HTMLCanvasElement, wm: WatermarkSettings, background?: CanvasImageSource | null): Promise<void>;
}

/* ================================================================== */
/* analysis/                                                           */
/* ================================================================== */

export interface ScopeOptions {
  /** CSS color strings; defaults read from theme tokens. */
  background?: string;
  grid?: string;
  /** Intensity multiplier. */
  gain?: number;
}

/** src/editor/analysis/index.ts — pure functions (no DOM except the draw* helpers). */
export interface AnalysisModule {
  computeHistogram(px: PixelBufferU8): Histogram;
  drawHistogram(canvas: HTMLCanvasElement, hist: Histogram, opts?: ScopeOptions & { mode?: 'rgb' | 'luminance' | 'both'; showClipping?: boolean }): void;
  drawWaveform(canvas: HTMLCanvasElement, px: PixelBufferU8, opts?: ScopeOptions & { mode?: 'luma' | 'rgb' }): void;
  drawParade(canvas: HTMLCanvasElement, px: PixelBufferU8, opts?: ScopeOptions): void;
  drawVectorscope(canvas: HTMLCanvasElement, px: PixelBufferU8, opts?: ScopeOptions): void;
  /** Full analysis of the (proxy) SOURCE image. */
  analyzeImage(px: PixelBuffer, meta?: PhotoMeta): ImageAnalysis;
  autoExposure(px: PixelBuffer): number;
  autoTone(px: PixelBuffer): Pick<EditParams['basic'], 'exposure' | 'contrast' | 'highlights' | 'shadows' | 'whites' | 'blacks'> & {
    vibrance: number;
    saturation: number;
  };
  autoWhiteBalance(px: PixelBuffer): { temperature: number; tint: number };
  /** Rule-based "AI Auto Edit": analysis → parameters (incl. HSL, curve, subject/background/sky masks). */
  generateAutoEdit(analysis: ImageAnalysis, meta?: PhotoMeta, opts?: { strength?: number; idFactory?: () => string }): PartialParams;
  /** Horizon/vertical-line based level angle for Auto Straighten / Upright 'level'. */
  detectLevelAngle(px: PixelBuffer): { angle: number; confidence: number };
  /** Upright auto: keystone values (transform.vertical/horizontal/rotate). */
  detectPerspective(px: PixelBuffer, mode: 'auto' | 'vertical' | 'full'): { vertical: number; horizontal: number; rotate: number; confidence: number };
  /** Sensor dust candidates, source-normalized centre + radius (fraction of long edge). */
  detectDust(px: PixelBuffer, sensitivity?: number): { x: number; y: number; radius: number; score: number }[];
  estimateNoise(px: PixelBuffer): { level: number; sigma: number };
  estimateSharpness(px: PixelBuffer): { score: number; blurry: boolean };
}

/* ================================================================== */
/* masks/ & ai/segment/                                                */
/* ================================================================== */

/** In-memory (+ IndexedDB-backed) store of AI mask bitmaps, keyed by AiMaskParams.bitmapKey. */
export interface AiMaskStore {
  get(key: string): MaskBitmap | undefined;
  set(key: string, bmp: MaskBitmap): void;
  delete(key: string): void;
  onChange(cb: (key: string) => void): () => void;
}

export interface MaskRasterContext {
  /** Proxy of the SOURCE image (any transfer) for color/luminance range. */
  source: PixelBuffer;
  aiStore: AiMaskStore;
  /** Depth map (0 near .. 255 far) in source space, if estimated. */
  depth?: MaskBitmap | null;
  /** Called when an AI component has no bitmap yet (triggers async segmentation). */
  requestAi?: (componentId: string, target: AiMaskTarget) => void;
}

/** src/editor/masks/index.ts */
export interface MasksModule {
  /** Coverage 0..255, width×height, SOURCE space; combines components with add/subtract/intersect/invert. */
  rasterizeMask(mask: Mask, ctx: MaskRasterContext, width: number, height: number): Uint8Array;
  createMaskProvider(ctx: MaskRasterContext): MaskProvider & { setContext(ctx: Partial<MaskRasterContext>): void };
  createAiMaskStore(): AiMaskStore;
  /** Stroke rasterization shared with heal/removal (coverage 0..255). */
  rasterizeStrokes(strokes: BrushStroke[], width: number, height: number): Uint8Array;
  /** Bounding box (source-normalized) of strokes incl. brush size. */
  strokesBounds(strokes: BrushStroke[]): Rect;
}

export interface SegmentOptions {
  point?: Point;
  box?: Rect;
  signal?: AbortSignal;
}

export interface SegmentationBackend {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  segment(target: AiMaskTarget, px: PixelBuffer, opts?: SegmentOptions): Promise<MaskBitmap>;
  estimateDepth?(px: PixelBuffer): Promise<MaskBitmap>;
  detectObjects?(px: PixelBuffer): Promise<DetectedObject[]>;
}

/** src/editor/ai/segment/index.ts */
export interface SegmentModule {
  /** Best available backend (ML model when loadable, heuristic fallback otherwise). */
  segment(target: AiMaskTarget, px: PixelBuffer, opts?: SegmentOptions): Promise<MaskBitmap>;
  estimateDepth(px: PixelBuffer): Promise<MaskBitmap>;
  detectObjects(px: PixelBuffer): Promise<DetectedObject[]>;
  /** Try to load the optional ML backend (MediaPipe from CDN). Resolves false when blocked/offline. */
  enableMlBackend(): Promise<boolean>;
  getSegmentationStatus(): { backend: string; ml: 'unavailable' | 'loading' | 'ready' | 'failed'; message?: string };
}

/* ================================================================== */
/* ai/inpaint/ & ai/style/                                             */
/* ================================================================== */

export interface InpaintOptions {
  patchSize?: number;
  iterations?: number;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

/** src/editor/ai/inpaint/index.ts */
export interface InpaintModule {
  /** Fill the masked region (mask 0..255, same size as px). Returns RGBA8 of the same size. Runs in a worker. */
  inpaint(px: PixelBuffer, mask: Uint8Array, opts?: InpaintOptions): Promise<PixelBufferU8>;
  /** Best source centre for a content-aware spot (source-normalized in/out). */
  findHealSource(px: PixelBuffer, spot: Pick<HealSpot, 'x' | 'y' | 'radius'>): Point;
  /** Brush strokes → RemovalPatch + its pixels (patch covers bbox, alpha = coverage). */
  createRemovalPatch(
    source: PixelBuffer,
    strokes: BrushStroke[],
    kind: RemovalPatch['kind'],
    opts?: InpaintOptions & { idFactory?: () => string },
  ): Promise<{ patch: RemovalPatch; pixels: PixelBufferU8 }>;
  /** Dust candidates → heal spots (uses analysis.detectDust). */
  dustToSpots(candidates: { x: number; y: number; radius: number }[], px: PixelBuffer, idFactory: () => string): HealSpot[];
  createPatchStore(): PatchProvider & { set(key: string, px: PixelBuffer): void; delete(key: string): void; keys(): string[] };
}

/** src/editor/ai/style/index.ts — KLOUD Style / personal style learning. */
export interface StyleModule {
  /** Built-in "KLOUD" house style (hand-authored model). */
  KLOUD_STYLE: StyleModel;
  /** Feature vector of an ORIGINAL image (fixed length, documented in the module). */
  extractFeatures(px: PixelBuffer, meta?: PhotoMeta): number[];
  /** Estimate edit parameters that turn `original` into `edited` (pixel-aligned pair). */
  estimateParamsFromPair(original: PixelBuffer, edited: PixelBuffer): PartialParams;
  createStyleModel(name: string, learn?: Partial<StyleModel['learn']>): StyleModel;
  /** (Re)train on all pairs (ridge regression, weighted). */
  trainStyleModel(model: StyleModel, pairs: StylePair[]): StyleModel;
  /** Predict parameters for a new image; strength 0..150 (%). */
  predictParams(model: StyleModel, features: number[], strength?: number): PartialParams;
  /** Online correction: the user adjusted the prediction → returns a feedback pair to store and the updated model. */
  learnFromFeedback(model: StyleModel, features: number[], predicted: PartialParams, final: EditParams, pairs: StylePair[]): { model: StyleModel; pair: StylePair };
  /** Params → flat vector along model.paramPaths and back. */
  paramsToVector(params: PartialParams, paths: string[]): number[];
  vectorToParams(vec: number[], paths: string[]): PartialParams;
}

/* ================================================================== */
/* storage/ & library/                                                 */
/* ================================================================== */

export type StoreName =
  | 'photos'
  | 'files'
  | 'thumbs'
  | 'edits'
  | 'presets'
  | 'albums'
  | 'settings'
  | 'autosave'
  | 'styleModels'
  | 'stylePairs'
  | 'maskBitmaps'
  | 'patches';

/** src/editor/storage/db.ts */
export interface KloudDB {
  get<T>(store: StoreName, key: string): Promise<T | undefined>;
  put<T>(store: StoreName, key: string, value: T): Promise<void>;
  delete(store: StoreName, key: string): Promise<void>;
  getAll<T>(store: StoreName): Promise<T[]>;
  keys(store: StoreName): Promise<string[]>;
  clear(store: StoreName): Promise<void>;
  /** Approximate usage/quota via navigator.storage.estimate(). */
  estimate(): Promise<{ usage: number; quota: number }>;
}

export interface RecoverySession {
  photoId: string;
  state: SerializedEditState;
  savedAt: number;
}

/** src/editor/storage/index.ts */
export interface StorageModule {
  /** Falls back to an in-memory implementation when IndexedDB is unavailable. */
  openDB(): Promise<KloudDB>;
  AutosaveManager: new (db: KloudDB, opts?: { delayMs?: number }) => {
    schedule(photoId: string, state: SerializedEditState): void;
    flush(): Promise<void>;
    /** Unsaved session left behind by a crash / closed tab. */
    getRecovery(): Promise<RecoverySession | null>;
    discardRecovery(): Promise<void>;
    /** Mark the session as cleanly closed (call on successful save / beforeunload flush). */
    markClean(): Promise<void>;
  };
  /** Simple key/value app settings (theme, panel state, export settings, shortcuts). */
  loadSetting<T>(db: KloudDB, key: string, fallback: T): Promise<T>;
  saveSetting<T>(db: KloudDB, key: string, value: T): Promise<void>;
}

export interface ImportProgress {
  done: number;
  total: number;
  current?: string;
}

export interface LibraryFacets {
  cameras: string[];
  lenses: string[];
  isos: number[];
  apertures: number[];
  shutters: number[];
  focalLengths: number[];
  folders: string[];
  dateMin?: string;
  dateMax?: string;
}

/** src/editor/library/index.ts → `export class Library implements LibraryApi` + `openLibrary(db)` */
export interface LibraryApi {
  all(): PhotoRecord[];
  get(id: string): PhotoRecord | undefined;
  query(q: LibraryQuery): PhotoRecord[];
  facets(): LibraryFacets;
  importFiles(files: File[], opts?: { folder?: string; onProgress?: (p: ImportProgress) => void; signal?: AbortSignal }): Promise<PhotoRecord[]>;
  getFile(id: string): Promise<Blob | undefined>;
  getThumbnailUrl(id: string): Promise<string | undefined>;
  setThumbnail(id: string, blob: Blob): Promise<void>;
  update(id: string, patch: Partial<PhotoRecord>): Promise<void>;
  updateMany(ids: string[], patch: Partial<PhotoRecord>): Promise<void>;
  remove(ids: string[]): Promise<void>;
  loadEdit(id: string): Promise<SerializedEditState | undefined>;
  saveEdit(id: string, state: SerializedEditState): Promise<void>;
  albums(): Album[];
  createAlbum(name: string): Promise<Album>;
  renameAlbum(id: string, name: string): Promise<void>;
  deleteAlbum(id: string): Promise<void>;
  addToAlbum(photoIds: string[], albumId: string): Promise<void>;
  removeFromAlbum(photoIds: string[], albumId: string): Promise<void>;
  folders(): string[];
  setRating(ids: string[], rating: number): Promise<void>;
  setFlag(ids: string[], flag: PhotoRecord['flag']): Promise<void>;
  setLabel(ids: string[], label: ColorLabel | null): Promise<void>;
  toggleFavorite(ids: string[]): Promise<void>;
  subscribe(cb: () => void): () => void;
}

/** src/editor/library/index.ts — batch helpers */
export interface BatchModule {
  copySettings(params: EditParams, groups: SettingsGroup[]): { groups: SettingsGroup[]; params: PartialParams };
  pasteSettings(target: EditParams, clip: { groups: SettingsGroup[]; params: PartialParams }): EditParams;
  /** Load each target's edit, apply the groups from `source`, save. Crop sync maps the relative rect. */
  syncSettings(lib: LibraryApi, source: EditParams, targetIds: string[], groups: SettingsGroup[], onProgress?: (done: number, total: number) => void): Promise<void>;
  /** Apply a preset (with amount) to many photos. */
  batchApplyPreset(lib: LibraryApi, preset: Preset, targetIds: string[], amount?: number, onProgress?: (done: number, total: number) => void): Promise<void>;
  /** "Previous": apply the last edited photo's settings. */
  applyPrevious(lib: LibraryApi, previousId: string, targetIds: string[], groups?: SettingsGroup[]): Promise<void>;
}
