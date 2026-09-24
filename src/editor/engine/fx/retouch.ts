/**
 * Retouch passes (source space, LINEAR light):
 *
 * PATCH_COMPOSITE_PASS — composites one RemovalPatch (inpainted pixels,
 *   RGBA8 covering patch.bbox, alpha = coverage) onto the source.
 * HEAL_PASS — up to MAX_SPOTS_PER_PASS heal/clone spots per invocation.
 *
 * Orchestrator recipe (retouch step, before PRE):
 *   for (let i = 0; i < params.retouch.removals.length; i++) {
 *     const px = patchProvider.getPatch(params.retouch.removals[i].patchKey);
 *     if (!px) continue;                       // not computed yet → skip
 *     // upload px as plain RGBA8 UNORM (NOT SRGB8_ALPHA8) or float; bind to uPatch
 *     run(PATCH_COMPOSITE_PASS, { iteration: i });
 *   }
 *   for (const chunk of chunks(params.retouch.spots, MAX_SPOTS_PER_PASS))
 *     run(HEAL_PASS, { spots: chunk });
 * The patch pass decodes sRGB itself (uPatchSrgb = 1). For a patch whose
 * PixelBuffer is already linear, override with `patchCompositeUniforms(bbox, 'linear')`.
 */
import type { HealSpot, Rect } from '../../types';
import { MAX_SPOTS_PER_PASS, type PassContext, type PassDef, type PassExtra, type UniformMap } from '../pass-types';
import { GLSL_SAMPLING, fragment } from './glsl';

/* ------------------------------------------------------------------ */
/* Removal patch                                                       */
/* ------------------------------------------------------------------ */

const PATCH_GLSL = /* glsl */ `
uniform sampler2D uInput;
uniform sampler2D uPatch;
uniform vec4 uPatchRect;   // bbox x, y, w, h (source-normalized)
uniform float uPatchSrgb;  // 1 = patch texels are sRGB-encoded

vec4 patchTexel(ivec2 p) {
  vec4 t = fetchClamped(uPatch, p);
  vec3 rgb = uPatchSrgb > 0.5 ? srgbToLinear(clamp(t.rgb, 0.0, 1.0)) : t.rgb;
  float a = clamp(t.a, 0.0, 1.0);
  return vec4(rgb * a, a); // premultiplied: no dark fringes from alpha-0 texels
}

void main() {
  vec2 size = vec2(textureSize(uInput, 0));
  vec4 base = texelFetch(uInput, ivec2(floor(vUv * size)), 0);
  vec2 q = (vUv - uPatchRect.xy) / max(uPatchRect.zw, vec2(1e-9));
  if (q.x < 0.0 || q.y < 0.0 || q.x > 1.0 || q.y > 1.0) { outColor = base; return; }
  vec2 ps = vec2(textureSize(uPatch, 0));
  vec2 p = q * ps - 0.5;
  vec2 f = fract(p);
  ivec2 i = ivec2(floor(p));
  vec4 pm = mix(mix(patchTexel(i), patchTexel(i + ivec2(1, 0)), f.x),
                mix(patchTexel(i + ivec2(0, 1)), patchTexel(i + ivec2(1, 1)), f.x), f.y);
  if (pm.a <= 1e-6) { outColor = base; return; }
  vec3 rgb = pm.rgb / pm.a;
  outColor = vec4(mix(base.rgb, rgb, pm.a), base.a);
}
`;

/** Uniforms for compositing a patch covering `bbox`; `transfer` = encoding of the patch texels. */
export function patchCompositeUniforms(bbox: Rect, transfer: 'srgb' | 'linear' = 'srgb'): UniformMap {
  return { uPatchRect: [bbox.x, bbox.y, bbox.w, bbox.h], uPatchSrgb: transfer === 'srgb' ? 1 : 0 };
}

const patchAt = (params: Parameters<PassDef['uniforms']>[0], extra?: PassExtra) =>
  params.retouch.removals[extra?.iteration ?? 0];

