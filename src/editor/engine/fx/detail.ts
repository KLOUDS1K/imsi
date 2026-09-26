/**
 * DETAIL stage (display-referred, sRGB-encoded float in → out, source space):
 *
 *   1. fx-detail-ai-denoise     fine edge-aware à-trous pass (skipInDraft)
 *   2. fx-detail-ai-denoise-2   coarse edge-aware à-trous pass (skipInDraft)
 *   3. fx-detail-color-nr       edge-aware chroma smoothing
 *   4. fx-detail-luma-nr        cross-bilateral luma NR
 *   5. fx-detail-luma-contrast  restores the local contrast NR flattened
 *   6. fx-detail-sharpen        unsharp mask on luma (detail + edge masking)
 *
 * Every pass is an exact identity (and reports isIdentity) at default JPEG
 * settings. Radii are authored in REFERENCE px and multiplied by ctx.scale.
 *
 * Alpha: source-space alpha carries no meaning. Pass 4 temporarily stores the
 * pre-NR luma in .a for pass 5 (which blurs the NR residual and restores
 * .a = 1); both use the same predicate, so they always run together.
 *
 * Luma/chroma split: luma Y = Rec.709 weights on the ENCODED values;
 * chroma = rgb − Y (so Y + chroma reconstructs rgb exactly and changing
 * chroma never changes Y).
 */
import type { EditParams } from '../../types';
import type { PassContext, PassDef } from '../pass-types';
import { GLSL_SAMPLING, fragment } from './glsl';

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/* ------------------------------------------------------------------ */
/* 1–2. Smart denoise — multi-scale edge-aware à-trous filtering       */
/* ------------------------------------------------------------------ */

const SMART_DENOISE_GLSL = /* glsl */ `
uniform sampler2D uInput;
uniform sampler2D uSmartGuide;
uniform float uSmartStep;      // à-trous spacing in source px
uniform float uSmartMix;       // pass strength
uniform float uSmartSigmaY;    // luma edge threshold
uniform float uSmartSigmaC;    // chroma edge threshold
uniform float uSmartFloorY;    // expected fine luma noise
uniform float uSmartFloorC;    // expected fine chroma noise
uniform float uSmartPreserve;  // 0..1 texture preservation

float kernel5(int i) {
  if (i == -2 || i == 2) return 0.0625;
  if (i == -1 || i == 1) return 0.25;
  return 0.375;
}

void main() {
  vec2 texel = 1.0 / vec2(textureSize(uInput, 0));
  ivec2 pix = ivec2(floor(vUv / texel));
  vec4 c0 = texelFetch(uInput, pix, 0);
  vec3 g0rgb = texture(uSmartGuide, vUv).rgb;
  float g0y = luma(g0rgb);
  vec3 g0c = g0rgb - g0y;
  float invY = 0.5 / max(1e-6, uSmartSigmaY * uSmartSigmaY);
  float invC = 0.5 / max(1e-6, uSmartSigmaC * uSmartSigmaC);
  float accY = 0.0;
  vec3 accC = vec3(0.0);
  float wsum = 0.0;
  for (int j = -2; j <= 2; j++) {
    for (int i = -2; i <= 2; i++) {
      vec2 uv = vUv + vec2(float(i), float(j)) * uSmartStep * texel;
      vec3 guide = texture(uSmartGuide, uv).rgb;
      float gy = luma(guide);
      vec3 gc = guide - gy;
      float dy = gy - g0y;
      vec3 dc = gc - g0c;
      float w = kernel5(i) * kernel5(j) * exp(-dy * dy * invY - dot(dc, dc) * invC);
      vec3 sampleRgb = texture(uInput, uv).rgb;
      float sy = luma(sampleRgb);
      accY += w * sy;
      accC += w * (sampleRgb - sy);
      wsum += w;
    }
  }
  float y0 = luma(c0.rgb);
  vec3 c0c = c0.rgb - y0;
  float denY = accY / max(wsum, 1e-6);
  vec3 denC = accC / max(wsum, 1e-6);

  // The à-trous residual is a wavelet detail band. Soft coring removes values
  // compatible with noise while returning stronger texture and real edges.
  float shadow = 1.0 + 0.7 * pow(1.0 - clamp(y0, 0.0, 1.0), 2.0);
  float ry = y0 - denY;
  vec3 rc = c0c - denC;
  float signalY = smoothstep(0.65 * uSmartFloorY * shadow, 2.6 * uSmartFloorY * shadow, abs(ry));
  float signalC = smoothstep(0.65 * uSmartFloorC * shadow, 2.8 * uSmartFloorC * shadow, length(rc));
  float keepY = uSmartPreserve * (0.12 + 0.88 * signalY);
  float keepC = uSmartPreserve * (0.05 + 0.55 * signalC);
  vec3 filtered = (denY + ry * keepY) + (denC + rc * keepC);
  outColor = vec4(mix(c0.rgb, filtered, uSmartMix), c0.a);
}
`;

