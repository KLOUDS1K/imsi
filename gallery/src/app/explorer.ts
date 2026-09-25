/**
 * The explorer: breadcrumb, sidebar tree, and the folder/file pane.
 *
 * Rendering is a full redraw of each region from `state`. The lists here are
 * a few hundred nodes at most, a redraw is well under a frame, and it keeps
 * every path — navigation, upload finishing, a rename, a search — on exactly
 * one code path instead of a web of partial DOM updates.
 */
import type { BrowseResult, Folder, FolderEntry, Photo } from '../shared/types'
import {
  ROOT,
  displayName,
  folderHref,
  formatBytes,
  formatDate,
  formatDimensions,
  formatKind,
  formatTimestamp,
  plural,
  summarise,
} from '../shared/types'
import { icon } from './icons'
import type { MenuItem } from './ui'
import { el, need, openMenu, paintIcons } from './ui'
import { state, touch, update, ancestorsOf, childFolders } from './state'
import { adminHooks } from './hooks'
import { initPointerTilt, initScrollShade } from './motion'
import { api } from './api'
import { go, hrefFor } from './router'
import { downloadOriginal } from './download'
import { openLightbox, setSequence } from './lightbox'
import { openPhotoInStudio } from './studio-link'

const collator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' })

let crumbsHost: HTMLElement
let treeHost: HTMLElement
let contentHost: HTMLElement
let statusHost: HTMLElement
let totalsHost: HTMLElement
let paneHost: HTMLElement

// ------------------------------------------------------------------ sorting

function sortFolders(list: FolderEntry[]): FolderEntry[] {
  const dir = state.sortDir === 'asc' ? 1 : -1
  return [...list].sort((a, b) => {
    switch (state.sortKey) {
      case 'name':
        return collator.compare(a.name, b.name) * dir
      case 'size':
        return (a.photoCount - b.photoCount) * dir
      default: {
        const at = a.date ? Date.parse(`${a.date}T00:00:00Z`) / 1000 : a.createdAt
        const bt = b.date ? Date.parse(`${b.date}T00:00:00Z`) / 1000 : b.createdAt
        return (at - bt) * dir
      }
    }
  })
}

function sortPhotos(list: Photo[]): Photo[] {
  const dir = state.sortDir === 'asc' ? 1 : -1
  return [...list].sort((a, b) => {
    switch (state.sortKey) {
      case 'name':
        return collator.compare(displayName(a), displayName(b)) * dir
      case 'size':
        return (a.size - b.size) * dir
      default: {
        const at = a.date ? Date.parse(`${a.date}T00:00:00Z`) / 1000 : a.createdAt
        const bt = b.date ? Date.parse(`${b.date}T00:00:00Z`) / 1000 : b.createdAt
        return (at - bt) * dir
      }
    }
  })
}

// ---------------------------------------------------------------- breadcrumb

function crumbLink(id: string, label: string, current: boolean): HTMLElement {
  return el(
    'a',
    {
      class: `crumb${current ? ' crumb--current' : ''}`,
      href: folderHref(id),
      'data-link': true,
      'data-drop-folder': id,
      'aria-current': current ? 'page' : null,
    },
    [el('span', { text: label })],
  )
}

function renderCrumbs(): void {
  crumbsHost.innerHTML = ''
  const trail = state.current?.path ?? []
  const parts: HTMLElement[] = [crumbLink(ROOT, 'Archive', trail.length === 0)]

  trail.forEach((folder, i) => {
    parts.push(el('span', { class: 'crumb__sep', html: icon('chevronRight') }))
    parts.push(crumbLink(folder.id, folder.name, i === trail.length - 1))
  })

  crumbsHost.append(...parts)
  pinCrumbsToEnd()
  // Crumb widths move once the webfont swaps in, which would otherwise leave
  // the path a few pixels short of the folder you are actually in.
  requestAnimationFrame(pinCrumbsToEnd)
}

/** Keeps the folder you are in on screen when the path outgrows the bar. */
function pinCrumbsToEnd(): void {
  if (!crumbsHost) return
  crumbsHost.scrollLeft = crumbsHost.scrollWidth
  crumbsHost.classList.toggle('is-scrolled', crumbsHost.scrollLeft > 2)
}

// -------------------------------------------------------------------- tree

