/**
 * KLOUD edit sidecar (".kloud.json"): the full SerializedEditState as JSON.
 * parseEditFile also accepts a bare EditParams object and XMP sidecars, so a
 * user can drop any of those next to a photo.
 */
import { createDefaultParams } from '@/editor/defaults';
import type { HistoryEntry, SerializedEditState, Snapshot } from '@/editor/types';
import { isPlainObject, reconcile } from './paths';
import { normalizeParams, toNum } from './normalize';
import { xmpToEditParams } from './xmp';

export const EDIT_FILE_EXTENSION = '.kloud.json';
export const EDIT_FILE_MIME = 'application/json';

export function serializeEditFile(state: SerializedEditState): Blob {
  return new Blob([JSON.stringify(state)], { type: EDIT_FILE_MIME });
}

export function parseEditFile(text: string): SerializedEditState {
  const trimmed = text.replace(/^﻿/, '').trim();
  const now = Date.now();
  if (trimmed.startsWith('<')) {
    const params = xmpToEditParams(trimmed);
    return { format: 'kloud-edit', version: 1, params, history: [{ id: 0, label: 'Import XMP', params, time: now }], historyIndex: 0, snapshots: [], updated: now };
  }
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`Not a KLOUD edit file: ${(err as Error).message}`);
  }
  if (!isPlainObject(data)) throw new Error('Not a KLOUD edit file: expected a JSON object');

  if (data.format !== 'kloud-edit') {
    // A bare EditParams object (e.g. exported by hand / another tool).
    if (isPlainObject(data.basic) || data.version === 1) {
      const params = normalizeParams(data);
      return { format: 'kloud-edit', version: 1, params, history: [{ id: 0, label: 'Import', params, time: now }], historyIndex: 0, snapshots: [], updated: now };
    }
    throw new Error('Not a KLOUD edit file: unknown format');
  }

  const version = toNum(data.version) ?? 1;
  if (version > 1) console.warn(`KLOUD edit file version ${version} is newer than this app; reading known fields only.`);

  const history: HistoryEntry[] = [];
  let prev: HistoryEntry['params'] | null = null;
  if (Array.isArray(data.history)) {
    for (const e of data.history) {
      if (!isPlainObject(e)) continue;
      let p = normalizeParams(e.params);
      if (prev) p = reconcile(prev, p);
      history.push({ id: toNum(e.id) ?? history.length, label: typeof e.label === 'string' ? e.label : 'Edit', params: p, time: toNum(e.time) ?? now });
      prev = p;
    }
  }
  const params = data.params !== undefined ? normalizeParams(data.params) : (prev ?? createDefaultParams());
  if (history.length === 0) history.push({ id: 0, label: 'Import', params, time: toNum(data.updated) ?? now });
  const idx = toNum(data.historyIndex);
  const historyIndex = Math.max(0, Math.min(history.length - 1, Math.floor(idx ?? history.length - 1)));

  const snapshots: Snapshot[] = [];
  if (Array.isArray(data.snapshots)) {
    for (const s of data.snapshots) {
      if (!isPlainObject(s)) continue;
      snapshots.push({
        id: typeof s.id === 'string' && s.id ? s.id : `snap-${snapshots.length + 1}`,
        name: typeof s.name === 'string' && s.name ? s.name : `Snapshot ${snapshots.length + 1}`,
        params: normalizeParams(s.params),
        created: toNum(s.created) ?? now,
      });
    }
  }
  return { format: 'kloud-edit', version: 1, params, history, historyIndex, snapshots, updated: toNum(data.updated) ?? now };
}
