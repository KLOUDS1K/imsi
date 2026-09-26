import { describe, expect, it } from 'vitest';
import { AI_MASK_CACHE_VERSION, aiBitmapKey, aiKeysOf, isCurrentAiBitmapKey } from '@/app/ai-masks';
import { createDefaultParams, createMask } from '@/editor/defaults';

describe('AI mask cache versioning', () => {
  it('versions keys so masks from the weaker detector are regenerated', () => {
    const key = aiBitmapKey('photo-1', { target: 'subject' });
    expect(key).toContain(`ai:${AI_MASK_CACHE_VERSION}:photo-1:subject:`);
    expect(isCurrentAiBitmapKey(key)).toBe(true);
    expect(isCurrentAiBitmapKey('ai:photo-1:subject:old')).toBe(false);
  });

  it('restores only current detector masks', () => {
    const params = createDefaultParams();
    const mask = createMask('Subject', 'm1');
    const current = aiBitmapKey('photo-1', { target: 'subject' });
    mask.components = [
      { id: 'old', kind: 'ai', mode: 'add', invert: false, ai: { target: 'subject', bitmapKey: 'ai:photo-1:subject:old' } },
      { id: 'new', kind: 'ai', mode: 'add', invert: false, ai: { target: 'subject', bitmapKey: current } },
    ];
    params.masks.push(mask);
    expect(aiKeysOf(params)).toEqual([current]);
  });
});
