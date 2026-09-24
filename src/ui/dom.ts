/**
 * Minimal DOM helpers used by every UI module (no framework).
 *
 *   h('div', { class: 'k-row', onclick: fn, dataset: { id } }, child, 'text')
 */
type Child = Node | string | number | null | undefined | false | Child[];

export type Props = {
  class?: string | (string | false | null | undefined)[];
  style?: Partial<CSSStyleDeclaration> | string;
  dataset?: Record<string, string>;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  [key: string]: unknown;
};

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) applyProps(el, props);
  append(el, children);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs?: Record<string, string | number>, ...children: Child[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  append(el, children);
  return el;
}

export function applyProps(el: HTMLElement, props: Props): void {
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === 'class') {
      el.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : String(value);
    } else if (key === 'style') {
      if (typeof value === 'string') el.style.cssText = value;
      else Object.assign(el.style, value);
    } else if (key === 'dataset') {
      Object.assign(el.dataset, value as Record<string, string>);
    } else if (key === 'attrs') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (v === false || v === null || v === undefined) el.removeAttribute(k);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    } else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key in el) {
      (el as unknown as Record<string, unknown>)[key] = value;
    } else {
      el.setAttribute(key, String(value));
    }
  }
}

export function append(parent: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(parent, c);
    else parent.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function cls(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}

/** addEventListener that returns its own remover. */
export function on<K extends keyof HTMLElementEventMap>(
  target: HTMLElement | Window | Document,
  type: K,
  fn: (e: HTMLElementEventMap[K]) => void,
  opts?: AddEventListenerOptions,
): () => void {
  target.addEventListener(type, fn as EventListener, opts);
  return () => target.removeEventListener(type, fn as EventListener, opts);
}

/** Collects disposers; call dispose() when a component unmounts. */
export class Disposer {
  private fns: (() => void)[] = [];
  add(fn: (() => void) | undefined | null): void {
    if (fn) this.fns.push(fn);
  }
  dispose(): void {
    for (const fn of this.fns.splice(0).reverse()) {
      try {
        fn();
      } catch (e) {
        console.error(e);
      }
    }
  }
}

/** Short random id (not crypto-grade). */
export function uid(prefix = ''): string {
  return prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}
