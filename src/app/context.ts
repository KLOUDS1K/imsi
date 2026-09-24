/**
 * AppContext — the object every UI module receives. Implemented by the shell
 * (src/app/createContext.ts); panels, viewer tools and dialogs only depend on
 * this interface.
 */
import type {
  AiMaskStore,
  Engine,
  KloudDB,
  LibraryApi,
  MaskProvider,
  PatchProvider,
  DecodedPhoto,
  EditorStoreApi,
  ViewState,
} from '../editor/contracts';
import type {
  EditParams,
  ExportSettings,
  Histogram,
  PartialParams,
  PhotoMeta,
  PhotoRecord,
  PixelBuffer,
  Preset,
  SettingsGroup,
  SourceImage,
  StyleModel,
} from '../editor/types';
import type { Signal } from '../ui/signal';

export type AppModule = 'library' | 'develop';
/** Right-panel tool strip in Develop. */
export type DevelopTool = 'edit' | 'crop' | 'heal' | 'masks' | 'ai';
export type RetouchTool = 'heal' | 'clone' | 'content-aware' | 'ai-remove' | 'generative';
export type MaskDrawTool = 'none' | 'brush' | 'erase' | 'linear' | 'radial' | 'color-range' | 'luminance-range' | 'depth-range' | 'object';
export type ThemeChoice = 'system' | 'light' | 'dark';
export type ScopeKind = 'histogram' | 'waveform' | 'parade' | 'vectorscope';

export interface BrushSettings {
  /** fraction of the source long edge */
  size: number;
  feather: number;
  flow: number;
  density: number;
  autoMask: boolean;
}

export interface EditorDocument {
  photoId: string;
  record: PhotoRecord;
  meta: PhotoMeta;
  decoded: DecodedPhoto;
  /** Current (proxy) source on the GPU. */
  source: SourceImage;
  /** 8-bit sRGB proxy of the source (≤ 1024 px) for analysis / AI / color-range masks. */
  analysisProxy: PixelBuffer;
  store: EditorStoreApi;
  isRaw: boolean;
}

export interface Command {
  id: string;
  label: string;
  /** e.g. ['Mod+Z'], ['Shift+Mod+Z'], ['\\'], ['R'], ['ArrowRight']. Mod = Ctrl on Win/Linux, ⌘ on macOS. */
  keys?: string[];
  group?: string;
  /** Only runs (and only shows in help) when this returns true. */
  when?: () => boolean;
  run: (e?: KeyboardEvent) => void;
  /** Fire on keyup too (for "hold to view original"). */
  onKeyUp?: (e: KeyboardEvent) => void;
}

export interface CommandRegistry {
  register(cmd: Command): () => void;
  run(id: string): boolean;
  list(): Command[];
}

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

export interface PromptOptions {
  title: string;
  label?: string;
  value?: string;
  placeholder?: string;
  confirmLabel?: string;
}

export interface AppContext {
  root: HTMLElement;
  db: KloudDB;
  library: LibraryApi;
  /** null until WebGL2 is initialised (or unsupported). */
  engine: Engine | null;

  /* ---- global UI state ---- */
  module: Signal<AppModule>;
  theme: Signal<ThemeChoice>;
  /** Library selection (photo ids, in display order); the first is the "most selected". */
  selection: Signal<string[]>;
  /** Ordered ids currently shown in grid/filmstrip (after query). */
  visibleIds: Signal<string[]>;
  busy: Signal<{ active: boolean; label?: string; progress?: number }>;

  /* ---- develop ---- */
  doc: Signal<EditorDocument | null>;
  tool: Signal<DevelopTool>;
  view: Signal<ViewState>;
  /** Rendered-output histogram (updated after renders, throttled). */
  histogram: Signal<Histogram | null>;
  scope: Signal<ScopeKind>;
  /** Pixel readout under the pointer (sRGB 0..1) or null. */
  pixelReadout: Signal<{ u: number; v: number; rgb: [number, number, number] } | null>;
  /** Eyedropper for white balance (viewer handles the click). */
  wbPickerActive: Signal<boolean>;
  activeMaskId: Signal<string | null>;
  maskDrawTool: Signal<MaskDrawTool>;
  showMaskOverlay: Signal<boolean>;
  brush: Signal<BrushSettings>;
  retouchTool: Signal<RetouchTool>;
  retouchBrush: Signal<{ size: number; feather: number; opacity: number }>;
  /** Params used for the 'compare' slot (before / snapshot); null = defaults ("original"). */
  compareParams: Signal<EditParams | null>;
  /**
   * Temporary params rendered INSTEAD of the doc's params without touching the
   * store (live preset preview on hover, AI style preview). null = normal.
   */
  previewParams: Signal<EditParams | null>;
  /** Reference photo id for 'reference' compare mode. */
  referenceId: Signal<string | null>;
  /** Copy/paste clipboard for settings. */
  settingsClipboard: Signal<{ groups: SettingsGroup[]; params: PartialParams } | null>;

  /* ---- shared services ---- */
  aiMaskStore: AiMaskStore;
  maskProvider: MaskProvider | null;
  patchStore: PatchProvider & { set(key: string, px: PixelBuffer): void; delete(key: string): void; keys(): string[] };
  presets: Signal<Preset[]>;
  savePreset(preset: Preset): Promise<void>;
  deletePreset(id: string): Promise<void>;
  styleModels: Signal<StyleModel[]>;
  saveStyleModel(model: StyleModel): Promise<void>;
  exportSettings: Signal<ExportSettings>;
  commands: CommandRegistry;

  /* ---- actions ---- */
  openPhoto(id: string): Promise<void>;
  closePhoto(): void;
  /** Schedule a render of the current doc (rAF-coalesced; draft quality while a gesture is active). */
  requestRender(): void;
  /** Persist the current doc now (normally autosaved). */
  saveCurrent(): Promise<void>;
  /** Open the import file picker (or import the given files). */
  importFiles(files?: File[]): Promise<void>;
  openExportDialog(photoIds?: string[]): void;
  toast(message: string, kind?: 'info' | 'success' | 'error', ms?: number): void;
  confirm(opts: ConfirmOptions): Promise<boolean>;
  prompt(opts: PromptOptions): Promise<string | null>;
  /** Monotonic id factory for masks, spots, presets… */
  newId(prefix?: string): string;
}
