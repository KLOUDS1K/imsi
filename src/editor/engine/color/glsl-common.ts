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
  DEHAZE_AIRLIGHT,
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
  TEXTURE_EDGE_TAPER_HI,
  TEXTURE_EDGE_TAPER_LO,
  TEXTURE_FLAT_HI,
  TEXTURE_FLAT_LO,
  TEXTURE_GAIN,
  TEXTURE_LIMIT,
  TEXTURE_SMOOTH,
  TONE_EPS_L,
  TONE_EPS_M,
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

// Sharp soft-min of x ≥ 0 against r ≥ 0: ≈ x for x ≪ r, → r for x ≫ r.
float softMin4(float x, float r) {
  float x2 = x * x;
  float r2 = r * r;
  return x * r * inversesqrt(sqrt(x2 * x2 + r2 * r2) + 1e-12);
}

// Scale the chroma of encoded colour e about its luminance-matched grey ye.
// f ≤ 1 desaturates (f = 0 → the exact luminance-preserving grey, proper
// B&W). For f > 1 the boost is soft-limited so no channel can reach 0
// (dark saturated colours roll off instead of clipping), and when the
// brightest channel would grow past 1 its growth is folded smoothly into the
// remaining headroom by dimming the colour (hue and the boosted saturation
// kept), which is how a bright colour can still get more saturated.
vec3 scaleChroma(vec3 e, float ye, float fac) {
  vec3 d = e - vec3(ye);
  if (fac <= 1.0) return vec3(ye) + d * max(fac, 0.0);
  float lim = 1e6;
  if (d.r < -1e-6) lim = min(lim, max(ye, 0.0) / -d.r);
  if (d.g < -1e-6) lim = min(lim, max(ye, 0.0) / -d.g);
  if (d.b < -1e-6) lim = min(lim, max(ye, 0.0) / -d.b);
  fac = 1.0 + softMin4(fac - 1.0, max(lim - 1.0, 0.0));
  vec3 o = vec3(ye) + d * fac;
  float m0 = maxc(e);
  float m1 = maxc(o);
  if (m1 > m0 && m1 > 1e-6) {
    float head = max(1.0 - m0, 0.0);
    float m2 = m0 + softMin4(m1 - m0, head);
    o *= m2 / m1;
  }
  return o;
}

// Remove negative LINEAR channels by desaturating towards the luminance
// (hue kept) instead of clipping each channel to 0.
vec3 fitFloorLinear(vec3 c) {
  float mn = minc(c);
  if (mn >= 0.0) return c;
  float y = luma(c);
  return y > 0.0 ? mix(c, vec3(y), -mn / (y - mn)) : vec3(0.0);
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
// Lee (local Wiener) gain v / (v + eps) from a guide's (E[L], E[L²]).
float leeGain(vec2 g, float eps) {
  float s = localStd(g);
  float v = s * s;
  return v / (v + eps);
}

// Dark-channel refinement: the same Lee filter pulls the blurred min-channel
// towards the pixel's own min-channel where the local variance is high
// (edges), removing the classic DCP halos; capping at the pixel's
// min-channel guarantees the dehazed colour never goes negative.
float refineDark(float minPix, float mean, float meanSq) {
  float v = max(meanSq - mean * mean, 0.0);
  float a = v / (v + ${f(DEHAZE_EPS)});
  return clamp(min(mean + a * (minPix - mean), minPix), 0.0, 1.0);
}

// Transmission for a positive amount. dark/A is soft-capped at ~1 so bright
// non-haze objects (clouds, white walls) are not treated as dense haze.
float hazeTransmission(float dark, float amount) {
  float d = dark / ${f(DEHAZE_AIRLIGHT)};
  d = d * inversesqrt(sqrt(1.0 + d * d * d * d));
  return max(1.0 - ${f(DEHAZE_OMEGA)} * amount * d, ${f(DEHAZE_T_MIN)});
}

// Presence ΔL (EV). p = (texture, clarity, structure, localContrast) in -1..1.
//  texture:  fine band L − Ls, boosted only where there is fine structure
//            (spares skin, sky) and tapered on hard edges; negative smooths
//            it except on real edges.
//  clarity:  mid band Ls − bm (edge-aware medium base), mid-tones only;
//            negative softens.
//  structure: fine+mid detail weighted by medium-scale edge strength.
//  local contrast: large band L − edge-aware base.
// Positive gains go through softLimit so large differences cannot overshoot.
float presenceDelta(float L, float Ls, float bm, float bl, float stdS, float stdM, vec4 p) {
  float d = 0.0;
  if (p.x != 0.0) {
    float band = L - Ls;
    if (p.x > 0.0) {
      float w = smoothstep(${f(TEXTURE_FLAT_LO)}, ${f(TEXTURE_FLAT_HI)}, stdS)
              * (1.0 - 0.7 * smoothstep(${f(TEXTURE_EDGE_TAPER_LO)}, ${f(TEXTURE_EDGE_TAPER_HI)}, stdS));
      d += p.x * ${f(TEXTURE_GAIN)} * softLimit(band, ${f(TEXTURE_LIMIT)}) * w;
    } else {
      d += p.x * ${f(TEXTURE_SMOOTH)} * band * (1.0 - smoothstep(${f(TEXTURE_EDGE_LO)}, ${f(TEXTURE_EDGE_HI)}, stdS));
    }
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
  y = veil > 0.0 ? mix(y, ${f(HAZE_AIRLIGHT)}, veil) : max((y - ${f(DEHAZE_AIRLIGHT)} * (1.0 - t)) / t, 0.0) * comp;
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
  // Statistics of the original guides (a global exposure or dehaze changes
  // the means, the edge/texture decisions stay the same).
  float stdS = localStd(gs.xy);
  float stdM = localStd(gm.xy);
  float aM = leeGain(gm.xy, ${f(TONE_EPS_M)});
  float aL = leeGain(gl.xy, ${f(TONE_EPS_L)});

  if (dehaze != 0.0) {
    float k = exp2(ev);
    float t = 1.0;
    float comp = 1.0;
    float veil = 0.0;
    if (dehaze > 0.0) {
      // I = J·t + A·(1 − t)  →  J = (I − A·(1 − t)) / t, then a mild
      // brightness give-back t^−γ so the result is not simply darker.
      float dark = refineDark(clamp(minc(c), 0.0, 1.0), gm.z * k, gm.w * k * k);
      t = hazeTransmission(dark, dehaze);
      comp = pow(t, -${f(DEHAZE_COMPENSATE)});
      c = (c - vec3(${f(DEHAZE_AIRLIGHT)} * (1.0 - t))) / t * comp;
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
    // Edge-aware bases (Lee-refined means), mixed large → medium where the
    // two scales disagree (a big structure nearby), and finally following
    // the pixel where it is still far from any smooth base.
    float bm = Lm + aM * (L - Lm);
    float bl = Ll + aL * (L - Ll);
    float base = mix(bl, bm, smoothstep(${f(BASE_ML_LO)}, ${f(BASE_ML_HI)}, abs(Ll - Lm)));
    base = mix(base, L, smoothstep(${f(BASE_PIX_LO)}, ${f(BASE_PIX_HI)}, abs(L - base)));
    if (hsOn) dL += highlightsDelta(base, hs.x) + shadowsDelta(base, hs.y);
    if (presOn) dL += presenceDelta(L, Ls, bm, base, stdS, stdM, presence);
  }
  return c * exp2(dL);
}
`;
