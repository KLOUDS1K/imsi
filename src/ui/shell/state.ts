/**
 * Shell-local UI state: panel visibility, focus mode, responsive layout class,
 * and the Library controls the toolbar hosts (search pill, grid/list toggle,
 * sort). The Library UI module is bridged to these in ./library-bridge.ts.
 */
import type { LibrarySort } from '@/editor/types';
import { loadLocal, saveLocal } from '@/ui/kit';
import { Signal } from '@/ui/signal';

export type LayoutClass = 'wide' | 'medium' | 'narrow' | 'phone';
export type LibraryViewMode = 'grid' | 'list';

export interface LibrarySortState {
  sort: LibrarySort;
  order: 'asc' | 'desc';
}

export interface ShellState {
  leftOpen: Signal<boolean>;
  rightOpen: Signal<boolean>;
  /** Phone-only develop sheet. Kept separate so mobile use never changes the desktop panel preference. */
  mobilePanelOpen: Signal<boolean>;
  /** Lock button: hide every panel (Shift+Tab). */
  focusMode: Signal<boolean>;
  filmstripOpen: Signal<boolean>;
  layout: Signal<LayoutClass>;
  librarySearch: Signal<string>;
  libraryView: Signal<LibraryViewMode>;
  librarySort: Signal<LibrarySortState>;
  /** Breadcrumb of the current Library location, e.g. ['All Photos'] or ['Folders', '2026', 'Seoul']. */
  libraryPath: Signal<string[]>;
  dispose(): void;
}

const persisted = <T>(key: string, fallback: T, offs: (() => void)[]): Signal<T> => {
  const s = new Signal<T>(loadLocal<T>(key, fallback));
  offs.push(s.subscribe((v) => saveLocal(key, v)));
  return s;
};

/* Breakpoints (keep in sync with shell.css). */
export const BREAKPOINTS = { medium: 1024, narrow: 820, phone: 640 } as const;

export function layoutFor(width: number, height = Number.POSITIVE_INFINITY, coarsePointer = false): LayoutClass {
  // A phone rotated to landscape is often wider than 640px. Treat short,
  // touch-first viewports as phones too, without changing desktop windows.
  if (width <= BREAKPOINTS.phone || (coarsePointer && width <= 920 && height <= 640)) return 'phone';
  if (width <= BREAKPOINTS.narrow) return 'narrow';
  if (width <= BREAKPOINTS.medium) return 'medium';
  return 'wide';
}

export function createShellState(): ShellState {
  const offs: (() => void)[] = [];
  const state: ShellState = {
    leftOpen: persisted('kloud-shell:left', true, offs),
    rightOpen: persisted('kloud-shell:right', true, offs),
    mobilePanelOpen: new Signal(false),
    focusMode: new Signal(false),
    filmstripOpen: persisted('kloud-shell:filmstrip', true, offs),
    layout: new Signal<LayoutClass>(layoutFor(typeof window === 'undefined' ? 1440 : window.innerWidth)),
    librarySearch: new Signal(''),
    libraryView: persisted<LibraryViewMode>('kloud-shell:library-view', 'grid', offs),
    librarySort: persisted<LibrarySortState>('kloud-shell:library-sort', { sort: 'date-taken', order: 'desc' }, offs),
    libraryPath: new Signal<string[]>(['All Photos']),
    dispose: () => offs.splice(0).forEach((f) => f()),
  };
  return state;
}

export const SORT_LABELS: Record<LibrarySort, string> = {
  'date-taken': 'Capture date',
  'date-added': 'Import date',
  edited: 'Edit date',
  name: 'File name',
  rating: 'Rating',
  size: 'File size',
  camera: 'Camera',
  iso: 'ISO',
  'focal-length': 'Focal length',
};