function treeBranch(parentId: string, depth: number): HTMLElement | null {
  const children = childFolders(parentId)
  if (!children.length) return null

  const list = el('ul', { class: 'tree__list', role: depth === 0 ? 'tree' : 'group' })

  for (const folder of [...children].sort((a, b) => collator.compare(a.name, b.name))) {
    const hasChildren = childFolders(folder.id).length > 0
    const isOpen = state.expanded.has(folder.id)
    const isCurrent = state.folderId === folder.id

    const twisty = el('button', {
      class: `tree__twisty${hasChildren ? '' : ' is-empty'}`,
      type: 'button',
      'aria-label': isOpen ? 'Collapse' : 'Expand',
      'aria-expanded': hasChildren ? String(isOpen) : null,
      html: hasChildren ? icon('chevronRight') : '',
      tabindex: hasChildren ? 0 : -1,
    })
    if (hasChildren) {
      twisty.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (state.expanded.has(folder.id)) state.expanded.delete(folder.id)
        else state.expanded.add(folder.id)
        touch()
      })
    }

    const link = el(
      'a',
      {
        class: `tree__link${isCurrent ? ' is-current' : ''}`,
        href: folderHref(folder.id),
        'data-link': true,
        'data-drop-folder': folder.id,
        '--depth': String(depth),
      },
      [
        el('span', {
          class: 'tree__icon',
          html: icon(folder.locked || folder.hasPassword ? 'lock' : 'folder'),
        }),
        el('span', { class: 'tree__name', text: folder.name }),
      ],
    )

    const item = el('li', { class: 'tree__item' }, [
      el('div', { class: 'tree__row' }, [twisty, link]),
    ])
    if (isOpen) {
      const sub = treeBranch(folder.id, depth + 1)
      if (sub) item.append(sub)
    }
    list.append(item)
  }

  return list
}

function renderTree(): void {
  treeHost.innerHTML = ''
  const branch = treeBranch(ROOT, 0)
  if (branch) treeHost.append(branch)
  else if (!state.loading) {
    treeHost.append(el('p', { class: 'tree__empty', text: 'No folders' }))
  }
}

// ------------------------------------------------------------------- tiles

/**
 * The folder icon: a manila folder with the prints inside peeking over its
 * front. Built from elements rather than one image so the photos are real
 * thumbnails — the folder tells you what is in it at a glance, and the prints
 * lift a little further out when the pointer is on the card.
 */
function folderGraphic(folder: FolderEntry): HTMLElement {
  const frame = el('span', { class: 'folder' }, [el('span', { class: 'folder__back' })])

  if (folder.locked) {
    frame.classList.add('folder--locked')
  } else {
    // The count drives the layout: one print sits centred, two pair up, three
    // fan. Positioning is per-count in CSS rather than per-element here.
    // The slot has to be an explicit class: every child of .folder is a span,
    // so :nth-of-type() would count the back panel as the first print.
    const slots = ['a', 'b', 'c', 'd', 'e']
    folder.covers.slice(0, slots.length).forEach((src, index) => {
      frame.append(
        el('span', { class: `folder__print folder__print--${slots[index]}` }, [
          el('img', { src, alt: '', loading: 'lazy', decoding: 'async' }),
        ]),
      )
    })
  }

  frame.append(el('span', { class: 'folder__front' }))
  // A visitor gets the padlock stamped across the front of a folder they
  // cannot open; the owner, who can see straight into it, gets the same stamp
  // small in the corner so a protected folder is still obvious at a glance.
  if (folder.locked) {
    frame.append(el('span', { class: 'folder__glyph', html: icon('lockSolid') }))
  } else if (folder.hasPassword) {
    frame.append(
      el('span', { class: 'folder__glyph folder__glyph--badge', html: icon('lockSolid') }),
    )
  }
  // Written on the front of the folder, the way a date on a real one would be.
  if (folder.date && !folder.locked) {
    frame.append(el('span', { class: 'folder__date', text: formatDate(folder.date) }))
  }
  return frame
}

function moreButton(
  onOpen: (x: number, y: number, anchor: HTMLElement) => void,
): HTMLButtonElement {
  const button = el('button', {
    class: 'more-btn',
    type: 'button',
    title: 'More',
    'aria-label': 'More',
    html: icon('more'),
  })
  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    const rect = button.getBoundingClientRect()
    onOpen(rect.right - 8, rect.bottom + 6, button)
  })
  return button
}

