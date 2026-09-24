/**
 * Engine-internal fragment shaders (upload/resample, blur, clipping mask,
 * present, export encode). They follow the same conventions as the pass
 * modules: framebuffer row 0 = image top, vUv from the shared vertex shader.
 * Shaders that address pixels use gl_FragCoord (window coordinates are
 * framebuffer pixels regardless of the viewport), which keeps tiled draws
 * into sub-viewports exact.
 */
import { GLSL_COLOR_LIB } from '../color/math';

const HEADER = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
in vec2 vUv;
out vec4 outColor;
`;

/**
 * Exact area-average resampler (box filter with fractional pixel coverage).
 * Output pixel o covers source rect [o·ratio, (o+1)·ratio); every source
 * texel inside contributes its overlap area. The source may be a tile of a
 * larger image (uTile) — draws of several tiles into the same target with
 * additive blending then sum to the full average, so any source size can be
 * decoded through textures ≤ MAX_TEXTURE_SIZE.
 *
 * Decode per texel (before averaging, i.e. in linear light):
 *   raw × uScaleIn → optional sRGB decode → primaries matrix → premultiply.
 * `RAW_UINT` variant reads RGBA16UI textures (16-bit sources, normalized by uScaleIn = 1/65535).
 */
function resampleShader(uint: boolean): string {
  return /* glsl */ `${HEADER}
${uint ? 'precision highp usampler2D;\nuniform usampler2D uSrc;' : 'uniform sampler2D uSrc;'}
${GLSL_COLOR_LIB}
uniform vec2 uRatio;       // source px per output px
uniform vec4 uTile;        // x0, y0, w, h of the tile in source px (texel (0,0) of uSrc = (x0, y0))
uniform float uScaleIn;
uniform int uTransferIn;   // 0 linear, 1 sRGB-encoded
uniform vec3 uM0;          // rows of the primaries → linear sRGB matrix
uniform vec3 uM1;
uniform vec3 uM2;
uniform bool uOpaque;      // ignore source alpha
uniform bool uUnpremultiply;
uniform int uTransferOut;  // 0 linear, 1 sRGB encode

vec4 load(ivec2 p) {
  vec4 c = vec4(texelFetch(uSrc, p, 0)) * uScaleIn;
  vec3 rgb = uTransferIn == 1 ? srgbToLinear(c.rgb) : c.rgb;
  rgb = vec3(dot(uM0, rgb), dot(uM1, rgb), dot(uM2, rgb));
  float a = uOpaque ? 1.0 : clamp(c.a, 0.0, 1.0);
  return vec4(rgb * a, a);
}

void main() {
  vec2 o = floor(gl_FragCoord.xy);
  vec2 lo = max(o * uRatio, uTile.xy);
  vec2 hi = min((o + 1.0) * uRatio, uTile.xy + uTile.zw);
  if (hi.x <= lo.x || hi.y <= lo.y) { outColor = vec4(0.0); return; }
  ivec2 i0 = ivec2(floor(lo));
  ivec2 i1 = ivec2(ceil(hi));
  ivec2 t0 = ivec2(uTile.xy);
  vec4 acc = vec4(0.0);
  for (int y = i0.y; y < i1.y; y++) {
    float wy = min(hi.y, float(y + 1)) - max(lo.y, float(y));
    for (int x = i0.x; x < i1.x; x++) {
      float wx = min(hi.x, float(x + 1)) - max(lo.x, float(x));
      acc += (wx * wy) * load(ivec2(x, y) - t0);
    }
  }
  float area = uRatio.x * uRatio.y;
  vec3 rgb = uUnpremultiply ? acc.rgb / max(acc.a, 1e-8) : acc.rgb / area;
  if (uTransferOut == 1) rgb = linearToSrgb(rgb);
  outColor = vec4(rgb, acc.a / area);
}
`;
}

export const RESAMPLE_FRAGMENT = resampleShader(false);
export const RESAMPLE_UINT_FRAGMENT = resampleShader(true);

/** Bilinear 2× reduction at texel corners (= exact 2×2 box for even sizes, keeps normalized coords for odd). */
export const DOWNSAMPLE_FRAGMENT = /* glsl */ `${HEADER}
uniform sampler2D uSrc;
void main() { outColor = texture(uSrc, vUv); }
`;

/** One direction of a separable Gaussian (clamp-to-edge). */
export const BLUR_FRAGMENT = /* glsl */ `${HEADER}
uniform sampler2D uSrc;
uniform vec2 uDir;
uniform float uSigma;
uniform int uRadius;
void main() {
  ivec2 size = textureSize(uSrc, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 d = ivec2(uDir);
  float k = -0.5 / (uSigma * uSigma);
  vec4 acc = texelFetch(uSrc, p, 0);
  float ws = 1.0;
  for (int i = 1; i <= uRadius; i++) {
    float w = exp(float(i * i) * k);
    acc += w * (texelFetch(uSrc, clamp(p + d * i, ivec2(0), size - 1), 0) + texelFetch(uSrc, clamp(p - d * i, ivec2(0), size - 1), 0));
    ws += 2.0 * w;
  }
  outColor = acc / ws;
}
`;

/**
 * Clipping mask of the display-referred output: R = highlight clip (any
 * channel reaches 255 in 8-bit terms), G = shadow clip (all channels at 0).
 * Mipmapped by the presenter so a clipped pixel stays visible when zoomed out.
 */
export const CLIP_FRAGMENT = /* glsl */ `${HEADER}
uniform sampler2D uSrc;
void main() {
  vec4 c = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0);
  if (c.a < 0.5) { outColor = vec4(0.0); return; }
  float hi = max(max(c.r, c.g), c.b) >= 254.5 / 255.0 ? 1.0 : 0.0;
  float lo = max(max(c.r, c.g), c.b) <= 0.5 / 255.0 ? 1.0 : 0.0;
  outColor = vec4(hi, lo, 0.0, 1.0);
}
`;

/**
 * Draw one image (output slot, detail tile or reference) into a canvas pane.
 * Canvas device pixel → CSS px → output px → normalized output uv → texture uv.
 */
export const PRESENT_FRAGMENT = /* glsl */ `${HEADER}
uniform sampler2D uImage;
uniform sampler2D uClip;
uniform sampler2D uOverlay;
uniform float uCanvasH;      // device px
uniform float uDpr;
uniform vec2 uOffset;        // CSS px of output pixel (0,0)
uniform float uScale;        // CSS px per output px
uniform vec2 uOutSize;       // output px
uniform vec4 uImgRect;       // normalized output rect covered by uImage
uniform vec4 uBg;
uniform vec2 uClipOn;        // highlights, shadows
uniform vec3 uClipHigh;
uniform vec3 uClipLow;
uniform bool uOverlayOn;
uniform vec4 uOverlayColor;
uniform bool uUseImageAlpha;

