/**
 * Library filter bar: a collapsible panel (rating ≥, flag, color labels,
 * camera, lens, ISO / aperture / shutter / focal ranges, capture dates, edit
 * state) plus removable chips for every active filter.
 *
 * Numeric ranges slide over the DISTINCT values present in the library
 * (facets), so every stop is a real value (1/250 s, f/2.8…) and the log-like
 * spacing of shutter speeds and apertures needs no special scale.
 */
import type { AppContext } from '@/app/context';
import type { LibraryFacets } from '@/editor/contracts';
import type { ColorLabel, LibraryQuery, PickFlag } from '@/editor/types';
import { Disposer, h, on } from '@/ui/dom';
import { createButton, createRangeSlider, createRatingStars, createSegmentedControl, createSelect, icon, type RangeSlider } from '@/ui/kit';
import { LABEL_NAMES } from './actions';
import { formatAperture, formatDate, formatFocal, formatShutter } from './format';
import { librarySignals, type LibraryFilters } from './state';

type RangeKey = 'isoRange' | 'apertureRange' | 'shutterRange' | 'focalRange';
const RANGES: { key: RangeKey; label: string; facet: keyof LibraryFacets; fmt: (v: number) => string }[] = [
  { key: 'isoRange', label: 'ISO', facet: 'isos', fmt: (v) => `ISO ${Math.round(v)}` },
  { key: 'apertureRange', label: 'Aperture', facet: 'apertures', fmt: formatAperture },
  { key: 'shutterRange', label: 'Shutter', facet: 'shutters', fmt: formatShutter },
  { key: 'focalRange', label: 'Focal length', facet: 'focalLengths', fmt: formatFocal },
];
const LABELS: ColorLabel[] = ['red', 'yellow', 'green', 'blue', 'purple'];

function patch(p: Partial<LibraryFilters>): void {
  const next: LibraryFilters = { ...librarySignals.filters.value, ...p };
  for (const k of Object.keys(next) as (keyof LibraryFilters)[]) if (next[k] === undefined) delete next[k];
  librarySignals.filters.set(next);
}

/* ------------------------------------------------------------------ */
/* Chips                                                               */
/* ------------------------------------------------------------------ */

interface Chip {
  text: string;
  dot?: ColorLabel[];
  clear: Partial<LibraryFilters>;
}

export function activeChips(f: LibraryFilters): Chip[] {
  const chips: Chip[] = [];
  if (f.minRating) chips.push({ text: `★ ≥ ${f.minRating}`, clear: { minRating: undefined } });
  if (f.flag && f.flag !== 'any') chips.push({ text: f.flag === 'pick' ? 'Picked' : f.flag === 'reject' ? 'Rejected' : 'Unflagged', clear: { flag: undefined } });
  if (f.labels?.length) chips.push({ text: 'Label', dot: f.labels, clear: { labels: undefined } });
  if (f.camera) chips.push({ text: f.camera, clear: { camera: undefined } });
  if (f.lens) chips.push({ text: f.lens, clear: { lens: undefined } });
  for (const r of RANGES) {
    const v = f[r.key];
    if (v) chips.push({ text: v[0] === v[1] ? r.fmt(v[0]) : `${r.fmt(v[0])} – ${r.fmt(v[1])}`, clear: { [r.key]: undefined } });
  }
  if (f.dateRange) chips.push({ text: `${formatDate(f.dateRange[0], false) || '…'} – ${formatDate(f.dateRange[1], false) || '…'}`, clear: { dateRange: undefined } });
  if (f.edited) chips.push({ text: f.edited === 'edited' ? 'Edited' : f.edited === 'unedited' ? 'Unedited' : 'Edited this week', clear: { edited: undefined } });
  return chips;
}

