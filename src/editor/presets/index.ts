/**
 * presets/ — built-in KLOUD presets and preset operations.
 *
 * Apply with amount inside a gesture for the amount slider, computing from the
 * params captured when the gesture began (not the already-blended ones):
 *
 *   const base = store.params;
 *   store.beginGesture('Preset');
 *   store.replace(applyPreset(base, preset, amount), presetLabel(preset, amount)); // per input
 *   store.endGesture();
 */
import type { PresetsModule } from '@/editor/contracts';
import { BUILTIN_PRESETS } from './builtin';
import { applyPreset, createPreset, exportPresets, importPresetFile, matchConditionalPresets } from './presets';

export { BUILTIN_PRESETS, BUILTIN_GROUP_ORDER } from './builtin';
export {
  applyPreset,
  createPreset,
  exportPresets,
  IMPORTED_PRESET_GROUP,
  importPresetFile,
  matchConditionalPresets,
  matchPattern,
  parsePresetText,
  PRESET_FILE_EXTENSION,
  PRESET_FILE_FORMAT,
  PRESET_FILE_VERSION,
  presetLabel,
  presetMatches,
  presetToXmp,
  sanitizeConditions,
  USER_PRESET_GROUP,
  type PresetFile,
} from './presets';
export { parseLrTemplate } from './lrtemplate';

export const presetsModule = {
  BUILTIN_PRESETS,
  createPreset,
  applyPreset,
  matchConditionalPresets,
  exportPresets,
  importPresetFile,
} satisfies PresetsModule;