void main() {
  vec2 css = vec2(gl_FragCoord.x, uCanvasH - gl_FragCoord.y) / uDpr;
  vec2 uv = (css - uOffset) / (uScale * uOutSize);
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x >= 1.0 || uv.y >= 1.0) discard;
  vec2 tuv = (uv - uImgRect.xy) / uImgRect.zw;
  if (tuv.x < 0.0 || tuv.y < 0.0 || tuv.x > 1.0 || tuv.y > 1.0) discard;
  vec4 c = texture(uImage, tuv);
  float a = uUseImageAlpha ? clamp(c.a, 0.0, 1.0) : 1.0;
  vec3 rgb = clamp(c.rgb, 0.0, 1.0);
  if (uOverlayOn) {
    float m = clamp(texture(uOverlay, uv).r, 0.0, 1.0);
    rgb = mix(rgb, uOverlayColor.rgb, uOverlayColor.a * m);
  }
  if (uClipOn.x > 0.5 || uClipOn.y > 0.5) {
    vec2 k = texture(uClip, uv).rg;
    if (uClipOn.x > 0.5 && k.r > 0.0) rgb = uClipHigh;
    else if (uClipOn.y > 0.5 && k.g > 0.0) rgb = uClipLow;
  }
  outColor = vec4(mix(uBg.rgb, rgb, a), mix(uBg.a, 1.0, a));
}
`;

/** Solid fill (divider lines). */
export const FILL_FRAGMENT = /* glsl */ `${HEADER}
uniform vec4 uColor;
void main() { outColor = uColor; }
`;

/**
 * Export encode: display-referred sRGB (linear sRGB primaries) → target colour
 * space. sRGB: as is. Display P3: sRGB transfer with P3 primaries. Adobe RGB:
 * pure 563/256 gamma. uQuant > 0 rounds to that many levels (8-bit output is
 * then exact whatever the driver's float→unorm rounding mode).
 */
export const ENCODE_FRAGMENT = /* glsl */ `${HEADER}
${GLSL_COLOR_LIB}
uniform sampler2D uSrc;
uniform ivec2 uOffset;     // texel offset of the tile's inner region
uniform int uSpace;        // 0 srgb, 1 display-p3, 2 adobe-rgb
uniform vec3 uM0;
uniform vec3 uM1;
uniform vec3 uM2;
uniform float uGamma;      // adobe-rgb gamma
uniform float uQuant;      // 255 for 8-bit, 0 = none
void main() {
  vec4 c = texelFetch(uSrc, ivec2(gl_FragCoord.xy) + uOffset, 0);
  vec3 rgb = c.rgb;
  if (uSpace != 0) {
    vec3 lin = srgbToLinear(rgb);
    lin = vec3(dot(uM0, lin), dot(uM1, lin), dot(uM2, lin));
    rgb = uSpace == 1 ? linearToSrgb(lin) : pow(max(lin, 0.0), vec3(1.0 / uGamma));
  }
  vec4 o = clamp(vec4(rgb, c.a), 0.0, 1.0);
  if (uQuant > 0.0) o = floor(o * uQuant + 0.5) / uQuant;
  outColor = o;
}
`;
