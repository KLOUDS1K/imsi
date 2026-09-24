/**
 * AutosaveManager — debounced persistence of the open photo's edit state plus
 * a crash-recovery record.
 *
 *   const autosave = new AutosaveManager(db, { save: (id, s) => library.saveEdit(id, s) });
 *   store.subscribe(() => autosave.schedule(photoId, store.serialize()));
 *   // on explicit save / closing the photo / beforeunload:
 *   await autosave.markClean();
 *   // at startup:
 *   const rec = await autosave.getRecovery(); // → offer "Restore unsaved edits?"
 *
 * Every write (after `delayMs` of quiet) stores the edit in 'edits' (or via
 * the `save` hook) AND the record { photoId, state, savedAt, dirty: true } in
 * the 'autosave' store. `markClean()` flips `dirty` off; a record still dirty
 * at the next start means the tab was closed or crashed mid-session.
 *
 * Writes are serialized through one queue, so they land in call order even
 * when the user switches photos faster than the debounce: scheduling a
 * different photo flushes the previous photo's pending state immediately.
 */
import type { KloudDB, RecoverySession } from '@/editor/contracts';
import type { SerializedEditState } from '@/editor/types';
import { AUTOSAVE_SESSION_KEY, type AutosaveRecord } from './schema';

export interface AutosaveOptions {
  /** Quiet period before a scheduled state is written. Default 800 ms. */
  delayMs?: number;
  /**
   * How the edit itself is persisted. Default: `db.put('edits', photoId, state)`.
   * Pass `(id, s) => library.saveEdit(id, s)` to keep PhotoRecord.hasEdits/editedAt in sync.
   */
  save?: (photoId: string, state: SerializedEditState) => Promise<void>;
  /** Failures of background (timer-driven) writes. Default: console.error. */
  onError?: (err: unknown, photoId: string) => void;
  /** Called after each successful write. */
  onSaved?: (photoId: string, savedAt: number) => void;
  /**
   * Flush when the page is hidden / unloaded (visibilitychange → hidden, pagehide).
   * Default true when running in a document.
   */
  flushOnHide?: boolean;
  /** Clock (tests). */
  now?: () => number;
}

interface Pending {
  photoId: string;
  state: SerializedEditState;
}

function isRecord(v: unknown): v is AutosaveRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Partial<AutosaveRecord>;
  return typeof r.photoId === 'string' && !!r.state && typeof r.state === 'object' && typeof r.savedAt === 'number';
}

export class AutosaveManager {
  private readonly db: KloudDB;
  private readonly delayMs: number;
  private readonly saveEdit: (photoId: string, state: SerializedEditState) => Promise<void>;
  private readonly onError: (err: unknown, photoId: string) => void;
  private readonly onSaved?: (photoId: string, savedAt: number) => void;
  private readonly now: () => number;
  private pending: Pending | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Tail of the write queue; never rejects (each caller gets its own promise). */
  private queue: Promise<void> = Promise.resolve();
  private detachPageHooks: (() => void) | null = null;

  constructor(db: KloudDB, opts: AutosaveOptions = {}) {
    this.db = db;
    this.delayMs = Math.max(0, opts.delayMs ?? 800);
    this.saveEdit = opts.save ?? ((id, state) => db.put('edits', id, state));
    this.onError = opts.onError ?? ((err, id) => console.error(`[kloud/autosave] saving ${id} failed`, err));
    this.onSaved = opts.onSaved;
    this.now = opts.now ?? Date.now;
    const hooks = opts.flushOnHide ?? typeof document !== 'undefined';
    if (hooks && typeof document !== 'undefined' && typeof window !== 'undefined') this.attachPageHooks();
  }

  /** Photo whose state is waiting for the debounce, if any. */
  get pendingPhotoId(): string | null {
    return this.pending?.photoId ?? null;
  }

  /** Queue `state` for `photoId`; the latest state wins within the debounce window. */
  schedule(photoId: string, state: SerializedEditState): void {
    if (this.pending && this.pending.photoId !== photoId) {
      // Switching photos: the previous photo's latest state must not be dropped or overwritten.
      this.flushInBackground();
    }
    this.pending = { photoId, state };
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushInBackground();
    }, this.delayMs);
  }

  /**
   * Write the pending state now and wait for every queued write. Rejects when
   * the write fails (the pending state is then kept for the next attempt
   * unless a newer one was scheduled meanwhile).
   */
  flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const job = this.pending;
    this.pending = null;
    if (!job) return this.queue;
    return this.enqueue(async () => {
      try {
        await this.write(job);
      } catch (err) {
        // Keep the unsaved state around so the next flush/markClean retries it.
        if (!this.pending) this.pending = job;
        throw err;
      }
    });
  }

  async getRecovery(): Promise<RecoverySession | null> {
    await this.queue;
    const rec = await this.db.get<AutosaveRecord>('autosave', AUTOSAVE_SESSION_KEY);
    if (!isRecord(rec) || rec.dirty !== true) return null;
    return { photoId: rec.photoId, state: rec.state, savedAt: rec.savedAt };
  }

  /** Forget the recovery record (the user declined to restore). Pending work of the current session is kept. */
  discardRecovery(): Promise<void> {
    return this.enqueue(() => this.db.delete('autosave', AUTOSAVE_SESSION_KEY));
  }

  /** Flush, then mark the session as cleanly closed. */
  async markClean(): Promise<void> {
    await this.flush();
    await this.enqueue(async () => {
      const rec = await this.db.get<AutosaveRecord>('autosave', AUTOSAVE_SESSION_KEY);
      if (isRecord(rec) && rec.dirty) await this.db.put<AutosaveRecord>('autosave', AUTOSAVE_SESSION_KEY, { ...rec, dirty: false });
    });
  }

  /** Stop the timer and page hooks. Pending state is flushed (best-effort). */
  dispose(): Promise<void> {
    this.detachPageHooks?.();
    this.detachPageHooks = null;
    return this.flush().catch((err: unknown) => this.onError(err, 'dispose'));
  }

  /* ---------------------------------------------------------------- */

  private async write(job: Pending): Promise<void> {
    const savedAt = this.now();
    await this.saveEdit(job.photoId, job.state);
    await this.db.put<AutosaveRecord>('autosave', AUTOSAVE_SESSION_KEY, {
      photoId: job.photoId,
      state: job.state,
      savedAt,
      dirty: true,
    });
    this.onSaved?.(job.photoId, savedAt);
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private flushInBackground(): void {
    const id = this.pending?.photoId ?? '';
    this.flush().catch((err: unknown) => this.onError(err, id));
  }

  private attachPageHooks(): void {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') this.flushInBackground();
    };
    const onPageHide = () => this.flushInBackground();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    this.detachPageHooks = () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
    };
  }
}
