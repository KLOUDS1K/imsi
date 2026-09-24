/**
 * createContext — builds the AppContext every UI module receives, plus the
 * shell-private runtime around it (render loop, document controller, autosave,
 * feature registry, status signals).
 *
 * Boot order (everything independent runs in parallel):
 *   IndexedDB (memory fallback) ─┬─ Library
 *                                ├─ presets / style models / export settings
 *   engine chunk → WebGL2 engine ┤  (null + message when WebGL2 is missing)
 *   masks + inpaint chunks ──────┘  (AI mask store, mask provider, patch store)
 * Other feature chunks (decoders, analysis, AI, UI modules) load right after.
 */
import type { Engine, MaskProvider, ViewState } from '@/editor/contracts';
import type { AiMaskTarget, EditParams, Histogram, MaskBitmap, PartialParams, PixelBuffer, SettingsGroup } from '@/editor/types';
import { AutosaveManager, backendOf, openDB } from '@/editor/storage';
import { openLibrary } from '@/editor/library';
import { applyTheme, confirmDialog, createToaster, getThemeChoice, onThemeChange, promptDialog, readToken, storedThemeChoice } from '@/ui/kit';
import { Signal } from '@/ui/signal';
import type {
  AppContext,
  AppModule,
  BrushSettings,
  DevelopTool,
  EditorDocument,
  MaskDrawTool,
  RetouchTool,
  ScopeKind,
  ThemeChoice,
} from './context';
import { createCommandRegistry, type CommandRegistryImpl } from './commands';
import { createFeatureRegistry, type FeatureRegistry } from './modules';
import {
  createExportSettings,
  createMemoryAiMaskStore,
  createMemoryPatchStore,
  createPersistentAiMaskStore,
  createPersistentPatchStore,
  createPresetService,
  createStyleModelService,
} from './services';
import { createRenderLoop, type RenderLoop } from './render-loop';
import { createDocumentController, type DocumentController, type SaveState } from './document';
import { createAiMaskCoordinator, depthKey } from './ai-masks';
import { createBusyTracker, type BusyTracker } from './busy';
import { collectDropped, pickFiles, runImport, type FileGroup } from './importer';
import { createIdFactory, previewMaxSize } from './env';

export interface EngineStatus {
  state: 'ready' | 'unavailable';
  message?: string;
}

/** Shell-private state and services around the public AppContext. */
export interface AppRuntime {
  ctx: AppContext;
  features: FeatureRegistry;
  commands: CommandRegistryImpl;
  docs: DocumentController;
  render: RenderLoop;
  busy: BusyTracker;
  saveState: Signal<SaveState>;
  /** Photo to return to with "Forward" (Library → Develop). */
  lastOpenedId: Signal<string | null>;
  /** Last main-slot render time in ms. */
  renderMs: Signal<number | null>;
  engineStatus: EngineStatus;
  storageBackend: 'indexeddb' | 'memory' | 'unknown';
  previewMaxSize: number;
  embedded: boolean;
  /** Switch to Develop, opening `id` (default: the most selected / first visible photo). */
  enterDevelop(id?: string): Promise<void>;
  importFolder(): Promise<void>;
  importGroups(groups: FileGroup[]): Promise<string[]>;
  importDataTransfer(dt: DataTransfer): Promise<string[]>;
  /** Offer to restore a crashed session (call once the UI is mounted). */
  checkRecovery(): Promise<void>;
  destroy(): void;
}

export interface CreateContextOptions {
  root: HTMLElement;
  theme?: ThemeChoice;
  initialModule?: AppModule;
  embedded?: boolean;
}

const BLANK_PROXY: PixelBuffer = { width: 1, height: 1, data: new Uint8ClampedArray(4), transfer: 'srgb' };

function canvasBackground(): string {
  // The engine clears the letterbox with this CSS color; it tracks the theme.
  return readToken('--k-canvas') || 'rgb(128, 128, 128)';
}

