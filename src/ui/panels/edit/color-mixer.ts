/**
 * Color Mixer (HSL): Hue / Saturation / Luminance / All tabs × 8 bands with
 * coloured gradient tracks, plus a "Color" view (pick a band chip, edit its
 * three sliders).
 */
import type { AppContext } from '@/app/context';
import { HSL_CENTERS, HSL_CHANNELS, type HslChannel } from '@/editor/types';
import { Disposer, h } from '@/ui/dom';
import {
  bandHueGradient,
  createSegmentedControl,
  createSwatch,
  createTabs,
  loadLocal,
  luminanceGradient,
  saturationGradient,
  saveLocal,
  type Section,
  type Swatch,
} from '@/ui/kit';
import { type DocBinder, paramSection, paramSlider } from '../binding';

type Prop = 'hue' | 'saturation' | 'luminance';
type HslTab = Prop | 'all';
type View = 'hsl' | 'color';
const PROPS: Prop[] = ['hue', 'saturation', 'luminance'];
const PROP_LABEL: Record<Prop, string> = { hue: 'Hue', saturation: 'Saturation', luminance: 'Luminance' };
const TAB_KEY = 'kloud-panels:hsl-tab';
const VIEW_KEY = 'kloud-panels:hsl-view';

const cap = (s: string): string => s[0].toUpperCase() + s.slice(1);

function gradientFor(prop: Prop, c: HslChannel): string {
  const hue = HSL_CENTERS[c];
  return prop === 'hue' ? bandHueGradient(hue) : prop === 'saturation' ? saturationGradient(hue) : luminanceGradient(hue);
}

export function createColorMixerSection(_ctx: AppContext, b: DocBinder, d: Disposer): Section {
  const section = paramSection(b, d, { id: 'develop.hsl', title: 'Color Mixer', paths: ['hsl'], open: false });
  let view: View = loadLocal<View>(VIEW_KEY, 'hsl') === 'color' ? 'color' : 'hsl';
  let tab: HslTab = loadLocal<HslTab>(TAB_KEY, 'hue');
  if (!['hue', 'saturation', 'luminance', 'all'].includes(tab)) tab = 'hue';

  /* ---- HSL view: one group of 8 sliders per property ---- */
  const groups = PROPS.map((prop) => {
    const head = h('div', { class: 'k-pnl-sub__head' }, h('span', { class: 'k-pnl-sub__title' }, PROP_LABEL[prop]));
    const body = h(
      'div',
      { class: 'k-pnl-hsl__group', dataset: { prop } },
      head,
      ...HSL_CHANNELS.map(
        (c) =>
          paramSlider(b, d, `hsl.${c}.${prop}`, {
            label: cap(c),
            ariaLabel: `${cap(c)} ${prop}`,
            gradient: gradientFor(prop, c),
          }).el,
      ),
    );
    return { prop, head, body };
  });

  const tabs = createTabs<HslTab>({
    ariaLabel: 'Color mixer adjustment',
    variant: 'underline',
    stretch: true,
    value: tab,
    tabs: [
      { id: 'hue', label: 'Hue' },
      { id: 'saturation', label: 'Sat' , title: 'Saturation' },
      { id: 'luminance', label: 'Lum', title: 'Luminance' },
      { id: 'all', label: 'All' },
    ],
    onChange: (t) => {
      tab = t;
      saveLocal(TAB_KEY, t);
      renderTab();
    },
  });
  d.add(() => tabs.destroy());
  const hslView = h('div', { class: 'k-pnl-hsl' }, tabs.el, ...groups.map((g) => g.body));

  function renderTab(): void {
    for (const g of groups) {
      g.body.hidden = tab !== 'all' && tab !== g.prop;
      g.head.hidden = tab !== 'all';
    }
  }
  renderTab();

  /* ---- Color view: band chips + three sliders for the selected band ---- */
  let band: HslChannel = 'red';
  const bandPath = (prop: Prop): string => `hsl.${band}.${prop}`;
  const bandSliders = PROPS.map((prop) =>
    paramSlider(b, d, `hsl.red.${prop}`, {
      label: PROP_LABEL[prop],
      resolvePath: () => bandPath(prop),
      gradient: gradientFor(prop, band),
    }),
  );
  const swatches: Swatch[] = HSL_CHANNELS.map((c) => {
    const sw = createSwatch({
      color: `hsl(${HSL_CENTERS[c]} 78% 52%)`,
      label: cap(c),
      size: 22,
      shape: 'circle',
      selected: c === band,
      onClick: () => selectBand(c),
    });
    sw.el.dataset.band = c;
    d.add(() => sw.destroy());
    return sw;
  });
  const bandLabel = h('span', { class: 'k-pnl-hsl__band' }, cap(band));
  const colorView = h(
    'div',
    { class: 'k-pnl-hsl k-pnl-hsl--color' },
    h('div', { class: 'k-pnl-swatches', attrs: { role: 'group', 'aria-label': 'Color band' } }, ...swatches.map((s) => s.el)),
    h('div', { class: 'k-pnl-sub__head' }, h('span', { class: 'k-pnl-sub__title' }, 'Adjust'), bandLabel),
    ...bandSliders.map((s) => s.el),
  );

  function selectBand(c: HslChannel): void {
    band = c;
    bandLabel.textContent = cap(c);
    swatches.forEach((s, i) => s.setSelected(HSL_CHANNELS[i] === c));
    bandSliders.forEach((s, i) => {
      s.setGradient(gradientFor(PROPS[i], c));
      s.resync();
    });
  }

  /* ---- modified dots on the swatches ---- */
  d.add(
    b.watch(['hsl'], (p) => {
      if (!p) return;
      HSL_CHANNELS.forEach((c, i) => {
        const v = p.hsl[c];
        swatches[i].el.classList.toggle('is-modified', v.hue !== 0 || v.saturation !== 0 || v.luminance !== 0);
      });
    }),
  );

  const viewCtl = createSegmentedControl<View>({
    ariaLabel: 'Color mixer view',
    size: 'sm',
    value: view,
    options: [
      { value: 'hsl', label: 'HSL' },
      { value: 'color', label: 'Color' },
    ],
    onChange: (v) => {
      view = v;
      saveLocal(VIEW_KEY, v);
      renderView();
    },
  });
  d.add(() => viewCtl.destroy());
  function renderView(): void {
    hslView.hidden = view !== 'hsl';
    colorView.hidden = view !== 'color';
  }
  renderView();

  section.body.append(h('div', { class: 'k-pnl-row k-pnl-row--end' }, viewCtl.el), hslView, colorView);
  return section;
}
