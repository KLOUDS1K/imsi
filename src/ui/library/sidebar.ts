/**
 * Library sidebar content (the shell renders the KLOUD wordmark above it):
 *
 *   LIBRARY  All Photos · Favorites · Picks · Recently Edited · Rejected · Unedited (with counts)
 *   FOLDERS  virtual folder tree (collapsible, drop photos to move them)
 *   ALBUMS   list + create / rename / delete, drop photos to add them
 *   footer   "128 photos" above a hairline (like the site's "2 folders")
 *
 * Selecting an item sets librarySignals.collection (and switches to the
 * Library module).
 */
import type { AppContext } from '@/app/context';
import type { PhotoRecord } from '@/editor/types';
import { Disposer, h, on } from '@/ui/dom';
import { attachContextMenu, createIconButton, createNavItem, createSectionLabel, icon, loadLocal, saveLocal, type NavItem } from '@/ui/kit';
import { addToAlbum, createAlbumWith } from './actions';
import { countLabel, formatCount } from './format';
import { PHOTO_DRAG_TYPE } from './grid';
import { librarySignals, sameCollection, setLibraryCollection, SIMPLE_COLLECTIONS, type LibraryCollection } from './state';
import './sidebar.css';

const LS_COLLAPSED = 'kloud-library:collapsed-folders';
const WEEK = 7 * 24 * 3600 * 1000;

interface FolderNode {
  path: string;
  name: string;
  children: FolderNode[];
  count: number;
}

