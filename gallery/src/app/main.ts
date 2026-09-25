/** Boot, wiring, and the one place the URL is turned into what is on screen. */
import { ROOT } from '../shared/types'
import { icon } from './icons'
import { el, need, openMenu, toast } from './ui'
import { applyTheme, nextTheme, state, subscribe, update } from './state'
import { themeTransition } from './motion'
import { initExplorer, render } from './explorer'
import { initImageGuard } from './guard'
import { syncViewer } from './lightbox'
import { adminHooks } from './hooks'
import {
  back,
  canGoBack,
  canGoForward,
  forward,
  go,
  parseRoute,
  startRouter,
  type Route,
} from './router'
import { api } from './api'
import { loadFolder, loadTree, prefetchFolder, reload, runSearch } from './data'

import '../styles/base.css'
import '../styles/explorer.css'
import '../styles/viewer.css'
import '../styles/admin.css'
import '../styles/motion.css'

/** Pulled in only once a session exists, so a visitor never downloads it. */
let adminLoading: Promise<void> | null = null

function ensureAdmin(): Promise<void> {
  adminLoading ??= import('./admin')
    .then((module) => module.installAdmin())
    .catch((err) => {
      adminLoading = null
      throw err
    })
  return adminLoading
}

// ------------------------------------------------------------------- chrome

function renderNav(): void {
  const backBtn = need<HTMLButtonElement>('[data-nav="back"]')
  const forwardBtn = need<HTMLButtonElement>('[data-nav="forward"]')
  const upBtn = need<HTMLButtonElement>('[data-nav="up"]')

  backBtn.disabled = !canGoBack()
  forwardBtn.disabled = !canGoForward()
  upBtn.disabled = state.folderId === ROOT && !state.search
}

function parentOfCurrent(): string {
  const trail = state.current?.path ?? []
  const parent = trail[trail.length - 2]
  return parent ? parent.id : ROOT
}

function openAccountMenu(anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect()
  if (!state.admin) {
    signIn()
    return
  }

  openMenu(
    [
      {
        label: 'Stats',
        icon: 'sort',
        run: () => go({ folderId: ROOT, photoId: null, stats: true }),
      },
      {
        label: 'New folder',
        icon: 'folderPlus',
        run: () => adminHooks()?.createFolder(state.folderId),
      },
      {
        label: 'Upload photos',
        icon: 'upload',
        run: () => adminHooks()?.pickFiles(state.folderId),
      },
      {
        label: `Sign out (${state.username ?? 'admin'})`,
        icon: 'logout',
        run: () => {
          void import('./admin').then((module) => module.signOut())
        },
      },
    ],
    rect.right - 8,
    rect.bottom + 8,
    anchor,
  )
}

function signIn(): void {
  void ensureAdmin()
    .then(() => import('./admin'))
    .then((module) => module.signIn())
    .catch(() => toast('Could not load the admin tools', 'error'))
}