/** Entrance delays are capped: a long folder should not take seconds to land. */
const STAGGER_CAP = 16

function stagger(node: HTMLElement, index: number): HTMLElement {
  node.style.setProperty('--i', String(Math.min(index, STAGGER_CAP)))
  return node
}

function folderCard(folder: FolderEntry, index = 0): HTMLElement {
  const card = stagger(
    el('div', { class: 'card', 'data-folder': folder.id, 'data-drop-folder': folder.id }),
    index,
  )
  const link = el(
    'a',
    { class: 'card__link', href: folderHref(folder.id), 'data-link': true },
    [
      folderGraphic(folder),
      el('span', { class: 'card__meta' }, [
        el('span', { class: 'card__name' }, [
          folder.locked || folder.hasPassword
            ? el('span', { class: 'card__lock', html: icon('lock'), 'aria-hidden': 'true' })
            : null,
          el('span', { text: folder.name }),
        ]),
        el('span', {
          class: 'card__sub',
          text: folder.locked ? 'Locked' : summarise(folder.folderCount, folder.photoCount),
        }),
      ]),
    ],
  )
  card.append(link)

  if (adminHooks()) card.append(moreButton((x, y, anchor) => openFolderMenu(folder, x, y, anchor)))

  card.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    openFolderMenu(folder, event.clientX, event.clientY)
  })
  return card
}

function photoTile(photo: Photo, siblings: Photo[], index = 0): HTMLElement {
  const name = displayName(photo)
  const href = hrefFor({ folderId: photo.folderId, photoId: photo.id })
  const tile = stagger(el('div', { class: 'tile', 'data-photo': photo.id }), index)
  const frame = el('span', { class: 'tile__frame' })

  if (photo.placeholder) frame.style.backgroundImage = `url("${photo.placeholder}")`

  const img = el('img', {
    class: 'tile__img',
    src: photo.thumbUrl,
    alt: name,
    loading: 'lazy',
    decoding: 'async',
  })
  // A format the uploading browser could not decode has no thumbnail; fall
  // back to a labelled glyph rather than a broken image.
  img.addEventListener('load', () => img.classList.add('is-loaded'))
  if (img.complete && img.naturalWidth > 0) img.classList.add('is-loaded')
  img.addEventListener('error', () => {
    img.remove()
    frame.classList.add('tile__frame--fallback')
    frame.prepend(
      el('span', { class: 'tile__glyph', html: icon('image') }),
      el('span', { class: 'tile__ext', text: formatKind(photo) }),
    )
  })
  frame.append(img)

  // The frame's click target is a stretched anchor rather than a wrapper, so
  // the download button can sit inside the square without nesting a button in
  // a link — and so the button never has to guess where the caption starts.
  const hit = el('a', {
    class: 'tile__hit',
    href,
    'data-link': true,
    'aria-label': `View ${name}`,
  })
  const open = (event: MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    openLightbox(siblings, photo.id)
  }
  hit.addEventListener('click', open)

  const quick = el('button', {
    class: 'tile__dl',
    type: 'button',
    title: 'Download original',
    'aria-label': `Download the original of ${name}`,
    html: icon('download'),
  })
  quick.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    downloadOriginal(photo)
  })

  frame.append(hit, quick)

  const meta = el('a', { class: 'tile__meta', href, 'data-link': true, tabindex: -1 }, [
    el('span', { class: 'tile__name', text: name, title: name }),
    el('span', {
      class: 'tile__sub',
      text: `${formatBytes(photo.size)} · ${formatDimensions(photo)}`,
    }),
  ])
  meta.addEventListener('click', open)

  tile.append(frame, meta)

  if (adminHooks()) tile.append(moreButton((x, y, anchor) => openPhotoMenu(photo, x, y, anchor)))

  tile.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    openPhotoMenu(photo, event.clientX, event.clientY)
  })
  return tile
}

// -------------------------------------------------------------------- menus

