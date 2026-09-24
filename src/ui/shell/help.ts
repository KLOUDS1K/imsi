/**
 * Keyboard shortcuts overlay ("?"): every registered command whose `when()`
 * currently passes, grouped by `group`, with a filter field. Commands that
 * don't apply right now can be revealed with "Show all".
 */
import './help.css';
import type { Command } from '@/app/context';
import type { AppRuntime } from '@/app/createContext';
import { createCheckbox, createKbd, createSearchInput, openDialog } from '@/ui/kit';
import { Disposer, h } from '@/ui/dom';

const GROUP_ORDER = ['Navigate', 'Edit', 'View', 'Develop', 'Tools', 'Masks', 'Library', 'File', 'Panels', 'App'];

function applicable(cmd: Command): boolean {
  try {
    return cmd.when ? cmd.when() : true;
  } catch {
    return false;
  }
}

let open = false;

export function openShortcutsHelp(rt: AppRuntime): void {
  if (open) return;
  open = true;
  const d = new Disposer();
  let showAll = false;
  let filter = '';
  const list = h('div', { class: 'k-help__groups' });

  const render = (): void => {
    const cmds = rt.commands.list().filter((c) => c.keys?.length && (showAll || applicable(c)));
    const q = filter.trim().toLowerCase();
    const shown = q ? cmds.filter((c) => c.label.toLowerCase().includes(q) || c.keys?.some((k) => k.toLowerCase().includes(q))) : cmds;
    const groups = new Map<string, Command[]>();
    for (const c of shown) {
      const g = c.group ?? 'App';
      groups.set(g, [...(groups.get(g) ?? []), c]);
    }
    const names = [...groups.keys()].sort((a, b) => {
      const ia = GROUP_ORDER.indexOf(a);
      const ib = GROUP_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    });
    list.replaceChildren(
      ...names.map((g) =>
        h(
          'section',
          { class: 'k-help__group' },
          h('h3', { class: 'k-label k-help__title' }, g),
          h(
            'dl',
            { class: 'k-help__list' },
            ...(groups.get(g) ?? []).map((c) =>
              h(
                'div',
                { class: 'k-help__row' },
                h('dt', { class: 'k-help__label' }, c.label),
                h('dd', { class: 'k-help__keys' }, ...(c.keys ?? []).slice(0, 2).map((k) => createKbd(k).el)),
              ),
            ),
          ),
        ),
      ),
    );
    if (!names.length) list.append(h('p', { class: 'k-desc' }, q ? 'No shortcut matches that search.' : 'No shortcuts apply here.'));
  };

  const search = createSearchInput({ placeholder: 'Filter shortcuts', width: '220px', debounce: 0, onInput: (v) => ((filter = v), render()) });
  const all = createCheckbox({ checked: false, label: 'Show all', onChange: (v) => ((showAll = v), render()) });
  d.add(() => (search.destroy(), all.destroy()));
  d.add(rt.commands.onChange(render));
  render();

  const dlg = openDialog<null>({
    title: 'Keyboard shortcuts',
    description: 'Mod is ⌘ on macOS and Ctrl on Windows / Linux. Shortcuts pause while you type in a field.',
    content: h('div', { class: 'k-help' }, h('div', { class: 'k-help__bar' }, search.el, all.el), list),
    size: 'lg',
    initialFocus: search.input,
    onClose: () => {
      open = false;
      d.dispose();
    },
  });
  void dlg.result;
}
