/**
 * EFFECTS stage (output space, display-referred sRGB-encoded float, straight
 * alpha = image coverage from the geometry pass):
 *
 *   fx-bloom      soft, wide additive glow from highlights
 *   fx-glow       diffuse soft-focus (Orton-style) glow, slight saturation
 *   fx-halation   film halation: red/orange glow around bright highlights
 *   fx-vignette   post-crop vignette (highlight-priority style)
 *   fx-grain      film grain, deterministic and resolution-independent
 *
 * Light is added in LINEAR light with a screen blend (a + b·(1−a)): dark areas
 * receive the full glow, bright areas cannot clip hard. Each pass is skipped
 * (isIdentity) at its default of 0. Out-of-image pixels (alpha 0) pass through.
 *
 * Vignette and grain evaluate positions in normalized OUTPUT coordinates
 * (ctx.outRect folded in), so tiles and zoomed renders line up with the full
 * image and preview/export produce the same pattern.
 */
import type { EditParams } from '../../types';
import type { PassContext, PassDef } from '../pass-types';
import { GLSL_NOISE, fragment } from './glsl';

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

const CENTER_FETCH = /* glsl */ `
vec4 centerTexel(sampler2D t) {
  return texelFetch(t, ivec2(floor(vUv * vec2(textureSize(t, 0)))), 0);
}
// Screen blend in linear light, safe for unclamped (HDR) values.
vec3 screenAdd(vec3 base, vec3 light) { return base + light * max(1.0 - base, 0.0); }
`;

/* ------------------------------------------------------------------ */
/* Bloom                                                               */
/* ------------------------------------------------------------------ */

const bloomAmount = (p: EditParams) => clamp01(p.effects.bloom / 100);

const BLOOM_EXTRACT: PassDef = {
  name: 'fx-bloom-extract',
  fragment: fragment(/* glsl */ `
uniform sampler2D uInput;
uniform float uThreshold;
uniform float uKnee;
void main() {
  vec4 c = texture(uInput, vUv);
  vec3 lin = srgbToLinear(max(c.rgb, 0.0));
  float br = max(max(lin.r, lin.g), lin.b);
  // Soft-knee highlight extraction (keeps colour of the light source).
  float w = smoothstep(uThreshold, uThreshold + uKnee, br);
  outColor = vec4(lin * w * c.a, 1.0);
}
`),
  inputs: ['uInput'],
  uniforms: (p) => ({ uThreshold: lerp(0.85, 0.35, bloomAmount(p)), uKnee: 0.35 }),
};

export const BLOOM_PASS: PassDef = {
  name: 'fx-bloom',
  fragment: fragment(
    CENTER_FETCH,
    /* glsl */ `
uniform sampler2D uInput;
uniform sampler2D uBloomNear;
uniform sampler2D uBloomFar;
uniform float uBloomAmount;
void main() {
  vec4 c = centerTexel(uInput);
  if (c.a <= 0.0) { outColor = c; return; }
  vec3 lin = srgbToLinear(max(c.rgb, 0.0));
  vec3 g = (0.35 * texture(uBloomNear, vUv).rgb + 0.65 * texture(uBloomFar, vUv).rgb) * uBloomAmount;
  outColor = vec4(linearToSrgb(screenAdd(lin, g)), c.a);
}
`,
  ),
  inputs: ['uInput'],
  blurs: [
    { uniform: 'uBloomNear', source: 'uInput', sigma: 10, prepass: BLOOM_EXTRACT },
    { uniform: 'uBloomFar', source: 'uInput', sigma: 40, prepass: BLOOM_EXTRACT },
  ],
  uniforms: (p) => ({ uBloomAmount: bloomAmount(p) * 1.6 }),
  isIdentity: (p) => !(p.effects.bloom > 0),
};

/* ------------------------------------------------------------------ */
/* Glow                                                                */
/* ------------------------------------------------------------------ */