export async function createContext(opts: CreateContextOptions): Promise<AppRuntime> {
  const features = createFeatureRegistry();
  const cleanup: (() => void)[] = [];

  /* ---------------- persistence + engine, in parallel ---------------- */
  const canvas = document.createElement('canvas');
  canvas.className = 'k-engine-canvas';
  const enginePromise = features.load('engine').then((mod): { engine: Engine | null; status: EngineStatus } => {
    if (!mod) return { engine: null, status: { state: 'unavailable', message: 'The rendering engine could not be loaded.' } };
    try {
      return { engine: mod.createEngine(canvas), status: { state: 'ready' } };
    } catch (err) {
      console.warn('[kloud] WebGL2 engine unavailable', err);
      const detail = err instanceof Error ? err.message : String(err);
      return {
        engine: null,
        status: {
          state: 'unavailable',
          message: `This browser can't run the WebGL2 renderer (${detail}). The library still works; try a current Chrome, Edge, Firefox or Safari to edit photos.`,
        },
      };
    }
  });
  const masksP = features.load('masks');
  const inpaintP = features.load('inpaint');
  const db = await openDB();
  const [library, presetSvc, styleSvc, exportSvc, engineResult, masks, inpaint] = await Promise.all([
    openLibrary(db),
    createPresetService(db),
    createStyleModelService(db),
    createExportSettings(db),
    enginePromise,
    masksP,
    inpaintP,
  ]);
  cleanup.push(() => exportSvc.dispose());
  const engine = engineResult.engine;

  /* ---------------- services ---------------- */
  const toaster = createToaster();
  cleanup.push(() => toaster.destroy());
  const aiMaskStore = createPersistentAiMaskStore(masks ? masks.createAiMaskStore() : createMemoryAiMaskStore(), db);
  const patchStore = createPersistentPatchStore(inpaint ? inpaint.createPatchStore() : createMemoryPatchStore(), db);
  const newId = createIdFactory();

  /* ---------------- signals ---------------- */
  const initialTheme: ThemeChoice = opts.theme ?? storedThemeChoice();
  if (opts.theme) applyTheme(opts.theme, { persist: false });
  const busySignal = new Signal<{ active: boolean; label?: string; progress?: number }>({ active: false });
  const busy = createBusyTracker(busySignal);
  const saveState = new Signal<SaveState>('idle');
  const lastOpenedId = new Signal<string | null>(null);
  const renderMs = new Signal<number | null>(null);
  const commands = createCommandRegistry();

  // Late-bound members (they need ctx itself).
  let docs!: DocumentController;
  let maskProvider: (MaskProvider & { setContext(c: Partial<{ source: PixelBuffer; depth: MaskBitmap | null }>): void }) | null = null;

  const ctx: AppContext = {
    root: opts.root,
    db,
    library,
    engine,
    module: new Signal<AppModule>(opts.initialModule ?? 'library'),
    theme: new Signal<ThemeChoice>(opts.theme ?? (getThemeChoice() === 'system' ? initialTheme : getThemeChoice())),
    selection: new Signal<string[]>([]),
    visibleIds: new Signal<string[]>(library.all().map((r) => r.id)),
    busy: busySignal,
    doc: new Signal<EditorDocument | null>(null),
    tool: new Signal<DevelopTool>('edit'),
    view: new Signal<ViewState>({
      zoom: 'fit',
      center: { x: 0.5, y: 0.5 },
      compare: 'off',
      splitPosition: 0.5,
      clipping: { highlights: false, shadows: false },
      maskOverlay: null,
      reference: null,
      background: canvasBackground(),
    }),
    histogram: new Signal<Histogram | null>(null),
    scope: new Signal<ScopeKind>('histogram'),
    pixelReadout: new Signal<{ u: number; v: number; rgb: [number, number, number] } | null>(null),
    wbPickerActive: new Signal<boolean>(false),
    activeMaskId: new Signal<string | null>(null),
    maskDrawTool: new Signal<MaskDrawTool>('none'),
    showMaskOverlay: new Signal<boolean>(false),
    brush: new Signal<BrushSettings>({ size: 0.04, feather: 60, flow: 60, density: 100, autoMask: false }),
    retouchTool: new Signal<RetouchTool>('content-aware'),
    retouchBrush: new Signal({ size: 0.02, feather: 50, opacity: 100 }),
    compareParams: new Signal<EditParams | null>(null),
    previewParams: new Signal<EditParams | null>(null),
    referenceId: new Signal<string | null>(null),
    settingsClipboard: new Signal<{ groups: SettingsGroup[]; params: PartialParams } | null>(null),
    aiMaskStore,
    get maskProvider() {
      return maskProvider;
    },
    patchStore,
    presets: presetSvc.presets,
    savePreset: (p) => presetSvc.save(p),
    deletePreset: (id) => presetSvc.remove(id),
    styleModels: styleSvc.models,
    saveStyleModel: (m) => styleSvc.save(m),
    exportSettings: exportSvc.signal,
    commands,
    openPhoto: (id) => docs.open(id),
    closePhoto: () => docs.close(),
    requestRender: () => render.request(),
    saveCurrent: () => docs.save(),
    importFiles: async (files) => {
      const list = files ?? (await pickFiles('files', features.get('io')?.ACCEPT_ATTRIBUTE ?? 'image/*'));
      await importGroups([{ folder: '', files: list }]);
    },
    openExportDialog: (ids) => {
      const list = ids?.length ? ids : ctx.module.value === 'develop' && ctx.doc.value ? [ctx.doc.value.photoId] : ctx.selection.value;
      if (!list.length) {
        ctx.toast('Select one or more photos to export.', 'info');
        return;
      }
      void features.load('exportUi').then((m) => {
        if (m) m.openExportDialog(ctx, list);
        else ctx.toast('Export is unavailable: the export module could not be loaded.', 'error');
      });
    },
    toast: (message, kind = 'info', ms) => void toaster.show(message, kind, ms),
    confirm: (o) => confirmDialog(o),
    prompt: (o) => promptDialog(o),
    newId,
  };

  /* ---------------- render loop ---------------- */
  const render = createRenderLoop(ctx, {
    analysis: () => features.get('analysis'),
    onStats: ({ ms }) => renderMs.set(Math.round(ms * 10) / 10),
    onError: (err) => ctx.toast(`Rendering failed: ${err instanceof Error ? err.message : String(err)}`, 'error'),
  });
  cleanup.push(() => render.dispose());
  if (engine) {
    cleanup.push(engine.onRendered((ms, target) => target === 'main' && renderMs.set(Math.round(ms * 10) / 10)));
    engine.setPatchProvider(patchStore);
  }
  cleanup.push(patchStore.onChange(() => render.invalidate()));

  /* ---------------- AI masks + mask provider ---------------- */
  const ai = createAiMaskCoordinator({
    ctx,
    features,
    store: aiMaskStore,
    busy,
    onDepth: (depth) => {
      maskProvider?.setContext({ depth });
      render.invalidate();
    },
  });
  cleanup.push(() => ai.dispose());
  if (masks) {
    maskProvider = masks.createMaskProvider({
      source: BLANK_PROXY,
      aiStore: aiMaskStore,
      depth: null,
      requestAi: (componentId: string, target: AiMaskTarget) => ai.requestAi(componentId, target),
    });
    cleanup.push(maskProvider.onChange(() => render.invalidate()));
    engine?.setMaskProvider(maskProvider);
  }
  // A late AI bitmap (segmentation finished) must reach the picture even if the provider cached "empty".
  cleanup.push(aiMaskStore.onChange((key) => key.startsWith('depth:') || render.invalidate()));

  /* ---------------- documents + autosave ---------------- */
  const autosave = new AutosaveManager(db, {
    delayMs: 800,
    save: (id, s) => library.saveEdit(id, s),
    onSaved: () => saveState.set('saved'),
    onError: (err) => {
      saveState.set('error');
      console.error('[kloud] autosave failed', err);
      ctx.toast('Autosave failed — your latest edits may not be stored. Check the browser storage settings.', 'error');
    },
  });
  cleanup.push(() => void autosave.dispose());

  const pMax = previewMaxSize();
  docs = createDocumentController({
    ctx,
    features,
    autosave,
    render,
    busy,
    aiMasks: aiMaskStore,
    patches: patchStore,
    ai,
    saveState,
    lastOpenedId,
    previewMaxSize: pMax,
    onDocChange: (doc) => maskProvider?.setContext({ source: doc ? doc.analysisProxy : BLANK_PROXY, depth: doc ? (aiMaskStore.get(depthKey(doc.photoId)) ?? null) : null }),
  });
  cleanup.push(() => docs.dispose());

  /* ---------------- reactions ---------------- */
  const rerender = (): void => render.request();
  cleanup.push(ctx.view.subscribe(rerender));
  cleanup.push(ctx.previewParams.subscribe(rerender));
  cleanup.push(ctx.compareParams.subscribe(rerender));
  cleanup.push(ctx.tool.subscribe(rerender));
  cleanup.push(
    ctx.theme.subscribe((choice) => {
      if (getThemeChoice() !== choice) applyTheme(choice);
    }),
  );
  cleanup.push(
    onThemeChange((_resolved, choice) => {
      ctx.theme.set(choice);
      ctx.view.set({ ...ctx.view.value, background: canvasBackground() });
    }),
  );
  // Keep selection / the open photo consistent with the library.
  cleanup.push(
    library.subscribe(() => {
      const sel = ctx.selection.value.filter((id) => library.get(id));
      if (sel.length !== ctx.selection.value.length) ctx.selection.set(sel);
      const doc = ctx.doc.value;
      if (doc && !library.get(doc.photoId)) {
        docs.close();
        ctx.module.set('library');
      }
      if (lastOpenedId.value && !library.get(lastOpenedId.value)) lastOpenedId.set(null);
    }),
  );
  // Entering Develop without an open photo opens the most relevant one.
  cleanup.push(
    ctx.module.subscribe((m) => {
      if (m === 'develop' && !ctx.doc.value) {
        const id = ctx.selection.value[0] ?? lastOpenedId.value ?? ctx.visibleIds.value[0];
        if (id) void docs.open(id);
      }
    }),
  );

  // Page lifecycle: persist on unload; warn only if a write is still pending.
  const onBeforeUnload = (e: BeforeUnloadEvent): void => {
    const pending = saveState.value === 'pending' || saveState.value === 'saving';
    void docs.flushAll().catch(() => undefined);
    if (pending) {
      e.preventDefault();
      e.returnValue = '';
    }
  };
  window.addEventListener('beforeunload', onBeforeUnload);
  cleanup.push(() => window.removeEventListener('beforeunload', onBeforeUnload));

  // House style model (lazy chunk).
  void features.load('style').then((style) => style && styleSvc.setBuiltin(style.KLOUD_STYLE));
  // Everything else in the background, so first use is instant.
  void features.preloadAll();

  cleanup.push(commands.attach({ scope: opts.embedded ? opts.root : null }));

  /* ---------------- runtime API ---------------- */
  async function importGroups(groups: FileGroup[]): Promise<string[]> {
    const io = await features.load('io');
    return runImport(ctx, busy, groups, { isSupported: io ? (f) => io.isSupportedFile(f) : undefined });
  }

  const runtime: AppRuntime = {
    ctx,
    features,
    commands,
    docs,
    render,
    busy,
    saveState,
    lastOpenedId,
    renderMs,
    engineStatus: engineResult.status,
    storageBackend: backendOf(db),
    previewMaxSize: pMax,
    embedded: !!opts.embedded,
    async enterDevelop(id) {
      const target = id ?? ctx.selection.value[0] ?? lastOpenedId.value ?? ctx.visibleIds.value[0];
      if (!target) {
        ctx.toast('Import a photo first — then open it in Develop.', 'info');
        return;
      }
      ctx.module.set('develop');
      await docs.open(target);
    },
    async importFolder() {
      const files = await pickFiles('folder', '');
      await importGroups([{ folder: '', files }]);
    },
    importGroups,
    async importDataTransfer(dt) {
      return importGroups(await collectDropped(dt));
    },
    async checkRecovery() {
      let rec: Awaited<ReturnType<AutosaveManager['getRecovery']>> = null;
      try {
        rec = await autosave.getRecovery();
      } catch {
        return;
      }
      if (!rec) return;
      const record = library.get(rec.photoId);
      if (!record) {
        await autosave.discardRecovery();
        return;
      }
      const mins = Math.max(1, Math.round((Date.now() - rec.savedAt) / 60000));
      const ok = await ctx.confirm({
        title: `Restore unsaved edits to ${record.name}?`,
        message: `KLOUD Studio closed unexpectedly while you were editing this photo. Its last autosave is from ${mins} min ago.`,
        confirmLabel: 'Restore',
        cancelLabel: 'Discard',
      });
      if (ok) {
        await library.saveEdit(rec.photoId, rec.state);
        await autosave.markClean();
        await runtime.enterDevelop(rec.photoId);
        ctx.toast(`Restored your edits to ${record.name}.`, 'success');
      } else {
        await autosave.discardRecovery();
      }
    },
    destroy() {
      for (const fn of cleanup.splice(0).reverse()) {
        try {
          fn();
        } catch (err) {
          console.error(err);
        }
      }
      engine?.dispose();
    },
  };
  return runtime;
}
