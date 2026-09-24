/**
 * PRE pass (source space, linear in → linear out, unclamped):
 *   1. camera calibration — primaries matrix (built on the CPU) + shadows tint
 *   2. white balance      — wbGains(temperature, tint) from color/math
 *   3. exposure           — × 2^EV
 *   4. lens vignetting    — ÷ (1 + v1 r² + v2 r⁴ + v3 r⁶) from ctx.lens, plus
 *                           the manual vignetting slider (positive brightens
 *                           the corners, midpoint = where the falloff starts).
 * r is normalized so the half-diagonal is 1, measured in pixels (aspect-correct).
 */
import { GLSL_COLOR_LIB } from '../../color/math';
import type { EditParams } from '../../types';
import type { PassContext, PassDef, UniformMap } from '../pass-types';
import { calibrationMatrix, isCalibrationIdentity, shadowTintStops } from './calibration';
import { LENS_VIG_EV, LENS_VIG_MID_MAX, glslFloat as f } from './constants';
import { GLSL_HEADER } from './glsl-common';

const FRAGMENT = /* glsl */ `${GLSL_HEADER}
${GLSL_COLOR_LIB}
uniform sampler2D uInput;

uniform bool uCalOn;
uniform vec3 uCalR;          // rows of the calibration matrix
uniform vec3 uCalG;
uniform vec3 uCalB;
uniform float uShadowTint;   // stops of green removed at black (positive = magenta)
uniform bool uWbOn;
uniform float uTemperature;  // ±100
uniform float uTint;         // ±100
uniform float uExposure;     // EV
uniform bool uLensOn;
uniform vec3 uLensV;         // profile vignetting polynomial v1, v2, v3
uniform vec2 uLensAspect;    // (W, H) / diagonal → r = 1 at the corners
uniform vec2 uManualVig;     // amount −1..1, falloff start radius

void main() {
  vec4 src = texture(uInput, vUv);
  vec3 c = src.rgb;

  if (uCalOn) {
    c = vec3(dot(uCalR, c), dot(uCalG, c), dot(uCalB, c));
    if (uShadowTint != 0.0) {
      // Green ↔ magenta, weighted to the shadows on perceptual luminance and
      // renormalized so the luminance is unchanged.
      float p = linearToSrgb1(clamp(luma(c), 0.0, 1.0));
      float w = 1.0 - smoothstep(0.0, 0.55, p);
      vec3 k = vec3(1.0, exp2(-uShadowTint * w), 1.0);
      c *= k / dot(k, LUMA709);
    }
  }

  if (uWbOn) c *= wbGains(uTemperature, uTint);

  if (uExposure != 0.0) c *= exp2(uExposure);

  if (uLensOn) {
    vec2 d = (vUv * 2.0 - 1.0) * uLensAspect;
    float r2 = dot(d, d);
    float g = 1.0 + r2 * (uLensV.x + r2 * (uLensV.y + r2 * uLensV.z));
    c /= max(g, 0.05);
    if (uManualVig.x != 0.0) {
      // Quadratic ramp from the start radius to the corner, C1 at the start.
      float t = clamp((sqrt(r2) - uManualVig.y) / max(1.0 - uManualVig.y, 1e-3), 0.0, 1.0);
      c *= exp2(uManualVig.x * ${f(LENS_VIG_EV)} * t * t);
    }
  }

  outColor = vec4(c, src.a);
}
`;

function lensTerms(ctx: PassContext): [number, number, number] {
  const l = ctx.lens;
  return l ? [l.v1 || 0, l.v2 || 0, l.v3 || 0] : [0, 0, 0];
}

function lensActive(params: EditParams, ctx: PassContext): boolean {
  const [v1, v2, v3] = lensTerms(ctx);
  return v1 !== 0 || v2 !== 0 || v3 !== 0 || params.lens.vignetting !== 0;
}

export function preUniforms(params: EditParams, ctx: PassContext): UniformMap {
  const cal = params.calibration;
  const calOn = !isCalibrationIdentity(cal);
  const m = calOn ? calibrationMatrix(cal) : [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const wb = params.whiteBalance;
  const w = Math.max(ctx.srcWidth || ctx.width || 1, 1);
  const h = Math.max(ctx.srcHeight || ctx.height || 1, 1);
  const diag = Math.hypot(w, h);
  return {
    uCalOn: calOn,
    uCalR: m.slice(0, 3),
    uCalG: m.slice(3, 6),
    uCalB: m.slice(6, 9),
    uShadowTint: shadowTintStops(cal),
    uWbOn: wb.temperature !== 0 || wb.tint !== 0,
    uTemperature: wb.temperature,
    uTint: wb.tint,
    uExposure: params.basic.exposure,
    uLensOn: lensActive(params, ctx),
    uLensV: lensTerms(ctx),
    uLensAspect: [w / diag, h / diag],
    uManualVig: [params.lens.vignetting / 100, LENS_VIG_MID_MAX * (params.lens.vignettingMidpoint / 100)],
  };
}

export function isPreIdentity(params: EditParams, ctx: PassContext): boolean {
  return (
    isCalibrationIdentity(params.calibration) &&
    params.whiteBalance.temperature === 0 &&
    params.whiteBalance.tint === 0 &&
    params.basic.exposure === 0 &&
    !lensActive(params, ctx)
  );
}

export const PRE_PASS: PassDef = {
  name: 'color.pre',
  fragment: FRAGMENT,
  inputs: ['uInput'],
  uniforms: (params, ctx) => preUniforms(params, ctx),
  isIdentity: (params, ctx) => isPreIdentity(params, ctx),
  output: 'rgba16f',
};
