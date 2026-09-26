/**
 * Develop viewport: mounts the engine canvas, routes pointer input to the
 * active on-image tool (crop / masks / heal / white-balance picker), handles
 * zoom, pan and pinch, and draws tool overlays in an SVG layer.
 */
import './viewer.css';
import type { AppContext } from '../../app/context';
import type { Point } from '../../editor/types';
import { Disposer, h, svg } from '../dom';
import { signal } from '../signal';
import { getController, setController } from './controller';
import { createCropTool } from './crop-tool';
import { createHealTool } from './heal-tool';
import { createMapping, shownParams, type Mapping, type ToolCommand, type ViewerHost, type ViewerTool } from './host';
import { createMaskTool } from './mask-tool';
import { createViewerBar } from './viewer-bar';
import { createWbTool } from './wb-tool';
import { visibleRect } from './view-math';
import { centerOn, currentTransform, cycleCompareLayout, isZoomedIn, panBy, setZoom, stepZoom, toggleBefore, toggleClipping, toggleFit100, zoomBy, zoomGesture } from './zoom';

export function createViewer(ctx: AppContext): { el: HTMLElement; dispose(): void } {
  const d = new Disposer();
  const root = h('div', { class: 'k-viewer' });
  const stage = h('div', { class: 'k-viewer__stage', attrs: { tabindex: 0, 'aria-label': 'Photo' } });
  const overlay = svg('svg', { class: 'k-viewer__overlay' });
  const layer = svg('g');
  overlay.append(layer);
  const busy = h('div', { class: 'k-viewer__busy', hidden: true }, h('span', { class: 'k-viewer__spinner' }), h('span', { class: 'k-viewer__busy-label' }));
  const empty = h('div', { class: 'k-viewer__empty' }, 'Open a photo from the library to start editing.');

  const engine = ctx.engine;
  if (engine) {
    engine.canvas.classList.add('k-viewer__canvas');
    stage.append(engine.canvas);
  } else {
    stage.append(h('div', { class: 'k-viewer__empty' }, 'This browser does not support WebGL2, which the editor needs to render photos. Try a recent Chrome, Edge, Safari or Firefox.'));
  }
  stage.append(overlay, busy, empty);

  let alt = false;
  let raf = 0;
  const host: ViewerHost = {
    ctx,
    stage,
    mapping(): Mapping | null {
      const doc = ctx.doc.value;
      const params = shownParams(ctx);
      const t = currentTransform(ctx);
      if (!doc || !params || !t) return null;
      return createMapping(t, params, doc.source.width, doc.source.height, ctx.tool.value === 'crop');
    },
    requestDraw() {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(draw);
    },
    local(e) {
      const r = stage.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    },
    altDown: () => alt,
  };

  const straighten = signal(false);
  const spiral = signal(0);
  const tools = {
    crop: createCropTool(host, { straighten, spiral }),
    masks: createMaskTool(host),
    heal: createHealTool(host),
    wb: createWbTool(host),
  };
  d.add(() => Object.values(tools).forEach((t) => t.dispose()));
  const activeTool = (): ViewerTool | null => {
    if (!ctx.doc.value) return null;
    if (ctx.wbPickerActive.value) return tools.wb;
    const t = ctx.tool.value;
    return t === 'crop' ? tools.crop : t === 'masks' ? tools.masks : t === 'heal' ? tools.heal : null;
  };

  const bar = createViewerBar(ctx, {
    straighten,
    onCropReset: () => tools.crop.command?.('delete'),
    onCropCancel: () => tools.crop.command?.('escape'),
  });
  d.add(() => bar.dispose());
  stage.append(bar.furniture);
  root.append(stage, bar.el);

  function draw(): void {
    while (layer.firstChild) layer.removeChild(layer.firstChild);
    const m = host.mapping();
    const tool = activeTool();
    if (m && tool) tool.draw(layer, m);
    bar.refresh();
  }

  /* ----------------------------- input ----------------------------- */
  let lastPointer: Point | null = null;
  let dragTool: ViewerTool | null = null;
  let pan: { id: number; x: number; y: number } | null = null;
  let spaceDown = false;
  const touches = new Map<number, Point>();
  const touchStarts = new Map<number, { point: Point; moved: boolean }>();
  let pinch: { dist: number; mid: Point } | null = null;
  let lastTap: { at: number; point: Point } | null = null;
  let wheelIntent: 'zoom' | 'pan' | null = null;
  let wheelTimer = 0;
  let readoutRaf = 0;

  const updateReadout = (p: Point) => {
    cancelAnimationFrame(readoutRaf);
    readoutRaf = requestAnimationFrame(() => {
      const t = currentTransform(ctx);
      if (!t || !ctx.engine) return;
      const u = (p.x - t.offsetX) / (t.scale * t.outWidth);
      const v = (p.y - t.offsetY) / (t.scale * t.outHeight);
      if (u < 0 || v < 0 || u > 1 || v > 1) return ctx.pixelReadout.set(null);
      ctx.pixelReadout.set({ u, v, rgb: ctx.engine.samplePixel(u, v) });
    });
  };

  const onDown = (e: PointerEvent) => {
    if (!ctx.doc.value) return;
    stage.focus({ preventScroll: true });
    const p = host.local(e);
    lastPointer = p;
    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, p);
      touchStarts.set(e.pointerId, { point: p, moved: false });
      stage.setPointerCapture(e.pointerId);
      if (touches.size === 2) {
        dragTool?.onCancel?.();
        dragTool = null;
        pan = null;
        stage.classList.remove('is-panning');
        for (const start of touchStarts.values()) start.moved = true;
        const [a, b] = [...touches.values()];
        pinch = { dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
        e.preventDefault();
        return;
      }
    }
    const tool = activeTool();
    const wantsPan = e.button === 1 || spaceDown || (!tool && isZoomedIn(ctx));
    if (!wantsPan && tool?.onPointerDown?.(e, p)) {
      dragTool = tool;
      stage.setPointerCapture(e.pointerId);
      e.preventDefault();
      host.requestDraw();
      return;
    }
    if (wantsPan || isZoomedIn(ctx)) {
      pan = { id: e.pointerId, x: p.x, y: p.y };
      stage.setPointerCapture(e.pointerId);
      stage.classList.add('is-panning');
      e.preventDefault();
    }
  };
  const onMove = (e: PointerEvent) => {
    const p = host.local(e);
    lastPointer = p;
    if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
      touches.set(e.pointerId, p);
      const origin = touchStarts.get(e.pointerId);
      if (origin && Math.hypot(p.x - origin.point.x, p.y - origin.point.y) > 7) origin.moved = true;
      if (pinch && touches.size === 2) {
        const [a, b] = [...touches.values()];
        const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        zoomGesture(ctx, dist / pinch.dist, pinch.mid, mid);
        pinch = { dist, mid };
        e.preventDefault();
        return;
      }
    }
    if (dragTool) {
      dragTool.onPointerMove?.(e, p);
      host.requestDraw();
      return;
    }
    if (pan && pan.id === e.pointerId) {
      panBy(ctx, p.x - pan.x, p.y - pan.y);
      pan.x = p.x;
      pan.y = p.y;
      return;
    }
    const tool = activeTool();
    tool?.onHover?.(p, e);
    stage.style.cursor = spaceDown ? 'grab' : (tool?.cursor?.(p, e) ?? (isZoomedIn(ctx) ? 'grab' : 'default'));
    if (tool) host.requestDraw();
    updateReadout(p);
  };
  const onUp = (e: PointerEvent) => {
    const p = host.local(e);
    const touchStart = touchStarts.get(e.pointerId);
    const endedPinch = !!pinch;
    touches.delete(e.pointerId);
    touchStarts.delete(e.pointerId);
    if (touches.size < 2) {
      pinch = null;
      if (endedPinch && touches.size === 1 && isZoomedIn(ctx)) {
        const [id, point] = [...touches.entries()][0];
        pan = { id, x: point.x, y: point.y };
        stage.classList.add('is-panning');
      }
    }
    if (dragTool) {
      dragTool.onPointerUp?.(e, host.local(e));
      dragTool = null;
      host.requestDraw();
    }
    if (pan && pan.id === e.pointerId) {
      pan = null;
      stage.classList.remove('is-panning');
    }
    if (e.pointerType === 'touch' && !endedPinch && !touchStart?.moved && !activeTool()) {
      const now = performance.now();
      if (lastTap && now - lastTap.at < 320 && Math.hypot(p.x - lastTap.point.x, p.y - lastTap.point.y) < 28) {
        toggleFit100(ctx, p);
        lastTap = null;
      } else {
        lastTap = { at: now, point: p };
      }
    }
    if (stage.hasPointerCapture(e.pointerId)) stage.releasePointerCapture(e.pointerId);
  };
  const onCancel = (e: PointerEvent) => {
    touches.clear();
    touchStarts.clear();
    pinch = null;
    dragTool?.onCancel?.();
    dragTool = null;
    pan = null;
    stage.classList.remove('is-panning');
    host.requestDraw();
  };
  const onLostCapture = (e: PointerEvent) => {
    // releasePointerCapture() after a normal pointerup also emits this event;
    // only cancel when the pointer is still part of an active interaction.
    if (touches.has(e.pointerId) || pan?.id === e.pointerId || dragTool) onCancel(e);
  };
  const onLeave = () => {
    ctx.pixelReadout.set(null);
    activeTool()?.onHover?.(null, null);
    host.requestDraw();
  };
  const onWheel = (e: WheelEvent) => {
    if (!ctx.doc.value) return;
    e.preventDefault();
    const p = host.local(e);
    const unit = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? stage.clientHeight : 1;
    const dx = e.deltaX * unit;
    const dy = e.deltaY * unit;
    if (!wheelIntent) {
      const pinchWheel = e.ctrlKey || e.metaKey;
      const steppedWheel = e.deltaMode !== WheelEvent.DOM_DELTA_PIXEL || (Math.abs(dx) < 1 && Math.abs(dy) >= 40);
      wheelIntent = pinchWheel || steppedWheel || !isZoomedIn(ctx) ? 'zoom' : 'pan';
    }
    window.clearTimeout(wheelTimer);
    wheelTimer = window.setTimeout(() => { wheelIntent = null; }, 160);
    if (wheelIntent === 'zoom' && !e.shiftKey) {
      const factor = Math.exp(-dy * (e.ctrlKey || e.metaKey ? 0.006 : 0.0015));
      zoomBy(ctx, factor, p);
    } else {
      panBy(ctx, e.shiftKey && Math.abs(dx) < 1 ? -dy : -dx, e.shiftKey ? 0 : -dy);
    }
  };
  const onDbl = (e: MouseEvent) => {
    if (!ctx.doc.value) return;
    const p = host.local(e);
    if (activeTool()?.onDoubleClick?.(p)) return host.requestDraw();
    toggleFit100(ctx, p);
  };
  const onKey = (e: KeyboardEvent) => {
    alt = e.altKey;
    if (e.code === 'Space' && !(e.target instanceof HTMLInputElement)) {
      spaceDown = e.type === 'keydown';
      if (spaceDown && e.target === stage) e.preventDefault();
    }
  };
  const resetPointers = () => {
    touches.clear();
    touchStarts.clear();
    pinch = null;
    pan = null;
    dragTool?.onCancel?.();
    dragTool = null;
    stage.classList.remove('is-panning');
    host.requestDraw();
  };
  stage.addEventListener('pointerdown', onDown);
  stage.addEventListener('pointermove', onMove);
  stage.addEventListener('pointerup', onUp);
  stage.addEventListener('pointercancel', onCancel);
  stage.addEventListener('lostpointercapture', onLostCapture);
  stage.addEventListener('pointerleave', onLeave);
  stage.addEventListener('wheel', onWheel, { passive: false });
  stage.addEventListener('dblclick', onDbl);
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);
  window.addEventListener('blur', resetPointers);
  d.add(() => {
    stage.removeEventListener('pointerdown', onDown);
    stage.removeEventListener('pointermove', onMove);
    stage.removeEventListener('pointerup', onUp);
    stage.removeEventListener('pointercancel', onCancel);
    stage.removeEventListener('lostpointercapture', onLostCapture);
    stage.removeEventListener('pointerleave', onLeave);
    stage.removeEventListener('wheel', onWheel);
    stage.removeEventListener('dblclick', onDbl);
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('keyup', onKey);
    window.removeEventListener('blur', resetPointers);
    window.clearTimeout(wheelTimer);
    cancelAnimationFrame(raf);
    cancelAnimationFrame(readoutRaf);
  });

  /* ----------------------------- layout ----------------------------- */
  const ro = new ResizeObserver(() => {
    const r = stage.getBoundingClientRect();
    if (!engine || r.width < 1 || r.height < 1) return;
    engine.resize(r.width, r.height, window.devicePixelRatio || 1);
    overlay.setAttribute('width', String(r.width));
    overlay.setAttribute('height', String(r.height));
    ctx.requestRender();
    host.requestDraw();
  });
  ro.observe(stage);
  d.add(() => ro.disconnect());

  const syncEmpty = () => {
    empty.hidden = !!ctx.doc.value;
    stage.classList.toggle('has-doc', !!ctx.doc.value);
  };
  syncEmpty();
  d.add(ctx.doc.subscribe(() => {
    syncEmpty();
    host.requestDraw();
    const doc = ctx.doc.value;
    if (doc) d.add(doc.store.subscribe(() => host.requestDraw()));
  }));
  d.add(ctx.view.subscribe(() => host.requestDraw()));
  d.add(ctx.tool.subscribe(() => {
    dragTool = null;
    host.requestDraw();
  }));
  d.add(ctx.wbPickerActive.subscribe(() => host.requestDraw()));
  d.add(ctx.activeMaskId.subscribe(() => host.requestDraw()));
  d.add(ctx.maskDrawTool.subscribe(() => host.requestDraw()));
  if (engine) d.add(engine.onRendered(() => host.requestDraw()));
  d.add(
    ctx.busy.subscribe((b) => {
      busy.hidden = !b.active;
      const label = busy.querySelector('.k-viewer__busy-label');
      if (label) label.textContent = b.label ? `${b.label}${b.progress !== undefined ? ` ${Math.round(b.progress * 100)}%` : ''}` : 'Working…';
    }, true),
  );

  setController(ctx, {
    toolCommand: (cmd: ToolCommand) => {
      const handled = activeTool()?.command?.(cmd) ?? false;
      if (handled) host.requestDraw();
      return handled;
    },
    pointer: () => lastPointer,
    activeTool: () => activeTool()?.name ?? null,
  });
  d.add(() => setController(ctx, null));

  return { el: root, dispose: () => d.dispose() };
}

