/**
 * Small inline chips: Badge (count pills, honest "Heuristic" / "On-device
 * model" labels) and Kbd (key caps).
 *
 *   createBadge(12)                                   // grey count pill (.k-badge)
 *   createBadge('Heuristic', { tone: 'outline', title: 'Classical algorithm, no ML model' })
 *   createKbd('Shift+Mod+Z')                          // ⇧ ⌘ Z  /  Ctrl Shift Z
 */
import './chips.css';
import { h } from '../dom';
import { attachTooltip } from './tooltip';
import { type Component, shortcutParts } from './util';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'danger' | 'info' | 'outline';

export interface BadgeOptions {
  tone?: BadgeTone;
  /** Tooltip (e.g. why a feature is labelled "Heuristic"). */
  title?: string;
}

export interface Badge extends Component<HTMLSpanElement> {
  set(text: string | number): void;
  setTone(tone: BadgeTone): void;
}

export function createBadge(text: string | number, opts: BadgeOptions = {}): Badge {
  const el = h('span', { class: ['k-badge', `k-badge--${opts.tone ?? 'neutral'}`] }, String(text));
  const tip = opts.title ? attachTooltip(el, opts.title) : null;
  if (opts.title) el.tabIndex = 0;
  return {
    el,
    set: (t) => void (el.textContent = String(t)),
    setTone(tone) {
      el.className = `k-badge k-badge--${tone}`;
    },
    destroy() {
      tip?.destroy();
      el.remove();
    },
  };
}

/** Key caps for a shortcut string ("Mod+Z", "Shift+ArrowRight", "\\"). */
export function createKbd(shortcut: string): Component<HTMLSpanElement> {
  const el = h(
    'span',
    { class: 'k-kbd-group', attrs: { 'aria-label': shortcutParts(shortcut).join(' ') } },
    ...shortcutParts(shortcut).map((k) => h('kbd', { class: 'k-kbd', attrs: { 'aria-hidden': 'true' } }, k)),
  );
  return { el, destroy: () => el.remove() };
}
