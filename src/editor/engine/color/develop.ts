/**
 * DEVELOP pass (source space): linear PRE output → display-referred,
 * sRGB-encoded float.
 *
 * Order (linear light first, then display-referred):
 *   defringe → dehaze → highlights/shadows + presence (local, tone space)
 *   → whites / blacks / contrast (perceptual luminance curves)
 *   → sRGB encode → tone curve LUT → HSL mixer → color grading
 *   → vibrance → saturation → hue-preserving gamut fit.
 *
 * Defringe runs first (Lightroom does it with the lens corrections): fringes
 * are an optical artefact and are easiest to find before saturation or
 * clarity amplify them. Its hue ranges are measured on the sRGB-encoded
 * colour, i.e. what the user sees with the eyedropper.
 *
 * With default params every stage is switched off by uniform flags, so the
 * pass reduces to out = linearToSrgb(in) exactly. It still has to run (it is
 * the linear → display conversion), so isIdentity() is always false; unused
 * blur requests collapse to a tiny shared blur (see BLUR_SIGMAS.collapsed).
 */
import { GLSL_COLOR_LIB } from '../../color/math';
import type { EditParams } from '../../types';
import type { BlurRequest, PassDef, UniformMap } from '../pass-types';
import {
  BLUR_SIGMAS,
  CONTRAST_SAT,
  FRINGE_CHROMA_HI,
  FRINGE_CHROMA_LO,
  FRINGE_EDGE_HI,
  FRINGE_EDGE_LO,
  FRINGE_FEATHER,
  HSL_LUM_CHROMA,
  HSL_LUM_DARKEN,
  HSL_LUM_LIFT,
  SKIN_FEATHER,
  SKIN_HUE_HI,
  SKIN_HUE_LO,
  SKIN_PROTECT,
  VIBRANCE_GAIN,
  glslFloat as f,
} from './constants';
import { GLSL_COLOR_OPS, GLSL_HEADER, GLSL_TONE_STAGE } from './glsl-common';
import { GLSL_GRADE, gradingUniforms, isGradingIdentity } from './grading';
import { FRINGE_SOURCE_PASS, GUIDE_LINEAR_PASS } from './guide';
import { GLSL_HSL, hslUniforms, isHslIdentity } from './hsl';
import { isCurveIdentity } from './lut';
import { GLSL_TONE } from './tone';

