/**
 * Tunable constants of the develop-stage colour math.
 *
 * Every number here is shared by the CPU mirrors (tone.ts, hsl.ts, …) and the
 * GLSL sources, which interpolate them at module load. Change a look here and
 * both sides follow.
 */

/* ------------------------------------------------------------------ */
/* Blur radii                                                          */
/* ------------------------------------------------------------------ */

/**
 * Gaussian sigmas (reference pixels, multiplied by ctx.scale by the
 * orchestrator) of the blurs the colour passes request.
 *
 * - `small`  (~2 px): fine detail band (texture), local std for edge/flat tests (defringe, noise).
 * - `medium` (~12 px): mid-frequency band (clarity, structure), dark channel (dehaze), tone base.
 * - `large`  (~60 px): tone base for highlights/shadows, local contrast, dehaze brightness compensation.
 * - `fringe` (~4 px): full-colour neighbourhood used by defringe to pick the replacement colour.
 * - `detail` (~1.5 px): full-colour blur used by the local sharpness / noise sliders.
 * - `collapsed`: sigma returned for a blur that the current params do not need.
 *   All unused requests collapse onto this one tiny, shared blur so the
 *   orchestrator pays (almost) nothing for them. The shaders never read a
 *   blur whose effect is off.
 */
export const BLUR_SIGMAS = {
  small: 2,
  medium: 12,
  large: 60,
  fringe: 4,
  detail: 1.5,
  collapsed: 0.75,
} as const;

/* ------------------------------------------------------------------ */
/* Tone space                                                          */
/* ------------------------------------------------------------------ */

/**
 * Local tone mapping and presence work on
 *   L = log2(Y + TONE_E0) - log2(0.18 + TONE_E0)
 * i.e. stops relative to middle grey with a small linear toe. The toe keeps
 * sensor noise in the deepest shadows (Y ≪ E0) from turning into huge log
 * swings that detail amplification would then blow up.
 */
export const TONE_E0 = 1 / 512;
export const TONE_MID = 0.18;
export const TONE_LOG_MID = Math.log2(TONE_MID + TONE_E0);

/**
 * Expected cancellation error of E[L²] − E[L]² when the guide blurs are
 * stored as half floats (≈ 3 ulp at the magnitude of L²). Subtracted from
 * every variance estimate so flat areas read as flat.
 */
export const VAR_QUANT = 1.5e-3;

/* Highlights / shadows (EV at ±100, evaluated on the local base). */
export const SHADOWS_EV = 1.8;
/** Shadows weight: full below SH_FULL, fading out by SH_END (EV rel. mid grey). */
export const SH_FULL = -3.4;
export const SH_END = 1.2;
/** Near-black taper: weight drops to SH_FLOOR_W at SH_FLOOR_LO. */
export const SH_FLOOR_LO = -6.6;
export const SH_FLOOR_HI = -3.6;
export const SH_FLOOR_W = 0.55;

export const HIGHLIGHTS_EV = 0.55;
export const HL_START = -1.0;
export const HL_FULL = 1.6;
/** Extra compression above white for recovery (negative highlights only). */
export const HL_RECOVER_START = 2.5;
export const HL_RECOVER_SLOPE = 0.7;
/** Positive highlights taper off towards white so brightening rolls into clipping gently. */
export const HL_POS_TAPER_LO = 1.0;
export const HL_POS_TAPER_HI = 2.6;
export const HL_POS_TAPER = 0.7;

/* Whites / blacks (perceptual = sRGB-encoded luminance domain). */
export const WHITES_GAIN = 0.22;
export const WHITES_LO = 0.2;
export const WHITES_HI = 1.0;
export const BLACKS_LIFT = 0.07;
export const BLACKS_HI = 0.55;
export const BLACKS_KNEE = 0.03;

/* Contrast: slope at middle grey and at the end points for ±100. */
export const CONTRAST_MID_SLOPE = 0.6;
export const CONTRAST_END_SLOPE = 0.4;
/** Share of the contrast amount fed into saturation (Lightroom's contrast adds a little colour). */
export const CONTRAST_SAT = 0.12;

/*
 * Edge-aware tone bases. Each blurred mean is refined with a Lee (local
 * Wiener) filter: base = mean + v/(v+eps)·(L − mean), v = local variance of L.
 * Near strong edges v ≫ eps and the base follows the pixel (no halo, no
 * gradient reversal inside small objects); in smooth or finely textured areas
 * v ≪ eps and the base is the smooth local mean (detail preserved).
 * eps are in EV² (tone-space variance).
 */
export const TONE_EPS_M = 0.25;
export const TONE_EPS_L = 0.5;
/** Mix large → medium base where their means disagree by this much (EV). */
export const BASE_ML_LO = 0.35;
export const BASE_ML_HI = 1.2;
/** Safety net: follow the pixel where it is still this far (EV) from the base. */
export const BASE_PIX_LO = 1.2;
export const BASE_PIX_HI = 3.0;

