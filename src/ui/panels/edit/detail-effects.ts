/**
 * Detail (sharpening, noise reduction, AI denoise), Effects (post-crop
 * vignette, grain, bloom / glow / halation) and Calibration sections.
 */
import type { AppContext } from '@/app/context';
import { Disposer, h } from '@/ui/dom';
import { createBadge, hueGradient, tintGradient, type Section } from '@/ui/kit';
import { type DocBinder, paramSection, paramSlider, paramToggle } from '../binding';
import { createSubgroup } from '../subgroup';

const SHARPEN = ['detail.sharpenAmount', 'detail.sharpenRadius', 'detail.sharpenDetail', 'detail.sharpenMasking'];
const NR = ['noise.luminance', 'noise.luminanceDetail', 'noise.luminanceContrast', 'noise.color', 'noise.colorDetail', 'noise.colorSmoothness'];
const AI_NR = ['noise.aiDenoise', 'noise.aiDenoiseStrength', 'noise.detailPreservation'];

export function createDetailSection(_ctx: AppContext, b: DocBinder, d: Disposer): Section {
  const section = paramSection(b, d, { id: 'develop.detail', title: 'Detail', paths: [...SHARPEN, ...NR, ...AI_NR], open: false });

  const sharpen = createSubgroup(b, d, { title: 'Sharpening', paths: SHARPEN, id: 'sharpen' });
  sharpen.body.append(
    paramSlider(b, d, 'detail.sharpenAmount', { label: 'Amount', fill: 'min' }).el,
    paramSlider(b, d, 'detail.sharpenRadius', { label: 'Radius', decimals: 1, fill: 'min' }).el,
    paramSlider(b, d, 'detail.sharpenDetail', { label: 'Detail', fill: 'min' }).el,
    paramSlider(b, d, 'detail.sharpenMasking', { label: 'Masking', fill: 'min' }).el,
  );

  const nr = createSubgroup(b, d, { title: 'Noise Reduction', paths: NR, id: 'nr' });
  nr.body.append(
    paramSlider(b, d, 'noise.luminance', { label: 'Luminance', fill: 'min' }).el,
    paramSlider(b, d, 'noise.luminanceDetail', { label: 'Detail', ariaLabel: 'Luminance detail', fill: 'min' }).el,
    paramSlider(b, d, 'noise.luminanceContrast', { label: 'Contrast', ariaLabel: 'Luminance contrast', fill: 'min' }).el,
    paramSlider(b, d, 'noise.color', { label: 'Color', fill: 'min' }).el,
    paramSlider(b, d, 'noise.colorDetail', { label: 'Detail', ariaLabel: 'Color detail', fill: 'min' }).el,
    paramSlider(b, d, 'noise.colorSmoothness', { label: 'Smoothness', ariaLabel: 'Color smoothness', fill: 'min' }).el,
  );

  const badge = createBadge('On-device', { tone: 'outline', title: 'Runs locally in your browser (edge-aware non-local-means filter, no cloud model)' });
  d.add(() => badge.destroy());
  const ai = createSubgroup(b, d, { title: 'AI Denoise', paths: AI_NR, actions: [badge.el], id: 'ai-denoise' });
  const strength = paramSlider(b, d, 'noise.aiDenoiseStrength', { label: 'Strength', fill: 'min' });
  const keep = paramSlider(b, d, 'noise.detailPreservation', { label: 'Keep Detail', ariaLabel: 'Detail preservation', fill: 'min' });
  ai.body.append(
    paramToggle(b, d, 'noise.aiDenoise', 'Enable AI Denoise', (on) => `AI Denoise ${on ? 'On' : 'Off'}`).el,
    strength.el,
    keep.el,
    h('p', { class: 'k-pnl-note' }, 'Classical edge-aware denoiser that runs on this device. Heavier than Noise Reduction; skipped while dragging.'),
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
const GLOW = ['effects.bloom', 'effects.glow', 'effects.halation'];

export function createEffectsSection(_ctx: AppContext, b: DocBinder, d: Disposer): Section {
  const section = paramSection(b, d, { id: 'develop.effects', title: 'Effects', paths: [...VIGNETTE, ...GRAIN, ...GLOW], open: false });
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
  const glow = createSubgroup(b, d, { title: 'Light', paths: GLOW, id: 'glow' });
  glow.body.append(
    paramSlider(b, d, 'effects.bloom', { label: 'Bloom', fill: 'min' }).el,
    paramSlider(b, d, 'effects.glow', { label: 'Glow', fill: 'min' }).el,
    paramSlider(b, d, 'effects.halation', { label: 'Halation', fill: 'min' }).el,
  );
  section.body.append(vig.el, grain.el, glow.el);
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
