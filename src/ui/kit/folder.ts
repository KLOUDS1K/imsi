/**
 * FolderTile — the site's yellow macOS-style folder (back tab + gradient front
 * panel, optional centred glyph, bold name + muted sub-line), and EmptyState
 * which uses it as its illustration.
 *
 *   createFolderTile({ name: 'NS apex', sub: 'Locked', glyph: 'lock', nameIcon: 'lock-small', onOpen })
 *   createEmptyState({ title: 'No photos yet', description: 'Import photos to start editing.',
 *     actions: [createButton({ label: 'Import', variant: 'primary', onClick: importFiles }).el] })
 *
 * Colours come from --k-folder-top / --k-folder-front-a / --k-folder-front-b;
 * the glyph is a darkened folder tone so it reads in both themes like the site.
 */
import './folder.css';
import { Disposer, h, on, svg } from '../dom';
import { type IconName, icon } from './icons';
import { type Component, kitId } from './util';

export type FolderSize = 'sm' | 'md' | 'lg';
/** 'lock' draws the site's solid padlock; any other icon name is drawn as a line glyph. */
export type FolderGlyph = 'lock' | IconName;

/** Just the folder artwork (SVG) — for custom layouts and empty states. */
export function folderArt(glyph?: FolderGlyph | null): SVGSVGElement {
  const gid = kitId('k-folder-grad');
  const art = svg(
    'svg',
    { class: 'k-folder__svg', viewBox: '0 0 180 144', 'aria-hidden': 'true', focusable: 'false' },
    svg(
      'defs',
      {},
      svg(
        'linearGradient',
        { id: gid, x1: '0', y1: '0', x2: '0', y2: '1' },
        svg('stop', { offset: '0', class: 'k-folder__stop-a' }),
        svg('stop', { offset: '1', class: 'k-folder__stop-b' }),
      ),
    ),
    // Back panel with the tab on the upper left.
    svg('path', {
      class: 'k-folder__back',
      d: 'M0 8a8 8 0 0 1 8-8h51.5a6 6 0 0 1 4.6 2.2l6.8 8.4a6 6 0 0 0 4.6 2.2H172a8 8 0 0 1 8 8V136a8 8 0 0 1-8 8H8a8 8 0 0 1-8-8Z',
    }),
    // Front panel.
    svg('rect', { class: 'k-folder__front', x: 0, y: 44, width: 180, height: 100, rx: 8, fill: `url(#${gid})` }),
  );
  if (glyph === 'lock') {
    art.append(
      svg('path', { class: 'k-folder__glyph-stroke', d: 'M83 94v-6.5a7 7 0 0 1 14 0V94', fill: 'none', 'stroke-width': 3.4 }),
      svg('rect', { class: 'k-folder__glyph-fill', x: 78.5, y: 92, width: 23, height: 17.5, rx: 3.5 }),
    );
  } else if (glyph) {
    const g = icon(glyph, 30, { strokeWidth: 2.4 });
    g.setAttribute('x', '75');
    g.setAttribute('y', '79');
    g.classList.add('k-folder__glyph-icon');
    art.append(g);
  }
  return art;
}

export interface FolderTileOptions {
  name: string;
  /** Muted second line ("Locked", "24 photos"). */
  sub?: string;
  glyph?: FolderGlyph | null;
  /** Small icon before the name (the site shows 'lock-small'). */
  nameIcon?: IconName;
  size?: FolderSize;
  selected?: boolean;
  /** Renders an <a> instead of a <button>. */
  href?: string;
  onOpen?: (e: MouseEvent | KeyboardEvent) => void;
}

export interface FolderTile extends Component<HTMLElement> {
  setName(name: string): void;
  setSub(sub: string): void;
  setSelected(selected: boolean): void;
}

export function createFolderTile(opts: FolderTileOptions): FolderTile {
  const d = new Disposer();
  const nameText = h('span', { class: 'k-folder__name-text' }, opts.name);
  const sub = h('span', { class: 'k-folder__sub' }, opts.sub ?? '');
  sub.hidden = !opts.sub;
  const children = [
    h('span', { class: 'k-folder__art' }, folderArt(opts.glyph ?? null)),
    h('span', { class: 'k-folder__meta' }, h('span', { class: 'k-folder__name' }, opts.nameIcon ? icon(opts.nameIcon, 11, { class: 'k-folder__name-icon' }) : null, nameText), sub),
  ];
  const cls = ['k-folder', `k-folder--${opts.size ?? 'lg'}`, opts.selected && 'is-selected'];
  const el: HTMLElement = opts.href
    ? h('a', { class: cls, href: opts.href }, ...children)
    : h('button', { type: 'button', class: cls }, ...children);
  if (opts.onOpen) d.add(on(el, 'click', (e) => opts.onOpen?.(e)));
  return {
    el,
    setName: (n) => void (nameText.textContent = n),
    setSub(s) {
      sub.textContent = s;
      sub.hidden = !s;
    },
    setSelected: (b) => void el.classList.toggle('is-selected', b),
    destroy() {
      d.dispose();
      el.remove();
    },
  };
}

export interface EmptyStateOptions {
  title: string;
  description?: string;
  /** Illustration: 'folder' (default), an icon name, a custom node, or null for none. */
  art?: 'folder' | IconName | Node | null;
  /** Glyph drawn on the folder illustration. */
  glyph?: FolderGlyph;
  actions?: HTMLElement[];
  /** Smaller variant for panels. */
  compact?: boolean;
}

export function createEmptyState(opts: EmptyStateOptions): Component<HTMLDivElement> {
  const artOpt = opts.art === undefined ? 'folder' : opts.art;
  let art: Node | null = null;
  if (artOpt === 'folder') art = h('span', { class: 'k-empty__folder' }, folderArt(opts.glyph ?? null));
  else if (typeof artOpt === 'string') art = h('span', { class: 'k-empty__icon' }, icon(artOpt, 28));
  else art = artOpt;
  const el = h(
    'div',
    { class: ['k-empty', opts.compact && 'k-empty--compact'] },
    art,
    h('h2', { class: 'k-empty__title' }, opts.title),
    opts.description ? h('p', { class: 'k-empty__desc' }, opts.description) : null,
    opts.actions?.length ? h('div', { class: 'k-empty__actions' }, ...opts.actions) : null,
  );
  return { el, destroy: () => el.remove() };
}
