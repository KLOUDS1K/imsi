/**
 * Keys of per-photo binary assets referenced from an edit: removal-patch
 * pixels ('patches' store, RemovalPatch.patchKey) and AI mask bitmaps
 * ('maskBitmaps' store, AiMaskParams.bitmapKey). Looked up in the current
 * params, every history entry and every snapshot, since undo can bring any of
 * them back.
 */
import type { SerializedEditState } from '@/editor/types';

export interface AssetKeys {
  patches: Set<string>;
  bitmaps: Set<string>;
}

export function emptyAssetKeys(): AssetKeys {
  return { patches: new Set(), bitmaps: new Set() };
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Collect keys from one params object (defensive: stored data may be old or partial). */
function collectFromParams(params: unknown, out: AssetKeys): void {
  const p = obj(params);
  if (!p) return;
  for (const removal of asArray(obj(p.retouch)?.removals)) {
    const key = obj(removal)?.patchKey;
    if (typeof key === 'string' && key) out.patches.add(key);
  }
  for (const mask of asArray(p.masks)) {
    for (const comp of asArray(obj(mask)?.components)) {
      const key = obj(obj(comp)?.ai)?.bitmapKey;
      if (typeof key === 'string' && key) out.bitmaps.add(key);
    }
  }
}

export function collectAssetKeys(state: SerializedEditState | undefined | null, out: AssetKeys = emptyAssetKeys()): AssetKeys {
  if (!state || typeof state !== 'object') return out;
  // History entries share most of their structure; skip params objects we already walked.
  const seen = new Set<unknown>();
  const visit = (params: unknown) => {
    if (!params || seen.has(params)) return;
    seen.add(params);
    collectFromParams(params, out);
  };
  visit(state.params);
  for (const h of asArray(state.history)) visit(obj(h)?.params);
  for (const s of asArray(state.snapshots)) visit(obj(s)?.params);
  return out;
}
