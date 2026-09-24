/**
 * Command registry + global keyboard dispatcher.
 *
 * Key specs (Command.keys) look like 'Mod+Z', 'Shift+Mod+Z', 'Alt+Mod+V',
 * 'ArrowRight', '\\', '[', '?', 'Space'. `Mod` is ⌘ on macOS and Ctrl
 * elsewhere; `Ctrl` always means the Control key. Modifier order in the spec is
 * irrelevant; letters are case-insensitive.
 *
 * Dispatch rules
 * - Keys typed into text fields (input, textarea, select, contenteditable) are
 *   ignored, as are keys inside modal dialogs, menus and popovers (they own
 *   their keyboard handling). Controls that consume a key stop propagation.
 * - When several commands share a key, the most recently registered one whose
 *   `when()` passes wins (feature modules register after the shell's defaults,
 *   so they can specialise them).
 * - For punctuation keys whose character already implies Shift ('?', '+', '{')
 *   the Shift state is ignored unless the spec names Shift explicitly.
 * - `onKeyUp` fires on release of the key whose keydown ran the command
 *   ("hold to view original").
 */
import type { Command, CommandRegistry } from './context';

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);

interface ParsedKey {
  key: string;
  mod: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  /** Whether Shift was named explicitly. */
  shiftExplicit: boolean;
}

const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  space: ' ',
  spacebar: ' ',
  del: 'delete',
  left: 'arrowleft',
  right: 'arrowright',
  up: 'arrowup',
  down: 'arrowdown',
  plus: '+',
  minus: '-',
  return: 'enter',
};

function normKey(k: string): string {
  const low = k.toLowerCase();
  return KEY_ALIASES[low] ?? low;
}

export function parseKeySpec(spec: string): ParsedKey {
  // Split on '+' but keep a trailing literal '+' ("Mod++" / "+").
  const parts: string[] = [];
  let buf = '';
  for (let i = 0; i < spec.length; i++) {
    const c = spec[i];
    if (c === '+' && buf !== '') {
      parts.push(buf);
      buf = '';
    } else buf += c;
  }
  if (buf !== '') parts.push(buf);
  const out: ParsedKey = { key: '', mod: false, ctrl: false, shift: false, alt: false, shiftExplicit: false };
  for (const raw of parts) {
    const p = raw.trim().toLowerCase();
    if (p === 'mod' || p === 'cmdorctrl') out.mod = true;
    else if (p === 'cmd' || p === 'meta' || p === '⌘') out.mod = true;
    else if (p === 'ctrl' || p === 'control') out.ctrl = true;
    else if (p === 'shift' || p === '⇧') {
      out.shift = true;
      out.shiftExplicit = true;
    } else if (p === 'alt' || p === 'option' || p === '⌥') out.alt = true;
    else out.key = normKey(raw.trim() === '' ? raw : raw.trim());
  }
  return out;
}

/** Map KeyboardEvent.code to the unshifted character (layout-independent fallback; macOS Alt+letter produces symbols). */
function keyFromCode(code: string): string | null {
  if (code.startsWith('Key')) return code.slice(3).toLowerCase();
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad') && /^\d$/.test(code.slice(6))) return code.slice(6);
  const map: Record<string, string> = {
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Slash: '/',
    Minus: '-',
    Equal: '=',
    Comma: ',',
    Period: '.',
    Semicolon: ';',
    Quote: "'",
    Backquote: '`',
    NumpadAdd: '+',
    NumpadSubtract: '-',
  };
  return map[code] ?? null;
}

const LETTER_OR_DIGIT = /^[a-z0-9]$/;

export function matchesKey(p: ParsedKey, e: KeyboardEvent): boolean {
  if (IS_MAC) {
    // On macOS Ctrl is a separate modifier from ⌘.
    if (p.mod !== e.metaKey || p.ctrl !== e.ctrlKey) return false;
  } else {
    // Elsewhere Ctrl *is* Mod; the Windows key never takes part in shortcuts.
    if ((p.mod || p.ctrl) !== e.ctrlKey || e.metaKey) return false;
  }
  if (p.alt !== e.altKey) return false;
  const evKey = normKey(e.key);
  const codeKey = keyFromCode(e.code);
  const isNamed = p.key.length > 1; // Escape, ArrowLeft, Enter, Tab…
  const shiftMatters = p.shiftExplicit || LETTER_OR_DIGIT.test(p.key) || isNamed;
  if (shiftMatters && p.shift !== e.shiftKey) return false;
  if (evKey === p.key) return true;
  // Fallback to the physical key when the produced character differs (Alt on macOS, non-Latin layouts).
  if (codeKey !== null && codeKey === p.key && (LETTER_OR_DIGIT.test(p.key) || e.altKey || !/^[\x20-\x7e]$/.test(e.key))) return true;
  return false;
}

