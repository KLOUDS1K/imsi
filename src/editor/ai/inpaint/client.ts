/**
 * Runs PatchMatch jobs in a dedicated Web Worker (one worker per job, so an
 * abort simply terminates it). Where Workers are unavailable (Node tests,
 * exotic embeds) the core runs on the calling thread after yielding once.
 */
import { InpaintAbortError, inpaintRgba8, type PatchMatchOptions } from './patchmatch';
import type { InpaintJobRequest, InpaintJobResponse } from './protocol';

export interface JobControl {
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

let nextId = 1;

function createWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  try {
    return new Worker(new URL('./inpaint.worker.ts', import.meta.url), { type: 'module', name: 'kloud-inpaint' });
  } catch {
    return null;
  }
}

/**
 * Inpaint `data` (RGBA8, width×height) where `mask` > 0. Resolves with a new
 * RGBA8 array; rejects with an AbortError when `signal` fires.
 * `data` and `mask` are not modified (the worker receives transferred copies,
 * so the originals stay available for the inline fallback).
 */
export function runInpaintJob(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  mask: Uint8Array,
  options: Partial<PatchMatchOptions>,
  ctl: JobControl = {},
): Promise<Uint8ClampedArray> {
  if (ctl.signal?.aborted) return Promise.reject(new InpaintAbortError());
  const worker = createWorker();
  if (!worker) return runInline(data, width, height, mask, options, ctl);

  return new Promise<Uint8ClampedArray>((resolve, reject) => {
    const id = nextId++;
    let settled = false;
    const finish = () => {
      settled = true;
      ctl.signal?.removeEventListener('abort', onAbort);
      worker.terminate();
    };
    const onAbort = () => {
      if (settled) return;
      finish();
      reject(new InpaintAbortError());
    };
    ctl.signal?.addEventListener('abort', onAbort, { once: true });
    worker.onmessage = (e: MessageEvent<InpaintJobResponse>) => {
      const msg = e.data;
      if (msg.id !== id || settled) return;
      if (msg.type === 'progress') {
        ctl.onProgress?.(msg.fraction);
      } else if (msg.type === 'done') {
        finish();
        ctl.onProgress?.(1);
        resolve(msg.data);
      } else {
        finish();
        const err = new Error(msg.message);
        err.name = msg.name;
        reject(err);
      }
    };
    worker.onerror = (e: ErrorEvent) => {
      if (settled) return;
      finish();
      // Worker failed to load (e.g. blocked by CSP): fall back to the calling thread.
      e.preventDefault?.();
      runInline(data, width, height, mask, options, ctl).then(resolve, reject);
    };
    const dataCopy = new Uint8ClampedArray(data);
    const maskCopy = new Uint8Array(mask);
    const req: InpaintJobRequest = { id, data: dataCopy, width, height, mask: maskCopy, options };
    worker.postMessage(req, [dataCopy.buffer, maskCopy.buffer]);
  });
}

async function runInline(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  mask: Uint8Array,
  options: Partial<PatchMatchOptions>,
  ctl: JobControl,
): Promise<Uint8ClampedArray> {
  await new Promise<void>((r) => setTimeout(r, 0));
  if (ctl.signal?.aborted) throw new InpaintAbortError();
  return inpaintRgba8(data, width, height, mask, options, {
    onProgress: ctl.onProgress,
    isAborted: () => !!ctl.signal?.aborted,
  });
}