function initChrome(): void {
  need<HTMLButtonElement>('[data-nav="back"]').addEventListener('click', back)
  need<HTMLButtonElement>('[data-nav="forward"]').addEventListener('click', forward)
  need<HTMLButtonElement>('[data-nav="up"]').addEventListener('click', () => {
    go({ folderId: parentOfCurrent(), photoId: null })
  })

  const theme = need<HTMLButtonElement>('[data-role="theme"]')
  theme.addEventListener('click', () => {
    // The new theme is wiped in as a circle growing from this button.
    const box = theme.getBoundingClientRect()
    themeTransition({ x: box.left + box.width / 2, y: box.top + box.height / 2 }, () => {
      update({ theme: nextTheme() })
      applyTheme()
    })
  })

  const account = need<HTMLButtonElement>('[data-role="account"]')
  account.addEventListener('click', () => openAccountMenu(account))

  // The sidebar is a drawer below the tablet breakpoint.
  const scrim = need('[data-role="scrim"]')
  const drawer = need<HTMLButtonElement>('[data-role="drawer"]')
  const setDrawer = (open: boolean) => {
    document.documentElement.classList.toggle('is-drawer-open', open)
    scrim.hidden = !open
  }
  drawer.addEventListener('click', () => {
    setDrawer(!document.documentElement.classList.contains('is-drawer-open'))
  })
  scrim.addEventListener('click', () => setDrawer(false))
  need('[data-role="sidebar"]').addEventListener('click', (event) => {
    if ((event.target as Element | null)?.closest?.('a[data-link]')) setDrawer(false)
  })

  // ------------------------------------------------------------------ search
  const search = need<HTMLInputElement>('[data-role="search"]')
  let timer = 0
  search.addEventListener('input', () => {
    window.clearTimeout(timer)
    timer = window.setTimeout(() => void runSearch(search.value), 220)
  })
  search.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    search.value = ''
    void runSearch('')
    search.blur()
  })

  /*
   * Pointing at a folder starts fetching it. By the time the click lands the
   * answer is usually already in hand, which was most of what made navigation
   * feel slow — the request only began once the click had happened.
   */
  document.addEventListener(
    'pointerover',
    (event) => {
      const anchor = (event.target as Element | null)?.closest?.('a[data-link]')
      if (!(anchor instanceof HTMLAnchorElement)) return
      const route = parseRoute(new URL(anchor.href, window.location.origin))
      if (route.photoId) return
      prefetchFolder(route.folderId)
    },
    { passive: true },
  )

  // ------------------------------------------------------------- shortcuts
  document.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement | null
    const typing =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      target?.isContentEditable === true

    if (event.key === '/' && !typing) {
      event.preventDefault()
      search.focus()
      return
    }
    if (typing || event.metaKey || event.ctrlKey || event.altKey) return
    if (document.documentElement.classList.contains('is-viewing')) return

    if (event.key === 'Backspace') {
      event.preventDefault()
      if (state.folderId !== ROOT) go({ folderId: parentOfCurrent(), photoId: null })
      return
    }
    if (event.key === 'u' && state.admin) {
      event.preventDefault()
      adminHooks()?.pickFiles(state.folderId)
      return
    }
    if (event.key === 'n' && state.admin) {
      event.preventDefault()
      adminHooks()?.createFolder(state.folderId)
    }
  })
}

// -------------------------------------------------------------------- route

async function handleRoute(route: Route): Promise<void> {
  // The stats page is the owner's, and it is not a folder — it neither loads
  // one nor leaves the last one behind it.
  if (route.stats) {
    if (!state.admin) {
      go({ folderId: ROOT, photoId: null }, true)
      return
    }
    await ensureAdmin().catch(() => undefined)
    const module = await import('./stats')
    await module.loadStats()
    renderNav()
    return
  }
  if (state.statsOpen) update({ statsOpen: false })

  if (route.folderId !== state.folderId || !state.current || state.search) {
    const search = need<HTMLInputElement>('[data-role="search"]')
    if (search.value) search.value = ''
    await loadFolder(route.folderId)
  }
  syncViewer(route.photoId)
  renderNav()
}

// --------------------------------------------------------------------- boot

async function boot(): Promise<void> {
  const adminEntry = window.location.pathname.replace(/\/+$/, '') === '/admin'
  // Ask for the folder in the address bar before anything else. The tree call
  // below then rides alongside it instead of queueing in front of it, which on
  // a first load saved a whole round trip of staring at an empty pane.
  prefetchFolder(parseRoute().folderId)

  applyTheme()
  initImageGuard()
  initExplorer()
  initChrome()

  subscribe(() => {
    render()
    renderNav()
  })

  // Opening a locked folder changes what the server returns for the very same
  // URL, so the view has to be pulled again rather than merely re-rendered.
  window.addEventListener('kp:reload', () => void reload())

  // One visit per page load, counted once the page is actually up.
  api.hit({ visit: true })

  // The tree call also reports whether this browser holds a session, which is
  // what decides if the management bundle is worth downloading at all.
  await loadTree()
  if (state.admin) {
    await ensureAdmin().catch(() => toast('Could not load the admin tools', 'error'))
  }

  startRouter((route) => void handleRoute(route))

  // A bookmarked /admin is just a shortcut to the sign-in sheet.
  if (adminEntry) {
    go({ folderId: ROOT, photoId: null }, true)
    if (!state.admin) signIn()
  }
}

void boot().catch((err) => {
  console.error(err)
  const host = need('[data-role="content"]')
  host.innerHTML = ''
  host.append(
    el('div', { class: 'empty' }, [
      el('span', { class: 'empty__glyph', html: icon('info') }),
      el('p', { class: 'empty__title', text: 'The page could not start' }),
      el('p', { class: 'empty__hint', text: 'Please reload.' }),
    ]),
  )
})
