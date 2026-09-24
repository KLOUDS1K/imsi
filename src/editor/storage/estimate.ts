/**
 * navigator.storage helpers (StorageManager). Everything is best-effort: the
 * API is missing in some contexts (insecure origins, old Safari, workers in
 * some browsers, Node) and may throw in sandboxed iframes.
 */

function storageManager(): StorageManager | undefined {
  try {
    return typeof navigator !== 'undefined' ? navigator.storage : undefined;
  } catch {
    return undefined;
  }
}

/** Usage/quota in bytes; zeros when unknown. */
export async function storageEstimate(): Promise<{ usage: number; quota: number }> {
  const sm = storageManager();
  if (!sm || typeof sm.estimate !== 'function') return { usage: 0, quota: 0 };
  try {
    const e = await sm.estimate();
    return { usage: finite(e.usage), quota: finite(e.quota) };
  } catch {
    return { usage: 0, quota: 0 };
  }
}

/**
 * Ask the browser not to evict our data under storage pressure. Resolves to
 * whether storage is (now) persistent. Never throws, never prompts twice: if it
 * is already persistent the request is skipped.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  const sm = storageManager();
  if (!sm || typeof sm.persist !== 'function') return false;
  try {
    if (typeof sm.persisted === 'function' && (await sm.persisted())) return true;
    return await sm.persist();
  } catch {
    return false;
  }
}

function finite(n: number | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}
