/**
 * Menu (built on Popover), menu-button and context-menu helpers.
 *
 *   openMenu(anchorEl, [
 *     { label: 'Copy Settings…', icon: 'copy', shortcut: 'Mod+Shift+C', onSelect: copy },
 *     { kind: 'separator' },
 *     { label: 'Sort', submenu: [{ label: 'Name', checked: true, onSelect: … }] },
 *   ]);
 *   attachMenu(moreButton, () => items);                       // click / ↓ opens
 *   attachContextMenu(gridCell, (e) => itemsFor(cell));        // right-click / long-press
 *
 * Keyboard: ↑/↓ (wrap), Home/End, Enter/Space select, → opens a submenu,
 * ← / Escape closes one level, Tab closes all, typing jumps to an item.
 */
import { Disposer, h, on } from '../dom';
import { type IconName, icon } from './icons';
import { type Popover, openPopover } from './popover';
import { type AnchorLike, type Placement, formatShortcut, onLongPress } from './util';

export interface MenuAction {
  kind?: 'item';
  id?: string;
  label: string;
  icon?: IconName;
  /** Shortcut hint, e.g. 'Mod+Z'. */
  shortcut?: string;
  /** Muted right-aligned hint text (e.g. a count). */
  hint?: string;
  disabled?: boolean;
  /** Makes it a menuitemcheckbox (a tick is shown when true). */
  checked?: boolean;
  danger?: boolean;
  submenu?: MenuItem[] | (() => MenuItem[]);
  /** Keep the menu open after selecting (toggles). */
  keepOpen?: boolean;
  onSelect?: () => void;
}
export interface MenuSeparator {
  kind: 'separator';
}
export interface MenuHeader {
  kind: 'header';
  label: string;
}
export type MenuItem = MenuAction | MenuSeparator | MenuHeader;

export interface MenuOptions {
  placement?: Placement;
  offset?: number;
  ariaLabel?: string;
  minWidth?: number;
  /** Focus (highlight) the first item on open. Default true; attachMenu/attachContextMenu pass false for pointer-opened menus. Arrow keys work either way. */
  focusFirst?: boolean;
  onSelect?: (item: MenuAction) => void;
  onClose?: () => void;
  /** @internal parent popover for submenus */
  parent?: Popover;
  /** @internal close the whole chain */
  closeRoot?: () => void;
}

export interface MenuHandle {
  readonly el: HTMLDivElement;
  close(): void;
}

const isAction = (i: MenuItem): i is MenuAction => i.kind === undefined || i.kind === 'item';