const FRAGMENT = /* glsl */ `${GLSL_HEADER}
${GLSL_COLOR_LIB}
${GLSL_TONE}
${GLSL_COLOR_OPS}
${GLSL_TONE_STAGE}
${GLSL_HSL}
${GLSL_GRADE}

uniform sampler2D uInput;
uniform sampler2D uCurveLut;
uniform sampler2D uGuideS;
uniform sampler2D uGuideM;
uniform sampler2D uGuideL;
uniform sampler2D uFringeBlur;

uniform bool uDefringeOn;
uniform vec3 uFringePurple;   // strength 0..1, hue min, hue max (deg)
uniform vec3 uFringeGreen;
uniform bool uToneOn;         // any of dehaze / highlights / shadows / presence
uniform float uDehaze;        // −1..1
uniform vec2 uHighShadow;     // highlights, shadows −1..1
uniform vec4 uPresence;       // texture, clarity, structure, local contrast −1..1
uniform vec3 uGlobalTone;     // whites, blacks, contrast −1..1
uniform bool uCurveOn;
uniform bool uHslOn;
uniform vec4 uHslHueA;        // degrees: red orange yellow green
uniform vec4 uHslHueB;        //          aqua blue purple magenta
uniform vec4 uHslSatA;        // −1..1
uniform vec4 uHslSatB;
uniform vec4 uHslLumA;        // −1..1
uniform vec4 uHslLumB;
uniform bool uGradeOn;
uniform vec2 uVibSat;         // vibrance −1..1, saturation (incl. contrast coupling) −1..1

vec3 defringe(vec3 c) {
  vec3 e = linearToSrgb(clamp(c, 0.0, 1.0));
  float chroma = maxc(e) - minc(e);
  float stdS = localStd(texture(uGuideS, vUv).xy);
  float gate = smoothstep(${f(FRINGE_CHROMA_LO)}, ${f(FRINGE_CHROMA_HI)}, chroma)
             * smoothstep(${f(FRINGE_EDGE_LO)}, ${f(FRINGE_EDGE_HI)}, stdS);
  if (gate <= 0.0) return c;
  float h = rgb2hsv(e).x * 360.0;
  float kp = uFringePurple.x * hueArc(h, uFringePurple.y, uFringePurple.z, ${f(FRINGE_FEATHER)});
  float kg = uFringeGreen.x * hueArc(h, uFringeGreen.y, uFringeGreen.z, ${f(FRINGE_FEATHER)});
  float k = clamp(1.0 - (1.0 - kp) * (1.0 - kg), 0.0, 1.0) * gate;
  if (k <= 0.0) return c;
  // Replacement: the neighbourhood's chromaticity at the pixel's own
  // luminance; if the neighbourhood itself is fringe-coloured, its chroma is
  // dropped too (→ neutral), so wide fringes are desaturated, not smeared.
  vec3 nb = max(texture(uFringeBlur, vUv).rgb, vec3(0.0));
  float yn = luma(nb);
  float hn = rgb2hsv(linearToSrgb(clamp(nb, 0.0, 1.0))).x * 360.0;
  float fn = max(
    step(1e-4, uFringePurple.x) * hueArc(hn, uFringePurple.y, uFringePurple.z, ${f(FRINGE_FEATHER)}),
    step(1e-4, uFringeGreen.x) * hueArc(hn, uFringeGreen.y, uFringeGreen.z, ${f(FRINGE_FEATHER)}));
  vec3 chromN = yn > 1e-6 ? nb / yn : vec3(1.0);
  chromN = mix(chromN, vec3(1.0), fn);
  return mix(c, chromN * luma(c), k);
}

// Tone curve LUT: 1024×1 RGBA float, texel i ↔ x = i / (n − 1). Manual
// linear interpolation between texel centres (independent of the texture's
// filter mode — float textures are not always filterable). Values above 1
// continue with the curve's end slope so HDR headroom is not cut off here.
vec4 lutAt(float x) {
  int n = textureSize(uCurveLut, 0).x;
  float pos = clamp(x, 0.0, 1.0) * float(n - 1);
  int i0 = min(int(pos), n - 2);
  return mix(texelFetch(uCurveLut, ivec2(i0, 0), 0), texelFetch(uCurveLut, ivec2(i0 + 1, 0), 0), pos - float(i0));
}

vec3 applyCurve(vec3 e) {
  vec3 o = vec3(lutAt(e.r).r, lutAt(e.g).g, lutAt(e.b).b);
  if (maxc(e) > 1.0) {
    int n = textureSize(uCurveLut, 0).x;
    vec3 slope = (texelFetch(uCurveLut, ivec2(n - 1, 0), 0).rgb - texelFetch(uCurveLut, ivec2(n - 2, 0), 0).rgb) * float(n - 1);
    o += max(e - 1.0, vec3(0.0)) * clamp(slope, 0.0, 4.0);
  }
  return o;
}

vec3 applyHsl(vec3 e) {
  vec3 hsv = rgb2hsv(max(e, vec3(0.0)));
  vec4 wa;
  vec4 wb;
  hslWeights(hsv.x * 360.0, wa, wb);
  float dh = dot(wa, uHslHueA) + dot(wb, uHslHueB);
  float ds = dot(wa, uHslSatA) + dot(wb, uHslSatB);
  float dl = dot(wa, uHslLumA) + dot(wb, uHslLumB);
  if (dh != 0.0) e = hsv2rgb(vec3(fract(hsv.x + dh / 360.0), hsv.y, hsv.z));
  if (ds != 0.0) e = scaleChroma(e, encLuma(e), 1.0 + ds);
  if (dl != 0.0) {
    // Scaled by chroma so greys (and near-greys) are untouched. Lifts move
    // the encoded luminance towards white (never past it), darkening scales
    // it; the colour is re-lit in linear light and any channel pushed past 1
    // is desaturated with the luminance kept (bright colours turn pastel).
    float k = dl * smoothstep(0.0, ${f(HSL_LUM_CHROMA)}, maxc(e) - minc(e));
    float p = encLuma(e);
    float p2 = k > 0.0 ? p + max(1.0 - p, 0.0) * k * ${f(HSL_LUM_LIFT)} : p * (1.0 + k * ${f(HSL_LUM_DARKEN)});
    float y = srgbToLinear1(p);
    vec3 lin = srgbToLinear(max(e, vec3(0.0)));
    if (y > 1e-7) e = fitGamut(linearToSrgb(lin * (srgbToLinear1(max(p2, 0.0)) / y)), 1.0);
  }
  return e;
}

vec3 applyVibSat(vec3 e, float vib, float sat) {
  float ye = encLuma(e);
  if (vib != 0.0) {
    vec3 hsv = rgb2hsv(clamp(e, 0.0, 1.0));
    float s = hsv.y;
    float fac;
    if (vib > 0.0) {
      // Mostly boosts muted colours; skin hues keep only part of the boost.
      float skin = hueArc(hsv.x * 360.0, ${f(SKIN_HUE_LO)}, ${f(SKIN_HUE_HI)}, ${f(SKIN_FEATHER)});
      fac = 1.0 + vib * ${f(VIBRANCE_GAIN)} * (1.0 - s) * (1.0 - s) * (1.0 - ${f(SKIN_PROTECT)} * skin);
    } else {
      fac = 1.0 + vib * (1.0 - 0.5 * s);
    }
    e = scaleChroma(e, ye, fac);
  }
  if (sat != 0.0) e = scaleChroma(e, vib != 0.0 ? encLuma(e) : ye, 1.0 + sat);
  return e;
}

void main() {
  vec4 src = texture(uInput, vUv);
  vec3 c = src.rgb;

  if (uDefringeOn) c = defringe(c);

  if (uToneOn) {
    c = toneStage(c, texture(uGuideS, vUv), texture(uGuideM, vUv), texture(uGuideL, vUv),
                  0.0, uDehaze, uHighShadow, uPresence);
  }

  if (any(notEqual(uGlobalTone, vec3(0.0)))) {
    float y = luma(c);
    c = relight(c, y, globalToneLinear(y, uGlobalTone.x, uGlobalTone.y, uGlobalTone.z));
  }

  vec3 e = linearToSrgb(fitFloorLinear(c));
  if (uCurveOn) e = applyCurve(e);
  if (uHslOn) e = applyHsl(e);
  if (uGradeOn) e = applyGrade(e);
  if (uVibSat.x != 0.0 || uVibSat.y != 0.0) e = applyVibSat(e, uVibSat.x, uVibSat.y);

  outColor = vec4(fitGamut(e, 0.5), src.a);
}
`;