function smartDenoiseUniforms(params: EditParams, ctx: PassContext, coarse: boolean): Record<string, number> {
  const s = clamp01(params.noise.aiDenoiseStrength / 100);
  const preserve = clamp01(params.noise.detailPreservation / 100);
  const scale = Math.max(0.6, ctx.scale);
  const coarseAmount = clamp01((s - 0.18) / 0.82);
  return {
    uSmartStep: (coarse ? 2 : 1) * scale,
    uSmartMix: coarse ? 0.78 * coarseAmount : Math.min(1, 0.25 + 1.05 * s),
    uSmartSigmaY: (coarse ? 0.035 : 0.022) + (coarse ? 0.15 : 0.105) * s,
    uSmartSigmaC: (coarse ? 0.06 : 0.04) + (coarse ? 0.24 : 0.17) * s,
    uSmartFloorY: (coarse ? 0.007 : 0.005) + (coarse ? 0.04 : 0.027) * s,
    uSmartFloorC: (coarse ? 0.01 : 0.008) + (coarse ? 0.06 : 0.042) * s,
    uSmartPreserve: preserve,
  };
}

const AI_DENOISE_PASS: PassDef = {
  name: 'fx-detail-ai-denoise',
  fragment: fragment(SMART_DENOISE_GLSL),
  inputs: ['uInput'],
  blurs: [{ uniform: 'uSmartGuide', source: 'uInput', sigma: () => 0.65 }],
  skipInDraft: true,
  uniforms: (params, ctx) => smartDenoiseUniforms(params, ctx, false),
  isIdentity: (p) => !p.noise.aiDenoise || !(p.noise.aiDenoiseStrength > 0),
};

const AI_DENOISE_COARSE_PASS: PassDef = {
  name: 'fx-detail-ai-denoise-2',
  fragment: fragment(SMART_DENOISE_GLSL),
  inputs: ['uInput'],
  blurs: [{ uniform: 'uSmartGuide', source: 'uInput', sigma: () => 1.1 }],
  skipInDraft: true,
  uniforms: (params, ctx) => smartDenoiseUniforms(params, ctx, true),
  isIdentity: (p) => !p.noise.aiDenoise || !(p.noise.aiDenoiseStrength > 0),
};

/* ------------------------------------------------------------------ */
/* 2. Colour noise reduction                                           */
/* ------------------------------------------------------------------ */

/** Tap spacing (reference px) of the chroma filter; the pre-blur is half of it. */
function colorNrStepRef(p: EditParams): number {
  const a = clamp01(p.noise.color / 100);
  const smooth = clamp01(p.noise.colorSmoothness / 100);
  return (1 + 3 * smooth) * (0.6 + 0.8 * a);
}