export function openMenu(anchor: AnchorLike, items: MenuItem[], opts: MenuOptions = {}): MenuHandle {
  const d = new Disposer();
  const list = h('div', { class: 'k-menu', tabIndex: -1, attrs: { role: 'menu', 'aria-label': opts.ariaLabel ?? null } });
  if (opts.minWidth) list.style.minWidth = `${opts.minWidth}px`;
  const buttons: { btn: HTMLButtonElement; item: MenuAction }[] = [];
  let sub: MenuHandle | null = null;
  let subOwner: HTMLButtonElement | null = null;
  let hoverTimer = 0;

  const closeRoot = opts.closeRoot ?? ((): void => pop.close());

  for (const item of items) {
    if (item.kind === 'separator') {
      list.append(h('div', { class: 'k-menu__sep', attrs: { role: 'separator' } }));
      continue;
    }
    if (item.kind === 'header') {
      list.append(h('div', { class: 'k-menu__header', attrs: { role: 'presentation' } }, item.label));
      continue;
    }
    const hasSub = !!item.submenu;
    const checkable = item.checked !== undefined;
    const btn = h(
      'button',
      {
        type: 'button',
        class: ['k-menu__item', item.danger && 'is-danger'],
        disabled: !!item.disabled,
        tabIndex: -1,
        dataset: item.id ? { id: item.id } : undefined,
        attrs: {
          role: checkable ? 'menuitemcheckbox' : 'menuitem',
          'aria-checked': checkable ? String(!!item.checked) : null,
          'aria-haspopup': hasSub ? 'menu' : null,
          'aria-expanded': hasSub ? 'false' : null,
        },
      },
      h('span', { class: 'k-menu__icon' }, checkable ? icon('check', 14, { class: 'k-menu__tick' }) : item.icon ? icon(item.icon, 15) : null),
      h('span', { class: 'k-menu__label' }, item.label),
      item.hint ? h('span', { class: 'k-menu__hint' }, item.hint) : null,
      item.shortcut ? h('span', { class: 'k-menu__shortcut k-num' }, formatShortcut(item.shortcut)) : null,
      hasSub ? icon('chevron-right', 13, { class: 'k-menu__chevron' }) : null,
    );
    buttons.push({ btn, item });
    list.append(btn);
  }

  const enabled = (): HTMLButtonElement[] => buttons.filter((b) => !b.btn.disabled).map((b) => b.btn);
  const focusAt = (btn: HTMLButtonElement | undefined): void => btn?.focus({ preventScroll: false });

  function closeSub(): void {
    window.clearTimeout(hoverTimer);
    if (!sub) return;
    sub.close();
    sub = null;
    subOwner?.setAttribute('aria-expanded', 'false');
    subOwner = null;
  }

  function openSub(btn: HTMLButtonElement, item: MenuAction, focusFirst: boolean): void {
    if (subOwner === btn && sub) return;
    closeSub();
    const children = typeof item.submenu === 'function' ? item.submenu() : (item.submenu ?? []);
    subOwner = btn;
    btn.setAttribute('aria-expanded', 'true');
    sub = openMenu(btn, children, {
      placement: 'right-start',
      offset: 2,
      parent: pop,
      closeRoot,
      focusFirst,
      onSelect: opts.onSelect,
      ariaLabel: item.label,
      onClose: () => {
        if (subOwner === btn) {
          btn.setAttribute('aria-expanded', 'false');
          subOwner = null;
          sub = null;
        }
      },
    });
  }

  function activate(btn: HTMLButtonElement, item: MenuAction): void {
    if (item.disabled) return;
    if (item.submenu) {
      openSub(btn, item, true);
      return;
    }
    if (item.checked !== undefined && item.keepOpen) {
      item.checked = !item.checked;
      btn.setAttribute('aria-checked', String(item.checked));
    }
    if (!item.keepOpen) closeRoot();
    item.onSelect?.();
    opts.onSelect?.(item);
  }

  for (const { btn, item } of buttons) {
    d.add(on(btn, 'click', () => activate(btn, item)));
    d.add(
      on(btn, 'pointerenter', (e) => {
        if (e.pointerType === 'touch') return;
        if (!btn.disabled) btn.focus({ preventScroll: true });
        window.clearTimeout(hoverTimer);
        // Small delay so diagonal moves toward an open submenu don't close it.
        hoverTimer = window.setTimeout(() => {
          if (item.submenu && !btn.disabled) openSub(btn, item, false);
          else if (subOwner !== btn) closeSub();
        }, item.submenu ? 120 : 200);
      }),
    );
  }

  let typeBuffer = '';
  let typeTimer = 0;
  d.add(
    on(list, 'keydown', (e) => {
      const all = enabled();
      const cur = all.indexOf(document.activeElement as HTMLButtonElement);
      const entry = buttons.find((b) => b.btn === document.activeElement);
      switch (e.key) {
        case 'ArrowDown':
          focusAt(all[(cur + 1) % all.length]);
          break;
        case 'ArrowUp':
          // From the container (nothing highlighted yet) go to the last item.
          focusAt(all[cur < 0 ? all.length - 1 : (cur - 1 + all.length) % all.length]);
          break;
        case 'Home':
          focusAt(all[0]);
          break;
        case 'End':
          focusAt(all[all.length - 1]);
          break;
        case 'ArrowRight':
          if (entry?.item.submenu) openSub(entry.btn, entry.item, true);
          else return;
          break;
        case 'ArrowLeft':
          if (opts.parent) pop.close();
          else return;
          break;
        case 'Tab':
          e.preventDefault();
          closeRoot();
          return;
        default:
          if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== ' ') {
            window.clearTimeout(typeTimer);
            typeBuffer += e.key.toLowerCase();
            typeTimer = window.setTimeout(() => (typeBuffer = ''), 600);
            const start = cur + (typeBuffer.length === 1 ? 1 : 0);
            for (let k = 0; k < all.length; k++) {
              const b = all[(start + k) % all.length];
              const label = buttons.find((x) => x.btn === b)?.item.label.toLowerCase() ?? '';
              if (label.startsWith(typeBuffer)) {
                focusAt(b);
                break;
              }
            }
            break;
          }
          return;
      }
      e.preventDefault();
      e.stopPropagation();
    }),
  );

  const pop = openPopover({
    anchor,
    content: list,
    placement: opts.placement ?? 'bottom-start',
    offset: opts.offset ?? 4,
    role: 'presentation',
    class: 'k-popover--menu',
    parent: opts.parent,
    focus: opts.focusFirst === false ? list : (enabled()[0] ?? list),
    returnFocus: opts.parent ? (anchor instanceof HTMLElement ? anchor : null) : undefined,
    onClose: () => {
      window.clearTimeout(hoverTimer);
      window.clearTimeout(typeTimer);
      d.dispose();
      opts.onClose?.();
    },
  });

  return { el: list, close: () => pop.close() };
}