function openFolderMenu(folder: Folder, x: number, y: number, anchor?: HTMLElement): void {
  const admin = adminHooks()
  const items: MenuItem[] = [
    { label: 'Open', icon: 'folder', run: () => go({ folderId: folder.id, photoId: null }) },
  ]
  if (admin) {
    items.push(
      { label: 'Edit name & details', icon: 'pencil', run: () => admin.editFolder(folder) },
      { label: 'Move to another folder', icon: 'move', run: () => admin.moveFolder(folder) },
      { label: 'New subfolder', icon: 'folderPlus', run: () => admin.createFolder(folder.id) },
      { label: 'Upload photos', icon: 'upload', run: () => admin.pickFiles(folder.id) },
      {
        label: folder.hasPassword ? 'Change password' : 'Protect with a password',
        icon: 'lock',
        run: () => admin.setFolderPassword(folder),
      },
    )
    if (folder.hasPassword) {
      items.push({
        label: 'Remove password',
        icon: 'unlock',
        run: () => admin.clearFolderPassword(folder),
      })
    }
  }
  const menu = admin
    ? [...items, { label: 'Delete', icon: 'trash', danger: true, run: () => admin.deleteFolder(folder) }]
    : items
  openMenu(menu, x, y, anchor ?? null)
}

function openPhotoMenu(photo: Photo, x: number, y: number, anchor?: HTMLElement): void {
  const admin = adminHooks()
  const items: MenuItem[] = [
    { label: 'View', icon: 'image', run: () => openLightbox([photo], photo.id) },
    { label: 'Edit in Studio', icon: 'pencil', run: () => openPhotoInStudio(photo) },
    { label: 'Download original', icon: 'download', run: () => downloadOriginal(photo) },
  ]
  if (admin) {
    items.push(
      { label: 'Rename', icon: 'pencil', run: () => admin.renamePhoto(photo) },
      { label: 'Move to another folder', icon: 'move', run: () => admin.movePhoto(photo) },
      { label: 'Delete', icon: 'trash', danger: true, run: () => admin.deletePhoto(photo) },
    )
  }
  openMenu(items, x, y, anchor ?? null)
}

// --------------------------------------------------------------- list view

function listRows(folders: FolderEntry[], photos: Photo[]): HTMLElement {
  const table = el('div', { class: 'list', role: 'table' })
  table.append(
    el('div', { class: 'list__head', role: 'row' }, [
      el('span', { class: 'list__cell list__cell--name', role: 'columnheader', text: 'Name' }),
      el('span', { class: 'list__cell', role: 'columnheader', text: 'Size' }),
      el('span', { class: 'list__cell', role: 'columnheader', text: 'Kind' }),
      el('span', { class: 'list__cell', role: 'columnheader', text: 'Dimensions' }),
      el('span', { class: 'list__cell', role: 'columnheader', text: 'Added' }),
    ]),
  )

  let rowIndex = 0
  for (const folder of folders) {
    const row = el(
      'a',
      {
        class: 'row',
        role: 'row',
        href: folderHref(folder.id),
        'data-link': true,
        'data-drop-folder': folder.id,
      },
      [
        el('span', { class: 'list__cell list__cell--name' }, [
          el('span', {
            class: `row__icon row__icon--folder${folder.locked ? ' row__icon--locked' : ''}`,
            html: icon(folder.locked ? 'lock' : 'folder'),
          }),
          el('span', { class: 'row__name', text: folder.name }),
        ]),
        el('span', {
          class: 'list__cell',
          text: folder.locked ? 'Locked' : summarise(folder.folderCount, folder.photoCount),
        }),
        el('span', { class: 'list__cell', text: 'Folder' }),
        el('span', { class: 'list__cell', text: '—' }),
        el('span', {
          class: 'list__cell',
          text: folder.date ? formatDate(folder.date) : formatTimestamp(folder.createdAt),
        }),
      ],
    )
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      openFolderMenu(folder, event.clientX, event.clientY)
    })
    table.append(stagger(row, rowIndex++))
  }

  for (const photo of photos) {
    const row = el(
      'a',
      {
        class: 'row',
        role: 'row',
        href: hrefFor({ folderId: photo.folderId, photoId: photo.id }),
        'data-link': true,
        'data-photo': photo.id,
      },
      [
        el('span', { class: 'list__cell list__cell--name' }, [
          el('span', { class: 'row__thumb' }, [
            el('img', { src: photo.thumbUrl, alt: '', loading: 'lazy', decoding: 'async' }),
          ]),
          el('span', { class: 'row__name', text: displayName(photo) }),
        ]),
        el('span', { class: 'list__cell', text: formatBytes(photo.size) }),
        el('span', { class: 'list__cell', text: formatKind(photo) }),
        el('span', { class: 'list__cell', text: formatDimensions(photo) }),
        el('span', { class: 'list__cell', text: formatTimestamp(photo.createdAt) }),
      ],
    )
    row.addEventListener('click', (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      event.preventDefault()
      openLightbox(photos, photo.id)
    })
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      openPhotoMenu(photo, event.clientX, event.clientY)
    })
    table.append(stagger(row, rowIndex++))
  }

  return table
}