const GLOW_EXTRACT: PassDef = {
  name: 'fx-glow-extract',
  fragment: fragment(/* glsl */ `
uniform sampler2D uInput;
void main() {
  vec4 c = texture(uInput, vUv);
  vec3 lin = srgbToLinear(max(c.rgb, 0.0));
  float y = luma(lin);
  // Mid-tones and highlights feed the glow; slightly saturated so the glow
  // keeps the scene colour instead of washing it out.
  vec3 sat = max(mix(vec3(y), lin, 1.25), 0.0);
  outColor = vec4(sat * smoothstep(0.02, 0.5, y) * c.a, 1.0);
}
`),
  inputs: ['uInput'],
  uniforms: () => ({}),
};

export const GLOW_PASS: PassDef = {
  name: 'fx-glow',
  fragment: fragment(
    CENTER_FETCH,
    /* glsl */ `
uniform sampler2D uInput;
uniform sampler2D uGlowBlur;
uniform float uGlowMix;
uniform float uGlowSat;
void main() {
  vec4 c = centerTexel(uInput);
  if (c.a <= 0.0) { outColor = c; return; }
  vec3 lin = srgbToLinear(max(c.rgb, 0.0));
  vec3 soft = screenAdd(lin, texture(uGlowBlur, vUv).rgb);
  vec3 o = mix(lin, soft, uGlowMix);
  float y = luma(o);
  o = max(mix(vec3(y), o, uGlowSat), 0.0);
  outColor = vec4(linearToSrgb(o), c.a);
}
`,
  ),
  inputs: ['uInput'],
  blurs: [{ uniform: 'uGlowBlur', source: 'uInput', sigma: 18, prepass: GLOW_EXTRACT }],
  uniforms: (p) => {
    const g = clamp01(p.effects.glow / 100);
    return { uGlowMix: g * 0.75, uGlowSat: 1 + 0.12 * g };
  },
  isIdentity: (p) => !(p.effects.glow > 0),
};

/* ------------------------------------------------------------------ */
/* Halation                                                            */
/* ------------------------------------------------------------------ */

const halationAmount = (p: EditParams) => clamp01(p.effects.halation / 100);
/** Linear max-channel level where halation starts: only near-clipped highlights scatter. */
const halationThreshold = (p: EditParams) => lerp(0.92, 0.7, halationAmount(p));

/** Shared by the prepass and the composite (to keep the highlight cores untinted). */
const HALATION_LIB = /* glsl */ `
const vec3 HALATION_TINT = vec3(1.0, 0.28, 0.06);
uniform float uHalThreshold;
vec3 halationSource(vec4 c) {
  vec3 lin = srgbToLinear(max(c.rgb, 0.0));
  float br = max(max(lin.r, lin.g), lin.b);
  return vec3(luma(lin) * smoothstep(uHalThreshold, uHalThreshold + 0.25, br)) * HALATION_TINT * c.a;
}
`;

const HALATION_EXTRACT: PassDef = {
  name: 'fx-halation-extract',
  fragment: fragment(
    HALATION_LIB,
    /* glsl */ `
uniform sampler2D uInput;
void main() { outColor = vec4(halationSource(texture(uInput, vUv)), 1.0); }
`,
  ),
  inputs: ['uInput'],
  uniforms: (p) => ({ uHalThreshold: halationThreshold(p) }),
};

