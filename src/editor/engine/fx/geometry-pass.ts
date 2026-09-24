/**
 * GEOMETRY pass: renders the output (cropped, or the whole frame when
 * ctx.ignoreCrop; optionally only the ctx.outRect sub-rectangle) from the
 * source-space image.
 *
 * Per output pixel: vUv → (one homography) → lens-corrected L → radial lens
 * model → source position, i.e. exactly `outputToSource` of engine/geometry.ts
 * with the numbers from `buildGeometryUniforms`.
 *
 * Output (straight, non-premultiplied alpha):
 *   .rgb = resampled colour, .a = image coverage (1 inside, 0 outside, a
 *   1-pixel anti-aliased ramp on the image border). Fully outside → vec4(0).
 * Overlay mode (GEOMETRY_OVERLAY_PASS, uOverlayMode = 1): the R channel of
 *   uOverlay (mask coverage, source space) is warped instead:
 *   .rgb = coverage (replicated), .a = image coverage.
 *
 * Sampling: Catmull-Rom (anti-ringing) in full quality, bilinear in draft;
 * both via texelFetch so the source may be an unfilterable RGBA32F texture.
 * When the output minifies the source (export downsizing, thumbnails) the
 * pixel footprint is supersampled with up to 4×4 bilinear taps.
 */
import type { PassContext, PassDef } from '../pass-types';
import type { EditParams } from '../../types';
import { buildGeometryUniforms, isGeometryIdentity } from './geometry-core';
import { GLSL_SAMPLING, fragment } from './glsl';

const GEOMETRY_GLSL = /* glsl */ `
uniform sampler2D uInput;
uniform sampler2D uOverlay;
uniform vec3 uGeoRow0;
uniform vec3 uGeoRow1;
uniform vec3 uGeoRow2;
uniform vec3 uLensK;
uniform vec2 uLensAxis;
uniform vec2 uCA;
uniform float uUseCA;
uniform float uBicubic;
uniform float uOverlayMode;

// L → S radial model. Returns the source position; .z = 1 when the model is
// monotone at this radius (0 = folded over, treat as outside).
vec3 lensToSource(vec2 l) {
  vec2 d = l - 0.5;
  vec2 e = d * uLensAxis;
  float r2 = dot(e, e);
  float g = 1.0 + r2 * (uLensK.x + r2 * (uLensK.y + r2 * uLensK.z));
  float slope = 1.0 + r2 * (3.0 * uLensK.x + r2 * (5.0 * uLensK.y + r2 * 7.0 * uLensK.z));
  return vec3(0.5 + d * g, slope > 0.0 ? 1.0 : 0.0);
}

vec4 sampleImage(sampler2D t, vec2 uv, vec2 jx, vec2 jy, float footprint) {
  // Snap positions within 1/1000 texel of a texel centre onto it: varying
  // interpolation leaves ~1e-5 texel of float noise, which would otherwise
  // make identity/90° copies inexact.
  vec2 ts = vec2(textureSize(t, 0));
  vec2 tp = uv * ts - 0.5;
  vec2 tr = floor(tp + 0.5);
  uv = (mix(tp, tr, step(abs(tp - tr), vec2(1e-3))) + 0.5) / ts;
  if (footprint > 1.25) {
    // Minification: box-filter the pixel footprint (jx/jy = source uv per output pixel).
    int n = int(clamp(ceil(footprint), 2.0, 4.0));
    vec4 acc = vec4(0.0);
    for (int y = 0; y < 4; y++) {
      if (y >= n) break;
      for (int x = 0; x < 4; x++) {
        if (x >= n) break;
        vec2 o = (vec2(float(x), float(y)) + 0.5) / float(n) - 0.5;
        acc += sampleBilinear(t, uv + jx * o.x + jy * o.y);
      }
    }
    return acc / float(n * n);
  }
  return uBicubic > 0.5 ? sampleCatmullRom(t, uv) : sampleBilinear(t, uv);
}

void main() {
  vec3 h = vec3(dot(uGeoRow0, vec3(vUv, 1.0)), dot(uGeoRow1, vec3(vUv, 1.0)), dot(uGeoRow2, vec3(vUv, 1.0)));
  vec3 s = vec3(-1.0);
  if (h.z > 1e-12) s = lensToSource(h.xy / h.z);
  vec2 src = s.xy;

  // Derivatives before any divergent branch.
  // (GLSL ES forbids samplers as ?: operands.)
  vec2 size = uOverlayMode > 0.5 ? vec2(textureSize(uOverlay, 0)) : vec2(textureSize(uInput, 0));
  vec2 jx = dFdx(src);
  vec2 jy = dFdy(src);
  float footprint = max(length(jx * size), length(jy * size));

  if (h.z <= 1e-12 || s.z < 0.5) { outColor = vec4(0.0); return; }

  // Signed distance to the source border in source pixels → output pixels.
  vec2 sp = src * size;
  float dpx = min(min(sp.x, size.x - sp.x), min(sp.y, size.y - sp.y));
  float cover = clamp(dpx / max(footprint, 1e-4) + 0.5, 0.0, 1.0);
  if (cover <= 0.0) { outColor = vec4(0.0); return; }

  if (uOverlayMode > 0.5) {
    float m = sampleImage(uOverlay, src, jx, jy, footprint).r;
    outColor = vec4(vec3(m), cover);
    return;
  }

  vec4 c = sampleImage(uInput, src, jx, jy, footprint);
  if (uUseCA > 0.5) {
    vec2 sr = 0.5 + (src - 0.5) * uCA.x;
    vec2 sb = 0.5 + (src - 0.5) * uCA.y;
    c.r = sampleImage(uInput, sr, jx * uCA.x, jy * uCA.x, footprint * uCA.x).r;
    c.b = sampleImage(uInput, sb, jx * uCA.y, jy * uCA.y, footprint * uCA.y).b;
  }
  outColor = vec4(c.rgb, cover);
}
`;

const GEOMETRY_FRAGMENT = fragment(GLSL_SAMPLING, GEOMETRY_GLSL);

function geometryIdentity(params: EditParams, ctx: PassContext): boolean {
  if (ctx.width !== ctx.srcWidth || ctx.height !== ctx.srcHeight) return false;
  return isGeometryIdentity(buildGeometryUniforms(params, ctx));
}

/**
 * Main geometry pass. Inputs: uInput (source-space image after DETAIL/LOCAL),
 * uOverlay (unused in this mode; may be left unbound).
 * Render target: ctx.width × ctx.height = outWidth×outHeight scaled by
 * ctx.outRect (tile/zoom) — the pass itself only needs vUv.
 */
export const GEOMETRY_PASS: PassDef = {
  name: 'fx-geometry',
  fragment: GEOMETRY_FRAGMENT,
  inputs: ['uInput', 'uOverlay'],
  uniforms: (params, ctx) => buildGeometryUniforms(params, ctx),
  isIdentity: geometryIdentity,
};

/**
 * Same shader in overlay mode: warps the R channel of uOverlay (mask
 * coverage, source space) into output space (.rgb = coverage, .a = image
 * coverage). Bind the mask coverage to uOverlay; uInput may be any texture
 * (it is not sampled). Never an identity skip (its output differs in kind).
 */
export const GEOMETRY_OVERLAY_PASS: PassDef = {
  name: 'fx-geometry-overlay',
  fragment: GEOMETRY_FRAGMENT,
  inputs: ['uInput', 'uOverlay'],
  uniforms: (params, ctx) => ({ ...buildGeometryUniforms(params, ctx), uOverlayMode: 1 }),
};
