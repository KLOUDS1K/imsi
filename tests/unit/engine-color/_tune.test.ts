import { it } from 'vitest';
import { linearToSrgb, srgbToLinear } from '../../../src/editor/color/math';
import * as T from '../../../src/editor/engine/color/tone';
it('tune', () => {
  const rows: string[] = [];
  for (const p of [0.02, 0.05, 0.1, 0.14, 0.2, 0.33, 0.46, 0.6, 0.735, 0.85, 0.95, 1.0, 1.2, 1.5]) {
    const y = srgbToLinear(p);
    const x = T.toneL(y);
    const sh = (s: number) => linearToSrgb(y * Math.pow(2, T.shadowsDelta(x, s)));
    const hl = (h: number) => linearToSrgb(y * Math.pow(2, T.highlightsDelta(x, h)));
    rows.push([p, x.toFixed(2), 'sh+', sh(1).toFixed(3), 'sh-', sh(-1).toFixed(3), 'hl-', hl(-1).toFixed(3), 'hl+', hl(1).toFixed(3),
      'wh+', T.whitesCurve(p, 1).toFixed(3), 'wh-', T.whitesCurve(p, -1).toFixed(3), 'bl+', T.blacksCurve(p, 1).toFixed(3), 'bl-', T.blacksCurve(p, -1).toFixed(3),
      'c+', T.contrastCurve(p, 1).toFixed(3), 'c-', T.contrastCurve(p, -1).toFixed(3)].join(' '));
  }
  console.log(rows.join('\n'));
});
