/**
 * LOCAL pass: one invocation per visible mask (PassExtra.mask), source space,
 * display-referred in → display-referred out.
 *
 * Every LocalAdjustments slider is scaled by mask.amount/100 and by the
 * per-pixel coverage (uMask.r), then applied with the same math as the global
 * sliders (so "+1 EV in a mask" means the same as "+1 EV globally"):
 *   noise / sharpness (on the input) → temperature / tint → exposure
 *   → dehaze + highlights / shadows + texture / clarity (tone stage)
 *   → whites / blacks / contrast → saturation → hue-preserving gamut fit.
 * Pixels with zero coverage are returned bit-exact.
 */
import { GLSL_COLOR_LIB } from '../../color/math';
import type { EditParams, LocalAdjustments, Mask } from '../../types';
import type { BlurRequest, PassDef, PassExtra, UniformMap } from '../pass-types';
import {
  BLUR_SIGMAS,
  LOCAL_NOISE_FLAT_HI,
  LOCAL_NOISE_FLAT_LO,
  LOCAL_NOISE_SMOOTH,
  LOCAL_SHARPEN_GAIN,
  LOCAL_SHARPEN_LIMIT,
  LOCAL_WB_SCALE,
  glslFloat as f,
} from './constants';
import { GLSL_COLOR_OPS, GLSL_HEADER, GLSL_TONE_STAGE } from './glsl-common';
import { GUIDE_DISPLAY_PASS } from './guide';
import { GLSL_TONE } from './tone';

const FRAGMENT = /* glsl */ `${GLSL_HEADER}
${GLSL_COLOR_LIB}
${GLSL_TONE}
${GLSL_COLOR_OPS}
${GLSL_TONE_STAGE}

uniform sampler2D uInput;
uniform sampler2D uMask;
uniform sampler2D uLocalGuideS;
uniform sampler2D uLocalGuideM;
uniform sampler2D uLocalGuideL;
uniform sampler2D uDetailBlur;

uniform bool uLocalOn;
uniform float uAmount;       // mask.amount / 100
uniform vec4 uLocTone;       // exposure (EV), contrast, highlights, shadows (−1..1)
uniform vec4 uLocTone2;      // whites, blacks (−1..1), temperature, tint (wbGains units)
uniform vec4 uLocPresence;   // texture, clarity, dehaze, saturation (−1..1)
uniform vec2 uLocDetail;     // sharpness, noise (−1..1)

void main() {
  vec4 src = texture(uInput, vUv);
  if (!uLocalOn) { outColor = src; return; }
  float m = clamp(texture(uMask, vUv).r, 0.0, 1.0) * uAmount;
  if (m <= 1e-5) { outColor = src; return; }

  vec3 c = srgbToLinear(max(src.rgb, vec3(0.0)));

  // Detail: noise smoothing (flat areas only) and unsharp sharpening, on the input.
  float sharp = uLocDetail.x * m;
  float noise = uLocDetail.y * m;
  if (sharp != 0.0 || noise != 0.0) {
    vec3 blurC = srgbToLinear(max(texture(uDetailBlur, vUv).rgb, vec3(0.0)));
    float flatW = 1.0 - smoothstep(${f(LOCAL_NOISE_FLAT_LO)}, ${f(LOCAL_NOISE_FLAT_HI)}, localStd(texture(uLocalGuideS, vUv).xy));
    if (noise > 0.0) c = mix(c, blurC, noise * ${f(LOCAL_NOISE_SMOOTH)} * flatW);
    // Negative noise re-emphasises fine grain in flat areas (mirror of smoothing).
    else if (noise < 0.0) c = max(c + (c - blurC) * (-noise * 0.6 * flatW), vec3(0.0));
    if (sharp > 0.0) {
      // Luminance-only unsharp mask in tone space (no colour fringes), soft-limited against halos.
      float d = toneL(luma(c)) - toneL(luma(blurC));
      c *= exp2(sharp * ${f(LOCAL_SHARPEN_GAIN)} * softLimit(d, ${f(LOCAL_SHARPEN_LIMIT)}));
    } else if (sharp < 0.0) {
      c = mix(c, blurC, -sharp);
    }
  }

  vec2 wb = uLocTone2.zw * m;
  if (wb.x != 0.0 || wb.y != 0.0) c *= wbGains(wb.x, wb.y);

  float ev = uLocTone.x * m;
  if (ev != 0.0) c *= exp2(ev);

  float dehaze = uLocPresence.z * m;
  vec2 hs = uLocTone.zw * m;
  vec4 presence = vec4(uLocPresence.x * m, uLocPresence.y * m, 0.0, 0.0);
  if (dehaze != 0.0 || hs != vec2(0.0) || presence.xy != vec2(0.0)) {
    c = toneStage(c, texture(uLocalGuideS, vUv), texture(uLocalGuideM, vUv), texture(uLocalGuideL, vUv),
                  ev, dehaze, hs, presence);
  }

  vec3 g = vec3(uLocTone2.x, uLocTone2.y, uLocTone.y) * m;
  if (g != vec3(0.0)) {
    float y = luma(c);
    c = relight(c, y, globalToneLinear(y, g.x, g.y, g.z));
  }

  vec3 e = linearToSrgb(c);
  float sat = uLocPresence.w * m;
  if (sat != 0.0) e = scaleChroma(e, encLuma(e), 1.0 + sat);

  outColor = vec4(fitGamut(e, 0.5), src.a);
}
`;