const COLOR_NR_GLSL = /* glsl */ `
uniform sampler2D uInput;
uniform sampler2D uCnrBlur;
uniform float uCnrMix;
uniform float uCnrStep;    // px
uniform float uCnrSigmaC;  // chroma range sigma
uniform float uCnrSigmaY;  // luma range sigma (don't bleed colour across luma edges)

void main() {
  vec2 texel = 1.0 / vec2(textureSize(uInput, 0));
  vec4 c0 = texelFetch(uInput, ivec2(floor(vUv / texel)), 0);
  float y0 = luma(c0.rgb);
  vec3 b0 = texture(uCnrBlur, vUv).rgb;
  float by = luma(b0);
  vec3 bc = b0 - by;
  float kc = 0.5 / (uCnrSigmaC * uCnrSigmaC);
  float ky = 0.5 / (uCnrSigmaY * uCnrSigmaY);
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  // Sparse 7×7 cross-bilateral over the pre-blurred image: the pre-blur
  // (σ ≈ step/2) band-limits the taps, so large blotches are removed without
  // aliasing while the range terms keep colour edges.
  for (int j = -3; j <= 3; j++) {
    for (int i = -3; i <= 3; i++) {
      vec2 o = vec2(float(i), float(j));
      vec3 s = texture(uCnrBlur, vUv + o * uCnrStep * texel).rgb;
      float sy = luma(s);
      vec3 sc = s - sy;
      vec3 dc = sc - bc;
      float dy = sy - by;
      float w = exp(-dot(o, o) * 0.1033 - dot(dc, dc) * kc - dy * dy * ky); // spatial σ = 2.2 taps
      acc += w * sc;
      wsum += w;
    }
  }
  vec3 chroma = mix(c0.rgb - y0, acc / wsum, uCnrMix);
  outColor = vec4(y0 + chroma, c0.a);
}
`;

const COLOR_NR_PASS: PassDef = {
  name: 'fx-detail-color-nr',
  fragment: fragment(COLOR_NR_GLSL),
  inputs: ['uInput'],
  blurs: [{ uniform: 'uCnrBlur', source: 'uInput', sigma: (p) => 0.5 * colorNrStepRef(p) }],
  uniforms(params, ctx) {
    const a = clamp01(params.noise.color / 100);
    const detailFactor = lerp(1.6, 0.4, clamp01(params.noise.colorDetail / 100));
    return {
      uCnrMix: Math.min(1, a * 2.5),
      uCnrStep: Math.max(0.75, colorNrStepRef(params) * ctx.scale),
      uCnrSigmaC: (0.015 + 0.16 * a) * detailFactor,
      uCnrSigmaY: (0.04 + 0.2 * a) * detailFactor,
    };
  },
  isIdentity: (p) => !(p.noise.color > 0),
};

/* ------------------------------------------------------------------ */
/* 3. Luminance noise reduction                                        */
/* ------------------------------------------------------------------ */

const lumaContrastActive = (p: EditParams) => p.noise.luminance > 0 && p.noise.luminanceContrast > 0;

const LUMA_NR_GLSL = /* glsl */ `
uniform sampler2D uInput;
uniform sampler2D uLnrGuide;
uniform float uLnrMix;
uniform float uLnrStep;       // px
uniform float uLnrSigmaR;     // range sigma (luminanceDetail: smaller = more edges kept)
uniform float uLnrStoreLuma;  // 1 = write the pre-NR luma to .a for the contrast pass

void main() {
  vec2 texel = 1.0 / vec2(textureSize(uInput, 0));
  vec4 c0 = texelFetch(uInput, ivec2(floor(vUv / texel)), 0);
  float y0 = luma(c0.rgb);
  float g0 = luma(texture(uLnrGuide, vUv).rgb);
  float kr = 0.5 / (uLnrSigmaR * uLnrSigmaR);
  float acc = 0.0;
  float wsum = 0.0;
  // Cross-bilateral: values from the noisy image, range weights from a
  // lightly pre-blurred guide (noise in the centre pixel would otherwise
  // decide the weights and leave speckles).
  for (int j = -3; j <= 3; j++) {
    for (int i = -3; i <= 3; i++) {
      vec2 o = vec2(float(i), float(j));
      vec2 uv = vUv + o * uLnrStep * texel;
      float ys = luma(texture(uInput, uv).rgb);
      float dg = luma(texture(uLnrGuide, uv).rgb) - g0;
      float w = exp(-dot(o, o) * 0.125 - dg * dg * kr); // spatial σ = 2 taps
      acc += w * ys;
      wsum += w;
    }
  }
  float y1 = mix(y0, acc / wsum, uLnrMix);
  outColor = vec4(c0.rgb + (y1 - y0), uLnrStoreLuma > 0.5 ? y0 : c0.a);
}
`;

