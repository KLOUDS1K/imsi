/**
 * Theme helpers — same behaviour as the site's sun/moon toggle.
 *
 * The theme lives on <html data-theme="light|dark">; without the attribute the
 * OS preference decides (tokens.css handles both). The choice is persisted in
 * localStorage under 'kloud-theme' (each route applies it before revealing
 * the application shell).
 *
 *   applyTheme('dark');
 *   const off = onThemeChange((resolved) => redrawCanvas(readToken('--k-accent')));
 */
import type { ThemeChoice } from '../../app/context';

export type { ThemeChoice };
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'kloud-theme';

const root = (): HTMLElement => document.documentElement;
const darkQuery = (): MediaQueryList | null =>
  typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

/** The explicit choice currently applied to the page ('system' when no attribute). */
export function getThemeChoice(): ThemeChoice {
  const attr = root().getAttribute('data-theme');
  return attr === 'light' || attr === 'dark' ? attr : 'system';
}

/** The persisted choice (what the user picked last time), default 'system'. */
export function storedThemeChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
  } catch {
    return 'system';
  }
}

/** The theme actually on screen. */
export function resolvedTheme(): ResolvedTheme {
  const choice = getThemeChoice();
  if (choice !== 'system') return choice;
  return darkQuery()?.matches ? 'dark' : 'light';
}

/**
 * Apply a theme choice: sets/removes html[data-theme] and persists it.
 * Listeners registered with onThemeChange() fire synchronously.
 */
export function applyTheme(choice: ThemeChoice, opts: { persist?: boolean } = {}): void {
  if (choice === 'light' || choice === 'dark') root().setAttribute('data-theme', choice);
  else root().removeAttribute('data-theme');
  if (opts.persist !== false) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, choice);
    } catch {
      /* not persisted */
    }
  }
  notify();
}

/** Re-apply the persisted choice once during route startup. */
export function initTheme(): ThemeChoice {
  const choice = storedThemeChoice();
  applyTheme(choice, { persist: false });
  return choice;
}

/**
 * Site toggle behaviour: flip between explicit light and dark based on what
 * is on screen now. Returns the new choice.
 */
export function toggleTheme(): ThemeChoice {
  const next: ThemeChoice = resolvedTheme() === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  return next;
}

/** Read a CSS custom property (resolved value) — for canvas drawing. */
export function readToken(name: string, el: Element = root()): string {
  return getComputedStyle(el).getPropertyValue(name).trim();
}

/* ---- change notifications (toggle, attribute set elsewhere, OS change) ---- */

type ThemeListener = (resolved: ResolvedTheme, choice: ThemeChoice) => void;
const listeners = new Set<ThemeListener>();
let last: { resolved: ResolvedTheme; choice: ThemeChoice } | null = null;
let observer: MutationObserver | null = null;
let mql: MediaQueryList | null = null;
let storageListener: ((event: StorageEvent) => void) | null = null;

function notify(): void {
  if (!listeners.size) return;
  const resolved = resolvedTheme();
  const choice = getThemeChoice();
  if (last && last.resolved === resolved && last.choice === choice) return;
  last = { resolved, choice };
  for (const fn of [...listeners]) {
    try {
      fn(resolved, choice);
    } catch (e) {
      console.error(e);
    }
  }
}

/**
 * Subscribe to theme changes: fires when the resolved theme or the choice
 * changes — via applyTheme(), anyone setting html[data-theme], or the OS
 * switching light/dark while the choice is 'system'. Returns an unsubscribe.
 */
export function onThemeChange(cb: ThemeListener): () => void {
  if (!listeners.size) {
    last = { resolved: resolvedTheme(), choice: getThemeChoice() };
    observer = new MutationObserver(notify);
    observer.observe(root(), { attributes: true, attributeFilter: ['data-theme'] });
    mql = darkQuery();
    mql?.addEventListener('change', notify);
    storageListener = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY) return;
      const choice: ThemeChoice = event.newValue === 'light' || event.newValue === 'dark' || event.newValue === 'system'
        ? event.newValue
        : 'system';
      applyTheme(choice, { persist: false });
    };
    window.addEventListener('storage', storageListener);
  }
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
    if (!listeners.size) {
      observer?.disconnect();
      observer = null;
      mql?.removeEventListener('change', notify);
      mql = null;
      if (storageListener) window.removeEventListener('storage', storageListener);
      storageListener = null;
      last = null;
    }
  };
}
