/**
 * KLOUD Studio — public entry point.
 *
 *   const editor = await mountKloudEditor(document.getElementById('app')!);
 *
 * Builds the site-style chrome (toolbar, sidebar, content, develop panel,
 * status bar) around the feature modules. Every feature is loaded lazily and
 * degrades to a placeholder if it fails, so one broken module never takes the
 * whole editor down.
 */
import '../ui/kit';
import '../ui/shell/shell.css';
import type { AppContext, AppModule, ThemeChoice } from './context';
import { registerAppCommands } from './app-commands';
import { createContext, type AppRuntime } from './createContext';
import type { Mounted } from './modules';
import { Disposer, h } from '../ui/dom';
import { createWordmark } from '../ui/kit';
import { attachDropzone } from '../ui/shell/dropzone';
import { createFallbackLibraryView, createFallbackViewer, createUnavailable } from '../ui/shell/fallbacks';
import { openShortcutsHelp } from '../ui/shell/help';
import { createShellState, layoutFor, type ShellState } from '../ui/shell/state';
import { createAppStatusBar } from '../ui/shell/statusbar';
import { createAppToolbar } from '../ui/shell/toolbar';

export type { AppContext, AppModule, ThemeChoice } from './context';

export interface MountOptions {
  theme?: ThemeChoice;
  initialModule?: AppModule;
  /** Scope keyboard shortcuts to the editor root (when embedded in a larger page). */
  embedded?: boolean;
  onReady?: (ctx: AppContext) => void;
}

export interface KloudEditorHandle {
  ctx: AppContext;
  destroy(): void;
  importFiles(files: File[]): Promise<void>;
}

/** Keep the library UI's own signals in step with the shell toolbar controls. */
async function bridgeLibraryState(rt: AppRuntime, state: ShellState, d: Disposer): Promise<void> {
  const lib = await rt.features.load('libraryUi');
  const mod = lib as unknown as { librarySignals?: { search: { set(v: string): void }; viewMode: { set(v: 'grid' | 'list'): void }; sort: { set(v: { key: string; order: 'asc' | 'desc' }): void } } } | null;
  const s = mod?.librarySignals;
  if (!s) return;
  d.add(state.librarySearch.subscribe((v) => s.search.set(v), true));
  d.add(state.libraryView.subscribe((v) => s.viewMode.set(v), true));
  d.add(state.librarySort.subscribe((v) => s.sort.set({ key: v.sort, order: v.order }), true));
}