// ------------------------------------------------------------------ content

function section(title: string, count: number, body: HTMLElement): HTMLElement {
  return el('section', { class: 'section' }, [
    el('h2', { class: 'section__title' }, [
      el('span', { text: title }),
      el('span', { class: 'section__count', text: String(count) }),
    ]),
    body,
  ])
}

/**
 * What a visitor gets instead of a locked folder's contents. Deliberately a
 * panel in the pane rather than a modal: the address stays shareable, and a
 * refresh brings them back to the same door.
 */
function lockPanel(lock: { id: string; name: string }): HTMLElement {
  const error = el('p', { class: 'lockbox__error', hidden: true })
  const input = el('input', {
    class: 'input',
    type: 'password',
    name: 'password',
    placeholder: 'Password',
    autocomplete: 'off',
    'aria-label': `Password for ${lock.name}`,
  })
  const submit = el('button', { class: 'btn btn--primary', type: 'submit' }, [
    el('span', { class: 'btn__icon', html: icon('unlock') }),
    el('span', { text: 'Open' }),
  ])

  const form = el('form', { class: 'lockbox__form' }, [input, submit])
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    error.hidden = true
    submit.disabled = true
    try {
      await api.unlock(lock.id, input.value)
      window.dispatchEvent(new CustomEvent('kp:reload'))
    } catch (err) {
      error.textContent = err instanceof Error ? err.message : 'Could not open the folder'
      error.hidden = false
      submit.disabled = false
      input.select()
    }
  })

  const panel = el('div', { class: 'lockbox' }, [
    el('span', { class: 'lockbox__glyph', html: icon('lock') }),
    el('h2', { class: 'lockbox__title', text: `"${lock.name}" is locked` }),
    el('p', {
      class: 'lockbox__hint',
      text: 'Enter the password to open this folder. It stays open on this device for 30 days.',
    }),
    form,
    error,
  ])
  requestAnimationFrame(() => input.focus())
  return panel
}

function emptyState(): HTMLElement {
  const admin = adminHooks()
  const atRoot = state.folderId === ROOT
  const card = el('div', { class: 'empty' }, [
    el('span', { class: 'empty__glyph', html: icon('empty') }),
    el('p', {
      class: 'empty__title',
      text: admin
        ? atRoot
          ? 'Create your first folder'
          : 'This folder is empty'
        : atRoot
          ? 'Nothing here yet'
          : 'This folder is empty',
    }),
    el('p', {
      class: 'empty__hint',
      text: admin
        ? atRoot
          ? 'Name a top-level folder after a date or a title, then put subfolders inside it.'
          : 'Create a subfolder, or drag photos onto this window.'
        : '',
    }),
  ])

  if (admin) {
    const actions = el('div', { class: 'empty__actions' })
    const make = el('button', { class: 'btn btn--primary', type: 'button' }, [
      el('span', { class: 'btn__icon', html: icon('folderPlus') }),
      el('span', { text: atRoot ? 'New top-level folder' : 'New subfolder' }),
    ])
    make.addEventListener('click', () => admin.createFolder(state.folderId))
    actions.append(make)

    if (!atRoot) {
      const up = el('button', { class: 'btn', type: 'button' }, [
        el('span', { class: 'btn__icon', html: icon('upload') }),
        el('span', { text: 'Upload photos' }),
      ])
      up.addEventListener('click', () => admin.pickFiles(state.folderId))
      actions.append(up)
    }
    card.append(actions)
  }
  return card
}

/** True when this folder, or a subfolder in view, has anything to zip. */
function hasPhotosBelow(view: BrowseResult | null): boolean {
  if (!view || view.lock) return false
  if (view.photos.length > 0) return true
  return view.folders.some((f) => !f.locked && f.photoCount > 0)
}