/** Mini-map: preview of the current render with the visible viewport rectangle. */
export function createNavigator(ctx: AppContext): { el: HTMLElement; dispose(): void } {
  const d = new Disposer();
  const canvas = h('canvas', { class: 'k-nav__canvas', width: 240, height: 160 });
  const rect = h('div', { class: 'k-nav__rect' });
  const box = h('div', { class: 'k-nav__box' }, canvas, rect);
  const zoomRow = h('div', { class: 'k-nav__zoom' });
  const presets: [string, 'fit' | 'fill' | number][] = [
    ['Fit', 'fit'],
    ['Fill', 'fill'],
    ['100%', 100],
    ['200%', 200],
  ];
  for (const [label, preset] of presets) {
    zoomRow.append(h('button', { class: 'k-nav__zbtn', type: 'button', onclick: () => setZoom(ctx, preset as never) }, label));
  }
  const el = h('div', { class: 'k-nav' }, h('div', { class: 'k-label-row' }, h('span', { class: 'k-label' }, 'Navigator')), box, zoomRow);
  let imgW = 1;
  let imgH = 1;

  const paintRect = () => {
    const t = currentTransform(ctx);
    const doc = ctx.doc.value;
    if (!t || !doc || ctx.view.value.zoom === 'fit') {
      rect.hidden = true;
      return;
    }
    const r = visibleRect(t);
    rect.hidden = false;
    Object.assign(rect.style, {
      left: `${r.x * imgW}px`,
      top: `${r.y * imgH}px`,
      width: `${r.w * imgW}px`,
      height: `${r.h * imgH}px`,
    });
  };
  const paint = () => {
    const e = ctx.engine;
    if (!e || !ctx.doc.value) return;
    const px = e.readPixels(240, 'main');
    const g = canvas.getContext('2d');
    if (!g) return;
    canvas.width = px.width;
    canvas.height = px.height;
    g.putImageData(new ImageData(new Uint8ClampedArray(px.data), px.width, px.height), 0, 0);
    const bw = box.clientWidth || 240;
    imgW = bw;
    imgH = (bw * px.height) / px.width;
    canvas.style.width = `${imgW}px`;
    canvas.style.height = `${imgH}px`;
    paintRect();
  };
  let pending = 0;
  if (ctx.engine) {
    d.add(
      ctx.engine.onRendered((_ms, target) => {
        if (target !== 'main') return;
        clearTimeout(pending);
        pending = window.setTimeout(paint, 250);
      }),
    );
  }
  d.add(ctx.view.subscribe(paintRect));
  const recentre = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    centerOn(ctx, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  };
  box.addEventListener('pointerdown', (e) => {
    box.setPointerCapture(e.pointerId);
    recentre(e);
  });
  box.addEventListener('pointermove', (e) => {
    if (box.hasPointerCapture(e.pointerId)) recentre(e);
  });
  d.add(() => clearTimeout(pending));
  return { el, dispose: () => d.dispose() };
}