export async function mountKloudEditor(root: HTMLElement, options: MountOptions = {}): Promise<KloudEditorHandle> {
  root.classList.add('k-root');
  root.textContent = '';
  const loading = h('div', { class: 'k-app__loading' }, createWordmark(), h('span', { class: 'k-muted' }, 'Loading…'));
  root.append(loading);

  const rt = await createContext({ root, theme: options.theme, initialModule: options.initialModule, embedded: options.embedded });
  const { ctx } = rt;
  const d = new Disposer();
  const state = createShellState();
  d.add(() => state.dispose());
  d.add(registerAppCommands(rt));

  /* ------------------------------ skeleton ------------------------------ */
  const left = h('aside', { class: 'k-app__left', attrs: { 'aria-label': 'Sidebar' } });
  const leftHead = h('div', { class: 'k-app__brand' }, createWordmark());
  const leftBody = h('div', { class: 'k-app__leftbody' });
  left.append(leftHead, leftBody);
  const main = h('main', { class: 'k-app__main' });
  const mainBody = h('div', { class: 'k-app__mainbody' });
  const film = h('div', { class: 'k-app__film' });
  main.append(mainBody, film);
  const right = h('div', { class: 'k-app__right' });
  const scrim = h('div', { class: 'k-app__scrim', onclick: () => state.leftOpen.set(false) });
  const body = h('div', { class: 'k-app__body' }, left, main, right, scrim);

  const toolbar = createAppToolbar(rt, state, {
    openDrawer: () => state.leftOpen.set(!state.leftOpen.value),
    openHelp: () => openShortcutsHelp(rt),
    libraryUp: () => {
      const p = state.libraryPath.value;
      if (p.length <= 1) return false;
      state.libraryPath.set(p.slice(0, -1));
      return true;
    },
    canGoUp: () => state.libraryPath.value.length > 1,
    libraryCrumb: (i) => state.libraryPath.set(state.libraryPath.value.slice(0, i + 1)),
  });
  d.add(() => toolbar.dispose());
  const status = createAppStatusBar(rt);
  d.add(() => status.dispose());

  const app = h('div', { class: 'k-app' }, toolbar.el, body, status.el);
  loading.remove();
  root.append(app);
  d.add(attachDropzone(rt, app));
  void bridgeLibraryState(rt, state, d);

  /* ------------------------------ mounting ------------------------------ */
  let mounted: Mounted[] = [];
  let generation = 0;
  const unmount = () => {
    for (const m of mounted) {
      try {
        m.dispose();
      } catch (e) {
        console.error(e);
      }
    }
    mounted = [];
    leftBody.replaceChildren();
    mainBody.replaceChildren();
    right.replaceChildren();
    film.replaceChildren();
  };
  const put = (host: HTMLElement, m: Mounted | null) => {
    if (!m) return;
    mounted.push(m);
    host.append(m.el);
  };

  const mountLibrary = async (gen: number) => {
    const lib = await rt.features.load('libraryUi');
    if (gen !== generation) return;
    if (lib) {
      put(leftBody, lib.createLibrarySidebar(ctx));
      // The shell toolbar already hosts the search pill and the grid/list toggle.
      put(mainBody, (lib.createLibraryView as (c: AppContext, o?: { search?: boolean; viewToggle?: boolean }) => Mounted)(ctx, { search: false, viewToggle: false }));
    } else {
      put(mainBody, createFallbackLibraryView(rt, state));
    }
  };

  const mountDevelop = async (gen: number) => {
    const [viewer, panels, lib] = await Promise.all([rt.features.load('viewer'), rt.features.load('panels'), rt.features.load('libraryUi')]);
    if (gen !== generation) return;
    const nav = viewer ? viewer.createNavigator(ctx) : null;
    if (nav) mounted.push(nav);
    if (panels) {
      put(leftBody, panels.createDevelopLeftPanel(ctx, { navigator: nav?.el }));
      put(right, panels.createDevelopRightPanel(ctx));
    } else {
      put(right, createUnavailable('Panels unavailable', rt.features.error('panels') ?? 'The develop panels failed to load.'));
    }
    put(mainBody, viewer ? viewer.createViewer(ctx) : createFallbackViewer(rt));
    if (lib) put(film, lib.createFilmstrip(ctx));
  };

  const show = (module: AppModule) => {
    generation++;
    unmount();
    app.dataset.module = module;
    void (module === 'library' ? mountLibrary(generation) : mountDevelop(generation));
  };
  d.add(ctx.module.subscribe(show, true));

  /* Feature command sets (registered once, guarded by their own `when`). */
  void rt.features.load('panels').then((m) => m && d.add(m.registerPanelCommands(ctx)));
  void rt.features.load('viewer').then((m) => m && d.add(m.registerViewerCommands(ctx)));
  void rt.features.load('libraryUi').then((m) => m && d.add(m.registerLibraryCommands(ctx)));

  /* ------------------------------ layout ------------------------------ */
  const applyLayout = () => {
    const layout = layoutFor(app.clientWidth || window.innerWidth);
    const small = layout === 'narrow' || layout === 'phone';
    const wasSmall = app.dataset.layout === 'narrow' || app.dataset.layout === 'phone';
    // The sidebar is a drawer on small screens: start closed there.
    if (small && !wasSmall) state.leftOpen.set(false);
    if (!small && wasSmall) state.leftOpen.set(true);
    state.layout.set(layout);
    app.dataset.layout = layout;
  };
  const ro = new ResizeObserver(applyLayout);
  ro.observe(app);
  d.add(() => ro.disconnect());
  applyLayout();
  const syncPanels = () => {
    const focus = state.focusMode.value;
    app.classList.toggle('is-left-open', state.leftOpen.value && !focus);
    app.classList.toggle('is-right-open', state.rightOpen.value && !focus);
    app.classList.toggle('is-film-open', state.filmstripOpen.value && !focus);
    app.classList.toggle('is-focus', focus);
  };
  for (const s of [state.leftOpen, state.rightOpen, state.focusMode, state.filmstripOpen]) d.add(s.subscribe(syncPanels));
  syncPanels();
  // On narrow screens the sidebar is a drawer: close it after navigating.
  d.add(
    ctx.module.subscribe(() => {
      if (state.layout.value === 'narrow' || state.layout.value === 'phone') state.leftOpen.set(false);
    }),
  );
  d.add(
    ctx.commands.register({
      id: 'layout.panels',
      label: 'Toggle side panels',
      keys: ['Tab'],
      group: 'View',
      run: () => state.rightOpen.set(!state.rightOpen.value),
    }),
  );
  d.add(
    ctx.commands.register({
      id: 'layout.focus',
      label: 'Hide all panels',
      keys: ['Shift+Tab'],
      group: 'View',
      run: () => state.focusMode.set(!state.focusMode.value),
    }),
  );
  d.add(
    ctx.commands.register({
      id: 'layout.fullscreen',
      label: 'Fullscreen',
      keys: ['F'],
      group: 'View',
      run: () => {
        const doc = document as Document & { webkitFullscreenElement?: Element };
        if (doc.fullscreenElement || doc.webkitFullscreenElement) void document.exitFullscreen?.().catch(() => undefined);
        else void root.requestFullscreen?.().catch(() => ctx.toast('Fullscreen is not available here.', 'info'));
      },
    }),
  );
  d.add(ctx.commands.register({ id: 'help.shortcuts', label: 'Keyboard shortcuts', keys: ['?', 'Shift+/'], group: 'Help', run: () => openShortcutsHelp(rt) }));

  void rt.checkRecovery();
  (window as unknown as { __kloud?: AppRuntime }).__kloud = rt;
  options.onReady?.(ctx);

  return {
    ctx,
    async importFiles(files: File[]) {
      await ctx.importFiles(files);
    },
    destroy() {
      unmount();
      d.dispose();
      rt.destroy();
      app.remove();
      root.classList.remove('k-root');
    },
  };
}