export function renderChips(host: HTMLElement, f: LibraryFilters): void {
  host.replaceChildren(
    ...activeChips(f).map((c) =>
      h(
        'span',
        { class: 'k-lib-chip' },
        c.dot ? c.dot.map((l) => h('span', { class: `k-tile__label k-tile__label--${l}`, attrs: { 'aria-label': LABEL_NAMES[l] } })) : null,
        h('span', { class: 'k-truncate' }, c.text),
        h(
          'button',
          { type: 'button', class: 'k-lib-chip__x', attrs: { 'aria-label': `Remove filter ${c.text}` }, onclick: () => patch(c.clear) },
          icon('x', 11),
        ),
      ),
    ),
  );
}

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

export interface FilterPanel {
  el: HTMLElement;
  /** Rebuild facet-dependent controls (library changed). */
  refresh(): void;
  dispose(): void;
}

export function createFilterPanel(ctx: AppContext): FilterPanel {
  const d = new Disposer();
  const el = h('div', { class: 'k-lib-filters', attrs: { role: 'region', 'aria-label': 'Filters' } });
  let facetKey = '';
  let parts: { destroy(): void }[] = [];

  const field = (label: string, ...children: (Node | null)[]): HTMLElement =>
    h('div', { class: 'k-lib-filters__field' }, h('span', { class: 'k-label' }, label), h('div', { class: 'k-lib-filters__ctl' }, ...children));

  const build = (): void => {
    for (const p of parts) p.destroy();
    parts = [];
    const f = librarySignals.filters.value;
    const facets = ctx.library.facets();

    const rating = createRatingStars({ value: f.minRating ?? 0, size: 15, ariaLabel: 'Minimum rating', onChange: (v) => patch({ minRating: v || undefined }) });
    const flag = createSegmentedControl<PickFlag | 'any'>({
      ariaLabel: 'Flag',
      size: 'sm',
      value: f.flag ?? 'any',
      options: [
        { value: 'any', label: 'Any' },
        { value: 'pick', label: 'Picked' },
        { value: 'none', label: 'Unflagged' },
        { value: 'reject', label: 'Rejected' },
      ],
      onChange: (v) => patch({ flag: v === 'any' ? undefined : v }),
    });
    const labelRow = h('div', { class: 'k-lib-filters__labels', attrs: { role: 'group', 'aria-label': 'Color labels' } });
    for (const l of LABELS) {
      const on_ = !!f.labels?.includes(l);
      const b = h(
        'button',
        { type: 'button', class: 'k-lib-filters__swatch', attrs: { 'aria-pressed': String(on_), 'aria-label': LABEL_NAMES[l], title: LABEL_NAMES[l] } },
        h('span', { class: `k-tile__label k-tile__label--${l}` }),
      );
      b.addEventListener('click', () => {
        const cur = new Set(librarySignals.filters.value.labels ?? []);
        if (cur.has(l)) cur.delete(l);
        else cur.add(l);
        patch({ labels: cur.size ? LABELS.filter((x) => cur.has(x)) : undefined });
      });
      labelRow.append(b);
    }
    const anyOpt = (list: string[], none: string) => [{ value: '', label: none }, ...list.map((v) => ({ value: v, label: v }))];
    const camera = createSelect<string>({ ariaLabel: 'Camera', size: 'sm', block: true, value: f.camera ?? '', options: anyOpt(facets.cameras, 'Any camera'), onChange: (v) => patch({ camera: v || undefined }) });
    const lens = createSelect<string>({ ariaLabel: 'Lens', size: 'sm', block: true, value: f.lens ?? '', options: anyOpt(facets.lenses, 'Any lens'), onChange: (v) => patch({ lens: v || undefined }) });
    const edited = createSegmentedControl<NonNullable<LibraryQuery['edited']> | 'any'>({
      ariaLabel: 'Edit state',
      size: 'sm',
      value: f.edited ?? 'any',
      options: [
        { value: 'any', label: 'Any' },
        { value: 'edited', label: 'Edited' },
        { value: 'unedited', label: 'Unedited' },
        { value: 'recent', label: 'This week' },
      ],
      onChange: (v) => patch({ edited: v === 'any' ? undefined : v }),
    });
    parts.push(rating, flag, camera, lens, edited);

    const rangeFields: HTMLElement[] = [];
    for (const r of RANGES) {
      const values = facets[r.facet] as number[];
      if (values.length < 2) {
        rangeFields.push(field(r.label, h('span', { class: 'k-lib-filters__na' }, values.length ? r.fmt(values[0]) : 'No data')));
        continue;
      }
      const cur = f[r.key];
      const idx = (v: number, fallback: number): number => {
        let best = fallback;
        let dist = Infinity;
        values.forEach((x, i) => {
          const dd = Math.abs(Math.log(x) - Math.log(v));
          if (dd < dist) {
            dist = dd;
            best = i;
          }
        });
        return best;
      };
      const n = values.length - 1;
      const slider: RangeSlider = createRangeSlider({
        min: 0,
        max: n,
        step: 1,
        value: cur ? [idx(cur[0], 0), idx(cur[1], n)] : [0, n],
        defaultValue: [0, n],
        format: (i) => r.fmt(values[Math.round(i)] ?? values[0]),
        onChange: ([a, b]) => {
          const lo = Math.round(a);
          const hi = Math.round(b);
          patch({ [r.key]: lo <= 0 && hi >= n ? undefined : [values[lo], values[hi]] } as Partial<LibraryFilters>);
        },
      });
      parts.push(slider);
      rangeFields.push(field(r.label, slider.el));
    }

    const dateIn = (which: 0 | 1): HTMLInputElement => {
      const input = h('input', {
        type: 'date',
        class: 'k-lib-filters__date',
        value: f.dateRange?.[which]?.slice(0, 10) ?? '',
        min: facets.dateMin?.slice(0, 10) ?? '',
        max: facets.dateMax?.slice(0, 10) ?? '',
        attrs: { 'aria-label': which === 0 ? 'From date' : 'To date' },
      });
      input.addEventListener('change', () => {
        const cur = librarySignals.filters.value.dateRange ?? ['', ''];
        const next: [string, string] = [...cur] as [string, string];
        next[which] = input.value;
        patch({ dateRange: next[0] || next[1] ? next : undefined });
      });
      return input;
    };

    const clear = createButton({ label: 'Clear filters', size: 'sm', variant: 'ghost', icon: 'x', onClick: () => librarySignals.filters.set({}) });
    parts.push(clear);

    el.replaceChildren(
      h(
        'div',
        { class: 'k-lib-filters__grid' },
        field('Rating ≥', rating.el),
        field('Flag', flag.el),
        field('Color label', labelRow),
        field('Edit state', edited.el),
        field('Camera', camera.el),
        field('Lens', lens.el),
        ...rangeFields,
        field('Capture date', h('div', { class: 'k-lib-filters__dates' }, dateIn(0), h('span', { class: 'k-muted' }, '–'), dateIn(1))),
      ),
      h('div', { class: 'k-lib-filters__foot' }, clear.el),
    );
  };

  const refresh = (): void => {
    if (el.hidden) return;
    const facets = ctx.library.facets();
    const key = JSON.stringify([facets, librarySignals.filters.value]);
    if (key === facetKey) return;
    facetKey = key;
    // Rebuilding while a control is being used would steal focus: defer until it loses focus.
    if (el.contains(document.activeElement) && document.activeElement !== document.body) {
      const off = on(el, 'focusout', () => {
        off();
        queueMicrotask(refresh);
      });
      facetKey = '';
      return;
    }
    build();
  };

  d.add(
    librarySignals.filterOpen.subscribe((open) => {
      el.hidden = !open;
      if (open) refresh();
    }, true),
  );
  d.add(librarySignals.filters.subscribe(refresh));

  return {
    el,
    refresh,
    dispose() {
      d.dispose();
      for (const p of parts) p.destroy();
      el.remove();
    },
  };
}
