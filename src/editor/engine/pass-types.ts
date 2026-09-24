/**
 * Contract between the engine orchestrator (engine-core) and the modules that
 * provide shader passes (engine/color = develop math, engine/fx = geometry,
 * detail, retouch, effects).
 *
 * TEXTURE CONVENTION (everyone): texture coordinate (0,0) is the TOP-LEFT pixel
 * of the image, v grows downwards. Pixel data is uploaded without
 * UNPACK_FLIP_Y and every intermediate FBO keeps this orientation; only the
 * final present-to-canvas pass flips. `vUv` in fragment shaders follows this
 * convention, so `texture(uInput, vUv)` is the same image position as the
 * output pixel. Normalized image coordinates in params (masks, crop, spots)
 * use the same convention: (0,0) = top-left.
 *
 * VERTEX SHADER: the orchestrator draws a full-screen triangle and provides
 * `in vec2 vUv;` to every fragment shader. Fragment shaders must start with
 * `#version 300 es`, declare `precision highp float;`, `in vec2 vUv;` and
 * `out vec4 outColor;`.
 *
 * UNIFORMS: the orchestrator introspects each program (getActiveUniform) and
 * sets values by their GLSL type, so `uniforms()` just returns plain values:
 * number → float/int/bool, number[] → vecN / matN / arrays (flattened), boolean → bool.
 * Uniforms a pass does not declare are ignored; declared uniforms that are not
 * returned keep their previous value (set everything every frame).
 *
 * Built-in uniforms set by the orchestrator on every pass when declared:
 *   vec2 uResolution   — size in pixels of the texture being rendered
 *   vec2 uTexel        — 1.0 / uResolution
 *   vec2 uInputTexel   — 1.0 / size of uInput
 *   float uScale       — PassContext.scale
 */
import type { LensCorrection } from '../contracts';
import type { EditParams, Mask, PhotoMeta, Rect } from '../types';

export type UniformValue = number | boolean | readonly number[] | Float32Array | Int32Array;
export type UniformMap = Record<string, UniformValue>;

export interface PassContext {
  /** Pixel size of the texture this pass renders into. */
  width: number;
  height: number;
  /** Pixel size of the source image at the current processing resolution. */
  srcWidth: number;
  srcHeight: number;
  /** Full-resolution source size (for resolution-independent parameters). */
  fullWidth: number;
  fullHeight: number;
  /**
   * Radius scale: processing long edge / 2560. A radius authored as R
   * "reference pixels" should be applied as R * scale actual pixels, so the
   * preview proxy and the full-size export look the same.
   */
  scale: number;
  quality: 'draft' | 'full';
  isRaw: boolean;
  meta: PhotoMeta;
  lens: LensCorrection;
  /** Crop tool active: geometry renders the uncropped frame. */
  ignoreCrop: boolean;
  /**
   * Output-space passes only: the normalized sub-rectangle of the final output
   * being rendered (tiles / zoomed region). Default {x:0,y:0,w:1,h:1}.
   */
  outRect: Rect;
  /** Output (cropped) size in pixels at this processing resolution. */
  outWidth: number;
  outHeight: number;
}

/** Extra per-invocation data for passes the orchestrator runs repeatedly. */
export interface PassExtra {
  /** LOCAL pass: the mask being applied. */
  mask?: Mask;
  /** HEAL pass: the chunk of spots for this invocation (≤ MAX_SPOTS_PER_PASS). */
  spots?: EditParams['retouch']['spots'];
  /** Multi-iteration passes: iteration index. */
  iteration?: number;
}

export interface BlurRequest {
  /** Sampler uniform that receives the blurred texture. */
  uniform: string;
  /** Name of one of this pass's inputs to blur (e.g. 'uInput', 'uPre'). */
  source: string;
  /** Gaussian sigma in reference pixels (× ctx.scale by the orchestrator). */
  sigma: number | ((params: EditParams, ctx: PassContext) => number);
  /**
   * Optional single-input pass run on the source before blurring (its input
   * sampler is named 'uInput'), e.g. to extract luminance or highlights.
   * Blurs with the same (source, prepass.name, sigma) are computed once per
   * frame and shared.
   */
  prepass?: PassDef;
  /** Blur only luminance-like single channel data at lower precision (hint). */
  lowPrecision?: boolean;
}

export interface PassDef {
  /** Unique, stable name (used for program caching and blur sharing). */
  name: string;
  /** Complete GLSL ES 3.00 fragment shader source. */
  fragment: string;
  /**
   * Sampler uniform names, in binding order. Standard names the orchestrator
   * knows how to fill:
   *   uInput     — output of the previous pass in the stage (or stage input)
   *   uSource    — linear source after retouch (source space)
   *   uPre       — output of the color PRE pass (linear, source space)
   *   uCurveLut  — tone-curve LUT (1024×1 RGBA float, from color/curves.buildCurveLut)
   *   uMask      — coverage of PassExtra.mask (R channel, source space)
   *   uOverlay   — mask overlay coverage (geometry pass; R channel, source space)
   *   uNoise     — 256×256 RGBA8 blue/white-noise texture (effects/grain)
   * Samplers named in `blurs[].uniform` are filled by the blur mechanism.
   */
  inputs: string[];
  uniforms(params: EditParams, ctx: PassContext, extra?: PassExtra): UniformMap;
  /** True when the pass would not change the image (the orchestrator skips it). */
  isIdentity?(params: EditParams, ctx: PassContext, extra?: PassExtra): boolean;
  blurs?: BlurRequest[];
  /** Render target format (default 'rgba16f', falls back to rgba8 when float rendering is unavailable). */
  output?: 'rgba16f' | 'rgba8';
  /** Skip in draft quality (expensive passes such as AI denoise). */
  skipInDraft?: boolean;
}

/** Heal spots per HEAL pass invocation (uniform array size). */
export const MAX_SPOTS_PER_PASS = 16;
