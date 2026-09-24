/**
 * Grid tile DOM: rounded photo (aspect-correct, bottom-aligned like the site's
 * folder tiles) with overlays — pick/reject flag, favorite heart, rating
 * stars, edited badge — and hover actions; bold name + muted EXIF sub-line.
 * Tiles are recycled by the virtualized grid: `bindTile` re-targets one.
 */
import type { PhotoRecord } from '@/editor/types';
import { h } from '@/ui/dom';
import { icon, replaceIcon } from '@/ui/kit';
import { exifLine, formatBytes } from './format';
import { thumbImg } from './thumbs';

export interface Tile {
  el: HTMLDivElement;
  wrap: HTMLDivElement;
  img: HTMLImageElement;
  name: HTMLSpanElement;
  label: HTMLSpanElement;
  sub: HTMLSpanElement;
  flag: HTMLSpanElement;
  stars: HTMLSpanElement;
  edited: HTMLSpanElement;
  heart: HTMLButtonElement;
  rec: PhotoRecord | null;
  /** Last applied geometry (to skip redundant style writes). */
  geo: string;
}

export function createTile(): Tile {
  const img = thumbImg('k-tile__img');
  const flag = h('span', { class: 'k-tile__flag', attrs: { 'aria-hidden': 'true' } });
  const stars = h('span', { class: 'k-tile__stars k-num', attrs: { 'aria-hidden': 'true' } });
  const edited = h('span', { class: 'k-tile__edited', attrs: { title: 'Edited', 'aria-hidden': 'true' } }, icon('sliders', 12));
  const heart = h(
    'button',
    { type: 'button', class: 'k-tile__act k-tile__heart', tabIndex: -1, dataset: { act: 'favorite' }, attrs: { 'aria-label': 'Favorite' } },
    icon('heart', 14),
  );
  const more = h(
    'button',
    { type: 'button', class: 'k-tile__act k-tile__more', tabIndex: -1, dataset: { act: 'menu' }, attrs: { 'aria-label': 'More actions' } },
    icon('more-horizontal', 14),
  );
  const wrap = h('div', { class: 'k-tile__wrap' }, img, flag, h('span', { class: 'k-tile__acts' }, heart, more), stars, edited);
  const name = h('span', { class: 'k-tile__name-text k-truncate' });
  const label = h('span', { class: 'k-tile__label', attrs: { 'aria-hidden': 'true' } });
  const sub = h('span', { class: 'k-tile__sub k-num k-truncate' });
  const el = h(
    'div',
    { class: 'k-tile', attrs: { role: 'option', 'aria-selected': 'false' } },
    h('div', { class: 'k-tile__frame' }, wrap),
    h('div', { class: 'k-tile__meta' }, h('span', { class: 'k-tile__name' }, label, name), sub),
  );
  return { el, wrap, img, name, label, sub, flag, stars, edited, heart, rec: null, geo: '' };
}

/** Update overlays and text for `rec` (skipped when the record snapshot is unchanged). */
export function renderTileRecord(t: Tile, rec: PhotoRecord): void {
  if (t.rec === rec) return;
  const prev = t.rec;
  t.rec = rec;
  if (!prev || prev.id !== rec.id) {
    t.el.dataset.id = rec.id;
    t.el.id = `k-tile-${rec.id}`;
  }
  t.name.textContent = rec.name;
  t.sub.textContent = exifLine(rec.meta, formatBytes(rec.size));
  t.el.title = rec.name;

  t.label.className = rec.label ? `k-tile__label k-tile__label--${rec.label}` : 'k-tile__label';
  t.label.hidden = !rec.label;

  if (!prev || prev.flag !== rec.flag) {
    t.flag.hidden = rec.flag === 'none';
    t.flag.className = `k-tile__flag k-tile__flag--${rec.flag}`;
    t.flag.replaceChildren(rec.flag === 'none' ? '' : icon(rec.flag === 'pick' ? 'flag' : 'flag-x', 12));
  }
  t.stars.hidden = rec.rating <= 0;
  t.stars.textContent = rec.rating > 0 ? '★'.repeat(rec.rating) : '';
  t.edited.hidden = !rec.hasEdits;
  if (!prev || prev.favorite !== rec.favorite) {
    replaceIcon(t.heart, rec.favorite ? 'heart-filled' : 'heart', 14);
    t.heart.classList.toggle('is-on', rec.favorite);
    t.heart.setAttribute('aria-pressed', String(rec.favorite));
    t.heart.setAttribute('aria-label', rec.favorite ? 'Remove from Favorites' : 'Add to Favorites');
  }
  t.el.classList.toggle('is-rejected', rec.flag === 'reject');

  const bits = [rec.name];
  if (rec.rating) bits.push(`${rec.rating} star${rec.rating === 1 ? '' : 's'}`);
  if (rec.flag !== 'none') bits.push(rec.flag === 'pick' ? 'picked' : 'rejected');
  if (rec.label) bits.push(`${rec.label} label`);
  if (rec.favorite) bits.push('favorite');
  if (rec.hasEdits) bits.push('edited');
  t.el.setAttribute('aria-label', bits.join(', '));
}

/** Fit a photo of aspect `ar` into a box, returning the image size. */
export function fitBox(ar: number, boxW: number, boxH: number): { w: number; h: number } {
  const a = Number.isFinite(ar) && ar > 0 ? ar : 1.5;
  if (a >= boxW / boxH) return { w: boxW, h: Math.max(8, Math.round(boxW / a)) };
  return { w: Math.max(8, Math.round(boxH * a)), h: boxH };
}

/** Aspect of a record's thumbnail: measured from the loaded image when known, else from metadata. */
export function recordAspect(rec: PhotoRecord, measured: Map<string, number>): number {
  const m = measured.get(rec.id);
  if (m) return m;
  const w = rec.meta?.width ?? 0;
  const hh = rec.meta?.height ?? 0;
  return w > 0 && hh > 0 ? w / hh : 1.5;
}