export const HALATION_PASS: PassDef = {
  name: 'fx-halation',
  fragment: fragment(
    CENTER_FETCH,
    HALATION_LIB,
    /* glsl */ `
uniform sampler2D uInput;
uniform sampler2D uHalNear;
uniform sampler2D uHalFar;
uniform float uHalAmount;
void main() {
  vec4 c = centerTexel(uInput);
  if (c.a <= 0.0) { outColor = c; return; }
  vec3 lin = srgbToLinear(max(c.rgb, 0.0));
  vec3 spread = 0.55 * texture(uHalNear, vUv).rgb + 0.45 * texture(uHalFar, vUv).rgb;
  // Film halation is light scattered back from the film base: it surrounds
  // the highlight while the (overexposed) core itself stays neutral.
  vec3 halo = max(spread - 0.8 * halationSource(c), 0.0) * uHalAmount;
  outColor = vec4(linearToSrgb(screenAdd(lin, halo)), c.a);
}
`,
  ),
  inputs: ['uInput'],
  blurs: [
    { uniform: 'uHalNear', source: 'uInput', sigma: 4, prepass: HALATION_EXTRACT },
    { uniform: 'uHalFar', source: 'uInput', sigma: 16, prepass: HALATION_EXTRACT },
  ],
  uniforms: (p) => ({ uHalAmount: halationAmount(p) * 1.8, uHalThreshold: halationThreshold(p) }),
  isIdentity: (p) => !(p.effects.halation > 0),
};

/* ------------------------------------------------------------------ */
/* Post-crop vignette                                                  */
/* ------------------------------------------------------------------ */

const OUT_RECT = (ctx: PassContext) => {
  const r = ctx.outRect ?? { x: 0, y: 0, w: 1, h: 1 };
  return [r.x, r.y, r.w, r.h];
};

/** (W, H) / long edge of the full output. */
const outAspect = (ctx: PassContext) => {
  const w = Math.max(1, ctx.outWidth);
  const h = Math.max(1, ctx.outHeight);
  const l = Math.max(w, h);
  return [w / l, h / l];
};

export const VIGNETTE_PASS: PassDef = {
  name: 'fx-vignette',
  fragment: fragment(
    CENTER_FETCH,
    /* glsl */ `
uniform sampler2D uInput;
uniform vec4 uOutRect;
uniform vec2 uOutAspect;
uniform float uVigAmount;     // -1..1
uniform float uVigMid;        // radius at the middle of the transition
uniform float uVigWidth;      // transition width (feather)
uniform float uVigP;          // superellipse exponent (2 = ellipse, larger = squarer)
uniform float uVigRound;      // 0..1 blend of the shape towards a circle
uniform float uVigHighlights; // 0..1 highlight protection when darkening

void main() {
  vec4 c = centerTexel(uInput);
  if (c.a <= 0.0) { outColor = c; return; }
  vec2 pos = uOutRect.xy + vUv * uOutRect.zw;
  // d ∈ [-1,1]²: the unit superellipse is inscribed in the output rectangle.
  vec2 d = (pos - 0.5) * 2.0;
  d = mix(d, d * uOutAspect / min(uOutAspect.x, uOutAspect.y), uVigRound);
  vec2 a = max(abs(d), vec2(1e-6));
  float rho = pow(pow(a.x, uVigP) + pow(a.y, uVigP), 1.0 / uVigP);
  float v = smoothstep(uVigMid - 0.5 * uVigWidth, uVigMid + 0.5 * uVigWidth, rho);
  vec3 lin = srgbToLinear(max(c.rgb, 0.0));
  if (uVigAmount < 0.0) {
    // Highlight priority: an exposure-like darkening (hue-preserving) that
    // bright pixels resist in proportion to uVigHighlights.
    float protect = uVigHighlights * smoothstep(0.25, 1.0, luma(lin));
    lin *= mix(exp2(3.0 * uVigAmount * v), 1.0, protect);
  } else {
    lin = screenAdd(lin, vec3(0.9 * uVigAmount * v));
  }
  outColor = vec4(linearToSrgb(lin), c.a);
}
`,
  ),
  inputs: ['uInput'],
  uniforms(p, ctx) {
    const e = p.effects;
    const round = Math.max(-1, Math.min(1, e.vignetteRoundness / 100));
    const mid = clamp01(e.vignetteMidpoint / 100);
    const feather = clamp01(e.vignetteFeather / 100);
    return {
      uOutRect: OUT_RECT(ctx),
      uOutAspect: outAspect(ctx),
      uVigAmount: Math.max(-1, Math.min(1, e.vignetteAmount / 100)),
      uVigMid: 0.35 + 1.05 * mid,
      uVigWidth: 0.1 + 1.3 * feather,
      uVigP: round < 0 ? 2 + 6 * -round : 2,
      uVigRound: round > 0 ? round : 0,
      uVigHighlights: clamp01(e.vignetteHighlights / 100),
    };
  },
  isIdentity: (p) => p.effects.vignetteAmount === 0,
};

