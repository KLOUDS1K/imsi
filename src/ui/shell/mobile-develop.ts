/** Phone-only primary tool dock. Desktop continues to use the right-panel toolbar. */
import type { AppContext, DevelopTool } from '@/app/context';
import { Disposer, h } from '@/ui/dom';
import { icon, type IconName } from '@/ui/kit';
import type { ShellState } from './state';

interface DockTool {
  id: DevelopTool;
  icon: IconName;
  label: string;
}

const TOOLS: DockTool[] = [
  { id: 'edit', icon: 'sliders', label: 'Adjust' },
  { id: 'crop', icon: 'crop', label: 'Crop' },
  { id: 'heal', icon: 'bandage', label: 'Retouch' },
  { id: 'masks', icon: 'layers', label: 'Masks' },
  { id: 'ai', icon: 'sparkles', label: 'AI' },
];

export interface MobileDevelopDock {
  el: HTMLElement;
  dispose(): void;
}

export function createMobileDevelopDock(ctx: AppContext, state: ShellState): MobileDevelopDock {
  const d = new Disposer();
  const buttons = TOOLS.map((tool) => {
    const button = h(
      'button',
      {
        type: 'button',
        class: 'k-mobile-dock__button',
        attrs: { role: 'tab', 'aria-label': tool.label, 'aria-controls': 'kloud-mobile-develop-sheet' },
        onclick: () => {
          const active = ctx.tool.value === tool.id;
          if (active && state.mobilePanelOpen.value) state.mobilePanelOpen.set(false);
          else {
            ctx.tool.set(tool.id);
            state.mobilePanelOpen.set(true);
          }
        },
      },
      h('span', { class: 'k-mobile-dock__icon', attrs: { 'aria-hidden': 'true' } }, icon(tool.icon, 20)),
      h('span', { class: 'k-mobile-dock__label' }, tool.label),
    );
    return { tool, button };
  });
  const el = h('nav', { class: 'k-mobile-dock', attrs: { 'aria-label': 'Develop tools', role: 'tablist' } }, ...buttons.map((item) => item.button));

  const render = (): void => {
    const current = ctx.tool.value;
    const open = state.mobilePanelOpen.value;
    for (const { tool, button } of buttons) {
      const selected = open && tool.id === current;
      button.classList.toggle('is-active', selected);
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = tool.id === current ? 0 : -1;
    }
  };
  d.add(ctx.tool.subscribe(render));
  d.add(state.mobilePanelOpen.subscribe(render));
  render();

  return {
    el,
    dispose() {
      d.dispose();
      el.remove();
    },
  };
}
