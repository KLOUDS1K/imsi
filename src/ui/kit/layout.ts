/**
 * Chrome helpers in the site's language: toolbar row/group/spacer/divider,
 * back/forward/up chevrons, breadcrumb, wordmark, sidebar nav items, section
 * label with count badge, status bar and the sun/moon theme toggle.
 *
 *   const bar = createToolbar({ children: [
 *     createNavArrows({ onBack, onForward, onUp }).el,
 *     createBreadcrumb([{ label: 'Archive' }]).el,
 *     toolbarSpacer(),
 *     createSearchInput({ onInput }).el,
 *     createThemeToggle({ onChange: (t) => ctx.theme.set(t) }).el,
 *   ] });
 */
import './layout.css';
import { Disposer, h, on } from '../dom';
import { createIconButton, type IconButton } from './button';
import { type IconName, icon } from './icons';
import { onThemeChange, resolvedTheme, toggleTheme, type ThemeChoice } from './theme';
import type { Component } from './util';

/* ---- toolbar ---- */

export interface ToolbarOptions {
  children?: (Node | null | undefined | false)[];
  /** Accessible label (makes it a labelled region). */
  label?: string;
  class?: string;
}

/** 44px toolbar row (sidebar background, hairline bottom border). */
export function createToolbar(opts: ToolbarOptions = {}): HTMLDivElement {
  return h('div', { class: ['k-toolbar', opts.class], attrs: { role: opts.label ? 'region' : null, 'aria-label': opts.label ?? null } }, ...(opts.children ?? []));
}

/** Tight cluster of toolbar controls. */
export function toolbarGroup(...children: (Node | null | undefined | false)[]): HTMLDivElement {
  return h('div', { class: 'k-toolbar__group' }, ...children);
}

/** Flexible space that pushes following items to the right. */
export function toolbarSpacer(): HTMLDivElement {
  return h('div', { class: 'k-toolbar__spacer' });
}

/** Short vertical hairline between groups. */
export function toolbarDivider(): HTMLDivElement {
  return h('div', { class: 'k-toolbar__divider', attrs: { role: 'separator', 'aria-orientation': 'vertical' } });
}

/* ---- back / forward / up ---- */

export interface NavArrowsOptions {
  onBack?: () => void;
  onForward?: () => void;
  onUp?: () => void;
}

export interface NavArrows extends Component<HTMLDivElement> {
  setState(state: { back?: boolean; forward?: boolean; up?: boolean }): void;
}

/** The site's thin grey ‹ › ↑ chevrons. Buttons without a handler are omitted. */
export function createNavArrows(opts: NavArrowsOptions): NavArrows {
  const make = (ic: IconName, label: string, fn?: () => void): IconButton | null =>
    fn ? createIconButton({ icon: ic, label, size: 'sm', iconSize: 15, onClick: fn }) : null;
  const back = make('chevron-left', 'Back', opts.onBack);
  const fwd = make('chevron-right', 'Forward', opts.onForward);
  const up = make('arrow-up', 'Enclosing folder', opts.onUp);
  const el = h('div', { class: 'k-toolbar__group k-nav-arrows' }, back?.el, fwd?.el, up?.el);
  return {
    el,
    setState(s) {
      if (s.back !== undefined) back?.setDisabled(!s.back);
      if (s.forward !== undefined) fwd?.setDisabled(!s.forward);
      if (s.up !== undefined) up?.setDisabled(!s.up);
    },
    destroy() {
      back?.destroy();
      fwd?.destroy();
      up?.destroy();
      el.remove();
    },
  };
}

/* ---- breadcrumb ---- */

export interface Crumb {
  label: string;
  onClick?: () => void;
}

export interface Breadcrumb extends Component<HTMLElement> {
  set(items: Crumb[]): void;
}

/** Bold current location ("Archive"), earlier levels muted and clickable. */
export function createBreadcrumb(items: Crumb[]): Breadcrumb {
  const d = new Disposer();
  const list = h('ol', { class: 'k-breadcrumb', attrs: { role: 'list' } });
  const el = h('nav', { class: 'k-breadcrumb-nav', attrs: { 'aria-label': 'Breadcrumb' } }, list);
  let local = new Disposer();
  const set = (next: Crumb[]): void => {
    local.dispose();
    local = new Disposer();
    list.replaceChildren(
      ...next.map((c, i) => {
        const last = i === next.length - 1;
        const node = c.onClick && !last ? h('button', { type: 'button', class: 'k-breadcrumb__item' }, c.label) : h('span', { class: 'k-breadcrumb__item', attrs: { 'aria-current': last ? 'page' : null } }, c.label);
        if (c.onClick && !last) local.add(on(node, 'click', c.onClick));
        return h('li', { class: 'k-breadcrumb__li' }, i > 0 ? icon('chevron-right', 12, { class: 'k-breadcrumb__sep' }) : null, node);
      }),
    );
  };
  set(items);
  d.add(() => local.dispose());
  return {
    el,
    set,
    destroy() {
      d.dispose();
      el.remove();
    },
  };
}