export function registerViewerCommands(ctx: AppContext): () => void {
  const d = new Disposer();
  const dev = () => ctx.module.value === 'develop' && !!ctx.doc.value;
  const tool = (cmd: ToolCommand) => getController(ctx)?.toolCommand(cmd) ?? false;
  const reg = (id: string, label: string, keys: string[], run: () => void, group = 'View') =>
    d.add(ctx.commands.register({ id, label, keys, group, when: dev, run }));
  reg('view.fit100', 'Toggle fit / 100%', ['Z'], () => toggleFit100(ctx, getController(ctx)?.pointer() ?? undefined));
  reg('view.zoomIn', 'Zoom in', ['+', '=', 'Mod+='], () => stepZoom(ctx, 1));
  reg('view.zoomOut', 'Zoom out', ['-', 'Mod+-'], () => stepZoom(ctx, -1));
  reg('view.before', 'Before / after', ['\\'], () => toggleBefore(ctx));
  reg('view.compare', 'Cycle compare layouts', ['Y'], () => cycleCompareLayout(ctx));
  reg('view.clipping', 'Clipping warnings', ['J'], () => toggleClipping(ctx));
  reg('view.overlay', 'Mask overlay / crop overlay', ['O'], () => {
    if (ctx.tool.value === 'crop') tool('overlay-cycle');
    else ctx.showMaskOverlay.set(!ctx.showMaskOverlay.value);
  });
  reg('view.overlayOrient', 'Rotate golden spiral', ['Shift+O'], () => tool('overlay-orientation'));
  reg('tool.crop', 'Crop & rotate', ['R'], () => ctx.tool.set(ctx.tool.value === 'crop' ? 'edit' : 'crop'), 'Tools');
  reg('tool.heal', 'Remove & heal', ['Q'], () => ctx.tool.set(ctx.tool.value === 'heal' ? 'edit' : 'heal'), 'Tools');
  reg('tool.masks', 'Masks', ['Shift+W'], () => ctx.tool.set(ctx.tool.value === 'masks' ? 'edit' : 'masks'), 'Tools');
  reg('tool.swapAspect', 'Swap crop orientation', ['X'], () => tool('swap-aspect'), 'Tools');
  reg('tool.sizeUp', 'Brush / spot larger', [']'], () => tool('size-up'), 'Tools');
  reg('tool.sizeDown', 'Brush / spot smaller', ['['], () => tool('size-down'), 'Tools');
  reg('tool.featherUp', 'Feather more', ['Shift+]'], () => tool('feather-up'), 'Tools');
  reg('tool.featherDown', 'Feather less', ['Shift+['], () => tool('feather-down'), 'Tools');
  reg('tool.delete', 'Delete selected pin / spot', ['Delete', 'Backspace'], () => tool('delete'), 'Tools');
  reg('tool.enter', 'Commit tool', ['Enter'], () => {
    if (!tool('enter') && ctx.tool.value === 'crop') ctx.tool.set('edit');
  }, 'Tools');
  reg('tool.escape', 'Cancel / exit tool', ['Escape'], () => {
    if (tool('escape')) return;
    if (ctx.wbPickerActive.value) ctx.wbPickerActive.set(false);
    else if (ctx.tool.value !== 'edit') ctx.tool.set('edit');
  }, 'Tools');
  return () => d.dispose();
}
