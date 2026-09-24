/**
 * Runs an EncodeTask in a dedicated module worker (so a 24 MP PNG/TIFF encode
 * never blocks the UI), falling back to inline execution when workers are not
 * available or fail to start. The pixel buffer is copied, then transferred, so
 * the caller's RenderedImage stays intact.
 */
import { runEncodeTaskSync, type EncodeTask } from './tasks';

interface Res {
  id: number;
  ok: boolean;
  bytes?: Uint8Array;
  error?: string;
}

let nextId = 1;

export function runEncodeTask(task: EncodeTask): Promise<Uint8Array> {
  if (typeof Worker === 'undefined') return Promise.resolve().then(() => runEncodeTaskSync(task));
  let worker: Worker;
  try {
    worker = new Worker(new URL('./encode.worker.ts', import.meta.url), { type: 'module', name: 'kloud-encode' });
  } catch {
    return Promise.resolve().then(() => runEncodeTaskSync(task));
  }
  const id = nextId++;
  const copy = task.data.slice();
  return new Promise<Uint8Array>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<Res>) => {
      if (e.data.id !== id) return;
      worker.terminate();
      if (e.data.ok && e.data.bytes) resolve(e.data.bytes);
      else reject(new Error(e.data.error ?? 'encode failed'));
    };
    worker.onerror = (e: ErrorEvent) => {
      e.preventDefault();
      worker.terminate();
      // Worker blocked (CSP, bundling) or crashed → encode inline instead; if that also
      // fails (e.g. out of memory) the error surfaces to the caller.
      try {
        resolve(runEncodeTaskSync(task));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(e.message || 'encode failed'));
      }
    };
    worker.postMessage({ id, task: { ...task, data: copy } }, [copy.buffer]);
  });
}
