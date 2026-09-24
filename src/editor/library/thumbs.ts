/**
 * Object-URL cache for grid thumbnails.
 *
 * - LRU: at most `capacity` URLs are alive; the least recently requested one
 *   is revoked when the cache is full (an <img> that already decoded it keeps
 *   showing it; a re-mounted tile simply asks again).
 * - Concurrent requests for the same id share one storage read.
 * - `invalidate()` / `replace()` bump a per-id version so a read that was in
 *   flight while the thumbnail changed can never cache the stale image.
 */

export interface ObjectUrlApi {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

export class ThumbnailUrlCache {
  /** id → url, in LRU order (oldest first; Map preserves insertion order). */
  private readonly urls = new Map<string, string>();
  private readonly inflight = new Map<string, Promise<string | undefined>>();
  private readonly versions = new Map<string, number>();

  constructor(
    private readonly load: (id: string) => Promise<Blob | undefined>,
    private readonly capacity = 500,
    private readonly urlApi: ObjectUrlApi = URL,
  ) {}

  get size(): number {
    return this.urls.size;
  }

  /** Cached URL without touching storage or LRU order. */
  peek(id: string): string | undefined {
    return this.urls.get(id);
  }

  get(id: string): Promise<string | undefined> {
    const hit = this.urls.get(id);
    if (hit !== undefined) {
      this.urls.delete(id);
      this.urls.set(id, hit);
      return Promise.resolve(hit);
    }
    const pending = this.inflight.get(id);
    if (pending) return pending;
    const version = this.versions.get(id) ?? 0;
    const p: Promise<string | undefined> = this.load(id).then(
      (blob) => {
        if (this.inflight.get(id) === p) this.inflight.delete(id);
        if ((this.versions.get(id) ?? 0) !== version) return this.get(id); // changed meanwhile: read the new one
        if (!blob) return undefined;
        const existing = this.urls.get(id);
        if (existing !== undefined) return existing;
        const url = this.urlApi.createObjectURL(blob);
        this.urls.set(id, url);
        this.evict();
        return url;
      },
      (err: unknown) => {
        if (this.inflight.get(id) === p) this.inflight.delete(id);
        throw err;
      },
    );
    this.inflight.set(id, p);
    return p;
  }

  /** Put a freshly generated thumbnail in place (no storage round-trip). */
  replace(id: string, blob: Blob): string {
    this.invalidate(id);
    const url = this.urlApi.createObjectURL(blob);
    this.urls.set(id, url);
    this.evict();
    return url;
  }

  /** Drop (and revoke) the cached URL for `id`; in-flight reads are discarded. */
  invalidate(id: string): void {
    this.versions.set(id, (this.versions.get(id) ?? 0) + 1);
    this.inflight.delete(id);
    const url = this.urls.get(id);
    if (url !== undefined) {
      this.urls.delete(id);
      this.urlApi.revokeObjectURL(url);
    }
  }

  /** Revoke everything (library disposal). */
  clear(): void {
    for (const url of this.urls.values()) this.urlApi.revokeObjectURL(url);
    this.urls.clear();
    for (const id of this.inflight.keys()) this.versions.set(id, (this.versions.get(id) ?? 0) + 1);
    this.inflight.clear();
  }

  private evict(): void {
    while (this.urls.size > this.capacity) {
      const oldest = this.urls.keys().next();
      if (oldest.done) return;
      const url = this.urls.get(oldest.value);
      this.urls.delete(oldest.value);
      if (url !== undefined) this.urlApi.revokeObjectURL(url);
    }
  }
}