/* ------------------------------------------------------------------ */

export interface AttachMenuOptions extends Omit<MenuOptions, 'parent' | 'closeRoot'> {}

/**
 * Menu button: click toggles, ArrowDown/Enter/Space opens with the first item
 * focused. Maintains aria-haspopup / aria-expanded. Returns a remover.
 */
export function attachMenu(button: HTMLElement, items: MenuItem[] | (() => MenuItem[]), opts: AttachMenuOptions = {}): () => void {
  let menu: MenuHandle | null = null;
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  const openIt = (viaKeyboard: boolean): void => {
    menu = openMenu(button, typeof items === 'function' ? items() : items, {
      // Keyboard-opened menus highlight the first item; pointer-opened ones don't.
      focusFirst: viaKeyboard,
      ...opts,
      onClose: () => {
        menu = null;
        button.setAttribute('aria-expanded', 'false');
        button.classList.remove('is-active');
        opts.onClose?.();
      },
    });
    button.setAttribute('aria-expanded', 'true');
    button.classList.add('is-active');
  };
  const offs = [
    // detail === 0 → the click came from Enter/Space.
    on(button, 'click', (e) => (menu ? menu.close() : openIt(e.detail === 0))),
    on(button, 'keydown', (e) => {
      if (e.key === 'ArrowDown' && !menu) {
        e.preventDefault();
        openIt(true);
      }
    }),
  ];
  return () => {
    menu?.close();
    for (const off of offs) off();
  };
}

/**
 * Context menu on right-click, the keyboard menu key / Shift+F10, and touch
 * long-press (iOS never fires `contextmenu`). `items` may return null to fall
 * through to the browser's own menu.
 */
export function attachContextMenu(
  target: HTMLElement,
  items: (e: MouseEvent | PointerEvent) => MenuItem[] | null,
  opts: AttachMenuOptions = {},
): () => void {
  let lastOpen = -1e9;
  const openAt = (e: MouseEvent | PointerEvent, point: { x: number; y: number }, viaKeyboard: boolean): boolean => {
    // Android fires both our long-press and a native contextmenu: open once.
    if (e.timeStamp - lastOpen < 800) return true;
    const list = items(e);
    if (!list) return false;
    lastOpen = e.timeStamp;
    openMenu(point, list, { placement: 'bottom-start', offset: 2, focusFirst: viaKeyboard, ...opts });
    return true;
  };
  const offs = [
    on(target, 'contextmenu', (e) => {
      // Keyboard-invoked menus report (0,0): use the focused element instead.
      const fromKeyboard = e.button !== 2 && e.clientX === 0 && e.clientY === 0;
      let point = { x: e.clientX, y: e.clientY };
      if (fromKeyboard) {
        const r = (document.activeElement instanceof HTMLElement && target.contains(document.activeElement) ? document.activeElement : target).getBoundingClientRect();
        point = { x: r.left + 8, y: r.top + r.height / 2 };
      }
      if (openAt(e, point, fromKeyboard)) e.preventDefault();
    }),
    onLongPress(target, (e) => openAt(e, { x: e.clientX, y: e.clientY }, false), { pointerTypes: ['touch'] }),
  ];
  return () => {
    for (const off of offs) off();
  };
}
