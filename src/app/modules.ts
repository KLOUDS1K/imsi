/**
 * Feature-module loader.
 *
 * Every optional feature (engine, decoders, analysis, AI, the Develop / Library
 * UI modules…) is loaded through a one-line shim in ./features/ with a dynamic
 * `import()`. Two reasons:
 *
 * 1. Resilience — if one module fails to load (missing while the app is being
 *    assembled, a runtime error at import time, a blocked worker), only that
 *    feature degrades to a placeholder; the rest of the app still boots. In the
 *    Vite dev server a missing file makes the *shim* fail to transform, which
 *    rejects the dynamic import instead of breaking the whole bundle.
 * 2. Startup cost — the heavy modules (RAW decoder, AI, export encoders) are
 *    split into their own chunks and fetched in parallel after first paint.
 *
 * The types below are what the shell relies on. Contract modules are checked
 * against contracts.ts; UI modules against the export names documented in the
 * module briefs (ARCHITECTURE.md / docs).
 */
import type {
  AnalysisModule,
  Engine,
  InpaintModule,
  IoModule,
  MasksModule,
  SegmentModule,
  StyleModule,
} from '@/editor/contracts';
import type { PhotoMeta } from '@/editor/types';
import type { AppContext } from './context';

/** What every mountable UI module factory returns. */
export interface Mounted {
  el: HTMLElement;
  dispose(): void;
}

export interface EngineFeature {
  createEngine(canvas: HTMLCanvasElement): Engine;
}

export interface GeometryFeature {
  setGeometryMeta(meta: PhotoMeta | null): void;
}

export interface PanelsFeature {
  createDevelopRightPanel(ctx: AppContext, opts?: { onMobileClose?: () => void }): Mounted;
  createDevelopLeftPanel(ctx: AppContext, opts: { navigator?: HTMLElement }): Mounted;
  registerPanelCommands(ctx: AppContext): () => void;
}

export interface ViewerFeature {
  createViewer(ctx: AppContext): Mounted;
  createNavigator(ctx: AppContext): Mounted;
  registerViewerCommands(ctx: AppContext): () => void;
}

export interface LibraryUiFeature {
  createLibrarySidebar(ctx: AppContext): Mounted;
  createLibraryView(ctx: AppContext): Mounted;
  createFilmstrip(ctx: AppContext): Mounted;
  registerLibraryCommands(ctx: AppContext): () => void;
  createSamplePhotos(): Promise<File[]>;
}

export interface ExportUiFeature {
  openExportDialog(ctx: AppContext, photoIds: string[]): void;
}

export interface FeatureMap {
  engine: EngineFeature;
  geometry: GeometryFeature;
  io: IoModule;
  analysis: AnalysisModule;
  masks: MasksModule;
  segment: SegmentModule;
  inpaint: InpaintModule;
  style: StyleModule;
  panels: PanelsFeature;
  viewer: ViewerFeature;
  libraryUi: LibraryUiFeature;
  exportUi: ExportUiFeature;
  batchUi: Record<string, unknown>;
}

export type FeatureName = keyof FeatureMap;

/*
 * Each loader is a literal import() so Vite can code-split it. The `satisfies`
 * check makes TypeScript verify that every module exposes what the shell uses.
 */
const LOADERS = {
  engine: () => import('./features/engine'),
  geometry: () => import('./features/geometry'),
  io: () => import('./features/io'),
  analysis: () => import('./features/analysis'),
  masks: () => import('./features/masks'),
  segment: () => import('./features/segment'),
  inpaint: () => import('./features/inpaint'),
  style: () => import('./features/style'),
  panels: () => import('./features/panels'),
  viewer: () => import('./features/viewer'),
  libraryUi: () => import('./features/library-ui'),
  exportUi: () => import('./features/export-ui'),
  batchUi: () => import('./features/batch-ui'),
} satisfies { [K in FeatureName]: () => Promise<FeatureMap[K]> };

export type FeatureStatus = 'idle' | 'loading' | 'ready' | 'failed';

export interface FeatureRegistry {
  /** Load (once) and return the module, or null when it is unavailable. */
  load<K extends FeatureName>(name: K): Promise<FeatureMap[K] | null>;
  /** The module if it already loaded successfully (synchronous). */
  get<K extends FeatureName>(name: K): FeatureMap[K] | null;
  status(name: FeatureName): FeatureStatus;
  /** Why a feature failed to load (for placeholders / the console). */
  error(name: FeatureName): string | null;
  /** Kick off loading of every feature in parallel (non-blocking). */
  preloadAll(): Promise<void>;
}

export function createFeatureRegistry(): FeatureRegistry {
  const promises = new Map<FeatureName, Promise<unknown>>();
  const loaded = new Map<FeatureName, unknown>();
  const statuses = new Map<FeatureName, FeatureStatus>();
  const errors = new Map<FeatureName, string>();

  const load = <K extends FeatureName>(name: K): Promise<FeatureMap[K] | null> => {
    let p = promises.get(name) as Promise<FeatureMap[K] | null> | undefined;
    if (!p) {
      statuses.set(name, 'loading');
      const loader = LOADERS[name] as () => Promise<FeatureMap[K]>;
      p = loader().then(
        (mod) => {
          loaded.set(name, mod);
          statuses.set(name, 'ready');
          return mod;
        },
        (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          errors.set(name, msg);
          statuses.set(name, 'failed');
          console.warn(`[kloud] feature "${name}" is unavailable: ${msg}`);
          return null;
        },
      );
      promises.set(name, p);
    }
    return p;
  };

  return {
    load,
    get: <K extends FeatureName>(name: K) => (loaded.get(name) as FeatureMap[K] | undefined) ?? null,
    status: (name) => statuses.get(name) ?? 'idle',
    error: (name) => errors.get(name) ?? null,
    async preloadAll() {
      await Promise.all((Object.keys(LOADERS) as FeatureName[]).map((n) => load(n)));
    },
  };
}
