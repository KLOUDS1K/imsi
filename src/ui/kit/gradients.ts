/**
 * CSS gradients for slider tracks. These depict actual colours (what the
 * slider does to the image), so they are data rather than theme colours.
 *
 *   createSlider({ label: 'Temp', min: -100, max: 100, gradient: temperatureGradient() })
 */

/** Blue → neutral → yellow (white balance temperature, positive = warmer). */
export function temperatureGradient(): string {
  return 'linear-gradient(90deg, hsl(212 72% 52%), hsl(210 20% 72%) 45%, hsl(48 20% 74%) 55%, hsl(46 88% 52%))';
}

/** Green → neutral → magenta (white balance tint, positive = magenta). */
export function tintGradient(): string {
  return 'linear-gradient(90deg, hsl(120 55% 42%), hsl(120 12% 70%) 45%, hsl(300 12% 72%) 55%, hsl(305 60% 55%))';
}

/** Full hue circle 0..360 (hue pickers, defringe hue ranges). */
export function hueGradient(from = 0, to = 360, sat = 80, light = 55): string {
  const stops: string[] = [];
  const n = 12;
  for (let i = 0; i <= n; i++) {
    const hue = from + ((to - from) * i) / n;
    stops.push(`hsl(${hue.toFixed(1)} ${sat}% ${light}%)`);
  }
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

/** HSL-panel Hue slider for one band: the colours the band can shift to (±spread°). */
export function bandHueGradient(centerHue: number, spread = 40): string {
  return hueGradient(centerHue - spread, centerHue + spread, 70, 55);
}

/** Grey → fully saturated hue (HSL Saturation, Saturation/Vibrance). */
export function saturationGradient(hue = 0): string {
  return `linear-gradient(90deg, hsl(${hue} 0% 55%), hsl(${hue} 80% 52%))`;
}

/** Dark → light of a hue (HSL Luminance). */
export function luminanceGradient(hue = 0, sat = 55): string {
  return `linear-gradient(90deg, hsl(${hue} ${sat}% 18%), hsl(${hue} ${sat}% 50%), hsl(${hue} ${sat}% 84%))`;
}

/** Black → white (tone / luminance ranges). */
export function greyGradient(): string {
  return 'linear-gradient(90deg, hsl(0 0% 6%), hsl(0 0% 96%))';
}
