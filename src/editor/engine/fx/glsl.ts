/**
 * GLSL building blocks shared by the fx passes. Every fragment shader is
 * `FX_HEADER + GLSL_COLOR_LIB + (helpers) + body`.
 *
 * Sampling policy:
 * - Images the pass reads at exact texel positions use `texelFetch` so the
 *   result does not depend on the texture's filter mode (the uploaded source
 *   may be RGBA32F, which is not filterable everywhere).
 * - Blur textures (BlurRequest results, possibly lower resolution) and
 *   fractional-offset taps in DETAIL/EFFECTS use `texture()`, which requires
 *   LINEAR filtering + CLAMP_TO_EDGE (RGBA16F/RGBA8 render targets are always
 *   filterable in WebGL2).
 */
import { GLSL_COLOR_LIB } from '../../color/math';

export const FX_HEADER = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
in vec2 vUv;
out vec4 outColor;
`;

/** Clamp-to-edge texel fetches, manual bilinear and anti-ringing Catmull-Rom. */
export const GLSL_SAMPLING = /* glsl */ `
vec4 fetchClamped(sampler2D t, ivec2 p) {
  ivec2 s = textureSize(t, 0);
  return texelFetch(t, clamp(p, ivec2(0), s - 1), 0);
}

// Bilinear from texel fetches (independent of the sampler's filter mode).
vec4 sampleBilinear(sampler2D t, vec2 uv) {
  vec2 size = vec2(textureSize(t, 0));
  vec2 p = uv * size - 0.5;
  vec2 f = fract(p);
  ivec2 i = ivec2(floor(p));
  vec4 a = fetchClamped(t, i);
  vec4 b = fetchClamped(t, i + ivec2(1, 0));
  vec4 c = fetchClamped(t, i + ivec2(0, 1));
  vec4 d = fetchClamped(t, i + ivec2(1, 1));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// Catmull-Rom (a = -0.5) bicubic from 16 fetches. Exact at texel centres
// (weights 0,1,0,0), so identity warps copy pixels bit-for-bit. The result is
// clamped to the min/max of the 4 nearest texels to suppress ringing halos at
// hard edges.
vec4 sampleCatmullRom(sampler2D t, vec2 uv) {
  vec2 size = vec2(textureSize(t, 0));
  vec2 p = uv * size - 0.5;
  vec2 f = fract(p);
  ivec2 i = ivec2(floor(p));
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec4 acc = vec4(0.0);
  vec4 lo = vec4(1e20);
  vec4 hi = vec4(-1e20);
  for (int y = 0; y < 4; y++) {
    float wy = y == 0 ? w0.y : (y == 1 ? w1.y : (y == 2 ? w2.y : w3.y));
    vec4 row = vec4(0.0);
    for (int x = 0; x < 4; x++) {
      float wx = x == 0 ? w0.x : (x == 1 ? w1.x : (x == 2 ? w2.x : w3.x));
      vec4 s = fetchClamped(t, i + ivec2(x - 1, y - 1));
      row += s * wx;
      if ((x == 1 || x == 2) && (y == 1 || y == 2)) { lo = min(lo, s); hi = max(hi, s); }
    }
    acc += row * wy;
  }
  return clamp(acc, lo, hi);
}
`;

/**
 * Deterministic integer hashing (PCG-style, Jarzynski & Olano 2020) and 2-D
 * gradient noise. Pure functions of integer lattice coordinates, so results
 * are identical across tiles, resolutions and GPUs.
 */
export const GLSL_NOISE = /* glsl */ `
uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
// Lattice coordinates are offset so the image (0..~10^4 cells) stays positive.
vec2 latticeGradient(ivec2 c, uint seed) {
  uvec3 h = pcg3d(uvec3(uvec2(c + ivec2(32768)), seed));
  float a = float(h.x) * (6.28318530718 / 4294967296.0);
  return vec2(cos(a), sin(a));
}
// Perlin gradient noise, zero mean, std ≈ 0.20 (normalized by GRAD_NOISE_STD).
const float GRAD_NOISE_STD = 0.2;
float gradientNoise(vec2 p, uint seed) {
  vec2 i = floor(p);
  vec2 f = p - i;
  ivec2 c = ivec2(i);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n00 = dot(latticeGradient(c, seed), f);
  float n10 = dot(latticeGradient(c + ivec2(1, 0), seed), f - vec2(1.0, 0.0));
  float n01 = dot(latticeGradient(c + ivec2(0, 1), seed), f - vec2(0.0, 1.0));
  float n11 = dot(latticeGradient(c + ivec2(1, 1), seed), f - vec2(1.0, 1.0));
  return mix(mix(n00, n10, u.x), mix(n01, n11, u.x), u.y);
}
`;

/** Assemble a fragment shader from the header, the color library and body chunks. */
export function fragment(...chunks: string[]): string {
  return [FX_HEADER, GLSL_COLOR_LIB, ...chunks].join('\n');
}
