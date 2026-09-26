/**
 * One store, one subscriber list. Views never read the DOM to work out what is
 * on screen — they read this, and re-render when it changes.
 */
import type { BrowseResult, Folder, Photo, StatsReport } from '../shared/types'
import { ROOT } from '../shared/types'

export type ViewMode = 'grid' | 'list'
export type SortKey = 'name' | 'date' | 'size'
export type SortDir = 'asc' | 'desc'
export type Theme = 'system' | 'light' | 'dark'

export interface SearchResult {
  query: string
  folders: Folder[]
  photos: Photo[]
}

export interface State {
  folderId: string
  view: ViewMode
  sortKey: SortKey
  sortDir: SortDir
  theme: Theme
  admin: boolean
  username: string | null
  tree: Folder[]
  expanded: Set<string>
  current: BrowseResult | null
  search: SearchResult | null
  /** The owner's stats view: open, and what it is showing. */
  statsOpen: boolean
  stats: StatsReport | null
  loading: boolean
  errorText: string | null
}

const STORE_KEY = 'kloud.explorer.prefs'
/** Shared with KLOUD Studio (`src/ui/kit/theme.ts`) on the same origin. */
export const THEME_STORAGE_KEY = 'kloud-theme'

interface Prefs {
  view: ViewMode
  sortKey: SortKey
  sortDir: SortDir
  theme: Theme
  expanded: string[]
}

function validTheme(value: unknown): Theme | null {
  return value === 'light' || value === 'dark' || value === 'system' ? value : null
}

function loadPrefs(): Prefs {
  const fallback: Prefs = {
    view: 'grid',
    sortKey: 'date',
    sortDir: 'desc',
    theme: 'system',
    expanded: [],
  }
  try {
    const shared = validTheme(localStorage.getItem(THEME_STORAGE_KEY))
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return { ...fallback, theme: shared ?? fallback.theme }
    const parsed = JSON.parse(raw) as Partial<Prefs>
    return {
      view: parsed.view === 'list' ? 'list' : 'grid',
      sortKey: parsed.sortKey === 'name' || parsed.sortKey === 'size' ? parsed.sortKey : 'date',
      sortDir: parsed.sortDir === 'asc' ? 'asc' : 'desc',
      theme: shared ?? validTheme(parsed.theme) ?? 'system',
      expanded: Array.isArray(parsed.expanded) ? parsed.expanded.filter((v) => typeof v === 'string') : [],
    }
  } catch {
    return fallback
  }
}

const prefs = loadPrefs()

export const state: State = {
  folderId: ROOT,
  view: prefs.view,
  sortKey: prefs.sortKey,
  sortDir: prefs.sortDir,
  theme: prefs.theme,
  admin: false,
  username: null,
  tree: [],
  expanded: new Set(prefs.expanded),
  current: null,
  search: null,
  statsOpen: false,
  stats: null,
  loading: true,
  errorText: null,
}

type Listener = () => void
const listeners = new Set<Listener>()

export function subscribe(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function savePrefs(): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, state.theme)
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        view: state.view,
        sortKey: state.sortKey,
        sortDir: state.sortDir,
        theme: state.theme,
        expanded: [...state.expanded],
      } satisfies Prefs),
    )
  } catch {
    // Private-mode browsers refuse writes; preferences just do not persist.
  }
}

export function update(patch: Partial<State>): void {
  Object.assign(state, patch)
  savePrefs()
  for (const fn of listeners) fn()
}

/** Mutating the expanded set in place still has to notify and persist. */
export function touch(): void {
  savePrefs()
  for (const fn of listeners) fn()
}

function emit(): void {
  for (const fn of listeners) fn()
}

/**
 * Keep an already-open gallery in step when Studio (or another gallery tab)
 * changes the shared theme. System-theme changes also refresh the icon.
 */
export function installThemeSync(): () => void {
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const onStorage = (event: StorageEvent) => {
    if (event.key !== THEME_STORAGE_KEY) return
    const next = validTheme(event.newValue) ?? 'system'
    if (state.theme === next) return
    state.theme = next
    savePrefs()
    applyTheme()
    emit()
  }
  const onSystem = () => {
    if (state.theme === 'system') emit()
  }
  window.addEventListener('storage', onStorage)
  media.addEventListener('change', onSystem)
  return () => {
    window.removeEventListener('storage', onStorage)
    media.removeEventListener('change', onSystem)
  }
}

// -------------------------------------------------------------------- theme

export function applyTheme(): void {
  const root = document.documentElement
  if (state.theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', state.theme)
}

/** Cycles through the two explicit themes, starting from whatever is showing. */
export function nextTheme(): Theme {
  const dark =
    state.theme === 'dark' ||
    (state.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  return dark ? 'light' : 'dark'
}

// --------------------------------------------------------------------- tree

export function childFolders(parentId: string): Folder[] {
  return state.tree.filter((f) => f.parentId === parentId)
}

export function folderById(id: string): Folder | null {
  return state.tree.find((f) => f.id === id) ?? null
}

/** Every ancestor of `id`, so the sidebar can open the branch it lives on. */
export function ancestorsOf(id: string): string[] {
  const out: string[] = []
  let cursor = folderById(id)
  while (cursor && cursor.parentId !== ROOT) {
    out.push(cursor.parentId)
    cursor = folderById(cursor.parentId)
  }
  return out
}
