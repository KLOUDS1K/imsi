/**
 * Key/value app settings ('settings' store): theme, panel state, export
 * settings, shortcuts, last-used folders…
 */
import type { KloudDB } from '@/editor/contracts';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Read a setting, falling back when it is missing, unreadable, or of a
 * different type than `fallback` (a stale value from an older build).
 *
 * When both the stored value and `fallback` are plain objects, keys missing
 * from the stored object are filled from `fallback` (shallow), so settings
 * objects gain new fields added in later versions without a migration.
 */
export async function loadSetting<T>(db: KloudDB, key: string, fallback: T): Promise<T> {
  let stored: unknown;
  try {
    stored = await db.get<unknown>('settings', key);
  } catch {
    return fallback;
  }
  if (stored === undefined) return fallback;
  if (fallback === null || fallback === undefined) return stored as T;
  if (Array.isArray(fallback)) return (Array.isArray(stored) ? stored : fallback) as T;
  if (typeof stored !== typeof fallback || (stored === null && fallback !== null)) return fallback;
  if (isPlainObject(fallback)) {
    if (!isPlainObject(stored)) return fallback;
    return { ...fallback, ...stored } as T;
  }
  return stored as T;
}

export async function saveSetting<T>(db: KloudDB, key: string, value: T): Promise<void> {
  await db.put<T>('settings', key, value);
}

export async function deleteSetting(db: KloudDB, key: string): Promise<void> {
  await db.delete('settings', key);
}
