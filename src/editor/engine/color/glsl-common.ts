/**
 * GLSL building blocks shared by the PRE / DEVELOP / LOCAL shaders.
 *
 * Include order in a fragment shader:
 *   GLSL_HEADER, GLSL_COLOR_LIB (color/math), GLSL_TONE (tone.ts),
 *   GLSL_COLOR_OPS, [GLSL_TONE_STAGE], [GLSL_HSL], [GLSL_GRADE], main().
 */
import {
  BASE_ML_HI,
  BASE_ML_LO,
  BASE_PIX_HI,
  BASE_PIX_LO,
  CLARITY_GAIN,
  CLARITY_LIMIT,
  CLARITY_MID_HI0,
  CLARITY_MID_HI1,
  CLARITY_MID_LO0,
  CLARITY_MID_LO1,
  CLARITY_SMOOTH,
  DEHAZE_COMPENSATE,
  DEHAZE_EPS,
  DEHAZE_OMEGA,
  DEHAZE_T_MIN,
  HAZE_ADD,
  HAZE_AIRLIGHT,
  LOCAL_CONTRAST_GAIN,
  LOCAL_CONTRAST_LIMIT,
  LOCAL_CONTRAST_SMOOTH,
  STRUCTURE_EDGE_HI,
  STRUCTURE_EDGE_LO,
  STRUCTURE_GAIN,
  STRUCTURE_LIMIT,
  STRUCTURE_SMOOTH,
  TEXTURE_EDGE_HI,
  TEXTURE_EDGE_LO,
  TEXTURE_FLAT_HI,
  TEXTURE_FLAT_LO,
  TEXTURE_GAIN,
  TEXTURE_LIMIT,
  TEXTURE_SMOOTH,
  VAR_QUANT,
  glslFloat as f,
} from './constants';

/** Mandatory first lines of every fragment shader (see pass-types.ts). */
export const GLSL_HEADER = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
in vec2 vUv;
out vec4 outColor;
`;

/** Gamut-safe colour helpers. Needs GLSL_COLOR_LIB. */
export const GLSL_COLOR_OPS = /* glsl */ `
const float PI = 3.14159265358979;

float maxc(vec3 c) { return max(c.r, max(c.g, c.b)); }
float minc(vec3 c) { return min(c.r, min(c.g, c.b)); }

// sRGB-encoded value of the TRUE (linear Rec.709) luminance of encoded colour e.
float encLuma(vec3 e) { return linearToSrgb1(luma(srgbToLinear(max(e, vec3(0.0))))); }

float chromaHeadroom(float d, float ye) {
  if (d > 1e-6) return max(1.0 - ye, 0.0) / d;
  if (d < -1e-6) return max(ye, 0.0) / -d;
  return 1e6;
}

// Scale the chroma of encoded colour e about its luminance-matched grey ye.
// f = 0 gives the exact luminance-preserving grey (proper B&W). f > 1 is
// soft-limited against the gamut headroom (x·r / sqrt(r² + x²)), so strong
// boosts roll off smoothly instead of clipping a channel (no hue skew).
vec3 scaleChroma(vec3 e, float ye, float fac) {
  vec3 d = e - vec3(ye);
  if (fac > 1.0) {
    float lim = min(chromaHeadroom(d.r, ye), min(chromaHeadroom(d.g, ye), chromaHeadroom(d.b, ye)));
    float room = max(lim - 1.0, 0.0);
    float x = fac - 1.0;
    fac = 1.0 + x * room * inversesqrt(room * room + x * x + 1e-12);
  }
  return vec3(ye) + d * max(fac, 0.0);
}

// Bring encoded colour e into [0,1] without changing its hue. Negative
// channels are removed by desaturating towards the luminance-matched grey.
// For channels above 1 the result mixes (by keepLum) a luminance-preserving
// desaturation with a saturation-preserving scale-down, both of which keep
// the hue; the mix avoids both flat white and dull highlights.
vec3 fitGamut(vec3 e, float keepLum) {
  float mx = maxc(e);
  float mn = minc(e);
  if (mx <= 1.0 && mn >= 0.0) return e;
  float ye = encLuma(e);
  if (mn < 0.0) {
    e = ye > 0.0 ? mix(e, vec3(ye), -mn / (ye - mn)) : vec3(0.0);
    mx = maxc(e);
  }
  if (mx > 1.0) {
    float yc = min(ye, 1.0);
    vec3 desat = mix(e, vec3(yc), (mx - 1.0) / max(mx - yc, 1e-6));
    e = mix(e / mx, desat, keepLum);
  }
  return clamp(e, 0.0, 1.0);
}

