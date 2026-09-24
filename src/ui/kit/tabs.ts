/**
 * Tabs — ARIA tablist with automatic activation (arrows move + select,
 * Home/End). Optional panels are shown/hidden for you.
 *
 *   const tabs = createTabs({ ariaLabel: 'Scopes', value: 'histogram', tabs: [
 *     { id: 'histogram', label: 'Histogram', panel: histEl },
 *     { id: 'waveform', icon: 'waveform', title: 'Waveform', panel: waveEl } ],
 *     onChange: (id) => ctx.scope.set(id) });
 */
import './tabs.css';
import { Disposer, h, on } from '../dom';
import { type IconName, icon } from './icons';
import { attachTooltip } from './tooltip';
import { type Component, kitId } from './util';

export interface TabDef<T extends string> {
  id: T;
  label?: string;
  icon?: IconName;
  /** Tooltip / accessible name for icon-only tabs. */
  title?: string;
  badge?: string | number;
  panel?: HTMLElement;
  disabled?: boolean;
}

export interface TabsOptions<T extends string> {
  tabs: TabDef<T>[];
  value: T;
  ariaLabel: string;
  /** 'underline' (default, panel headers) or 'pill' (segmented look). */
  variant?: 'underline' | 'pill';
  /** Tabs share the full width equally. */
  stretch?: boolean;
  onChange?: (id: T) => void;
}

export interface Tabs<T extends string> extends Component<HTMLDivElement> {
  readonly list: HTMLDivElement;
  setValue(id: T, silent?: boolean): void;
  getValue(): T;
  setBadge(id: T, badge: string | number | null): void;
}

export function createTabs<T extends string>(opts: TabsOptions<T>): Tabs<T> {
  const d = new Disposer();
  let value = opts.value;
  const badges = new Map<T, HTMLSpanElement>();
  const buttons = opts.tabs.map((t) => {
    const tabId = kitId('k-tab');
    const badge = h('span', { class: 'k-badge k-tabs__badge' });
    badges.set(t.id, badge);
    if (t.badge === undefined) badge.hidden = true;
    else badge.textContent = String(t.badge);
    const b = h(
      'button',
      {
        type: 'button',
        id: tabId,
        class: 'k-tabs__tab',
        disabled: !!t.disabled,
        dataset: { tab: t.id },
        attrs: { role: 'tab', 'aria-label': t.label ? null : (t.title ?? t.id) },
      },
      t.icon ? icon(t.icon, 15) : null,
      t.label ? h('span', { class: 'k-tabs__text' }, t.label) : null,
      badge,
    );
    if (t.title && !t.label) {
      const tip = attachTooltip(b, t.title);
      d.add(() => tip.destroy());
    }
    if (t.panel) {
      const panelId = t.panel.id || kitId('k-tabpanel');
      t.panel.id = panelId;
      t.panel.setAttribute('role', 'tabpanel');
      t.panel.setAttribute('aria-labelledby', tabId);
      t.panel.tabIndex = -1;
      b.setAttribute('aria-controls', panelId);
    }
    return b;
  });
  const list = h(
    'div',
    {
      class: ['k-tabs', `k-tabs--${opts.variant ?? 'underline'}`, opts.stretch && 'k-tabs--stretch'],
      attrs: { role: 'tablist', 'aria-label': opts.ariaLabel },
    },
    ...buttons,
  );
  const panels = opts.tabs.filter((t) => t.panel).map((t) => t.panel!);
  const el = h('div', { class: 'k-tabs-wrap' }, list, panels.length ? h('div', { class: 'k-tabs__panels' }, ...panels) : null);

  const render = (): void => {
    opts.tabs.forEach((t, i) => {
      const sel = t.id === value;
      buttons[i].setAttribute('aria-selected', String(sel));
      buttons[i].tabIndex = sel ? 0 : -1;
      if (t.panel) t.panel.hidden = !sel;
    });
  };
  const select = (id: T, focus: boolean, silent: boolean): void => {
    const i = opts.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    if (focus) buttons[i].focus();
    if (id === value) return;
    value = id;
    render();
    if (!silent) opts.onChange?.(id);
  };

  buttons.forEach((b, i) => {
    d.add(on(b, 'click', () => select(opts.tabs[i].id, false, false)));
    d.add(
      on(b, 'keydown', (e) => {
        const n = opts.tabs.length;
        let j = -1;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = i + 1;
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = i - 1;
        else if (e.key === 'Home') j = 0;
        else if (e.key === 'End') j = n - 1;
        else return;
        e.preventDefault();
        e.stopPropagation();
        const dir = e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'End' ? -1 : 1;
        for (let k = 0; k < n; k++) {
          const idx = (((j + dir * k) % n) + n) % n;
          if (!opts.tabs[idx].disabled) {
            select(opts.tabs[idx].id, true, false);
            break;
          }
        }
      }),
    );
  });
  render();

  return {
    el,
    list,
    setValue: (id, silent = false) => select(id, false, silent),
    getValue: () => value,
    setBadge(id, badge) {
      const b = badges.get(id);
      if (!b) return;
      b.hidden = badge === null || badge === '';
      b.textContent = badge === null ? '' : String(badge);
    },
    destroy() {
      d.dispose();
      el.remove();
    },
  };
}
