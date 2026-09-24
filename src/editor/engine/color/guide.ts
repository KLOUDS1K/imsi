/**
 * Guide prepasses for the blur requests of DEVELOP and LOCAL.
 *
 * Output: vec4(L, L², minRGB, minRGB²)
 *  - L: tone-space log luminance (stops relative to middle grey, with toe).
 *    Blurred L gives the local tone base; blurred L² with it the local
 *    variance (edge / texture detector).
 *  - minRGB (linear, clamped 0..1): the dark channel of the haze model;
 *    its blurred square gives the variance used to refine it at edges.
 * All values are small (|L| < ~7) so RGBA16F storage is sufficient.
 */
import { GLSL_COLOR_LIB } from '../../color/math';
import type { PassDef } from '../pass-types';
import { GLSL_HEADER } from './glsl-common';
import { GLSL_TONE } from './tone';

const guideFragment = (decode: boolean) => /* glsl */ `${GLSL_HEADER}
${GLSL_COLOR_LIB}
${GLSL_TONE}
uniform sampler2D uInput;
void main() {
  vec3 c = texture(uInput, vUv).rgb;
  ${decode ? 'c = srgbToLinear(max(c, vec3(0.0)));' : ''}
  float L = toneL(luma(c));
  float m = clamp(min(c.r, min(c.g, c.b)), 0.0, 1.0);
  outColor = vec4(L, L * L, m, m * m);
}
`;

/** Guide of a LINEAR image (DEVELOP: the PRE output). */
export const GUIDE_LINEAR_PASS: PassDef = {
  name: 'color.guide.linear',
  fragment: guideFragment(false),
  inputs: ['uInput'],
  uniforms: () => ({}),
  output: 'rgba16f',
};

/** Guide of a display-referred (sRGB-encoded) image (LOCAL: the developed image). */
export const GUIDE_DISPLAY_PASS: PassDef = {
  name: 'color.guide.display',
  fragment: guideFragment(true),
  inputs: ['uInput'],
  uniforms: () => ({}),
  output: 'rgba16f',
};