// Soft membership of hue h (degrees) in the arc lo → hi (counter-clockwise, may wrap).
float hueArc(float h, float lo, float hi, float feather) {
  float width = hi - lo;
  if (width < 0.0) width += 360.0;
  if (width >= 359.9) return 1.0;
  float halfW = 0.5 * width;
  float d = abs(hueDelta(lo + halfW, h));
  return 1.0 - smoothstep(halfW - feather, halfW + feather, d);
}

// Local standard deviation (EV) from a guide blur (E[L], E[L²]), with the
// half-float cancellation error removed so flat areas read as flat.
float localStd(vec2 g) {
  float m2 = g.x * g.x;
  return sqrt(max(g.y - m2 - ${f(VAR_QUANT)} * (m2 + 1.0), 0.0));
}
`;

/**
 * Dehaze, highlights/shadows and presence in linear light, shared by DEVELOP
 * and LOCAL. Needs GLSL_COLOR_LIB, GLSL_TONE and GLSL_COLOR_OPS.
 *
 * Guides are vec4(L, L², minRGB, minRGB²) blurred at the small / medium /
 * large radius (see guide.ts), L in tone space.
 */
export const GLSL_TONE_STAGE = /* glsl */ `
// Edge-aware base for local tone mapping (tone space). The large blur gives
// the most natural local adaptation but halos around big structures; where
// it disagrees with the medium blur (a large edge is within reach) we slide
// to the medium one, and right next to a hard edge — where the pixel itself
// is far from any smooth base — we follow the pixel (pure global behaviour,
// hence no halo at all).
float toneBase(float L, float Lm, float Ll) {
  float b = mix(Ll, Lm, smoothstep(${f(BASE_ML_LO)}, ${f(BASE_ML_HI)}, abs(Ll - Lm)));
  return mix(b, L, smoothstep(${f(BASE_PIX_LO)}, ${f(BASE_PIX_HI)}, abs(L - b)));
}

float mediumBase(float L, float Lm) {
  return mix(Lm, L, smoothstep(${f(BASE_PIX_LO)}, ${f(BASE_PIX_HI)}, abs(L - Lm)));
}

// Dark-channel refinement: a Lee (local Wiener) filter pulls the blurred
// min-channel towards the pixel's own min-channel where the local variance
// is high (edges), removing the classic DCP halos; capping at the pixel's
// min-channel guarantees the dehazed colour never goes negative.
float refineDark(float minPix, float mean, float meanSq) {
  float v = max(meanSq - mean * mean, 0.0);
  float a = v / (v + ${f(DEHAZE_EPS)});
  return clamp(min(mean + a * (minPix - mean), minPix), 0.0, 1.0);
}

float hazeTransmission(float dark, float amount) {
  return max(1.0 - ${f(DEHAZE_OMEGA)} * amount * dark, ${f(DEHAZE_T_MIN)});
}

// Presence ΔL (EV). p = (texture, clarity, structure, localContrast) in -1..1.
//  texture:  fine band L − Ls, boosted only where there is fine structure
//            (spares skin, sky); negative smooths it except on real edges.
//  clarity:  mid band Ls − medium base, mid-tones only; negative softens.
//  structure: fine+mid detail weighted by medium-scale edge strength.
//  local contrast: large band L − edge-aware large base.
// Positive gains go through softLimit so large (edge) differences cannot
// overshoot into halos.
float presenceDelta(float L, float Ls, float bm, float bl, float stdS, float stdM, vec4 p) {
  float d = 0.0;
  if (p.x != 0.0) {
    float band = L - Ls;
    if (p.x > 0.0) d += p.x * ${f(TEXTURE_GAIN)} * softLimit(band, ${f(TEXTURE_LIMIT)}) * smoothstep(${f(TEXTURE_FLAT_LO)}, ${f(TEXTURE_FLAT_HI)}, stdS);
    else d += p.x * ${f(TEXTURE_SMOOTH)} * band * (1.0 - smoothstep(${f(TEXTURE_EDGE_LO)}, ${f(TEXTURE_EDGE_HI)}, stdS));
  }
  if (p.y != 0.0) {
    float band = Ls - bm;
    float w = smoothstep(${f(CLARITY_MID_LO0)}, ${f(CLARITY_MID_LO1)}, bm) * (1.0 - smoothstep(${f(CLARITY_MID_HI0)}, ${f(CLARITY_MID_HI1)}, bm));
    d += p.y * w * (p.y > 0.0 ? ${f(CLARITY_GAIN)} * softLimit(band, ${f(CLARITY_LIMIT)}) : ${f(CLARITY_SMOOTH)} * band);
  }
  if (p.z != 0.0) {
    float band = 0.5 * (L - Ls) + (Ls - bm);
    float w = smoothstep(${f(STRUCTURE_EDGE_LO)}, ${f(STRUCTURE_EDGE_HI)}, stdM);
    d += p.z * w * (p.z > 0.0 ? ${f(STRUCTURE_GAIN)} * softLimit(band, ${f(STRUCTURE_LIMIT)}) : ${f(STRUCTURE_SMOOTH)} * band);
  }
  if (p.w != 0.0) {
    float band = L - bl;
    d += p.w * (p.w > 0.0 ? ${f(LOCAL_CONTRAST_GAIN)} * softLimit(band, ${f(LOCAL_CONTRAST_LIMIT)}) : ${f(LOCAL_CONTRAST_SMOOTH)} * band);
  }
  return d;
}