function paneHeader(): HTMLElement {
  const admin = adminHooks()
  const folder = state.current?.folder ?? null
  const title = folder?.name ?? 'Archive'

  const head = el('header', { class: 'pane__head' }, [
    el('div', { class: 'pane__titles' }, [
      el('h1', { class: 'pane__title', text: title }),
      folder?.note
        ? el('p', { class: 'pane__note', text: folder.note })
        : el('p', {
            class: 'pane__note',
            text: folder
              ? folder.date
                ? formatDate(folder.date)
                : ''
              : 'Open a folder to browse the photos, then download the originals exactly as they were uploaded.',
          }),
    ]),
  ])

  const actions = el('div', { class: 'pane__actions' })

  // Anyone who can see the folder can take it; /download still checks each
  // photo, so a locked subfolder cannot ride along inside the archive.
  if (state.current && !state.current.lock) {
    const grab = el('button', { class: 'btn', type: 'button' }, [
      el('span', { class: 'btn__icon', html: icon('download') }),
      el('span', { text: 'Download all' }),
    ])
    grab.addEventListener('click', async () => {
      grab.disabled = true
      try {
        const bulk = await import('./bulk')
        await bulk.downloadFolder(state.folderId, folder?.name ?? 'Archive')
      } finally {
        grab.disabled = false
      }
    })
    // Answered from state, not from the bulk module: waiting on the import
    // would show the button and then take it away again.
    if (hasPhotosBelow(state.current)) actions.append(grab)
  }

  if (admin) {
    const make = el('button', { class: 'btn', type: 'button' }, [
      el('span', { class: 'btn__icon', html: icon('folderPlus') }),
      el('span', { text: state.folderId === ROOT ? 'New folder' : 'New subfolder' }),
    ])
    make.addEventListener('click', () => admin.createFolder(state.folderId))
    actions.append(make)

    const up = el('button', { class: 'btn btn--primary', type: 'button' }, [
      el('span', { class: 'btn__icon', html: icon('upload') }),
      el('span', { text: 'Upload' }),
    ])
    up.addEventListener('click', () => admin.pickFiles(state.folderId))
    actions.append(up)
  }

  if (actions.childElementCount) head.append(actions)

  return head
}

function renderSearch(): HTMLElement[] {
  const found = state.search
  if (!found) return []

  const folders: FolderEntry[] = found.folders.map((f) => ({
    ...f,
    photoCount: 0,
    folderCount: 0,
    covers: [],
  }))
  const photos = sortPhotos(found.photos)
  setSequence(photos)

  const head = el('header', { class: 'pane__head' }, [
    el('div', { class: 'pane__titles' }, [
      el('h1', { class: 'pane__title', text: `Results for “${found.query}”` }),
      el('p', {
        class: 'pane__note',
        text: summarise(folders.length, photos.length),
      }),
    ]),
  ])

  if (!folders.length && !photos.length) {
    return [
      head,
      el('div', { class: 'empty' }, [
        el('span', { class: 'empty__glyph', html: icon('search') }),
        el('p', { class: 'empty__title', text: 'Nothing matched that search' }),
      ]),
    ]
  }

  const blocks: HTMLElement[] = [head]
  if (state.view === 'list') {
    blocks.push(listRows(folders, photos))
    return blocks
  }
  if (folders.length) {
    blocks.push(
      section('Folders', folders.length, el('div', { class: 'grid grid--folders' }, folders.map((f, i) => folderCard(f, i)))),
    )
  }
  if (photos.length) {
    blocks.push(
      section(
        'Photos',
        photos.length,
        el('div', { class: 'grid grid--photos' }, photos.map((p, i) => photoTile(p, photos, i))),
      ),
    )
  }
  return blocks
}

/**
 * The view a redraw belongs to. A folder is painted twice — once from what the
 * sidebar already knows, then again when the server answers — and the entrance
 * animation must only play on the first of those. Replaying it on the refill is
 * exactly the blink it looks like.
 */
let animatedView = ''

