/**
 * Busy tracker: several background tasks (opening a photo, AI masks, imports)
 * can run at once while ctx.busy shows one line. The most recently started
 * task that is still running is shown; when it ends, the previous one comes
 * back. Other modules may also write ctx.busy directly (export dialog…); the
 * tracker only clears the signal if it still shows one of its own tasks.
 */
import type { Signal } from '@/ui/signal';

export type BusyState = { active: boolean; label?: string; progress?: number };

export interface BusyTask {
  update(progress?: number, label?: string): void;
  end(): void;
}

export interface BusyTracker {
  begin(label: string, progress?: number): BusyTask;
}

export function createBusyTracker(signal: Signal<BusyState>): BusyTracker {
  const tasks: { label: string; progress?: number }[] = [];
  let shown: BusyState | null = null;

  const show = (): void => {
    const top = tasks[tasks.length - 1];
    if (top) {
      shown = { active: true, label: top.label, progress: top.progress };
      signal.set(shown);
    } else if (shown && signal.value === shown) {
      shown = null;
      signal.set({ active: false });
    } else {
      shown = null;
    }
  };

  return {
    begin(label, progress) {
      const task = { label, progress };
      tasks.push(task);
      show();
      let ended = false;
      return {
        update(p, l) {
          if (ended) return;
          task.progress = p;
          if (l) task.label = l;
          if (tasks[tasks.length - 1] === task) show();
        },
        end() {
          if (ended) return;
          ended = true;
          const i = tasks.indexOf(task);
          if (i >= 0) tasks.splice(i, 1);
          show();
        },
      };
    },
  };
}