/* Presence (EV of detail gain per unit slider, i.e. at ±100). */
export const TEXTURE_GAIN = 1.4;
export const TEXTURE_SMOOTH = 0.9;
export const TEXTURE_LIMIT = 0.35;
/** Fine local std (EV) below which a region counts as smooth (skin, sky). */
export const TEXTURE_FLAT_LO = 0.02;
export const TEXTURE_FLAT_HI = 0.1;
/** Fine local std (EV) above which negative texture stops smoothing (keeps real edges). */
export const TEXTURE_EDGE_LO = 0.25;
export const TEXTURE_EDGE_HI = 0.6;

export const CLARITY_GAIN = 1.1;
export const CLARITY_SMOOTH = 0.9;
export const CLARITY_LIMIT = 0.6;
/** Clarity acts on mid-tones: fades in over LO0→LO1 and out over HI0→HI1 (tone-space EV). */
export const CLARITY_MID_LO0 = -5.5;
export const CLARITY_MID_LO1 = -2.5;
export const CLARITY_MID_HI0 = 1.2;
export const CLARITY_MID_HI1 = 2.8;

export const STRUCTURE_GAIN = 1.0;
export const STRUCTURE_SMOOTH = 0.7;
export const STRUCTURE_LIMIT = 0.5;
export const STRUCTURE_EDGE_LO = 0.15;
export const STRUCTURE_EDGE_HI = 0.7;

export const LOCAL_CONTRAST_GAIN = 0.9;
export const LOCAL_CONTRAST_SMOOTH = 0.8;
export const LOCAL_CONTRAST_LIMIT = 1.0;

/* Dehaze (dark channel prior in linear light). */
/** Assumed airlight (linear). Typical haze in a normally exposed photo sits around 0.5–0.8. */
export const DEHAZE_AIRLIGHT = 0.85;
export const DEHAZE_OMEGA = 0.85;
export const DEHAZE_T_MIN = 0.15;
/** Lee-filter epsilon for refining the blurred dark channel (linear² units). */
export const DEHAZE_EPS = 0.0025;
/** Mild brightness give-back after veil removal: comp = t^(−γ) (γ in log2 per log2 t). */
export const DEHAZE_COMPENSATE = 0.3;
/** Positive texture is tapered on strong edges (fine std in EV) to avoid rims. */
export const TEXTURE_EDGE_TAPER_LO = 0.5;
export const TEXTURE_EDGE_TAPER_HI = 1.5;
/** Negative dehaze: max veil opacity and airlight level (linear). */
export const HAZE_ADD = 0.6;
export const HAZE_AIRLIGHT = 0.78;

/* Colour. */
/** HSL hue ±100 → up to this many degrees towards the neighbouring band. */
export const HSL_HUE_DEG = 30;
/** HSL luminance ±100 → EV (scaled by pixel chroma). */
export const HSL_LUM_EV = 1.25;
/** Encoded chroma (max−min) at which the HSL luminance slider reaches full effect. */
export const HSL_LUM_CHROMA = 0.35;

export const VIBRANCE_GAIN = 1.0;
/** Skin protection (vibrance): hue band in degrees and how much of the boost skin keeps. */
export const SKIN_HUE_LO = 15;
export const SKIN_HUE_HI = 50;
export const SKIN_FEATHER = 10;
export const SKIN_PROTECT = 0.75;

/** Colour grading: tint strength at saturation 100, split points and widths. */
export const GRADE_TINT = 0.35;
export const GRADE_SPLIT_LO = 1 / 3;
export const GRADE_SPLIT_HI = 2 / 3;
export const GRADE_BALANCE_SHIFT = 0.22;
export const GRADE_WIDTH_MIN = 0.06;
export const GRADE_WIDTH_MAX = 0.4;
export const GRADE_LUM_LIFT = 0.2;
export const GRADE_LUM_DARKEN = 0.35;

/* Calibration. */
export const CAL_HUE_DEG = 25;
export const CAL_SAT = 0.5;
export const CAL_SHADOW_TINT_EV = 0.35;

/* Lens vignetting (manual slider). */
export const LENS_VIG_EV = 1.2;
export const LENS_VIG_MID_MAX = 0.85;

/* Defringe. */
export const FRINGE_FEATHER = 8;
/** Fine local std (EV) range over which a pixel counts as "next to a strong edge". */
export const FRINGE_EDGE_LO = 0.06;
export const FRINGE_EDGE_HI = 0.3;
/** Encoded chroma range over which a pixel is coloured enough to be a fringe. */
export const FRINGE_CHROMA_LO = 0.03;
export const FRINGE_CHROMA_HI = 0.12;

/* Local adjustments. */
export const LOCAL_SHARPEN_GAIN = 1.6;
export const LOCAL_SHARPEN_LIMIT = 0.3;
export const LOCAL_NOISE_SMOOTH = 0.95;
export const LOCAL_NOISE_FLAT_LO = 0.12;
export const LOCAL_NOISE_FLAT_HI = 0.45;
/** Local temperature/tint use wbGains with the slider scaled by this factor. */
export const LOCAL_WB_SCALE = 0.6;

/** Format a JS number as a GLSL float literal. */
export function glslFloat(v: number): string {
  if (!Number.isFinite(v)) throw new Error(`non-finite GLSL constant: ${v}`);
  const s = v.toPrecision(9);
  return /[.eE]/.test(s) ? s : `${s}.0`;
}
