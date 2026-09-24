/**
 * engine/fx — non-colour GPU passes (PassDef objects, see ../pass-types.ts).
 *
 * Pipeline placement (ARCHITECTURE.md "Render pipeline"):
 *   2. Retouch  (source, linear):   PATCH_COMPOSITE_PASS per removal, HEAL_PASS per ≤16 spots
 *   6. Detail   (source, display):  DETAIL_STAGE
 *   8. Geometry (source → output):  GEOMETRY_PASS (+ GEOMETRY_OVERLAY_PASS for the mask overlay)
 *   9. Effects  (output, display):  EFFECTS_STAGE
 *
 * Conventions every pass follows:
 * - `inputs` lists only the standard samplers the orchestrator binds by name
 *   (uInput, uPatch, uOverlay); samplers of `blurs[].uniform` are filled by
 *   the blur mechanism and are NOT repeated in `inputs`.
 * - Uniform arrays (HEAL) are returned flattened and padded to the declared size.
 * - vec3 rows (not mat3) carry the geometry homography, so no transpose convention is involved.
 * - Blur textures and fractional taps are read with texture() and need LINEAR
 *   filtering + CLAMP_TO_EDGE; exact-texel reads use texelFetch.
 */
export { HEAL_PASS, PATCH_COMPOSITE_PASS, healUniforms, patchCompositeUniforms, HEAL_BLUR_SMALL, HEAL_BLUR_LARGE } from './retouch';
export {
  DETAIL_STAGE,
  AI_DENOISE_PASS,
  COLOR_NR_PASS,
  LUMA_NR_PASS,
  LUMA_CONTRAST_PASS,
  LUMA_RESIDUAL_PREPASS,
  SHARPEN_PASS,
} from './detail';
export { GEOMETRY_PASS, GEOMETRY_OVERLAY_PASS } from './geometry-pass';
export {
  EFFECTS_STAGE,
  BLOOM_PASS,
  GLOW_PASS,
  HALATION_PASS,
  VIGNETTE_PASS,
  GRAIN_PASS,
  BLOOM_EXTRACT,
  GLOW_EXTRACT,
  HALATION_EXTRACT,
  grainCellsAcrossLongEdge,
} from './effects';
export { buildGeometryUniforms, isGeometryIdentity, type GeometryUniforms, type GeometryUniformContext } from './geometry-core';