/* ---- wordmark ---- */

/** "KLOUD" + ".PHOTOGRAPHY" (tiny, tracked, muted). Pass `href` for a link. */
export function createWordmark(opts: { name?: string; sub?: string; href?: string } = {}): HTMLElement {
  const children = [h('span', { class: 'k-wordmark__name' }, opts.name ?? 'KLOUD'), h('span', { class: 'k-wordmark__sub' }, opts.sub ?? '.photography')];
  return opts.href
    ? h('a', { class: 'k-wordmark', href: opts.href, attrs: { 'aria-label': 'KLOUD Photography' } }, ...children)
    : h('span', { class: 'k-wordmark', attrs: { role: 'img', 'aria-label': 'KLOUD Photography' } }, ...children);
}

/* ---- sidebar nav item ---- */

export interface NavItemOptions {
  label: string;
  icon?: IconName;
  count?: number | string;
  active?: boolean;
  /** Indent level (0 = top). */
  depth?: number;
  onClick?: (e: MouseEvent) => void;
}

export interface NavItem extends Component<HTMLButtonElement> {
  setActive(active: boolean): void;
  setCount(count: number | string | null): void;
  setLabel(label: string): void;
}

/** Flat sidebar row with a small leading line icon (site sidebar). */
export function createNavItem(opts: NavItemOptions): NavItem {
  const d = new Disposer();
  const labelEl = h('span', { class: 'k-navitem__label' }, opts.label);
  const countEl = h('span', { class: 'k-navitem__count k-num' });
  const el = h(
    'button',
    { type: 'button', class: 'k-navitem', style: opts.depth ? { paddingLeft: `${10 + opts.depth * 14}px` } : undefined },
    opts.icon ? icon(opts.icon, 13, { class: 'k-navitem__icon' }) : null,
    labelEl,
    countEl,
  );
  const setCount = (c: number | string | null): void => {
    countEl.textContent = c === null || c === undefined ? '' : String(c);
  };
  setCount(opts.count ?? null);
  const setActive = (b: boolean): void => {
    if (b) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  };
  setActive(!!opts.active);
  if (opts.onClick) d.add(on(el, 'click', opts.onClick));
  return {
    el,
    setActive,
    setCount,
    setLabel: (l) => void (labelEl.textContent = l),
    destroy() {
      d.dispose();
      el.remove();
    },
  };
}

/* ---- section label ("FOLDERS  2") ---- */

export function createSectionLabel(text: string, count?: number | string): HTMLDivElement {
  return h('div', { class: 'k-label-row' }, h('span', { class: 'k-label' }, text), count === undefined ? null : h('span', { class: 'k-badge' }, String(count)));
}

/* ---- status bar ---- */

/** 26px bottom status bar with muted small text. */
export function createStatusBar(...children: (Node | string | null | undefined | false)[]): HTMLDivElement {
  return h('div', { class: 'k-statusbar', attrs: { role: 'status', 'aria-live': 'polite' } }, ...children);
}

/* ---- theme toggle ---- */

export interface ThemeToggleOptions {
  /** Called after the theme was applied (sync ctx.theme here). */
  onChange?: (choice: ThemeChoice) => void;
}

/**
 * The site's sun/moon button: shows a moon on the light theme (click → dark)
 * and a sun on the dark theme. Follows OS changes while the choice is 'system'.
 */
export function createThemeToggle(opts: ThemeToggleOptions = {}): IconButton {
  const labelFor = (): string => (resolvedTheme() === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  const btn = createIconButton({
    icon: resolvedTheme() === 'dark' ? 'sun' : 'moon',
    label: labelFor(),
    class: 'k-theme-toggle',
    onClick: () => opts.onChange?.(toggleTheme()),
  });
  const off = onThemeChange((resolved) => {
    btn.setIcon(resolved === 'dark' ? 'sun' : 'moon');
    btn.setLabel(labelFor());
  });
  const destroy = btn.destroy;
  return {
    ...btn,
    destroy() {
      off();
      destroy();
    },
  };
}