/* ------------------------------------------------------------------ */
/* Grain                                                               */
/* ------------------------------------------------------------------ */

/** Grain cells across the output's long edge for a grainSize slider value. */
export function grainCellsAcrossLongEdge(grainSize: number): number {
  const s = clamp01(grainSize / 100);
  // Cell size in px of a 2560 px reference image: ~0.9 px (fine) … 5.4 px (coarse).
  return 2560 / (0.9 + 4.5 * Math.pow(s, 1.3));
}

export const GRAIN_PASS: PassDef = {
  name: 'fx-grain',
  fragment: fragment(
    CENTER_FETCH,
    GLSL_NOISE,
    /* glsl */ `
uniform sampler2D uInput;
uniform vec4 uOutRect;
uniform vec2 uGrainCells;  // grain cells across the full output (x, y)
uniform float uGrainAmp;   // grain std in encoded units at mid-grey
uniform float uGrainRough; // 0..1

const mat2 ROT_A = mat2(0.8776, 0.4794, -0.4794, 0.8776);  // 0.5 rad: hides the lattice axes
const mat2 ROT_B = mat2(0.5403, -0.8415, 0.8415, 0.5403);  // -1.0 rad

void main() {
  vec4 c = centerTexel(uInput);
  vec2 pos = uOutRect.xy + vUv * uOutRect.zw;
  vec2 P = pos * uGrainCells;
  // Cells per output pixel (before any branch: derivatives).
  float fp = max(length(dFdx(P)), length(dFdy(P)));
  if (c.a <= 0.0) { outColor = c; return; }
  float n1 = gradientNoise(ROT_A * P, 1u);
  float n2 = gradientNoise(ROT_B * P * 2.03 + 17.1, 2u);
  // Roughness mixes in a finer octave (same total variance) and clumps the
  // grain with an independent low-frequency amplitude field, so the mean of
  // the product stays zero.
  float n = mix(n1, 0.6 * n1 + 0.8 * n2, uGrainRough) / GRAD_NOISE_STD;
  float clump = gradientNoise(P * 0.29 + 5.7, 3u) / GRAD_NOISE_STD;
  n *= max(0.0, 1.0 + 0.45 * uGrainRough * clump);
  // When a pixel covers several cells (fit-to-screen preview of a fine
  // grain) the visible grain is the pixel-average: std falls like 1/fp.
  float atten = 1.0 / max(1.0, fp);
  // Film grain is most visible in the mid-tones.
  float y = clamp(luma(c.rgb), 0.0, 1.0);
  float w = 0.2 + 0.8 * pow(4.0 * y * (1.0 - y), 0.75);
  outColor = vec4(c.rgb + vec3(uGrainAmp * w * atten * n), c.a);
}
`,
  ),
  inputs: ['uInput'],
  uniforms(p, ctx) {
    const e = p.effects;
    const cells = grainCellsAcrossLongEdge(e.grainSize);
    const [ax, ay] = outAspect(ctx);
    return {
      uOutRect: OUT_RECT(ctx),
      uGrainCells: [cells * ax, cells * ay],
      uGrainAmp: clamp01(e.grainAmount / 100) * 0.1,
      uGrainRough: clamp01(e.grainRoughness / 100),
    };
  },
  isIdentity: (p) => !(p.effects.grainAmount > 0),
};

/** Output-space EFFECTS stage, in order. */
export const EFFECTS_STAGE: PassDef[] = [BLOOM_PASS, GLOW_PASS, HALATION_PASS, VIGNETTE_PASS, GRAIN_PASS];

export { BLOOM_EXTRACT, GLOW_EXTRACT, HALATION_EXTRACT };