const LUMA_NR_PASS: PassDef = {
  name: 'fx-detail-luma-nr',
  fragment: fragment(LUMA_NR_GLSL),
  inputs: ['uInput'],
  blurs: [{ uniform: 'uLnrGuide', source: 'uInput', sigma: (p) => 0.5 + 0.9 * clamp01(p.noise.luminance / 100) }],
  uniforms(params, ctx) {
    const a = clamp01(params.noise.luminance / 100);
    const detail = clamp01(params.noise.luminanceDetail / 100);
    return {
      uLnrMix: Math.min(1, a * 3),
      uLnrStep: Math.max(0.5, (0.6 + 0.9 * a) * ctx.scale),
      uLnrSigmaR: (0.012 + 0.1 * a) * lerp(1.8, 0.35, detail),
      uLnrStoreLuma: lumaContrastActive(params) ? 1 : 0,
    };
  },
  isIdentity: (p) => !(p.noise.luminance > 0),
};

/* ------------------------------------------------------------------ */
/* 4. Luminance contrast restore                                       */
/* ------------------------------------------------------------------ */

/** Prepass: NR residual (pre-NR luma in .a minus the denoised luma). */
const LUMA_RESIDUAL_PREPASS: PassDef = {
  name: 'fx-detail-luma-residual',
  fragment: fragment(/* glsl */ `
uniform sampler2D uInput;
void main() {
  vec4 c = texture(uInput, vUv);
  outColor = vec4(vec3(c.a - luma(c.rgb)), 1.0);
}
`),
  inputs: ['uInput'],
  uniforms: () => ({}),
};

const LUMA_CONTRAST_GLSL = /* glsl */ `
uniform sampler2D uInput;
uniform sampler2D uLcResidual;
uniform float uLcAmount;
void main() {
  vec4 c = texelFetch(uInput, ivec2(floor(vUv * vec2(textureSize(uInput, 0)))), 0);
  // The low-passed residual is the mid-frequency structure the bilateral
  // flattened (pixel noise averages out); adding it back restores local contrast.
  float r = texture(uLcResidual, vUv).r;
  outColor = vec4(c.rgb + uLcAmount * r, 1.0);
}
`;

const LUMA_CONTRAST_PASS: PassDef = {
  name: 'fx-detail-luma-contrast',
  fragment: fragment(LUMA_CONTRAST_GLSL),
  inputs: ['uInput'],
  blurs: [
    {
      uniform: 'uLcResidual',
      source: 'uInput',
      sigma: (p) => 1.0 + 1.5 * clamp01(p.noise.luminance / 100),
      prepass: LUMA_RESIDUAL_PREPASS,
    },
  ],
  uniforms: (params) => ({ uLcAmount: clamp01(params.noise.luminanceContrast / 100) }),
  isIdentity: (p) => !lumaContrastActive(p),
};

/* ------------------------------------------------------------------ */
/* 5. Sharpening                                                       */
/* ------------------------------------------------------------------ */

