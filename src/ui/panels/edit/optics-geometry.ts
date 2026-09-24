/**
 * Optics (lens profile, chromatic aberration, defringe, manual lens) and
 * Geometry (Upright + manual transform) sections.
 */
import type { AppContext } from '@/app/context';
import { detectLevelAngle, detectPerspective } from '@/editor/analysis';
import type { LensProfile } from '@/editor/contracts';
import { detectLensProfile, getLensProfile, LENS_PROFILES } from '@/editor/lens';
import type { UprightMode } from '@/editor/types';
import { Disposer, h } from '@/ui/dom';
import { clamp, createBadge, createSegmentedControl, createSelect, hueGradient, type ChoiceOption, type Section, type SelectGroup } from '@/ui/kit';
import { type DocBinder, paramRange, paramSection, paramSlider, paramToggle } from '../binding';
import { createSubgroup } from '../subgroup';
import { guarded } from '../util';

const PROFILE = ['lens.profileEnabled', 'lens.profileId', 'lens.profileDistortionScale', 'lens.profileVignettingScale'];
const CA = ['lens.removeCA'];
const DEFRINGE = ['lens.defringe'];
const MANUAL = ['lens.distortion', 'lens.vignetting', 'lens.vignettingMidpoint'];
const AUTO = '__auto__';

function profileName(p: LensProfile): string {
  return `${p.make} ${p.model}`.trim();
}

export function createOpticsSection(ctx: AppContext, b: DocBinder, d: Disposer): Section {
  const section = paramSection(b, d, { id: 'develop.optics', title: 'Optics', paths: [...PROFILE, ...CA, ...DEFRINGE, ...MANUAL], open: false });

  /* ---- lens profile ---- */
  const approx = createBadge('Approximate', { tone: 'outline', title: 'Coefficients are approximations, not measured calibration data' });
  d.add(() => approx.destroy());
  const detected = h('p', { class: 'k-pnl-note k-pnl-note--tight' });

  const byMake = new Map<string, ChoiceOption<string>[]>();
  for (const p of LENS_PROFILES) {
    const list = byMake.get(p.make) ?? [];
    list.push({ value: p.id, label: p.model });
    byMake.set(p.make, list);
  }
  const autoOpt: ChoiceOption<string> = { value: AUTO, label: 'Auto (from metadata)' };
  const options: (ChoiceOption<string> | SelectGroup<string>)[] = [autoOpt, ...[...byMake].map(([group, opts]) => ({ group, options: opts }))];
  const select = createSelect<string>({
    ariaLabel: 'Lens profile',
    size: 'sm',
    block: true,
    value: AUTO,
    options,
    onChange: (v) => b.store?.set('lens.profileId', v === AUTO ? null : v, { label: v === AUTO ? 'Lens Profile: Auto' : `Lens Profile: ${profileName(getLensProfile(v) ?? { make: '', model: v } as LensProfile)}`, coalesceKey: null }),
  });
  d.add(() => select.destroy());

  const profile = createSubgroup(b, d, { title: 'Lens Profile', paths: PROFILE, actions: [approx.el], id: 'profile' });
  const distScale = paramSlider(b, d, 'lens.profileDistortionScale', { label: 'Distortion', ariaLabel: 'Profile distortion scale', fill: 'min' });
  const vigScale = paramSlider(b, d, 'lens.profileVignettingScale', { label: 'Vignetting', ariaLabel: 'Profile vignetting scale', fill: 'min' });
  profile.body.append(
    paramToggle(b, d, 'lens.profileEnabled', 'Enable Profile Corrections', (on) => `Profile Corrections ${on ? 'On' : 'Off'}`).el,
    select.el,
    detected,
    distScale.el,
    vigScale.el,
  );

  d.add(
    b.watch(['lens.profileEnabled', 'lens.profileId'], (p) => {
      const doc = b.doc;
      select.setDisabled(!p);
      if (!p || !doc) {
        approx.el.hidden = true;
        detected.textContent = '';
        return;
      }
      const auto = safeDetect(doc.meta);
      autoOpt.label = auto ? `Auto: ${profileName(auto)}` : 'Auto (no match)';
      select.setOptions(options);
      select.setValue(p.lens.profileId ?? AUTO, true);
      const active = p.lens.profileId ? getLensProfile(p.lens.profileId) : auto;
      approx.el.hidden = !active?.approximate;
      detected.textContent = active
        ? `${p.lens.profileId ? 'Selected' : 'Detected'}: ${profileName(active)}${doc.meta.lens ? ` · ${doc.meta.lens}` : ''}`
        : doc.meta.lens
          ? `No profile for “${doc.meta.lens}”. Choose one manually.`
          : 'No lens information in this photo.';
      profile.body.classList.toggle('is-off', !p.lens.profileEnabled);
    }),
  );

  /* ---- chromatic aberration + defringe ---- */
  const ca = createSubgroup(b, d, { title: 'Chromatic Aberration', paths: [...CA, ...DEFRINGE], id: 'ca' });
  ca.body.append(
    paramToggle(b, d, 'lens.removeCA', 'Remove Chromatic Aberration', (on) => `Remove CA ${on ? 'On' : 'Off'}`).el,
    h('div', { class: 'k-pnl-sub__minor' }, 'Defringe'),
    paramSlider(b, d, 'lens.defringe.purpleAmount', { label: 'Purple', ariaLabel: 'Purple amount', fill: 'min' }).el,
    paramRange(b, d, ['lens.defringe.purpleHueMin', 'lens.defringe.purpleHueMax'], {
      label: 'Purple Hue',
      min: 0,
      max: 360,
      step: 1,
      minGap: 10,
      defaultValue: [270, 330],
      gradient: hueGradient(0, 360, 70, 55),
      format: (v) => `${Math.round(v)}°`,
    }).el,
    paramSlider(b, d, 'lens.defringe.greenAmount', { label: 'Green', ariaLabel: 'Green amount', fill: 'min' }).el,
    paramRange(b, d, ['lens.defringe.greenHueMin', 'lens.defringe.greenHueMax'], {
      label: 'Green Hue',
      min: 0,
      max: 360,
      step: 1,
      minGap: 10,
      defaultValue: [80, 160],
      gradient: hueGradient(0, 360, 70, 55),
      format: (v) => `${Math.round(v)}°`,
    }).el,
  );

  /* ---- manual ---- */
  const manual = createSubgroup(b, d, { title: 'Manual', paths: MANUAL, id: 'manual' });
  manual.body.append(
    paramSlider(b, d, 'lens.distortion', { label: 'Distortion' }).el,
    paramSlider(b, d, 'lens.vignetting', { label: 'Vignetting' }).el,
    paramSlider(b, d, 'lens.vignettingMidpoint', { label: 'Midpoint', ariaLabel: 'Vignetting midpoint' }).el,
  );

  section.body.append(profile.el, ca.el, manual.el);
  void ctx;
  return section;
}