/**
 * One invocation per RemovalPatch; `extra.iteration` = index into
 * params.retouch.removals (whose patch pixels are bound to uPatch).
 */
export const PATCH_COMPOSITE_PASS: PassDef = {
  name: 'fx-patch-composite',
  fragment: fragment(GLSL_SAMPLING, PATCH_GLSL),
  inputs: ['uInput', 'uPatch'],
  uniforms(params, _ctx, extra) {
    const p = patchAt(params, extra);
    return p ? patchCompositeUniforms(p.bbox, 'srgb') : { uPatchRect: [0, 0, 0, 0], uPatchSrgb: 1 };
  },
  isIdentity(params, _ctx, extra) {
    const p = patchAt(params, extra);
    return !p || !(p.bbox.w > 0 && p.bbox.h > 0);
  },
};

/* ------------------------------------------------------------------ */
/* Heal / clone                                                        */
/* ------------------------------------------------------------------ */

/** Blur sigmas (reference px) used to read smooth boundary colours around the spots. */
export const HEAL_BLUR_SMALL = 1.5;
export const HEAL_BLUR_LARGE = 6;
/** Boundary samples of the Poisson interpolation. */
const RING_SAMPLES = 16;

const HEAL_GLSL = /* glsl */ `
#define MAX_SPOTS ${MAX_SPOTS_PER_PASS}
#define RING ${RING_SAMPLES}
uniform sampler2D uInput;
uniform sampler2D uHealBlurS;
uniform sampler2D uHealBlurL;
uniform int uSpotCount;
uniform vec2 uSpotDst[MAX_SPOTS];   // destination centre, source-normalized
uniform vec2 uSpotSrc[MAX_SPOTS];   // source centre, source-normalized
uniform vec4 uSpotShape[MAX_SPOTS]; // radius px, feather 0..1, opacity 0..1, mode (0 clone, 1 heal)
uniform vec2 uHealSigmaPx;          // actual px sigmas of uHealBlurS / uHealBlurL

vec3 ringColor(vec2 uv, float t) {
  return mix(texture(uHealBlurS, uv).rgb, texture(uHealBlurL, uv).rgb, t);
}

void main() {
  vec2 sz = vec2(textureSize(uInput, 0));
  ivec2 pix = ivec2(floor(vUv * sz));
  vec4 base = texelFetch(uInput, pix, 0);
  vec3 col = base.rgb;
  vec2 p = vec2(pix) + 0.5;
  for (int i = 0; i < MAX_SPOTS; i++) {
    if (i >= uSpotCount) break;
    vec4 sh = uSpotShape[i];
    float R = sh.x;
    vec2 rel = p - uSpotDst[i] * sz;
    float d = length(rel);
    if (d >= R + 0.5) continue;
    // Feathered circular falloff: flat core, smoothstep edge of width feather·R
    // (at least one pixel, which anti-aliases hard-edged spots).
    float edge = max(R * sh.y, 1.0);
    float t = clamp((R + 0.5 - d) / edge, 0.0, 1.0);
    float w = t * t * (3.0 - 2.0 * t) * sh.z;
    if (w <= 0.0) continue;
    // Whole-pixel offset: the copy is exact (no resampling blur).
    ivec2 delta = ivec2(round((uSpotSrc[i] - uSpotDst[i]) * sz));
    vec3 result = fetchClamped(uInput, pix + delta).rgb;
    if (sh.w > 0.5) {
      // Healing = source texture + a smooth correction that makes the patch
      // match the destination's surroundings. The correction is the harmonic
      // function whose boundary values are (dst ring colour - src ring
      // colour) — the solution of the Laplace equation that Poisson/healing-
      // brush editing reduces to — evaluated with the discrete Poisson kernel
      // over RING samples on a circle just outside the spot.
      float Rr = R + 1.0;
      float spacing = 6.28318530718 * Rr / float(RING);
      float tb = clamp((0.35 * spacing - uHealSigmaPx.x) / max(uHealSigmaPx.y - uHealSigmaPx.x, 1e-3), 0.0, 1.0);
      vec2 dstUv = uSpotDst[i];
      vec2 srcUv = dstUv + vec2(delta) / sz;
      float rho = min(d / Rr, 0.97);
      float phi = atan(rel.y, rel.x);
      vec3 num = vec3(0.0);
      float den = 0.0;
      for (int k = 0; k < RING; k++) {
        float th = 6.28318530718 * (float(k) + 0.5) / float(RING);
        vec2 o = vec2(cos(th), sin(th)) * Rr / sz;
        vec3 diff = ringColor(dstUv + o, tb) - ringColor(srcUv + o, tb);
        float P = (1.0 - rho * rho) / max(1.0 - 2.0 * rho * cos(th - phi) + rho * rho, 1e-4);
        num += P * diff;
        den += P;
      }
      result = max(result + num / max(den, 1e-6), vec3(0.0));
    }
    col = mix(col, result, w);
  }
  outColor = vec4(col, base.a);
}
`;

