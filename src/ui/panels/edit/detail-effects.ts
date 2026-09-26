/**
 * Detail (sharpening, noise reduction, AI denoise), Effects (post-crop
 * vignette, grain, bloom / glow / halation) and Calibration sections.
 */
import type { AppContext } from '@/app/context';
import { analyzeImage, recommendBloom, recommendNoiseReduction } from '@/editor/analysis';
import { Disposer, h } from '@/ui/dom';
import { createBadge, createButton, hueGradient, tintGradient, type Section } from '@/ui/kit';
import { type DocBinder, paramSection, paramSlider, paramToggle } from '../binding';
import { createSubgroup } from '../subgroup';

const SHARPEN = ['detail.sharpenAmount', 'detail.sharpenRadius', 'detail.sharpenDetail', 'detail.sharpenMasking'];
const NR = ['noise.luminance', 'noise.luminanceDetail', 'noise.luminanceContrast', 'noise.color', 'noise.colorDetail', 'noise.colorSmoothness'];
const AI_NR = ['noise.aiDenoise', 'noise.aiDenoiseStrength', 'noise.detailPreservation'];

export function createDetailSection(ctx: AppContext, b: DocBinder, d: Disposer): Section {
  const section = paramSection(b, d, { id: 'develop.detail', title: 'Detail', paths: [...SHARPEN, ...NR, ...AI_NR], open: false });

  const sharpen = createSubgroup(b, d, { title: 'Sharpening', paths: SHARPEN, id: 'sharpen' });
  sharpen.body.append(
    paramSlider(b, d, 'detail.sharpenAmount', { label: 'Amount', fill: 'min' }).el,
    paramSlider(b, d, 'detail.sharpenRadius', { label: 'Radius', decimals: 1, fill: 'min' }).el,
    paramSlider(b, d, 'detail.sharpenDetail', { label: 'Detail', fill: 'min' }).el,
    paramSlider(b, d, 'detail.sharpenMasking', { label: 'Masking', fill: 'min' }).el,
  );

  const autoNr = createButton({
    label: 'Auto',
    size: 'sm',
    variant: 'ghost',
    title: 'Measure this photo and set noise reduction',
    onClick: () => {
      const doc = ctx.doc.value;
      if (!doc) return;
      const measured = analyzeImage(doc.analysisProxy, doc.meta).noise.level;
      const recommendation = recommendNoiseReduction(measured);
      doc.store.update('Auto Noise Reduction', (p) => Object.assign(p.noise, recommendation), { coalesceKey: null });
      ctx.toast(`Noise measured ${Math.round(measured)} / 100. Reduction adjusted.`, 'success');
    },
  });
  d.add(() => autoNr.destroy());
  d.add(b.onDoc((doc) => autoNr.setDisabled(!doc)));
  const nr = createSubgroup(b, d, { title: 'Noise Reduction', paths: NR, actions: [autoNr.el], id: 'nr' });
  nr.body.append(
    paramSlider(b, d, 'noise.luminance', { label: 'Luminance', fill: 'min' }).el,
    paramSlider(b, d, 'noise.luminanceDetail', { label: 'Detail', ariaLabel: 'Luminance detail', fill: 'min' }).el,
    paramSlider(b, d, 'noise.luminanceContrast', { label: 'Contrast', ariaLabel: 'Luminance contrast', fill: 'min' }).el,
    paramSlider(b, d, 'noise.color', { label: 'Color', fill: 'min' }).el,
    paramSlider(b, d, 'noise.colorDetail', { label: 'Detail', ariaLabel: 'Color detail', fill: 'min' }).el,
    paramSlider(b, d, 'noise.colorSmoothness', { label: 'Smoothness', ariaLabel: 'Color smoothness', fill: 'min' }).el,
  );

  const badge = createBadge('GPU · Local', { tone: 'outline', title: 'Runs locally with a multi-scale edge-aware wavelet filter' });
  d.add(() => badge.destroy());
  const ai = createSubgroup(b, d, { title: 'Smart Denoise', paths: AI_NR, actions: [badge.el], id: 'ai-denoise' });
  const strength = paramSlider(b, d, 'noise.aiDenoiseStrength', { label: 'Strength', fill: 'min' });
  const keep = paramSlider(b, d, 'noise.detailPreservation', { label: 'Keep Detail', ariaLabel: 'Detail preservation', fill: 'min' });
  ai.body.append(
    paramToggle(b, d, 'noise.aiDenoise', 'Enable Smart Denoise', (on) => `Smart Denoise ${on ? 'On' : 'Off'}`).el,
    strength.el,
    keep.el,
    h('p', { class: 'k-pnl-note' }, 'Multi-scale edge-aware filtering keeps strong texture while smoothing fine luma and color noise. Skipped while dragging.'),
  );
  d.add(
    b.watch(['noise.aiDenoise'], (p) => {
      const on = !!p?.noise.aiDenoise;
      ai.body.classList.toggle('is-off', !on);
    }),
  );

  section.body.append(sharpen.el, nr.el, ai.el);
  return section;
}

const VIGNETTE = ['effects.vignetteAmount', 'effects.vignetteMidpoint', 'effects.vignetteRoundness', 'effects.vignetteFeather', 'effects.vignetteHighlights'];
const GRAIN = ['effects.grainAmount', 'effects.grainSize', 'effects.grainRoughness'];
const BLOOM = ['effects.bloom', 'effects.bloomThreshold', 'effects.bloomRadius'];
const ATMOSPHERE = ['effects.glow', 'effects.halation'];

