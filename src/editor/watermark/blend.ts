import type { WatermarkBlendMode } from '@/editor/types';

/** Blend one colour channel in the image's encoded space. */
export function blendWatermarkChannel(
  mode: WatermarkBlendMode,
  source: number,
  destination: number,
  max: number,
): number {
  if (mode === 'normal') return source;
  const s = Math.max(0, Math.min(1, source / max));
  const d = Math.max(0, Math.min(1, destination / max));
  let out = s;
  if (mode === 'multiply') out = s * d;
  else if (mode === 'screen') out = s + d - s * d;
  else if (mode === 'overlay') out = d <= 0.5 ? 2 * s * d : 1 - 2 * (1 - s) * (1 - d);
  else if (mode === 'difference') out = Math.abs(d - s);
  else if (mode === 'soft-light') {
    const g = d <= 0.25 ? ((16 * d - 12) * d + 4) * d : Math.sqrt(d);
    out = s <= 0.5
      ? d - (1 - 2 * s) * d * (1 - d)
      : d + (2 * s - 1) * (g - d);
  }
  return Math.max(0, Math.min(max, out * max));
}