function isAdjustmentsIdentity(a: LocalAdjustments): boolean {
  return (Object.keys(a) as (keyof LocalAdjustments)[]).every((k) => a[k] === 0);
}

/** True when this mask would not change the image. */
export function isMaskIdentity(mask: Mask | undefined): boolean {
  return !mask || !mask.visible || mask.amount === 0 || isAdjustmentsIdentity(mask.adjustments);
}

export interface LocalNeeds {
  small: boolean;
  medium: boolean;
  large: boolean;
  detail: boolean;
}

/**
 * Blurs needed by ANY visible mask (blur sigmas cannot see PassExtra, and the
 * orchestrator shares blurs between the mask invocations of a frame).
 */
export function localNeeds(params: EditParams): LocalNeeds {
  const n: LocalNeeds = { small: false, medium: false, large: false, detail: false };
  for (const mask of params.masks) {
    if (isMaskIdentity(mask)) continue;
    const a = mask.adjustments;
    const tone = a.dehaze !== 0 || a.highlights !== 0 || a.shadows !== 0 || a.texture !== 0 || a.clarity !== 0;
    const detail = a.sharpness !== 0 || a.noise !== 0;
    n.small ||= tone || detail;
    n.medium ||= tone;
    n.large ||= tone;
    n.detail ||= detail;
  }
  return n;
}

const sigmaIf = (need: (n: LocalNeeds) => boolean, sigma: number) => (params: EditParams) =>
  need(localNeeds(params)) ? sigma : BLUR_SIGMAS.collapsed;

export const LOCAL_BLURS: BlurRequest[] = [
  { uniform: 'uLocalGuideS', source: 'uInput', prepass: GUIDE_DISPLAY_PASS, sigma: sigmaIf((n) => n.small, BLUR_SIGMAS.small) },
  { uniform: 'uLocalGuideM', source: 'uInput', prepass: GUIDE_DISPLAY_PASS, sigma: sigmaIf((n) => n.medium, BLUR_SIGMAS.medium) },
  { uniform: 'uLocalGuideL', source: 'uInput', prepass: GUIDE_DISPLAY_PASS, sigma: sigmaIf((n) => n.large, BLUR_SIGMAS.large) },
  { uniform: 'uDetailBlur', source: 'uInput', sigma: sigmaIf((n) => n.detail, BLUR_SIGMAS.detail) },
];

export function localUniforms(extra?: PassExtra): UniformMap {
  const mask = extra?.mask;
  const on = !isMaskIdentity(mask);
  const a = mask?.adjustments;
  const v = (k: keyof LocalAdjustments) => (on && a ? a[k] : 0);
  return {
    uLocalOn: on,
    uAmount: on && mask ? Math.max(0, Math.min(mask.amount, 100)) / 100 : 0,
    uLocTone: [v('exposure'), v('contrast') / 100, v('highlights') / 100, v('shadows') / 100],
    uLocTone2: [v('whites') / 100, v('blacks') / 100, v('temperature') * LOCAL_WB_SCALE, v('tint') * LOCAL_WB_SCALE],
    uLocPresence: [v('texture') / 100, v('clarity') / 100, v('dehaze') / 100, v('saturation') / 100],
    uLocDetail: [v('sharpness') / 100, v('noise') / 100],
  };
}

export const LOCAL_PASS: PassDef = {
  name: 'color.local',
  fragment: FRAGMENT,
  inputs: ['uInput', 'uMask'],
  uniforms: (_params, _ctx, extra) => localUniforms(extra),
  isIdentity: (_params, _ctx, extra) => isMaskIdentity(extra?.mask),
  blurs: LOCAL_BLURS,
  output: 'rgba16f',
};
