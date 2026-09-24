/**
 * Basic section: White Balance, Tone, Presence and Color sub-groups.
 */
import type { AppContext } from '@/app/context';
import { autoTone, autoWhiteBalance } from '@/editor/analysis';
import type { WhiteBalanceParams } from '@/editor/types';
import { Disposer, h } from '@/ui/dom';
import { createButton, createIconButton, createSelect, temperatureGradient, tintGradient, type Section } from '@/ui/kit';
import { type DocBinder, paramSection, paramSlider } from '../binding';
import { createSubgroup } from '../subgroup';
import { guarded } from '../util';

const WB_PATHS = ['whiteBalance.mode', 'whiteBalance.temperature', 'whiteBalance.tint'];
const TONE_PATHS = ['basic.exposure', 'basic.contrast', 'basic.highlights', 'basic.shadows', 'basic.whites', 'basic.blacks'];
const PRESENCE_PATHS = ['presence.texture', 'presence.clarity', 'presence.dehaze', 'presence.structure', 'presence.localContrast'];
const COLOR_PATHS = ['color.vibrance', 'color.saturation'];

type WbMode = WhiteBalanceParams['mode'];

/** Auto white balance from the analysis proxy, as one history step. */
export function applyAutoWhiteBalance(ctx: AppContext): void {
  const doc = ctx.doc.value;
  if (!doc) return;
  void guarded(ctx.toast.bind(ctx), 'Auto white balance', () => {
    const wb = autoWhiteBalance(doc.analysisProxy);
    doc.store.update(
      'White Balance: Auto',
      (p) => {
        p.whiteBalance.mode = 'auto';
        p.whiteBalance.temperature = Math.round(wb.temperature);
        p.whiteBalance.tint = Math.round(wb.tint);
      },
      { coalesceKey: null },
    );
  });
}

/** Auto tone (exposure, contrast, highlights, shadows, whites, blacks, vibrance, saturation) in one step. */
export function applyAutoTone(ctx: AppContext): void {
  const doc = ctx.doc.value;
  if (!doc) return;
  void guarded(ctx.toast.bind(ctx), 'Auto tone', () => {
    const t = autoTone(doc.analysisProxy);
    doc.store.update(
      'Auto Tone',
      (p) => {
        p.basic.exposure = Math.round(t.exposure * 100) / 100;
        p.basic.contrast = Math.round(t.contrast);
        p.basic.highlights = Math.round(t.highlights);
        p.basic.shadows = Math.round(t.shadows);
        p.basic.whites = Math.round(t.whites);
        p.basic.blacks = Math.round(t.blacks);
        p.color.vibrance = Math.round(t.vibrance);
        p.color.saturation = Math.round(t.saturation);
      },
      { coalesceKey: null },
    );
  });
}

export function createBasicSection(ctx: AppContext, b: DocBinder, d: Disposer): Section {
  const section = paramSection(b, d, {
    id: 'develop.basic',
    title: 'Basic',
    paths: [...WB_PATHS, ...TONE_PATHS, ...PRESENCE_PATHS, ...COLOR_PATHS],
    resetLabel: 'Reset Basic',
  });

  /* ---- White balance ---- */
  const wbSelect = createSelect<WbMode>({
    ariaLabel: 'White balance',
    size: 'sm',
    value: 'as-shot',
    options: [
      { value: 'as-shot', label: 'As Shot' },
      { value: 'auto', label: 'Auto' },
      { value: 'custom', label: 'Custom' },
    ],
    onChange: (mode) => {
      const store = b.store;
      if (!store) return;
      if (mode === 'auto') applyAutoWhiteBalance(ctx);
      else if (mode === 'as-shot') {
        store.update(
          'White Balance: As Shot',
          (p) => {
            p.whiteBalance = { mode: 'as-shot', temperature: 0, tint: 0 };
          },
          { coalesceKey: null },
        );
      } else store.set('whiteBalance.mode', 'custom', { label: 'White Balance: Custom' });
    },
  });
  d.add(() => wbSelect.destroy());
  const picker = createIconButton({
    icon: 'eyedropper',
    label: 'White balance selector',
    shortcut: 'W',
    size: 'sm',
    pressed: ctx.wbPickerActive.value,
    onToggle: (on) => ctx.wbPickerActive.set(on),
  });
  d.add(() => picker.destroy());
  d.add(ctx.wbPickerActive.subscribe((v) => picker.setPressed(v)));
  const wb = createSubgroup(b, d, { title: 'White Balance', paths: WB_PATHS, actions: [picker.el], id: 'wb' });
  const toCustom = (store: NonNullable<DocBinder['store']>, p: { whiteBalance: WhiteBalanceParams }): void => {
    if (p.whiteBalance.mode !== 'custom') store.set('whiteBalance.mode', 'custom');
  };
  wb.body.append(
    h('div', { class: 'k-pnl-row' }, h('span', { class: 'k-pnl-row__label' }, 'Mode'), wbSelect.el),
    paramSlider(b, d, 'whiteBalance.temperature', { label: 'Temp', gradient: temperatureGradient(), beforeSet: toCustom, ariaLabel: 'Temperature' }).el,
    paramSlider(b, d, 'whiteBalance.tint', { label: 'Tint', gradient: tintGradient(), beforeSet: toCustom }).el,
  );
  d.add(
    b.watch(['whiteBalance.mode'], (p) => {
      wbSelect.setDisabled(!p);
      picker.setDisabled(!p);
      if (p) wbSelect.setValue(p.whiteBalance.mode, true);
    }),
  );

  /* ---- Tone ---- */
  const auto = createButton({ label: 'Auto', size: 'sm', variant: 'ghost', title: 'Auto tone (⇧⌘U)', onClick: () => applyAutoTone(ctx) });
  d.add(() => auto.destroy());
  d.add(b.onDoc((doc) => auto.setDisabled(!doc)));
  const tone = createSubgroup(b, d, { title: 'Tone', paths: TONE_PATHS, actions: [auto.el], id: 'tone' });
  tone.body.append(
    paramSlider(b, d, 'basic.exposure', { label: 'Exposure', unit: '', decimals: 2 }).el,
    paramSlider(b, d, 'basic.contrast', { label: 'Contrast' }).el,
    paramSlider(b, d, 'basic.highlights', { label: 'Highlights' }).el,
    paramSlider(b, d, 'basic.shadows', { label: 'Shadows' }).el,
    paramSlider(b, d, 'basic.whites', { label: 'Whites' }).el,
    paramSlider(b, d, 'basic.blacks', { label: 'Blacks' }).el,
  );

  /* ---- Presence ---- */
  const presence = createSubgroup(b, d, { title: 'Presence', paths: PRESENCE_PATHS, id: 'presence' });
  presence.body.append(
    paramSlider(b, d, 'presence.texture', { label: 'Texture' }).el,
    paramSlider(b, d, 'presence.clarity', { label: 'Clarity' }).el,
    paramSlider(b, d, 'presence.dehaze', { label: 'Dehaze' }).el,
    paramSlider(b, d, 'presence.structure', { label: 'Structure' }).el,
    paramSlider(b, d, 'presence.localContrast', { label: 'Local Contrast' }).el,
  );

  /* ---- Color ---- */
  const color = createSubgroup(b, d, { title: 'Color', paths: COLOR_PATHS, id: 'color' });
  color.body.append(paramSlider(b, d, 'color.vibrance', { label: 'Vibrance' }).el, paramSlider(b, d, 'color.saturation', { label: 'Saturation' }).el);

  section.body.append(wb.el, tone.el, presence.el, color.el);
  return section;
}