export function createEffectsSection(ctx: AppContext, b: DocBinder, d: Disposer): Section {
  const section = paramSection(b, d, { id: 'develop.effects', title: 'Effects & Bloom', paths: [...VIGNETTE, ...GRAIN, ...BLOOM, ...ATMOSPHERE], open: false });
  const vig = createSubgroup(b, d, { title: 'Post-Crop Vignette', paths: VIGNETTE, id: 'vignette' });
  vig.body.append(
    paramSlider(b, d, 'effects.vignetteAmount', { label: 'Amount', ariaLabel: 'Vignette amount' }).el,
    paramSlider(b, d, 'effects.vignetteMidpoint', { label: 'Midpoint', ariaLabel: 'Vignette midpoint' }).el,
    paramSlider(b, d, 'effects.vignetteRoundness', { label: 'Roundness' }).el,
    paramSlider(b, d, 'effects.vignetteFeather', { label: 'Feather', ariaLabel: 'Vignette feather' }).el,
    paramSlider(b, d, 'effects.vignetteHighlights', { label: 'Highlights', ariaLabel: 'Vignette highlights', fill: 'min' }).el,
  );
  const grain = createSubgroup(b, d, { title: 'Grain', paths: GRAIN, id: 'grain' });
  grain.body.append(
    paramSlider(b, d, 'effects.grainAmount', { label: 'Amount', ariaLabel: 'Grain amount', fill: 'min' }).el,
    paramSlider(b, d, 'effects.grainSize', { label: 'Size', ariaLabel: 'Grain size', fill: 'min' }).el,
    paramSlider(b, d, 'effects.grainRoughness', { label: 'Roughness', fill: 'min' }).el,
  );
  const autoBloom = createButton({
    label: 'Auto',
    size: 'sm',
    variant: 'ghost',
    title: 'Measure the photo highlights and set a natural bloom starting point',
    onClick: () => {
      const doc = ctx.doc.value;
      if (!doc) return;
      const analysis = analyzeImage(doc.analysisProxy, doc.meta);
      const recommendation = recommendBloom({
        p99: analysis.exposure.p99,
        clippedHighlights: analysis.dynamicRange.clippedHighlights,
        scene: analysis.scene.label,
      });
      doc.store.update('Auto Bloom', (p) => Object.assign(p.effects, recommendation), { coalesceKey: null });
      ctx.toast(recommendation.bloom > 0 ? 'Bloom matched to this photo’s highlights.' : 'No strong highlights found — bloom left off.', 'success');
    },
  });
  d.add(() => autoBloom.destroy());
  d.add(b.onDoc((doc) => autoBloom.setDisabled(!doc)));
  const bloom = createSubgroup(b, d, { title: 'Bloom', paths: BLOOM, actions: [autoBloom.el], id: 'bloom' });
  bloom.body.append(
    paramSlider(b, d, 'effects.bloom', { label: 'Amount', ariaLabel: 'Bloom amount', fill: 'min' }).el,
    paramSlider(b, d, 'effects.bloomThreshold', { label: 'Threshold', ariaLabel: 'Bloom threshold', fill: 'min' }).el,
    paramSlider(b, d, 'effects.bloomRadius', { label: 'Radius', ariaLabel: 'Bloom radius', fill: 'min' }).el,
    h('p', { class: 'k-pnl-note' }, 'Adds a soft highlight glow in linear light. Raise Threshold to protect midtones; Radius controls how far light spreads.'),
  );
  const atmosphere = createSubgroup(b, d, { title: 'Atmosphere', paths: ATMOSPHERE, id: 'atmosphere' });
  atmosphere.body.append(
    paramSlider(b, d, 'effects.glow', { label: 'Glow', fill: 'min' }).el,
    paramSlider(b, d, 'effects.halation', { label: 'Halation', fill: 'min' }).el,
  );
  section.body.append(bloom.el, vig.el, grain.el, atmosphere.el);
  return section;
}

const CAL = [
  'calibration.shadowsTint',
  'calibration.redHue',
  'calibration.redSaturation',
  'calibration.greenHue',
  'calibration.greenSaturation',
  'calibration.blueHue',
  'calibration.blueSaturation',
];

export function createCalibrationSection(_ctx: AppContext, b: DocBinder, d: Disposer): Section {
  const section = paramSection(b, d, { id: 'develop.calibration', title: 'Calibration', paths: CAL, open: false });
  const primary = (name: 'red' | 'green' | 'blue', hue: number): HTMLElement => {
    const cap = name[0].toUpperCase() + name.slice(1);
    const g = createSubgroup(b, d, { title: `${cap} Primary`, paths: [`calibration.${name}Hue`, `calibration.${name}Saturation`], id: `cal-${name}` });
    g.body.append(
      paramSlider(b, d, `calibration.${name}Hue`, { label: 'Hue', ariaLabel: `${cap} primary hue`, gradient: hueGradient(hue - 40, hue + 40, 70, 52) }).el,
      paramSlider(b, d, `calibration.${name}Saturation`, {
        label: 'Saturation',
        ariaLabel: `${cap} primary saturation`,
        gradient: `linear-gradient(90deg, hsl(${hue} 0% 55%), hsl(${hue} 80% 50%))`,
      }).el,
    );
    return g.el;
  };
  const shadows = createSubgroup(b, d, { title: 'Shadows', paths: ['calibration.shadowsTint'], id: 'cal-shadows' });
  shadows.body.append(paramSlider(b, d, 'calibration.shadowsTint', { label: 'Tint', ariaLabel: 'Shadows tint', gradient: tintGradient() }).el);
  section.body.append(shadows.el, primary('red', 0), primary('green', 120), primary('blue', 240));
  return section;
}
