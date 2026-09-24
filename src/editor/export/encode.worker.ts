/// <reference lib="webworker" />
/**
 * Encode worker: runs one EncodeTask and posts the encoded bytes back
 * (transferred, zero-copy).
 */
import { runEncodeTaskSync, type EncodeTask } from './tasks';

interface Req {
  id: number;
  task: EncodeTask;
}

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (e: MessageEvent<Req>) => {
  const { id, task } = e.data;
  try {
    const bytes = runEncodeTaskSync(task);
    scope.postMessage({ id, ok: true, bytes }, [bytes.buffer]);
  } catch (err) {
    scope.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