const MODE: Record<HealSpot['kind'], number> = { clone: 0, heal: 1, 'content-aware': 1 };

/** Flattened uniform arrays for a chunk of spots (padded to MAX_SPOTS_PER_PASS). */
export function healUniforms(spots: readonly HealSpot[], ctx: Pick<PassContext, 'width' | 'height' | 'scale'>): UniformMap {
  const n = Math.min(spots.length, MAX_SPOTS_PER_PASS);
  const dst = new Float32Array(MAX_SPOTS_PER_PASS * 2);
  const src = new Float32Array(MAX_SPOTS_PER_PASS * 2);
  const shape = new Float32Array(MAX_SPOTS_PER_PASS * 4);
  const longEdge = Math.max(ctx.width, ctx.height);
  for (let i = 0; i < n; i++) {
    const s = spots[i];
    dst[i * 2] = s.x;
    dst[i * 2 + 1] = s.y;
    src[i * 2] = s.sx;
    src[i * 2 + 1] = s.sy;
    shape[i * 4] = Math.max(0, s.radius) * longEdge;
    shape[i * 4 + 1] = Math.min(1, Math.max(0, s.feather / 100));
    shape[i * 4 + 2] = Math.min(1, Math.max(0, s.opacity / 100));
    shape[i * 4 + 3] = MODE[s.kind] ?? 1;
  }
  return {
    uSpotCount: n,
    uSpotDst: dst,
    uSpotSrc: src,
    uSpotShape: shape,
    uHealSigmaPx: [HEAL_BLUR_SMALL * ctx.scale, HEAL_BLUR_LARGE * ctx.scale],
  };
}

/**
 * Heal/clone spots, source space. `extra.spots` = the chunk for this
 * invocation (≤ MAX_SPOTS_PER_PASS). 'clone' copies src → dst; 'heal' and
 * 'content-aware' (source auto-picked) add the low-frequency boundary match.
 * Spots within a chunk are applied in order (later on top); a spot reads its
 * source from the chunk's input, i.e. before earlier spots of the same chunk.
 */
export const HEAL_PASS: PassDef = {
  name: 'fx-heal',
  fragment: fragment(GLSL_SAMPLING, HEAL_GLSL),
  inputs: ['uInput'],
  blurs: [
    { uniform: 'uHealBlurS', source: 'uInput', sigma: HEAL_BLUR_SMALL },
    { uniform: 'uHealBlurL', source: 'uInput', sigma: HEAL_BLUR_LARGE },
  ],
  uniforms: (_params, ctx, extra) => healUniforms(extra?.spots ?? [], ctx),
  isIdentity: (_params, _ctx, extra) => {
    const spots = extra?.spots ?? [];
    return !spots.some((s) => s.opacity > 0 && s.radius > 0);
  },
};
