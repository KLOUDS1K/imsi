/**
 * Section — collapsible panel section with an uppercase label header.
 *
 *   const basic = createSection({
 *     id: 'develop.basic', title: 'Light',
 *     onReset: () => store.update('Reset Light', (p) => …),
 *     enabled: true, onEnabledChange: (on) => …,   // optional group switch
 *     content: [exposure.el, contrast.el],
 *   });
 *   basic.setModified(true);   // shows the reset button + a small accent dot
 *
 * The open state persists in localStorage ('kloud-section:<id>'). Opening and
 * closing animates the height (grid-rows 0fr ↔ 1fr), instant with reduced
 * motion. A closed body is `inert`. `onToggle` receives the click event, so
 * callers can implement Lightroom's Alt+click "solo" mode.
 */
import './section.css';
import { Disposer, h, on } from '../dom';
import { createIconButton } from './button';
import { createToggle, type Toggle } from './controls';
import { icon } from './icons';
import { type Component, kitId, loadLocal, saveLocal } from './util';

export interface SectionOptions {
  /** Stable id; the open state persists under `kloud-section:<id>`. */
  id: string;
  title: string;
  /** Initial open state when nothing is persisted. Default true. */
  open?: boolean;
  /** Persist open state (default true). */
  persist?: boolean;
  /** Pill count badge after the title ("FOLDERS 2"). */
  badge?: string | number;
  /** Extra header elements on the right (icon buttons…). */
  actions?: HTMLElement[];
  /** Adds a reset button, visible while the section is marked modified. */
  onReset?: () => void;
  resetLabel?: string;
  /** Adds an enable switch for the whole group (dims the body when off). */
  enabled?: boolean;
  onEnabledChange?: (enabled: boolean) => void;
  content?: Node | Node[];
  /** Compact header (24px) for nested sub-sections. */
  dense?: boolean;
  onToggle?: (open: boolean, e?: MouseEvent) => void;
}

export interface Section extends Component<HTMLElement> {
  /** Append your controls here. */
  readonly body: HTMLDivElement;
  setOpen(open: boolean): void;
  isOpen(): boolean;
  toggle(): void;
  setEnabled(enabled: boolean, silent?: boolean): void;
  isEnabled(): boolean;
  setModified(modified: boolean): void;
  setBadge(badge: string | number | null): void;
  setTitle(title: string): void;
}

const KEY = (id: string): string => `kloud-section:${id}`;

export function createSection(opts: SectionOptions): Section {
  const d = new Disposer();
  const persist = opts.persist !== false;
  let open = persist ? loadLocal<boolean>(KEY(opts.id), opts.open ?? true) !== false : opts.open !== false;
  let enabled = opts.enabled ?? true;

  const bodyId = kitId('k-section-body');
  const titleEl = h('span', { class: 'k-section__title' }, opts.title);
  const badgeEl = h('span', { class: 'k-badge k-section__badge' });
  const dot = h('span', { class: 'k-section__dot', attrs: { 'aria-hidden': 'true' } });
  const headBtn = h(
    'button',
    { type: 'button', class: 'k-section__toggle', attrs: { 'aria-expanded': String(open), 'aria-controls': bodyId } },
    icon('chevron-down', 12, { class: 'k-section__chevron', strokeWidth: 1.5 }),
    titleEl,
    badgeEl,
    dot,
  );
  const actions = h('div', { class: 'k-section__actions' });
  let resetBtn: ReturnType<typeof createIconButton> | null = null;
  if (opts.onReset) {
    resetBtn = createIconButton({
      icon: 'reset',
      label: opts.resetLabel ?? `Reset ${opts.title}`,
      size: 'sm',
      iconSize: 13,
      class: 'k-section__reset',
      onClick: () => opts.onReset?.(),
    });
    actions.append(resetBtn.el);
    d.add(() => resetBtn?.destroy());
  }
  for (const a of opts.actions ?? []) actions.append(a);
  let sw: Toggle | null = null;
  if (opts.enabled !== undefined || opts.onEnabledChange) {
    sw = createToggle({
      checked: enabled,
      size: 'sm',
      ariaLabel: `Enable ${opts.title}`,
      onChange: (b) => {
        enabled = b;
        renderEnabled();
        opts.onEnabledChange?.(b);
      },
    });
    actions.append(sw.el);
    d.add(() => sw?.destroy());
  }

  const body = h('div', { class: 'k-section__content' }, ...(opts.content ? (Array.isArray(opts.content) ? opts.content : [opts.content]) : []));
  const clip = h('div', { class: 'k-section__clip' }, body);
  const wrap = h('div', { class: 'k-section__body', id: bodyId, attrs: { role: 'region', 'aria-label': opts.title } }, clip);
  const el = h(
    'section',
    { class: ['k-section', opts.dense && 'k-section--dense'], dataset: { section: opts.id } },
    h('div', { class: 'k-section__header' }, headBtn, actions),
    wrap,
  );

  const setBadge = (b: string | number | null): void => {
    badgeEl.textContent = b === null || b === undefined ? '' : String(b);
    badgeEl.hidden = b === null || b === undefined || b === '';
  };
  setBadge(opts.badge ?? null);

  function renderEnabled(): void {
    el.classList.toggle('is-group-off', !enabled);
  }

  let animTimer = 0;
  function renderOpen(animate: boolean): void {
    headBtn.setAttribute('aria-expanded', String(open));
    wrap.inert = !open;
    if (animate) {
      // Clip only while animating so focus rings/popovers aren't cut off at rest.
      el.classList.add('is-animating');
      window.clearTimeout(animTimer);
      const ms = parseFloat(getComputedStyle(wrap).transitionDuration) * 1000 || 0;
      animTimer = window.setTimeout(() => el.classList.remove('is-animating'), ms + 30);
    }
    el.classList.toggle('is-open', open);
  }

  function setOpen(b: boolean, e?: MouseEvent): void {
    if (b === open) return;
    open = b;
    renderOpen(true);
    if (persist) saveLocal(KEY(opts.id), open);
    opts.onToggle?.(open, e);
  }

  d.add(on(headBtn, 'click', (e) => setOpen(!open, e)));
  d.add(() => window.clearTimeout(animTimer));

  renderOpen(false);
  renderEnabled();

  return {
    el,
    body,
    setOpen: (b) => setOpen(b),
    isOpen: () => open,
    toggle: () => setOpen(!open),
    setEnabled(b, silent = false) {
      if (b === enabled) return;
      enabled = b;
      sw?.setChecked(b, true);
      renderEnabled();
      if (!silent) opts.onEnabledChange?.(b);
    },
    isEnabled: () => enabled,
    setModified(b) {
      el.classList.toggle('is-modified', b);
    },
    setBadge,
    setTitle(t) {
      titleEl.textContent = t;
      wrap.setAttribute('aria-label', t);
    },
    destroy() {
      d.dispose();
      el.remove();
    },
  };
}