/** True when the event comes from somewhere that owns its own keys. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLInputElement) {
    const t = target.type;
    // Checkboxes / radios / ranges / buttons don't take text.
    return !['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'color', 'file'].includes(t);
  }
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  // Popup lists own their arrow keys. A plain role="listbox" (the photo grid, the
  // filmstrip) must NOT swallow shortcuts: rating / flag keys are pressed while it has focus.
  return !!target.closest('.k-dialog-layer, .k-menu, .k-popover, [role="menu"], .k-popover [role="listbox"]');
}

export interface KeyboardOptions {
  /** Only handle keys whose target is inside this element (embedded mode); `document.body` always counts. */
  scope?: HTMLElement | null;
}

export interface CommandRegistryImpl extends CommandRegistry {
  /** Attach the global keydown/keyup listeners. Returns a remover. */
  attach(opts?: KeyboardOptions): () => void;
  /** Handle one keydown (exposed for tests). Returns true when a command ran. */
  handleKeyDown(e: KeyboardEvent): boolean;
  handleKeyUp(e: KeyboardEvent): void;
  /** Fires whenever a command is registered/unregistered (help overlay refresh). */
  onChange(cb: () => void): () => void;
}

interface Entry {
  cmd: Command;
  parsed: ParsedKey[];
  seq: number;
}

export function createCommandRegistry(): CommandRegistryImpl {
  const entries: Entry[] = [];
  const listeners = new Set<() => void>();
  let seq = 0;
  /** Commands whose keydown ran and that want the keyup, keyed by e.code (fallback e.key). */
  const held = new Map<string, Command>();

  const notify = (): void => {
    for (const l of [...listeners]) l();
  };

  const passes = (cmd: Command): boolean => {
    try {
      return cmd.when ? cmd.when() : true;
    } catch (err) {
      console.error(`[kloud] command "${cmd.id}" when() threw`, err);
      return false;
    }
  };

  const execute = (cmd: Command, e?: KeyboardEvent): void => {
    try {
      cmd.run(e);
    } catch (err) {
      console.error(`[kloud] command "${cmd.id}" failed`, err);
    }
  };

  const registry: CommandRegistryImpl = {
    register(cmd) {
      const entry: Entry = { cmd, parsed: (cmd.keys ?? []).map(parseKeySpec), seq: seq++ };
      // Re-registering an id replaces the previous definition.
      const existing = entries.findIndex((x) => x.cmd.id === cmd.id);
      if (existing >= 0) entries.splice(existing, 1);
      entries.push(entry);
      notify();
      return () => {
        const i = entries.indexOf(entry);
        if (i >= 0) {
          entries.splice(i, 1);
          notify();
        }
      };
    },
    run(id) {
      for (let i = entries.length - 1; i >= 0; i--) {
        const { cmd } = entries[i];
        if (cmd.id !== id) continue;
        if (!passes(cmd)) return false;
        execute(cmd);
        return true;
      }
      return false;
    },
    list() {
      return entries.map((e) => e.cmd);
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    handleKeyDown(e) {
      if (e.defaultPrevented || e.isComposing) return false;
      if (isTypingTarget(e.target)) return false;
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (!entry.parsed.some((p) => matchesKey(p, e))) continue;
        if (!passes(entry.cmd)) continue;
        e.preventDefault();
        if (entry.cmd.onKeyUp) {
          // Key repeat of a hold-command must not re-run it.
          if (e.repeat) return true;
          held.set(e.code || e.key, entry.cmd);
        }
        execute(entry.cmd, e);
        return true;
      }
      return false;
    },
    handleKeyUp(e) {
      const k = e.code || e.key;
      const cmd = held.get(k);
      if (!cmd) return;
      held.delete(k);
      try {
        cmd.onKeyUp?.(e);
      } catch (err) {
        console.error(`[kloud] command "${cmd.id}" onKeyUp failed`, err);
      }
    },
    attach(opts = {}) {
      const inScope = (e: KeyboardEvent): boolean => {
        const scope = opts.scope;
        if (!scope) return true;
        const t = e.target;
        return t === document.body || t === document.documentElement || (t instanceof Node && scope.contains(t));
      };
      const down = (e: KeyboardEvent): void => {
        if (inScope(e)) registry.handleKeyDown(e);
      };
      const up = (e: KeyboardEvent): void => registry.handleKeyUp(e);
      // Releasing every hold-command when the window loses focus avoids a stuck "before" view.
      const blur = (): void => {
        for (const [k, cmd] of [...held]) {
          held.delete(k);
          try {
            cmd.onKeyUp?.(new KeyboardEvent('keyup', { key: k }));
          } catch (err) {
            console.error(err);
          }
        }
      };
      window.addEventListener('keydown', down);
      window.addEventListener('keyup', up);
      window.addEventListener('blur', blur);
      return () => {
        window.removeEventListener('keydown', down);
        window.removeEventListener('keyup', up);
        window.removeEventListener('blur', blur);
      };
    },
  };
  return registry;
}
