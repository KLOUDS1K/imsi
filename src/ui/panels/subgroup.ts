/**
 * Sub-group inside a section ("WHITE BALANCE", "TONE"…): a tiny uppercase
 * header with optional actions and a reset button that appears while any of
 * its paths differs from the defaults. Double-clicking the label also resets
 * (Lightroom convention).
 */
import { Disposer, h, on } from '@/ui/dom';
import { createIconButton } from '@/ui/kit';
import { type DocBinder, isModifiedAt, resetPaths } from './binding';

export interface Subgroup {
  el: HTMLElement;
  body: HTMLElement;
  head: HTMLElement;
}

export function createSubgroup(
  b: DocBinder,
  d: Disposer,
  o: { title: string; paths: string[]; actions?: HTMLElement[]; resetLabel?: string; id?: string },
): Subgroup {
  const label = h('span', { class: 'k-pnl-sub__title' }, o.title);
  const reset = createIconButton({
    icon: 'reset',
    label: `Reset ${o.title.toLowerCase()}`,
    size: 'sm',
    iconSize: 12,
    class: 'k-pnl-sub__reset',
    onClick: () => resetPaths(b, o.paths, o.resetLabel ?? `Reset ${o.title}`),
  });
  d.add(() => reset.destroy());
  const head = h('div', { class: 'k-pnl-sub__head' }, label, h('span', { class: 'k-pnl-sub__spacer' }), ...(o.actions ?? []), reset.el);
  const body = h('div', { class: 'k-pnl-sub__body' });
  const el = h('div', { class: 'k-pnl-sub', dataset: o.id ? { group: o.id } : undefined }, head, body);
  d.add(on(label, 'dblclick', () => resetPaths(b, o.paths, o.resetLabel ?? `Reset ${o.title}`)));
  d.add(b.watch(o.paths, (p) => el.classList.toggle('is-modified', !!p && isModifiedAt(b, p, o.paths))));
  return { el, body, head };
}
