import { it, expect } from 'vitest';
import { EditorStore, paramsToXmp, xmpToParams } from '@/editor/state';
import { BUILTIN_PRESETS, applyPreset } from '@/editor/presets';
import { createDefaultParams } from '@/editor/defaults';
it('smoke', () => {
  console.log('DEV', import.meta.env.DEV);
  const s = new EditorStore();
  s.set('basic.exposure', 0.35);
  console.log(s.history.map(h => h.label), Object.isFrozen(s.params.basic));
  const p = applyPreset(createDefaultParams(), BUILTIN_PRESETS[1], 80);
  const x = paramsToXmp(p);
  console.log(x.slice(0, 1500));
  const r = xmpToParams(x);
  console.log(r.groups, JSON.stringify(r.params).slice(0, 400));
  expect(1).toBe(1);
});