function safeDetect(meta: Parameters<typeof detectLensProfile>[0]): LensProfile | null {
  try {
    return detectLensProfile(meta);
  } catch (e) {
    console.error('[panels] detectLensProfile failed', e);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Geometry                                                             */
/* ------------------------------------------------------------------ */

const TRANSFORM = ['transform'];
const UPRIGHT_LABEL: Record<UprightMode, string> = { off: 'Off', auto: 'Auto', level: 'Level', vertical: 'Vertical', full: 'Full' };

/** Run Upright analysis on the analysis proxy and write the transform in ONE history step. */
export function applyUpright(ctx: AppContext, mode: UprightMode): void {
  const doc = ctx.doc.value;
  if (!doc) return;
  void guarded(ctx.toast.bind(ctx), `Upright ${UPRIGHT_LABEL[mode]}`, () => {
    let t = { vertical: 0, horizontal: 0, rotate: 0 };
    let confidence = 1;
    if (mode === 'level') {
      const r = detectLevelAngle(doc.analysisProxy);
      t = { vertical: 0, horizontal: 0, rotate: clamp(r.angle, -10, 10) };
      confidence = r.confidence;
    } else if (mode !== 'off') {
      const r = detectPerspective(doc.analysisProxy, mode);
      t = { vertical: clamp(r.vertical, -100, 100), horizontal: clamp(r.horizontal, -100, 100), rotate: clamp(r.rotate, -10, 10) };
      confidence = r.confidence;
    }
    doc.store.update(
      `Upright: ${UPRIGHT_LABEL[mode]}`,
      (p) => {
        p.transform.upright = mode;
        p.transform.vertical = Math.round(t.vertical);
        p.transform.horizontal = Math.round(t.horizontal);
        p.transform.rotate = Math.round(t.rotate * 100) / 100;
      },
      { coalesceKey: null },
    );
    if (mode !== 'off' && confidence < 0.25) ctx.toast('Few straight lines found — Upright result may be weak', 'info');
  });
}

export function createGeometrySection(ctx: AppContext, b: DocBinder, d: Disposer): Section {
  const section = paramSection(b, d, { id: 'develop.geometry', title: 'Geometry', paths: TRANSFORM, open: false });
  const upright = createSegmentedControl<UprightMode>({
    ariaLabel: 'Upright',
    size: 'sm',
    block: true,
    value: 'off',
    options: (['off', 'auto', 'level', 'vertical', 'full'] as UprightMode[]).map((m) => ({ value: m, label: UPRIGHT_LABEL[m], title: `Upright ${UPRIGHT_LABEL[m]}` })),
    onChange: (m) => applyUpright(ctx, m),
  });
  d.add(() => upright.destroy());
  d.add(
    b.watch(['transform.upright'], (p) => {
      upright.setDisabled(!p);
      if (p) upright.setValue(p.transform.upright, true);
    }),
  );
  const up = createSubgroup(b, d, { title: 'Upright', paths: ['transform.upright', 'transform.vertical', 'transform.horizontal', 'transform.rotate'], id: 'upright' });
  up.body.append(upright.el);
  const manual = createSubgroup(b, d, { title: 'Transform', paths: ['transform.vertical', 'transform.horizontal', 'transform.rotate', 'transform.aspect', 'transform.scale', 'transform.offsetX', 'transform.offsetY'], id: 'transform' });
  manual.body.append(
    paramSlider(b, d, 'transform.vertical', { label: 'Vertical' }).el,
    paramSlider(b, d, 'transform.horizontal', { label: 'Horizontal' }).el,
    paramSlider(b, d, 'transform.rotate', { label: 'Rotate', decimals: 1 }).el,
    paramSlider(b, d, 'transform.aspect', { label: 'Aspect' }).el,
    paramSlider(b, d, 'transform.scale', { label: 'Scale' }).el,
    paramSlider(b, d, 'transform.offsetX', { label: 'Offset X', decimals: 1 }).el,
    paramSlider(b, d, 'transform.offsetY', { label: 'Offset Y', decimals: 1 }).el,
  );
  section.body.append(up.el, manual.el);
  return section;
}