function renderContent(): void {
  const view = state.search ? `search:${state.search.query}` : `folder:${state.folderId}`
  contentHost.classList.toggle('is-refill', view === animatedView)
  animatedView = view

  contentHost.innerHTML = ''

  if (state.errorText) {
    setSequence([])
    contentHost.append(
      el('div', { class: 'empty' }, [
        el('span', { class: 'empty__glyph', html: icon('info') }),
        el('p', { class: 'empty__title', text: state.errorText }),
      ]),
    )
    return
  }

  if (state.statsOpen) {
    setSequence([])
    const panel = adminHooks()?.statsPanel()
    if (panel) contentHost.append(panel)
    return
  }

  if (state.search) {
    contentHost.append(...renderSearch())
    return
  }

  const lock = state.current?.lock
  if (lock) {
    setSequence([])
    contentHost.append(paneHeader(), lockPanel(lock))
    return
  }

  if (!state.current) {
    setSequence([])
    contentHost.append(el('p', { class: 'state', text: state.loading ? 'Opening' : '' }))
    return
  }

  const folders = sortFolders(state.current.folders)
  const photos = sortPhotos(state.current.photos)
  // The viewer steps through exactly what the pane shows, in the order it
  // shows it — so changing the sort changes the arrow order too.
  setSequence(photos)

  contentHost.append(paneHeader())

  if (!folders.length && !photos.length) {
    contentHost.append(emptyState())
    return
  }

  if (state.view === 'list') {
    contentHost.append(listRows(folders, photos))
    return
  }

  if (folders.length) {
    contentHost.append(
      section('Folders', folders.length, el('div', { class: 'grid grid--folders' }, folders.map((f, i) => folderCard(f, i)))),
    )
  }
  if (photos.length) {
    contentHost.append(
      section(
        'Photos',
        photos.length,
        el('div', { class: 'grid grid--photos' }, photos.map((p, i) => photoTile(p, photos, i))),
      ),
    )
  }
}

// ------------------------------------------------------------------- status

function renderStatus(): void {
  const current = state.current
  if (!current) {
    statusHost.textContent = state.loading ? 'Loading…' : ''
    totalsHost.textContent = ''
    return
  }

  const bytes = current.photos.reduce((sum, p) => sum + p.size, 0)
  const parts = [summarise(current.folders.length, current.photos.length)]
  if (bytes > 0) parts.push(formatBytes(bytes))
  statusHost.textContent = parts.join(' · ')

  const totalFolders = state.tree.length
  totalsHost.textContent = totalFolders ? plural(totalFolders, 'folder') : ''
}

// ------------------------------------------------------------------- chrome

function renderChrome(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-view]')) {
    button.classList.toggle('is-active', button.dataset.view === state.view)
    button.setAttribute('aria-pressed', String(button.dataset.view === state.view))
  }

  const account = need<HTMLButtonElement>('[data-role="account"]')
  account.innerHTML = icon(state.admin ? 'user' : 'lock')
  account.classList.toggle('is-active', state.admin)
  account.title = state.admin ? `${state.username ?? 'Admin'} — menu` : 'Admin sign in'

  const sortBtn = need<HTMLButtonElement>('[data-role="sort"]')
  sortBtn.classList.toggle('is-asc', state.sortDir === 'asc')

  const theme = need<HTMLButtonElement>('[data-role="theme"]')
  const dark =
    state.theme === 'dark' ||
    (state.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  theme.innerHTML = icon(dark ? 'sun' : 'moon')

  document.documentElement.classList.toggle('is-admin', state.admin)
}

// ------------------------------------------------------------- drag & drop

function folderIdFromEvent(event: DragEvent): string | null {
  const target = (event.target as Element | null)?.closest?.('[data-drop-folder]')
  if (target instanceof HTMLElement) return target.dataset.dropFolder ?? null
  return null
}

