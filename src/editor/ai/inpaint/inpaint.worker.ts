/**
 * Inpainting worker: runs the PatchMatch core off the main thread. One job at
 * a time; the client terminates the worker to abort.
 */
import { inpaintRgba8 } from './patchmatch';
import type { InpaintJobRequest, InpaintJobResponse } from './protocol';

/** The bits of DedicatedWorkerGlobalScope we use (the project compiles against the DOM lib). */
interface WorkerScope {
  onmessage: ((e: MessageEvent<InpaintJobRequest>) => void) | null;
  postMessage(msg: InpaintJobResponse, transfer: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;

scope.onmessage = (e: MessageEvent<InpaintJobRequest>) => {
  const { id, data, width, height, mask, options } = e.data;
  let lastPost = 0;
  const post = (msg: InpaintJobResponse, transfer: Transferable[] = []) => scope.postMessage(msg, transfer);
  try {
    const out = inpaintRgba8(data, width, height, mask, options, {
      onProgress: (fraction) => {
        // Throttle progress messages (~20/s).
        const now = performance.now();
        if (now - lastPost < 50 && fraction < 1) return;
        lastPost = now;
        post({ id, type: 'progress', fraction });
      },
    });
    post({ id, type: 'done', data: out }, [out.buffer]);
  } catch (err) {
    const e2 = err instanceof Error ? err : new Error(String(err));
    post({ id, type: 'error', message: e2.message, name: e2.name });
  }
};
