/**
 * HSL / Color Mixer: 8 hue bands centred at HSL_CENTERS (unevenly spaced).
 *
 * Band weights are a partition of unity over the hue circle: between two
 * neighbouring centres the weight moves from one band to the other along a
 * raised cosine, so every band is exactly 1 at its own centre, 0 at its
 * neighbours' centres, and the weights are C1-smooth everywhere. Because
 * each transition spans the actual gap to the neighbour, the uneven spacing
 * (e.g. 30° red→orange vs 60° yellow→green) is respected.
 */
import { hueDelta } from '../../color/math';
import type { EditParams, HslChannel } from '../../types';
import { HSL_CENTERS, HSL_CHANNELS } from '../../types';
import { HSL_HUE_DEG, HSL_LUM_EV, glslFloat as f } from './constants';

export interface HslBand {
  channel: HslChannel;
  centre: number;
  /** Gap (degrees) to the previous / next centre around the circle. */
  gapPrev: number;
  gapNext: number;
}

export const HSL_BANDS: readonly HslBand[] = HSL_CHANNELS.map((channel, i) => {
  const n = HSL_CHANNELS.length;
  const centre = HSL_CENTERS[channel];
  const prev = HSL_CENTERS[HSL_CHANNELS[(i + n - 1) % n]];
  const next = HSL_CENTERS[HSL_CHANNELS[(i + 1) % n]];
  return {
    channel,
    centre,
    gapPrev: ((centre - prev) % 360 + 360) % 360,
    gapNext: ((next - centre) % 360 + 360) % 360,
  };
});

/** Weight of one band at hue h (degrees). */
export function hslBandWeight(h: number, band: HslBand): number {
  const d = hueDelta(band.centre, h);
  const t = d >= 0 ? d / band.gapNext : -d / band.gapPrev;
  return t >= 1 ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * t);
}

/** Weights of all 8 bands at hue h (degrees); they sum to 1. */
export function hslWeights(h: number, out = new Float32Array(8)): Float32Array {
  for (let i = 0; i < HSL_BANDS.length; i++) out[i] = hslBandWeight(h, HSL_BANDS[i]);
  return out;
}

/**
 * Hue shift in degrees for a band's hue slider v (±100): towards the next
 * band for v > 0 and the previous band for v < 0, at most HSL_HUE_DEG and
 * never past the neighbour's centre.
 */
export function hslHueShift(band: HslBand, v: number): number {
  const gap = v >= 0 ? band.gapNext : band.gapPrev;
  return (v / 100) * Math.min(HSL_HUE_DEG, gap);
}

export function isHslIdentity(params: EditParams): boolean {
  return HSL_CHANNELS.every((c) => {
    const v = params.hsl[c];
    return v.hue === 0 && v.saturation === 0 && v.luminance === 0;
  });
}

/** Uniforms: per-band hue shift (deg), saturation (−1..1) and luminance (EV), packed as two vec4 each. */
export function hslUniforms(params: EditParams): Record<string, number[]> {
  const hue: number[] = [];
  const sat: number[] = [];
  const lum: number[] = [];
  HSL_BANDS.forEach((band) => {
    const v = params.hsl[band.channel];
    hue.push(hslHueShift(band, v.hue));
    sat.push(v.saturation / 100);
    lum.push((v.luminance / 100) * HSL_LUM_EV);
  });
  return {
    uHslHueA: hue.slice(0, 4),
    uHslHueB: hue.slice(4, 8),
    uHslSatA: sat.slice(0, 4),
    uHslSatB: sat.slice(4, 8),
    uHslLumA: lum.slice(0, 4),
    uHslLumB: lum.slice(4, 8),
  };
}

const bandCall = (b: HslBand) => `hslBandW(h, ${f(b.centre)}, ${f(b.gapPrev)}, ${f(b.gapNext)})`;

/** GLSL: `void hslWeights(float hDeg, out vec4 wa, out vec4 wb)`. Needs GLSL_COLOR_OPS (PI) and hueDelta. */
export const GLSL_HSL = /* glsl */ `
float hslBandW(float h, float c, float gp, float gn) {
  float d = hueDelta(c, h);
  float t = d >= 0.0 ? d / gn : -d / gp;
  return t >= 1.0 ? 0.0 : 0.5 + 0.5 * cos(PI * t);
}
void hslWeights(float h, out vec4 wa, out vec4 wb) {
  wa = vec4(${HSL_BANDS.slice(0, 4).map(bandCall).join(', ')});
  wb = vec4(${HSL_BANDS.slice(4, 8).map(bandCall).join(', ')});
}
`;