const SHARPEN_GLSL = /* glsl */ `
uniform sampler2D uInput;
uniform sampler2D uSharpBlur;
uniform float uSharpGain;
uniform float uSharpCompress;  // soft-limit of large high-pass values (halo suppression)
uniform float uSharpOvershoot; // allowed overshoot beyond the local 3×3 range
uniform float uSharpMaskT;     // edge-mask gradient threshold per reference px (0 = off)
uniform float uSharpGradScale; // 1 / ctx.scale

void main() {
  vec2 texel = 1.0 / vec2(textureSize(uInput, 0));
  ivec2 pix = ivec2(floor(vUv / texel));
  vec4 c0 = texelFetch(uInput, pix, 0);
  float y = luma(c0.rgb);
  float hp = y - luma(texture(uSharpBlur, vUv).rgb);
  // Detail slider: low values compress large high-pass amplitudes (strong
  // edges → halos) while small ones (fine texture) pass unchanged.
  float h = hp / (1.0 + uSharpCompress * abs(hp));
  float m = 1.0;
  if (uSharpMaskT > 0.0) {
    // Gradient of the blurred luma: noise-robust edge detector.
    float gx = luma(texture(uSharpBlur, vUv + vec2(texel.x, 0.0)).rgb) - luma(texture(uSharpBlur, vUv - vec2(texel.x, 0.0)).rgb);
    float gy = luma(texture(uSharpBlur, vUv + vec2(0.0, texel.y)).rgb) - luma(texture(uSharpBlur, vUv - vec2(0.0, texel.y)).rgb);
    float g = 0.5 * length(vec2(gx, gy)) * uSharpGradScale;
    m = smoothstep(0.5 * uSharpMaskT, 1.5 * uSharpMaskT, g);
  }
  float ys = y + uSharpGain * m * h;
  float mn = y;
  float mx = y;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      float n = luma(fetchClamped(uInput, pix + ivec2(i, j)).rgb);
      mn = min(mn, n);
      mx = max(mx, n);
    }
  }
  ys = clamp(ys, mn - uSharpOvershoot, mx + uSharpOvershoot);
  outColor = vec4(c0.rgb + (ys - y), c0.a);
}
`;

const SHARPEN_PASS: PassDef = {
  name: 'fx-detail-sharpen',
  fragment: fragment(GLSL_SAMPLING, SHARPEN_GLSL),
  inputs: ['uInput'],
  blurs: [{ uniform: 'uSharpBlur', source: 'uInput', sigma: (p) => Math.min(3, Math.max(0.5, p.detail.sharpenRadius)) }],
  uniforms(params, ctx: PassContext) {
    const d = clamp01(params.detail.sharpenDetail / 100);
    const masking = clamp01(params.detail.sharpenMasking / 100);
    return {
      uSharpGain: (Math.max(0, params.detail.sharpenAmount) / 100) * 1.25,
      uSharpCompress: (1 - d) * (1 - d) * 12,
      uSharpOvershoot: 0.01 + 0.6 * d * d,
      uSharpMaskT: masking > 0 ? 0.002 + 0.06 * Math.pow(masking, 1.5) : 0,
      uSharpGradScale: 1 / Math.max(1e-3, ctx.scale),
    };
  },
  isIdentity: (p) => !(p.detail.sharpenAmount > 0),
};

/** Display-referred DETAIL stage, in order. */
export const DETAIL_STAGE: PassDef[] = [AI_DENOISE_PASS, AI_DENOISE_COARSE_PASS, COLOR_NR_PASS, LUMA_NR_PASS, LUMA_CONTRAST_PASS, SHARPEN_PASS];

export {
  AI_DENOISE_PASS,
  AI_DENOISE_COARSE_PASS,
  COLOR_NR_PASS,
  LUMA_NR_PASS,
  LUMA_CONTRAST_PASS,
  LUMA_RESIDUAL_PREPASS,
  SHARPEN_PASS,
};
