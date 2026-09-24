/**
 * engine/color — develop-stage colour math as GPU passes (see pass-types.ts).
 *
 * Stage order in the pipeline (ARCHITECTURE.md):
 *   PRE_PASS (linear → linear) → blur pyramid → DEVELOP_PASS (linear →
 *   display-referred sRGB) → … detail … → LOCAL_PASS once per visible mask.
 *
 * Orchestrator notes
 * - DEVELOP_PASS needs `uCurveLut` = buildDevelopCurveLut(params) (RGBA32F,
 *   CURVE_LUT_SIZE × 1); cache the upload by curveLutKey(params). It is read
 *   with texelFetch only, so any filter mode works.
 * - DEVELOP_PASS.isIdentity() is always false: it performs the linear → sRGB
 *   encoding. With default params it is exactly `linearToSrgb(in)`.
 * - Blur sigmas are functions of params: a blur that the current settings do
 *   not read returns BLUR_SIGMAS.collapsed (a tiny radius shared by all such
 *   requests), so neutral settings cost almost nothing.
 * - Guide prepasses output vec4(L, L², min, min²) with negative L — they need a
 *   float render target (RGBA16F). Every blur request has a uniquely named
 *   prepass, so the (source, prepass, sigma) sharing key never collides with
 *   other modules' blurs of the same sampler name.
 */
export { BLUR_SIGMAS } from './constants';
export { PRE_PASS, preUniforms, isPreIdentity } from './pre';
export { DEVELOP_PASS, DEVELOP_BLURS, developUniforms, developNeeds, isDefringeActive } from './develop';
export type { DevelopNeeds } from './develop';
export { LOCAL_PASS, LOCAL_BLURS, localUniforms, localNeeds, isMaskIdentity } from './local';
export type { LocalNeeds } from './local';
export { GUIDE_LINEAR_PASS, GUIDE_DISPLAY_PASS, FRINGE_SOURCE_PASS, DETAIL_SOURCE_PASS } from './guide';
export { CURVE_LUT_SIZE, curveLutKey, isCurveIdentity, buildDevelopCurveLut } from './lut';
export { calibrationMatrix, isCalibrationIdentity } from './calibration';
export { HSL_BANDS, hslWeights, hslBandWeight, hslHueShift, isHslIdentity } from './hsl';
export type { HslBand } from './hsl';
export { gradeSplit, gradeWeights, tintDirection, isGradingIdentity } from './grading';
export {
  toneL,
  toneY,
  shadowsDelta,
  highlightsDelta,
  whitesCurve,
  blacksCurve,
  contrastCurve,
  globalToneCurve,
  globalToneCurveLinear,
} from './tone';

import type { PassDef } from '../pass-types';
import { DEVELOP_PASS } from './develop';
import { LOCAL_PASS } from './local';
import { PRE_PASS } from './pre';

/** All colour passes in pipeline order (handy for program pre-compilation). */
export const COLOR_PASSES: readonly PassDef[] = [PRE_PASS, DEVELOP_PASS, LOCAL_PASS];