function initDropTarget(): void {
  const overlay = need('[data-role="dropzone"]')
  const where = need('[data-role="dropwhere"]')
  let depth = 0
  let target = state.folderId

  const label = (id: string) =>
    id === ROOT ? 'Archive' : (state.tree.find((f) => f.id === id)?.name ?? 'this folder')

  const hide = () => {
    depth = 0
    overlay.hidden = true
    overlay.classList.remove('is-over')
    for (const node of document.querySelectorAll('.is-drop-target')) {
      node.classList.remove('is-drop-target')
    }
  }

  window.addEventListener('dragenter', (event) => {
    if (!adminHooks() || !event.dataTransfer?.types.includes('Files')) return
    event.preventDefault()
    depth += 1
    overlay.hidden = false
    requestAnimationFrame(() => overlay.classList.add('is-over'))
  })

  window.addEventListener('dragover', (event) => {
    if (!adminHooks() || overlay.hidden) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'

    const hovered = folderIdFromEvent(event) ?? state.folderId
    if (hovered !== target) {
      target = hovered
      for (const node of document.querySelectorAll('.is-drop-target')) {
        node.classList.remove('is-drop-target')
      }
      const node = (event.target as Element | null)?.closest?.('[data-drop-folder]')
      node?.classList.add('is-drop-target')
    }
    where.textContent = `Add to ${label(target)}`
  })

  window.addEventListener('dragleave', (event) => {
    if (overlay.hidden) return
    event.preventDefault()
    depth -= 1
    if (depth <= 0) hide()
  })

  window.addEventListener('drop', (event) => {
    const admin = adminHooks()
    if (!admin || !event.dataTransfer) return
    event.preventDefault()
    const destination = folderIdFromEvent(event) ?? target ?? state.folderId
    hide()
    admin.acceptDrop(event.dataTransfer, destination)
  })
}

// --------------------------------------------------------------------- init

export function initExplorer(): void {
  crumbsHost = need('[data-role="crumbs"]')
  treeHost = need('[data-role="tree"]')
  contentHost = need('[data-role="content"]')
  statusHost = need('[data-role="status"]')
  totalsHost = need('[data-role="totals"]')
  paneHost = need('[data-role="pane"]')

  paintIcons()

  crumbsHost.addEventListener('scroll', () => {
    crumbsHost.classList.toggle('is-scrolled', crumbsHost.scrollLeft > 2)
  })
  window.addEventListener('resize', pinCrumbsToEnd)
  document.fonts?.ready.then(pinCrumbsToEnd).catch(() => undefined)

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-view]')) {
    button.innerHTML = icon(button.dataset.view === 'list' ? 'list' : 'grid')
    button.addEventListener('click', () => {
      update({ view: button.dataset.view === 'list' ? 'list' : 'grid' })
    })
  }

  need<HTMLButtonElement>('[data-nav="back"]').innerHTML = icon('back')
  need<HTMLButtonElement>('[data-nav="forward"]').innerHTML = icon('forward')
  need<HTMLButtonElement>('[data-nav="up"]').innerHTML = icon('up')
  need<HTMLButtonElement>('[data-role="drawer"]').innerHTML = icon('menu')

  const sort = need<HTMLButtonElement>('[data-role="sort"]')
  sort.innerHTML = icon('sort')
  sort.addEventListener('click', () => {
    const rect = sort.getBoundingClientRect()
    const pick = (key: 'name' | 'date' | 'size') => () => {
      if (state.sortKey === key) update({ sortDir: state.sortDir === 'asc' ? 'desc' : 'asc' })
      else update({ sortKey: key, sortDir: key === 'name' ? 'asc' : 'desc' })
    }
    const mark = (key: string) => (state.sortKey === key ? 'check' : '')
    openMenu(
      [
        { label: 'Name', icon: mark('name'), run: pick('name') },
        { label: 'Date', icon: mark('date'), run: pick('date') },
        { label: 'Size', icon: mark('size'), run: pick('size') },
        {
          label: state.sortDir === 'asc' ? 'Descending' : 'Ascending',
          icon: 'sort',
          run: () => update({ sortDir: state.sortDir === 'asc' ? 'desc' : 'asc' }),
        },
      ],
      rect.right - 8,
      rect.bottom + 6,
      sort,
    )
  })

  initDropTarget()
  initPointerTilt(paneHost)
  initScrollShade(paneHost, need('.app'))
}

/** Keeps the branch the current folder lives on open in the sidebar. */
export function revealCurrentBranch(): void {
  let changed = false
  for (const id of ancestorsOf(state.folderId)) {
    if (!state.expanded.has(id)) {
      state.expanded.add(id)
      changed = true
    }
  }
  if (changed) touch()
}

export function render(): void {
  renderChrome()
  renderCrumbs()
  renderTree()
  renderContent()
  renderStatus()
}

export function scrollPaneToTop(): void {
  // Instant, not smooth: this runs on navigation, where an animated scroll
  // would race the new content being painted.
  paneHost.scrollTo({ top: 0, behavior: 'instant' })
}
