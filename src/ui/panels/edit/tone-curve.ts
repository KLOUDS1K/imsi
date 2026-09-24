/**
 * Tone Curve section: parametric / point tabs, channel chips, the canvas
 * editor and the four parametric region sliders.
 */
import type { AppContext } from '@/app/context';
import type { CurvePoint } from '@/editor/types';
import { Disposer, h } from '@/ui/dom';
import { createSegmentedControl, loadLocal, saveLocal, type Section } from '@/ui/kit';
import { type DocBinder, paramSection, paramSlider } from '../binding';
import { type CurveChannel, type CurveMode, createCurveEditor } from './curve-editor';

const PATHS = ['toneCurve.rgb', 'toneCurve.red', 'toneCurve.green', 'toneCurve.blue', 'toneCurve.parametric'];
const MODE_KEY = 'kloud-panels:curve-mode';
const CHANNELS: { id: CurveChannel; label: string }[] = [
  { id: 'rgb', label: 'RGB' },
  { id: 'red', label: 'Red' },
  { id: 'green', label: 'Green' },
  { id: 'blue', label: 'Blue' },
];

export function createToneCurveSection(ctx: AppContext, b: DocBinder, d: Disposer): Section {
  const section = paramSection(b, d, { id: 'develop.toneCurve', title: 'Tone Curve', paths: PATHS, open: false });
  let mode: CurveMode = loadLocal<CurveMode>(MODE_KEY, 'point') === 'parametric' ? 'parametric' : 'point';
  let channel: CurveChannel = 'rgb';

  const editor = createCurveEditor({
    onGestureStart: (label) => b.store?.beginGesture(label),
    onGestureEnd: () => b.store?.endGesture(),
    onPoints: (ch: CurveChannel, pts: CurvePoint[], label) => b.store?.set(`toneCurve.${ch}`, pts, { label }),
    onRegion: (region, v) => b.store?.set(`toneCurve.parametric.${region}`, v),
    onSplit: (key, v) => b.store?.set(`toneCurve.parametric.${key}`, v),
  });
  d.add(() => editor.destroy());
  editor.setMode(mode);

  const modeCtl = createSegmentedControl<CurveMode>({
    ariaLabel: 'Curve type',
    size: 'sm',
    value: mode,
    options: [
      { value: 'parametric', label: 'Parametric', title: 'Parametric curve' },
      { value: 'point', label: 'Point', title: 'Point curve' },
    ],
    onChange: (m) => setMode(m),
  });
  d.add(() => modeCtl.destroy());

  const chips = CHANNELS.map((c) =>
    h(
      'button',
      {
        type: 'button',
        class: ['k-pnl-chip', `k-pnl-chip--${c.id}`],
        dataset: { channel: c.id },
        attrs: { 'aria-pressed': String(c.id === channel), 'aria-label': `${c.label} channel` },
        onclick: () => setChannel(c.id),
      },
      h('span', { class: 'k-pnl-chip__dot', attrs: { 'aria-hidden': 'true' } }),
      c.label,
    ),
  );
  const chipRow = h('div', { class: 'k-pnl-chips', attrs: { role: 'group', 'aria-label': 'Curve channel' } }, ...chips);

  const paramBox = h(
    'div',
    { class: 'k-pnl-curve__params' },
    paramSlider(b, d, 'toneCurve.parametric.highlights', { label: 'Highlights' }).el,
    paramSlider(b, d, 'toneCurve.parametric.lights', { label: 'Lights' }).el,
    paramSlider(b, d, 'toneCurve.parametric.darks', { label: 'Darks' }).el,
    paramSlider(b, d, 'toneCurve.parametric.shadows', { label: 'Shadows' }).el,
  );

  function setMode(m: CurveMode): void {
    mode = m;
    saveLocal(MODE_KEY, m);
    modeCtl.setValue(m, true);
    editor.setMode(m);
    chipRow.hidden = m !== 'point';
    paramBox.hidden = m !== 'parametric';
  }
  function setChannel(ch: CurveChannel): void {
    channel = ch;
    chips.forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.channel === ch)));
    editor.setChannel(ch);
  }
  setMode(mode);

  section.body.append(h('div', { class: 'k-pnl-row k-pnl-row--split' }, modeCtl.el, chipRow), editor.el, paramBox);

  d.add(
    b.watch(['toneCurve'], (p) => {
      editor.setDisabled(!p);
      editor.setData(p ? p.toneCurve : null);
      // Channel chips show a dot when that channel's curve is modified.
      if (p) for (const c of chips) c.classList.toggle('is-modified', !isLinear(p.toneCurve[c.dataset.channel as CurveChannel]));
    }),
  );
  d.add(ctx.histogram.subscribe((hist) => editor.setHistogram(hist), true));
  return section;
}

function isLinear(pts: CurvePoint[]): boolean {
  return pts.every((q) => Math.abs(q.x - q.y) < 1e-4);
}
