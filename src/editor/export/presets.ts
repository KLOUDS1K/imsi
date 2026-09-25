/** Named, device-local output recipes, including watermark and file naming. */
import type { KloudDB } from '@/editor/contracts';
import type { ExportSettings } from '@/editor/types';
import { createDefaultExportSettings } from '@/editor/defaults';

const KEY = 'export.presets.v1';
export interface ExportPreset {
  name: string;
  settings: ExportSettings;
}

export async function loadExportPresets(db: KloudDB): Promise<ExportPreset[]> {
  const stored = await db.get<unknown>('settings', KEY);
  if (!Array.isArray(stored)) return [];
  return stored.filter((p): p is ExportPreset => !!p && typeof p === 'object'
    && typeof p.name === 'string' && p.name.trim().length > 0 && !!p.settings
    && ['jpeg', 'png', 'webp', 'tiff', 'dng'].includes(p.settings.format))
    .map(({ name, settings }) => {
      const defaults = createDefaultExportSettings();
      return { name, settings: { ...defaults, ...settings,
        resize: { ...defaults.resize, ...settings.resize },
        watermark: { ...defaults.watermark, ...settings.watermark },
        outputSharpening: { ...defaults.outputSharpening, ...settings.outputSharpening },
      } };
    });
}

/** Saving the same name replaces it without creating duplicate recipes. */
export async function saveExportPreset(db: KloudDB, name: string, settings: ExportSettings): Promise<ExportPreset[]> {
  const clean = name.trim().slice(0, 80);
  if (!clean) throw new Error('Enter a preset name.');
  const presets = await loadExportPresets(db);
  const index = presets.findIndex((p) => p.name.toLowerCase() === clean.toLowerCase());
  const preset = { name: clean, settings: structuredClone(settings) };
  if (index < 0) presets.push(preset);
  else presets[index] = preset;
  await db.put('settings', KEY, presets);
  return presets;
}

export async function deleteExportPreset(db: KloudDB, name: string): Promise<ExportPreset[]> {
  const presets = (await loadExportPresets(db)).filter((p) => p.name !== name);
  await db.put('settings', KEY, presets);
  return presets;
}