export interface DevelopNeeds {
  /** Fine guide blur (texture, structure, clarity, defringe edge test). */
  small: boolean;
  /** Medium guide blur (tone base, clarity, structure, dehaze). */
  medium: boolean;
  /** Large guide blur (tone base for highlights/shadows and local contrast). */
  large: boolean;
  /** Full-colour neighbourhood for defringe. */
  fringe: boolean;
}

export function isDefringeActive(params: EditParams): boolean {
  const d = params.lens.defringe;
  return d.purpleAmount > 0 || d.greenAmount > 0;
}

/** Which blurs the current params actually read. */
export function developNeeds(params: EditParams): DevelopNeeds {
  const p = params.presence;
  const b = params.basic;
  const dehaze = p.dehaze !== 0;
  const hs = b.highlights !== 0 || b.shadows !== 0;
  const defringe = isDefringeActive(params);
  const tone = dehaze || hs || p.texture !== 0 || p.clarity !== 0 || p.structure !== 0 || p.localContrast !== 0;
  return {
    small: tone || defringe,
    medium: tone,
    large: tone,
    fringe: defringe,
  };
}

const sigmaIf = (need: (n: DevelopNeeds) => boolean, sigma: number) => (params: EditParams) =>
  need(developNeeds(params)) ? sigma : BLUR_SIGMAS.collapsed;

export const DEVELOP_BLURS: BlurRequest[] = [
  { uniform: 'uGuideS', source: 'uInput', prepass: GUIDE_LINEAR_PASS, sigma: sigmaIf((n) => n.small, BLUR_SIGMAS.small) },
  { uniform: 'uGuideM', source: 'uInput', prepass: GUIDE_LINEAR_PASS, sigma: sigmaIf((n) => n.medium, BLUR_SIGMAS.medium) },
  { uniform: 'uGuideL', source: 'uInput', prepass: GUIDE_LINEAR_PASS, sigma: sigmaIf((n) => n.large, BLUR_SIGMAS.large) },
  { uniform: 'uFringeBlur', source: 'uInput', prepass: FRINGE_SOURCE_PASS, sigma: sigmaIf((n) => n.fringe, BLUR_SIGMAS.fringe) },
];

export function developUniforms(params: EditParams): UniformMap {
  const b = params.basic;
  const p = params.presence;
  const d = params.lens.defringe;
  const n = developNeeds(params);
  const contrast = b.contrast / 100;
  // Lightroom's contrast also adds a little colour; fold it into saturation.
  const sat = (1 + params.color.saturation / 100) * (1 + CONTRAST_SAT * contrast) - 1;
  return {
    uDefringeOn: n.fringe,
    uFringePurple: [d.purpleAmount / 20, d.purpleHueMin, d.purpleHueMax],
    uFringeGreen: [d.greenAmount / 20, d.greenHueMin, d.greenHueMax],
    uToneOn: n.medium,
    uDehaze: p.dehaze / 100,
    uHighShadow: [b.highlights / 100, b.shadows / 100],
    uPresence: [p.texture / 100, p.clarity / 100, p.structure / 100, p.localContrast / 100],
    uGlobalTone: [b.whites / 100, b.blacks / 100, contrast],
    uCurveOn: !isCurveIdentity(params),
    uHslOn: !isHslIdentity(params),
    ...hslUniforms(params),
    uGradeOn: !isGradingIdentity(params.colorGrading),
    ...gradingUniforms(params.colorGrading),
    uVibSat: [params.color.vibrance / 100, Math.abs(sat) < 1e-9 ? 0 : sat],
  };
}

export const DEVELOP_PASS: PassDef = {
  name: 'color.develop',
  fragment: FRAGMENT,
  inputs: ['uInput', 'uCurveLut'],
  uniforms: (params) => developUniforms(params),
  // Always runs: it is the linear → display-referred conversion.
  isIdentity: () => false,
  blurs: DEVELOP_BLURS,
  output: 'rgba16f',
};
