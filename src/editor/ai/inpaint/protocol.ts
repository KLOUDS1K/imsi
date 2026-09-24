/** Message protocol between the inpaint client and `inpaint.worker.ts`. */
import type { PatchMatchOptions } from './patchmatch';

export interface InpaintJobRequest {
  id: number;
  data: Uint8ClampedArray;
  width: number;
  height: number;
  mask: Uint8Array;
  options: Partial<PatchMatchOptions>;
}

export type InpaintJobResponse =
  | { id: number; type: 'progress'; fraction: number }
  | { id: number; type: 'done'; data: Uint8ClampedArray }
  | { id: number; type: 'error'; message: string; name: string };