// Apply the same per-pixel dehaze to a tone-space guide value.
float dehazeL(float L, float t, float comp, float veil) {
  float y = toneY(L);
  y = veil > 0.0 ? mix(y, ${f(HAZE_AIRLIGHT)}, veil) : max((y - (1.0 - t)) / t, 0.0) * comp;
  return toneL(y);
}

// Shift a tone-space guide value by an exposure change of ev stops.
float exposeL(float L, float ev) { return ev == 0.0 ? L : toneL(toneY(L) * exp2(ev)); }

// c: linear rgb. gs/gm/gl: guides of the image the blurs were made from;
// ev: exposure applied to c since then (LOCAL), 0 for DEVELOP.
// dehaze in -1..1, hs = (highlights, shadows) in -1..1, presence as above.
vec3 toneStage(vec3 c, vec4 gs, vec4 gm, vec4 gl, float ev, float dehaze, vec2 hs, vec4 presence) {
  float Ls = exposeL(gs.x, ev);
  float Lm = exposeL(gm.x, ev);
  float Ll = exposeL(gl.x, ev);
  float stdS = localStd(gs.xy);
  float stdM = localStd(gm.xy);

  if (dehaze != 0.0) {
    float k = exp2(ev);
    float t = 1.0;
    float comp = 1.0;
    float veil = 0.0;
    if (dehaze > 0.0) {
      float dark = refineDark(clamp(minc(c), 0.0, 1.0), gm.z * k, gm.w * k * k);
      t = hazeTransmission(dark, dehaze);
      // Give back part of the local brightness the veil removal takes away
      // (measured on the large-scale mean), keeping the contrast gain.
      float tl = hazeTransmission(clamp(gl.z * k, 0.0, 1.0), dehaze);
      float ym = toneY(Ll);
      float yd = (ym - (1.0 - tl)) / tl;
      comp = clamp(pow(ym / max(yd, 1e-4), ${f(DEHAZE_COMPENSATE)}), 1.0, 4.0);
      c = (c - vec3(1.0 - t)) / t * comp;
    } else {
      // Negative: add a veil, thicker where the scene is already bright/hazy.
      veil = -dehaze * ${f(HAZE_ADD)} * (0.45 + 0.55 * smoothstep(0.0, 0.5, gm.z * k));
      c = mix(c, vec3(${f(HAZE_AIRLIGHT)}), veil);
    }
    Ls = dehazeL(Ls, t, comp, veil);
    Lm = dehazeL(Lm, t, comp, veil);
    Ll = dehazeL(Ll, t, comp, veil);
  }

  float dL = 0.0;
  bool hsOn = hs.x != 0.0 || hs.y != 0.0;
  bool presOn = any(notEqual(presence, vec4(0.0)));
  if (hsOn || presOn) {
    float L = toneL(luma(c));
    float base = toneBase(L, Lm, Ll);
    if (hsOn) dL += highlightsDelta(base, hs.x) + shadowsDelta(base, hs.y);
    if (presOn) dL += presenceDelta(L, Ls, mediumBase(L, Lm), base, stdS, stdM, presence);
  }
  return c * exp2(dL);
}
`;
