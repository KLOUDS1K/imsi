/**
 * Link between a mounted viewer and the keyboard commands registered by
 * registerViewerCommands (which only receive the AppContext).
 */
import type { AppContext } from '@/app/context';
import type { Point } from '@/editor/types';
import type { ToolCommand } from './host';

export interface ViewerController {
  /** Forward a tool command to the active on-image tool; false when not handled. */
  toolCommand(cmd: ToolCommand): boolean;
  /** Last pointer position over the stage (stage CSS px), or null. */
  pointer(): Point | null;
  /** Name of the active on-image tool ('crop' | 'masks' | 'heal' | 'wb') or null. */
  activeTool(): string | null;
}

const controllers = new WeakMap<AppContext, ViewerController>();

export function setController(ctx: AppContext, c: ViewerController | null): void {
  if (c) controllers.set(ctx, c);
  else controllers.delete(ctx);
}

export function getController(ctx: AppContext): ViewerController | undefined {
  return controllers.get(ctx);
}
