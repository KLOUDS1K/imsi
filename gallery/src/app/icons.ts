/**
 * One stroke weight, one grid, one geometry — the icons are drawn as 24px
 * outlines in `currentColor` so a button only ever has to set a colour.
 */

const wrap = (body: string, extra = ''): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"${extra}>${body}</svg>`

export const icons: Record<string, string> = {
  back: wrap('<path d="M15 5 8 12l7 7"/>'),
  forward: wrap('<path d="m9 5 7 7-7 7"/>'),
  up: wrap('<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>'),
  chevronRight: wrap('<path d="m9 5 7 7-7 7"/>'),
  chevronDown: wrap('<path d="m5 9 7 7 7-7"/>'),

  search: wrap('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>'),
  grid: wrap(
    '<rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/>' +
      '<rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.6"/>',
  ),
  list: wrap(
    '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01" stroke-width="2.2"/>',
  ),
  sort: wrap('<path d="M7 4v16"/><path d="m3.5 7.5 3.5-3.5 3.5 3.5"/><path d="M17 20V4"/><path d="m13.5 16.5 3.5 3.5 3.5-3.5"/>'),

  sun: wrap(
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4' +
      'M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  ),
  moon: wrap('<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/>'),

  user: wrap('<circle cx="12" cy="8.5" r="3.5"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>'),
  lock: wrap('<rect x="4.5" y="10.5" width="15" height="10" rx="2.2"/><path d="M8 10.5V7.5a4 4 0 1 1 8 0v3"/>'),
  unlock: wrap('<rect x="4.5" y="10.5" width="15" height="10" rx="2.2"/><path d="M8 10.5V7.5a4 4 0 0 1 7.4-2.1"/>'),
  lockSolid:
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">' +
    '<path d="M8 10.6V7.6a4 4 0 1 1 8 0v3" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>' +
    '<rect x="4" y="10" width="16" height="11.6" rx="3.1" fill="currentColor"/></svg>',
  logout: wrap('<path d="M14 5H6.5A1.5 1.5 0 0 0 5 6.5v11A1.5 1.5 0 0 0 6.5 19H14"/><path d="M17 8.5 20.5 12 17 15.5"/><path d="M20 12H10"/>'),
  menu: wrap('<path d="M4 7h16M4 12h16M4 17h16"/>'),

  folder: wrap('<path d="M3.5 7.2A1.7 1.7 0 0 1 5.2 5.5h3.4a1.7 1.7 0 0 1 1.36.68l.9 1.2h7.94a1.7 1.7 0 0 1 1.7 1.7v8.24a1.7 1.7 0 0 1-1.7 1.7H5.2a1.7 1.7 0 0 1-1.7-1.7Z"/>'),
  folderPlus: wrap(
    '<path d="M3.5 7.2A1.7 1.7 0 0 1 5.2 5.5h3.4a1.7 1.7 0 0 1 1.36.68l.9 1.2h7.94a1.7 1.7 0 0 1 1.7 1.7v8.24a1.7 1.7 0 0 1-1.7 1.7H5.2a1.7 1.7 0 0 1-1.7-1.7Z"/>' +
      '<path d="M12 11.5v5M9.5 14h5"/>',
  ),
  image: wrap(
    '<rect x="3.5" y="4.5" width="17" height="15" rx="2.2"/><circle cx="8.8" cy="9.6" r="1.6"/>' +
      '<path d="m4.4 17.2 4.4-4.2a1.8 1.8 0 0 1 2.45-.05l5.2 4.6"/><path d="m14.2 13.6 1.9-1.8a1.8 1.8 0 0 1 2.44-.03l1.96 1.75"/>',
  ),

  upload: wrap('<path d="M12 16V4"/><path d="m7.5 8.5 4.5-4.5 4.5 4.5"/><path d="M4.5 15.5v2.8A2.2 2.2 0 0 0 6.7 20.5h10.6a2.2 2.2 0 0 0 2.2-2.2v-2.8"/>'),
  download: wrap('<path d="M12 4v12"/><path d="m7.5 11.5 4.5 4.5 4.5-4.5"/><path d="M4.5 15.5v2.8A2.2 2.2 0 0 0 6.7 20.5h10.6a2.2 2.2 0 0 0 2.2-2.2v-2.8"/>'),
  eye: wrap('<path d="M2.8 12s3.2-6 9.2-6 9.2 6 9.2 6-3.2 6-9.2 6-9.2-6-9.2-6Z"/><circle cx="12" cy="12" r="2.7"/>'),
  close: wrap('<path d="M6 6l12 12M18 6 6 18"/>'),
  check: wrap('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
  pencil: wrap('<path d="M4.5 19.5h3.2L18.4 8.8a2.26 2.26 0 0 0-3.2-3.2L4.5 16.3Z"/><path d="m14.2 6.6 3.2 3.2"/>'),
  trash: wrap('<path d="M4.5 7h15"/><path d="M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7"/><path d="M6.5 7l.8 11.1A1.9 1.9 0 0 0 9.2 20h5.6a1.9 1.9 0 0 0 1.9-1.9L17.5 7"/>'),
  move: wrap('<path d="M3.5 7.2A1.7 1.7 0 0 1 5.2 5.5h3.4a1.7 1.7 0 0 1 1.36.68l.9 1.2h7.94a1.7 1.7 0 0 1 1.7 1.7v8.24a1.7 1.7 0 0 1-1.7 1.7H5.2a1.7 1.7 0 0 1-1.7-1.7Z"/><path d="M9 13.5h6"/><path d="m12.6 11 2.5 2.5-2.5 2.5"/>'),
  info: wrap('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><path d="M12 8h.01" stroke-width="2.2"/>'),
  more: wrap('<circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none"/>'),
  empty: wrap(
    '<path d="M3 8.6A2.1 2.1 0 0 1 5.1 6.5h3.6a2.1 2.1 0 0 1 1.68.84l.72.96h8.8A2.1 2.1 0 0 1 22 10.4" stroke-opacity=".55"/>' +
      '<path d="M2.6 11.4h18.8l-1.5 7.4a2 2 0 0 1-1.96 1.6H6.06a2 2 0 0 1-1.96-1.6Z"/>',
  ),
}

/** Fills every `[data-icon]` inside `root` with its named glyph. */
export function paintIcons(root: ParentNode = document): void {
  for (const node of root.querySelectorAll<HTMLElement>('[data-icon]')) {
    const name = node.dataset.icon
    if (!name || node.dataset.painted === name) continue
    node.innerHTML = icons[name] ?? ''
    node.dataset.painted = name
  }
}

export function icon(name: string): string {
  return icons[name] ?? ''
}
