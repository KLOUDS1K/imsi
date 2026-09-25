import { describe, expect, it } from 'vitest';
import { createDefaultExportSettings } from '@/editor/defaults';
import { MemoryKloudDB } from '@/editor/storage';
import { deleteExportPreset, loadExportPresets, saveExportPreset } from '@/editor/export/presets';

describe('named export recipes', () => {
  it('persists a snapshot of sizing, watermark and file naming without later mutations', async () => {
    const db = new MemoryKloudDB();
    const settings = createDefaultExportSettings();
    settings.resize = { ...settings.resize, mode: 'width', width: 1080 };
    settings.watermark.enabled = true;
    settings.watermark.text = 'KLOUD';
    settings.fileNameTemplate = '{name}_{width}_{seq}';
    await saveExportPreset(db, '  Social  ', settings);
    settings.resize.width = 777;
    settings.watermark.text = 'Changed';
    const [preset] = await loadExportPresets(db);
    expect(preset.name).toBe('Social');
    expect(preset.settings.resize.width).toBe(1080);
    expect(preset.settings.watermark.text).toBe('KLOUD');
    expect(preset.settings.fileNameTemplate).toBe('{name}_{width}_{seq}');
  });

  it('replaces a name case-insensitively and only deletes the chosen recipe', async () => {
    const db = new MemoryKloudDB();
    const settings = createDefaultExportSettings();
    await saveExportPreset(db, 'Social', settings);
    await saveExportPreset(db, 'Print', { ...settings, format: 'tiff' });
    await saveExportPreset(db, 'social', { ...settings, quality: 70 });
    expect((await loadExportPresets(db)).map((p) => p.name)).toEqual(['social', 'Print']);
    expect((await loadExportPresets(db))[0].settings.quality).toBe(70);
    expect((await deleteExportPreset(db, 'social')).map((p) => p.name)).toEqual(['Print']);
  });

  it('rejects empty names and ignores invalid records while filling older settings', async () => {
    const db = new MemoryKloudDB();
    await expect(saveExportPreset(db, ' ', createDefaultExportSettings())).rejects.toThrow('name');
    await db.put('settings', 'export.presets.v1', [null, { name: 'broken' }, { name: 'Old', settings: { format: 'jpeg', resize: { mode: 'width', width: 1200 } } }]);
    const [preset] = await loadExportPresets(db);
    expect(preset.name).toBe('Old');
    expect(preset.settings.resize).toMatchObject({ mode: 'width', width: 1200, dontEnlarge: true });
    expect(preset.settings.watermark).toEqual(createDefaultExportSettings().watermark);
  });
});
