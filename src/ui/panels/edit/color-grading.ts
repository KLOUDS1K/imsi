/**
 * Color Grading: 3-way view (Midtones over Shadows | Highlights, then Global)
 * or a single large wheel for one region, plus Blending and Balance.
 */
import type { AppContext } from '@/app/context';
import type { GradeWheel } from '@/editor/types';
import { Disposer, h } from '@/ui/dom';
import { attachTooltip, createGradeWheelControl, loadLocal, saveLocal, type GradeWheelControl, type Section } from '@/ui/kit';
import { type DocBinder, paramSection, paramSlider } from '../binding';

type Region = 'shadows' | 'midtones' | 'highlights' | 'global';
type View = '3way' | Region;
const REGIONS: Region[] = ['shadows', 'midtones', 'highlights', 'global'];
const LABEL: Record<Region, string> = { shadows: 'Shadows', midtones: 'Midtones', highlights: 'Highlights', global: 'Global' };
const VIEW_KEY = 'kloud-panels:grading-view';
const ZERO: GradeWheel = { hue: 0, saturation: 0, luminance: 0 };

export function createColorGradingSection(_ctx: AppContext, b: DocBinder, d: Disposer): Section {
  const section = paramSection(b, d, { id: 'develop.grading', title: 'Color Grading', paths: ['colorGrading'], open: false });
  let view: View = loadLocal<View>(VIEW_KEY, '3way');
  if (view !== '3way' && !REGIONS.includes(view)) view = '3way';

  /** Wheel control bound to a (possibly switching) region path. */
  function boundWheel(size: number, region: () => Region): GradeWheelControl {
    const ctl = createGradeWheelControl({
      label: LABEL[region()],
      size,
      value: ZERO,
      defaultValue: ZERO,
      onGestureStart: () => b.store?.beginGesture(`Color Grading: ${LABEL[region()]}`),
      onInput: (v) => b.store?.set(`colorGrading.${region()}`, { hue: Math.round(v.hue * 10) / 10, saturation: Math.round(v.saturation * 10) / 10, luminance: Math.round(v.luminance) }),
      onGestureEnd: () => b.store?.endGesture(),
    });
    ctl.el.dataset.region = region();
    d.add(() => ctl.destroy());
    return ctl;
  }

  const wheels = new Map<Region, GradeWheelControl>();
  for (const r of REGIONS) wheels.set(r, boundWheel(r === 'midtones' ? 124 : 112, () => r));
  const w = (r: Region): HTMLElement => wheels.get(r)!.el;
  const threeWay = h(
    'div',
    { class: 'k-pnl-grade k-pnl-grade--3way' },
    h('div', { class: 'k-pnl-grade__center' }, w('midtones')),
    h('div', { class: 'k-pnl-grade__pair' }, w('shadows'), w('highlights')),
    h('div', { class: 'k-pnl-grade__center' }, w('global')),
  );

  let single: Region = 'midtones';
  const big = boundWheel(188, () => single);
  const singleLabel = big.el.querySelector('.k-label');
  const singleView = h('div', { class: 'k-pnl-grade k-pnl-grade--single' }, big.el);

  /* ---- view switcher: five small round buttons ---- */
  const viewBtns = (['3way', ...REGIONS] as View[]).map((v) => {
    const btn = h(
      'button',
      {
        type: 'button',
        class: ['k-pnl-gradeview__btn', `k-pnl-gradeview__btn--${v}`],
        dataset: { view: v },
        attrs: { 'aria-pressed': String(v === view), 'aria-label': v === '3way' ? '3-way view' : `${LABEL[v]} wheel` },
        onclick: () => setView(v),
      },
      v === '3way'
        ? h('span', { class: 'k-pnl-gradeview__tri', attrs: { 'aria-hidden': 'true' } }, h('i'), h('i'), h('i'))
        : h('span', { class: 'k-pnl-gradeview__dot', attrs: { 'aria-hidden': 'true' } }),
    );
    const tip = attachTooltip(btn, v === '3way' ? '3-way' : LABEL[v]);
    d.add(() => tip.destroy());
    return btn;
  });
  const switcher = h('div', { class: 'k-pnl-gradeview', attrs: { role: 'group', 'aria-label': 'Color grading view' } }, h('span', { class: 'k-pnl-row__label' }, 'Adjust'), ...viewBtns);

  function setView(v: View): void {
    view = v;
    saveLocal(VIEW_KEY, v);
    viewBtns.forEach((btn) => btn.setAttribute('aria-pressed', String(btn.dataset.view === v)));
    threeWay.hidden = v !== '3way';
    singleView.hidden = v === '3way';
    if (v !== '3way') {
      single = v;
      big.el.dataset.region = v;
      if (singleLabel) singleLabel.textContent = LABEL[v];
      const p = b.params;
      if (p) big.setValue(p.colorGrading[v], true);
    }
  }
  setView(view);

  const blending = paramSlider(b, d, 'colorGrading.blending', { label: 'Blending', fill: 'min' });
  const balance = paramSlider(b, d, 'colorGrading.balance', { label: 'Balance' });

  d.add(
    b.watch(['colorGrading'], (p) => {
      for (const r of REGIONS) {
        const ctl = wheels.get(r)!;
        ctl.setDisabled(!p);
        if (p) ctl.setValue(p.colorGrading[r], true);
      }
      big.setDisabled(!p);
      if (p && view !== '3way') big.setValue(p.colorGrading[single], true);
      if (p) viewBtns.forEach((btn) => {
        const v = btn.dataset.view as View;
        const g = v === '3way' ? null : p.colorGrading[v];
        btn.classList.toggle('is-modified', !!g && (g.saturation !== 0 || g.luminance !== 0));
      });
    }),
  );

  section.body.append(switcher, threeWay, singleView, blending.el, balance.el);
  return section;
}