function buildTree(folders: string[], recs: PhotoRecord[]): FolderNode[] {
  const nodes = new Map<string, FolderNode>();
  const roots: FolderNode[] = [];
  for (const path of [...folders].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
    if (!path) continue;
    const node: FolderNode = { path, name: path.split('/').pop() ?? path, children: [], count: 0 };
    nodes.set(path, node);
    const parent = path.includes('/') ? nodes.get(path.slice(0, path.lastIndexOf('/'))) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  // Count each photo in its folder and every ancestor.
  for (const r of recs) {
    let p = r.folder;
    while (p) {
      const n = nodes.get(p);
      if (n) n.count++;
      const i = p.lastIndexOf('/');
      p = i > 0 ? p.slice(0, i) : '';
    }
  }
  return roots;
}

function readDragIds(e: DragEvent): string[] | null {
  const raw = e.dataTransfer?.getData(PHOTO_DRAG_TYPE);
  if (!raw) return null;
  try {
    const ids = JSON.parse(raw) as unknown;
    return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : null;
  } catch {
    return null;
  }
}

export function createLibrarySidebar(ctx: AppContext): { el: HTMLElement; dispose: () => void } {
  const d = new Disposer();
  const collapsed = new Set<string>(loadLocal<string[]>(LS_COLLAPSED, []));
  const items: { c: LibraryCollection; nav: NavItem }[] = [];

  const select = (c: LibraryCollection): void => {
    setLibraryCollection(c);
    if (ctx.module.value !== 'library') ctx.module.set('library');
  };

  const libList = h('div', { class: 'k-libside__list', attrs: { role: 'list' } });
  for (const s of SIMPLE_COLLECTIONS) {
    const c: LibraryCollection = { kind: s.kind };
    const nav = createNavItem({ label: s.label, icon: s.icon, onClick: () => select(c) });
    nav.el.dataset.collection = s.kind;
    items.push({ c, nav });
    libList.append(nav.el);
    d.add(() => nav.destroy());
  }

  const folderList = h('div', { class: 'k-libside__list k-libside__tree', attrs: { role: 'tree', 'aria-label': 'Folders' } });
  const albumList = h('div', { class: 'k-libside__list', attrs: { role: 'list', 'aria-label': 'Albums' } });
  const addAlbum = createIconButton({ icon: 'plus', label: 'New album', size: 'sm', onClick: () => void createAlbumWith(ctx, []) });
  d.add(() => addAlbum.destroy());

  const foldersSection = h('section', { class: 'k-libside__section' }, h('div', { class: 'k-libside__head' }, createSectionLabel('Folders')), folderList);
  const albumsLabel = createSectionLabel('Albums');
  const albumsSection = h('section', { class: 'k-libside__section' }, h('div', { class: 'k-libside__head' }, albumsLabel, addAlbum.el), albumList);
  const footer = h('div', { class: 'k-libside__footer k-num' });
  const el = h(
    'nav',
    { class: 'k-libside', attrs: { 'aria-label': 'Library' } },
    h(
      'div',
      { class: 'k-libside__scroll' },
      h('section', { class: 'k-libside__section' }, h('div', { class: 'k-libside__head' }, createSectionLabel('Library')), libList),
      foldersSection,
      albumsSection,
    ),
    footer,
  );

  let dynamic: NavItem[] = [];

  const makeDropTarget = (target: HTMLElement, onDrop: (ids: string[]) => void): void => {
    target.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes(PHOTO_DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      target.classList.add('is-drop');
    });
    target.addEventListener('dragleave', () => target.classList.remove('is-drop'));
    target.addEventListener('drop', (e) => {
      target.classList.remove('is-drop');
      const ids = readDragIds(e);
      if (!ids?.length) return;
      e.preventDefault();
      e.stopPropagation();
      onDrop(ids);
    });
  };

  const renderFolders = (recs: PhotoRecord[]): void => {
    const roots = buildTree(ctx.library.folders(), recs);
    foldersSection.hidden = roots.length === 0;
    folderList.replaceChildren();
    const walk = (nodes: FolderNode[], depth: number): void => {
      for (const n of nodes) {
        const c: LibraryCollection = { kind: 'folder', path: n.path };
        const nav = createNavItem({ label: n.name, icon: 'folder', count: formatCount(n.count), depth: depth + 1, onClick: () => select(c) });
        nav.el.dataset.folder = n.path;
        nav.el.title = n.path;
        items.push({ c, nav });
        dynamic.push(nav);
        const row = h('div', { class: 'k-libside__row', attrs: { role: 'treeitem', 'aria-level': depth + 1 } });
        if (n.children.length) {
          const open = !collapsed.has(n.path);
          row.setAttribute('aria-expanded', String(open));
          const tw = h(
            'button',
            {
              type: 'button',
              class: 'k-libside__twisty',
              style: { left: `${depth * 14}px` },
              attrs: { 'aria-label': `${open ? 'Collapse' : 'Expand'} ${n.name}`, 'aria-expanded': String(open) },
            },
            icon(open ? 'chevron-down' : 'chevron-right', 12),
          );
          tw.addEventListener('click', () => {
            if (collapsed.has(n.path)) collapsed.delete(n.path);
            else collapsed.add(n.path);
            saveLocal(LS_COLLAPSED, [...collapsed]);
            renderFolders(ctx.library.all());
            syncActive();
          });
          row.append(tw);
        }
        row.append(nav.el);
        makeDropTarget(nav.el, (ids) => {
          void ctx.library.updateMany(ids, { folder: n.path }).then(
            () => ctx.toast(`Moved ${countLabel(ids.length)} to ${n.name}.`, 'success'),
            (err: unknown) => ctx.toast(`Moving failed: ${String(err)}`, 'error'),
          );
        });
        folderList.append(row);
        if (n.children.length && !collapsed.has(n.path)) walk(n.children, depth + 1);
      }
    };
    walk(roots, 0);
  };

  const renderAlbums = (recs: PhotoRecord[]): void => {
    const albums = ctx.library.albums();
    const counts = new Map<string, number>();
    for (const r of recs) for (const a of r.albumIds) counts.set(a, (counts.get(a) ?? 0) + 1);
    albumList.replaceChildren();
    if (albums.length === 0) {
      const hint = h('p', { class: 'k-libside__hint' }, 'No albums yet. Drop photos here to start one.');
      makeDropTarget(hint, (ids) => void createAlbumWith(ctx, ids));
      albumList.append(hint);
      return;
    }
    for (const a of albums) {
      const c: LibraryCollection = { kind: 'album', id: a.id };
      const nav = createNavItem({ label: a.name, icon: 'bookmark', count: formatCount(counts.get(a.id) ?? 0), onClick: () => select(c) });
      nav.el.dataset.album = a.id;
      items.push({ c, nav });
      dynamic.push(nav);
      makeDropTarget(nav.el, (ids) => void addToAlbum(ctx, ids, a.id));
      albumList.append(nav.el);
    }
  };

  d.add(
    attachContextMenu(albumList, (e) => {
      const id = (e.target as HTMLElement).closest<HTMLElement>('[data-album]')?.dataset.album;
      const album = id ? ctx.library.albums().find((a) => a.id === id) : undefined;
      if (!album) return null;
      return [
        { label: 'Open', icon: 'bookmark', onSelect: () => select({ kind: 'album', id: album.id }) },
        {
          label: 'Rename…',
          icon: 'text',
          onSelect: async () => {
            const name = await ctx.prompt({ title: 'Rename album', label: 'Album name', value: album.name, confirmLabel: 'Rename' });
            if (name?.trim() && name.trim() !== album.name) await ctx.library.renameAlbum(album.id, name.trim()).catch((err: unknown) => ctx.toast(String(err), 'error'));
          },
        },
        { kind: 'separator' },
        {
          label: 'Delete album…',
          icon: 'trash',
          danger: true,
          onSelect: async () => {
            const ok = await ctx.confirm({ title: `Delete the album “${album.name}”?`, message: 'The photos stay in your library.', confirmLabel: 'Delete', danger: true });
            if (!ok) return;
            await ctx.library.deleteAlbum(album.id);
            if (sameCollection(librarySignals.collection.value, { kind: 'album', id: album.id })) setLibraryCollection({ kind: 'all' });
          },
        },
      ];
    }),
  );

  const syncActive = (): void => {
    const cur = librarySignals.collection.value;
    for (const it of items) it.nav.setActive(sameCollection(it.c, cur));
  };

  const render = (): void => {
    const recs = ctx.library.all();
    const now = Date.now();
    const counts: Record<string, number> = { all: recs.length, favorites: 0, picks: 0, recent: 0, rejected: 0, unedited: 0 };
    for (const r of recs) {
      if (r.favorite) counts.favorites++;
      if (r.flag === 'pick') counts.picks++;
      if (r.flag === 'reject') counts.rejected++;
      if (!r.hasEdits) counts.unedited++;
      else if ((r.editedAt ?? 0) >= now - WEEK) counts.recent++;
    }
    for (const it of items.slice(0, SIMPLE_COLLECTIONS.length)) it.nav.setCount(counts[it.c.kind] ? formatCount(counts[it.c.kind]) : null);
    for (const n of dynamic) n.destroy();
    dynamic = [];
    items.length = SIMPLE_COLLECTIONS.length;
    renderFolders(recs);
    renderAlbums(recs);
    footer.textContent = countLabel(recs.length);
    syncActive();
  };

  let queued = false;
  const schedule = (): void => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      render();
    });
  };
  d.add(ctx.library.subscribe(schedule));
  d.add(librarySignals.collection.subscribe(syncActive));
  // Fall back to All Photos when the selected folder/album disappears.
  d.add(
    ctx.library.subscribe(() => {
      const c = librarySignals.collection.value;
      if (c.kind === 'album' && !ctx.library.albums().some((a) => a.id === c.id)) setLibraryCollection({ kind: 'all' });
      if (c.kind === 'folder' && !ctx.library.folders().includes(c.path)) setLibraryCollection({ kind: 'all' });
    }),
  );
  d.add(on(el, 'keydown', (e) => {
    // Up/down between sidebar items (roving within the nav, like the site).
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const navs = [...el.querySelectorAll<HTMLButtonElement>('.k-navitem')];
    const i = navs.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    e.stopPropagation();
    navs[Math.max(0, Math.min(navs.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  }));
  render();

  return {
    el,
    dispose() {
      for (const n of dynamic) n.destroy();
      d.dispose();
      el.remove();
    },
  };
}
