/**
 * KLOUD line icons — 24×24 grid, round caps/joins, `currentColor`, drawn to
 * match the site's thin lucide-like glyphs.
 *
 *   icon('chevron-left')            // 16px, 1.5px rendered stroke
 *   icon('lock-small', 12)          // 12px icons get a 1.25px stroke
 *   icon('star-filled', 14, { title: 'Rated' })
 *
 * The stroke width is compensated for the icon size so every icon renders with
 * the same physical line weight (1.5px; 1.25px at ≤ 12px), like the site.
 * Templates are built once and cloned, so calling icon() in lists is cheap.
 */
import { svg } from '../dom';

interface IconDef {
  /** Stroked outline path data. */
  d?: string;
  /** Solid (currentColor) path data. */
  fill?: string;
  /** Translucent fill (22% currentColor) — gradients / halves. */
  tint?: string;
  tintRule?: 'evenodd' | 'nonzero';
  /** SVG transform applied to all parts (e.g. "rotate(-45 12 12)"). */
  transform?: string;
}

/* ---- geometry helpers (evaluated once at import; no DOM) ---- */

const n = (v: number): string => String(Math.round(v * 100) / 100);

/** Circle as path data. */
function c(cx: number, cy: number, r: number): string {
  return `M${n(cx - r)} ${n(cy)}a${n(r)} ${n(r)} 0 1 0 ${n(2 * r)} 0a${n(r)} ${n(r)} 0 1 0 ${n(-2 * r)} 0Z`;
}

/** Ellipse as path data. */
function ell(cx: number, cy: number, rx: number, ry: number): string {
  return `M${n(cx - rx)} ${n(cy)}a${n(rx)} ${n(ry)} 0 1 0 ${n(2 * rx)} 0a${n(rx)} ${n(ry)} 0 1 0 ${n(-2 * rx)} 0Z`;
}

/** Rounded rectangle as path data. */
function rr(x: number, y: number, w: number, h: number, r = 0): string {
  if (r <= 0) return `M${n(x)} ${n(y)}h${n(w)}v${n(h)}h${n(-w)}Z`;
  const a = `a${n(r)} ${n(r)} 0 0 1`;
  return (
    `M${n(x + r)} ${n(y)}h${n(w - 2 * r)}${a} ${n(r)} ${n(r)}v${n(h - 2 * r)}${a} ${n(-r)} ${n(r)}` +
    `h${n(-(w - 2 * r))}${a} ${n(-r)} ${n(-r)}v${n(-(h - 2 * r))}${a} ${n(r)} ${n(-r)}Z`
  );
}

/** Five-pointed star. */
function star(cx: number, cy: number, outer: number, inner: number): string {
  let d = '';
  for (let i = 0; i < 10; i++) {
    const ang = -Math.PI / 2 + (i * Math.PI) / 5;
    const rad = i % 2 ? inner : outer;
    d += `${i ? 'L' : 'M'}${n(cx + rad * Math.cos(ang))} ${n(cy + rad * Math.sin(ang))}`;
  }
  return d + 'Z';
}

/** Cog with trapezoid teeth. */
function gear(teeth: number, rOut: number, rIn: number, cx = 12, cy = 12): string {
  const step = (Math.PI * 2) / teeth;
  const pt = (r: number, a: number): string => `${n(cx + r * Math.cos(a))} ${n(cy + r * Math.sin(a))}`;
  let d = '';
  for (let i = 0; i < teeth; i++) {
    const t = i * step - Math.PI / 2;
    const a0 = t - step * 0.26;
    const a1 = t - step * 0.13;
    const a2 = t + step * 0.13;
    const a3 = t + step * 0.26;
    const next = t + step - step * 0.26;
    d += `${i ? 'L' : 'M'}${pt(rIn, a0)}L${pt(rOut, a1)}A${rOut} ${rOut} 0 0 1 ${pt(rOut, a2)}L${pt(rIn, a3)}`;
    d += `A${rIn} ${rIn} 0 0 1 ${pt(rIn, next)}`;
  }
  return d + 'Z';
}

const FOLDER = 'M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z';
const HEART =
  'M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z';
const STAR = star(12, 12.8, 10, 4.3);
const FRAME = rr(3, 3, 18, 18, 2);
const ROT_CCW = 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5';
const SORT = 'M7 20V4M3 8l4-4 4 4M17 4v16M13 16l4 4 4-4';
const PIPETTE =
  'M2 22l1-1h3l9-9M3 21v-3l9-9M15 6l3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z';
const BANDAGE: IconDef = {
  d: rr(3, 7.5, 18, 9, 4.5) + 'M9 7.5v9M15 7.5v9M11 10.5h.01M13 10.5h.01M11 13.5h.01M13 13.5h.01',
  transform: 'rotate(-45 12 12)',
};
const CLONE: IconDef = {
  d:
    'M3.5 21h13M3 17.5V16a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v1.5ZM8 14v-3c0-1.3-1-2-1-3.5a3 3 0 0 1 6 0c0 1.5-1 2.2-1 3.5v3' +
    c(19.5, 5, 2.5),
};
const MORE_H: IconDef = { fill: c(5, 12, 1.5) + c(12, 12, 1.5) + c(19, 12, 1.5) };

const DEFS = {
  /* navigation */
  'chevron-left': { d: 'M15 18l-6-6 6-6' },
  'chevron-right': { d: 'M9 18l6-6-6-6' },
  'chevron-up': { d: 'M18 15l-6-6-6 6' },
  'chevron-down': { d: 'M6 9l6 6 6-6' },
  'arrow-left': { d: 'M19 12H5M12 19l-7-7 7-7' },
  'arrow-right': { d: 'M5 12h14M12 5l7 7-7 7' },
  'arrow-up': { d: 'M12 19V5M5 12l7-7 7 7' },
  'arrow-down': { d: 'M12 5v14M19 12l-7 7-7-7' },
  'arrow-up-down': { d: SORT },
  sort: { d: SORT },
  search: { d: c(11, 11, 7) + 'M21 21l-4.35-4.35' },
  grid: { d: rr(3, 3, 7, 7, 1.5) + rr(14, 3, 7, 7, 1.5) + rr(14, 14, 7, 7, 1.5) + rr(3, 14, 7, 7, 1.5) },
  list: { d: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01' },
  menu: { d: 'M4 6h16M4 12h16M4 18h16' },
  'more-horizontal': MORE_H,
  more: MORE_H,
  'more-vertical': { fill: c(12, 5, 1.5) + c(12, 12, 1.5) + c(12, 19, 1.5) },
  'grip-vertical': { fill: c(9, 5, 1.3) + c(15, 5, 1.3) + c(9, 12, 1.3) + c(15, 12, 1.3) + c(9, 19, 1.3) + c(15, 19, 1.3) },
  'external-link': { d: 'M15 3h6v6M10 14L21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6' },
  sidebar: { d: FRAME + 'M9 3v18' },
  'panel-right': { d: FRAME + 'M15 3v18' },
  'panel-bottom': { d: FRAME + 'M3 15h18' },
  library: { d: 'M16 6l4 14M12 6v14M8 8v12M4 4v16' },
  develop: { d: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M2 14h4M10 8h4M18 16h4' },
  export: { d: 'M21 12H9M17 8l4 4-4 4M14 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8' },

  /* theme, security */
  sun: {
    d:
      c(12, 12, 4) +
      'M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41',
  },
  'sun-dim': { d: c(12, 12, 4) + 'M12 4h.01M20 12h.01M12 20h.01M4 12h.01M17.66 6.34h.01M17.66 17.66h.01M6.34 17.66h.01M6.34 6.34h.01' },
  moon: { d: 'M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z' },
  lock: { d: rr(4, 11, 16, 10, 2) + 'M8 11V7a4 4 0 0 1 8 0v4' },
  unlock: { d: rr(4, 11, 16, 10, 2) + 'M8 11V7a4 4 0 0 1 7.75-1.4' },
  'lock-small': { d: rr(5.5, 11, 13, 9.5, 2) + 'M8.5 11V8.5a3.5 3.5 0 0 1 7 0V11' },
  cloud: { d: 'M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z' },

  /* files */
  folder: { d: FOLDER },
  'folder-plus': { d: FOLDER + 'M12 10v6M9 13h6' },
  image: { d: FRAME + c(9, 9, 2) + 'M21 15l-3.09-3.09a2 2 0 0 0-2.82 0L6 21' },
  images: { d: 'M18 22H4a2 2 0 0 1-2-2V6' + rr(6, 2, 16, 16, 2) + c(12, 8, 2) + 'M22 13l-1.3-1.3a2.41 2.41 0 0 0-3.4 0L11 18' },
  film: { d: FRAME + 'M7 3v18M17 3v18M3 7.5h4M3 12h18M3 16.5h4M17 7.5h4M17 16.5h4' },
  download: { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3' },
  upload: { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12' },
  share: { d: 'M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M16 6l-4-4-4 4M12 2v13' },
  save: {
    d: 'M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7M7 3v4a1 1 0 0 0 1 1h7',
  },
  copy: { d: rr(8, 8, 14, 14, 2) + 'M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2' },
  clipboard: { d: rr(8, 2, 8, 4, 1) + 'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2' },
  trash: { d: 'M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6' },
  bookmark: { d: 'M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16Z' },
  link: {
    d: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
  },
  calendar: { d: rr(3, 4, 18, 18, 2) + 'M16 2v4M8 2v4M3 10h18' },
  'map-pin': { d: 'M20 10c0 5-5.5 10.2-7.4 11.8a1 1 0 0 1-1.2 0C9.5 20.2 4 15 4 10a8 8 0 0 1 16 0Z' + c(12, 10, 3) },

  /* rating & labels */
  star: { d: STAR },
  'star-filled': { d: STAR, fill: STAR },
  flag: { d: 'M4 22v-7M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1Z' },
  'flag-x': { d: 'M4 21V4M4 13s1-.9 3.5-.9 3.6 1.6 6 1.6 3-.8 3-.8V4s-.6.8-3 .8S10 3.1 7.5 3.1 4 4 4 4M15.5 16l5 5M20.5 16l-5 5' },
  heart: { d: HEART },
  'heart-filled': { d: HEART, fill: HEART },
  tag: { d: 'M12.59 2.59A2 2 0 0 0 11.17 2H4a2 2 0 0 0-2 2v7.17a2 2 0 0 0 .59 1.42l8.7 8.7a2.43 2.43 0 0 0 3.42 0l6.58-6.58a2.43 2.43 0 0 0 0-3.42Z', fill: c(7.5, 7.5, 1.3) },
  filter: { d: 'M22 3H2l8 9.46V19l4 2v-8.54L22 3Z' },
  dot: { fill: c(12, 12, 3.5) },
  circle: { d: c(12, 12, 9) },

  /* status */
  x: { d: 'M18 6L6 18M6 6l12 12' },
  close: { d: 'M18 6L6 18M6 6l12 12' },
  check: { d: 'M20 6L9 17l-5-5' },
  plus: { d: 'M5 12h14M12 5v14' },
  minus: { d: 'M5 12h14' },
  'check-circle': { d: c(12, 12, 10) + 'M8.5 12l2.5 2.5 4.5-5' },
  'x-circle': { d: c(12, 12, 10) + 'M15 9l-6 6M9 9l6 6' },
  'plus-circle': { d: c(12, 12, 10) + 'M8 12h8M12 8v8' },
  info: { d: c(12, 12, 10) + 'M12 16v-4M12 8h.01' },
  question: { d: c(12, 12, 10) + 'M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01' },
  alert: { d: 'M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0ZM12 9v4M12 17h.01' },
  refresh: {
    d: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M8 16H3v5',
  },

  /* history */
  undo: { d: 'M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11' },
  redo: { d: 'M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13' },
  history: { d: ROT_CCW + 'M12 7v5l4 2' },
  reset: { d: ROT_CCW },
  'rotate-ccw': { d: ROT_CCW },
  'rotate-cw': { d: 'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8M21 3v5h-5' },
  play: { d: 'M6 3l14 9-14 9V3Z' },
  pause: { d: 'M8 4v16M16 4v16' },

  /* photo & camera */
  camera: { d: 'M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z' + c(12, 13, 3.5) },
  aperture: { d: c(12, 12, 10) + 'M14.31 8l5.74 9.94M9.69 8h11.48M7.38 12l5.74-9.94M9.69 16L3.95 6.06M14.31 16H2.83M16.62 12l-5.74 9.94' },
  lens: { d: c(12, 12, 9.5) + c(12, 12, 5.5) + 'M9.53 9.53A3.5 3.5 0 0 1 12 8.5' },
  'zoom-in': { d: c(11, 11, 7.5) + 'M21 21l-4.6-4.6M11 8v6M8 11h6' },
  'zoom-out': { d: c(11, 11, 7.5) + 'M21 21l-4.6-4.6M8 11h6' },
  hand: {
    d: 'M18 11V6a2 2 0 0 0-4 0M14 10V4a2 2 0 0 0-4 0v2M10 10.5V6a2 2 0 0 0-4 0v8M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15',
  },
  eye: { d: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z' + c(12, 12, 3) },
  'eye-off': {
    d: 'M10.7 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a13.2 13.2 0 0 1-1.7 2.7M6.6 6.6A13.5 13.5 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 1 0 4.2 4.2M2 2l20 20',
  },

  /* view layout */
  'split-v': { d: FRAME + 'M12 3v18' },
  'split-h': { d: FRAME + 'M3 12h18' },
  columns: { d: FRAME + 'M9 3v18M15 3v18' },
  compare: { d: rr(3, 4, 18, 16, 2) + 'M12 2v20', tint: 'M12 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7Z' },
  maximize: { d: 'M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3' },
  minimize: { d: 'M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3' },
  fullscreen: { d: 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7' },
  focus: { d: 'M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2' + c(12, 12, 3) },

  /* geometry tools */
  crop: { d: 'M6 2v14a2 2 0 0 0 2 2h14M18 22V8a2 2 0 0 0-2-2H2' },
  'flip-h': { d: 'M3 7l5 5-5 5V7ZM21 7l-5 5 5 5V7ZM12 2v2M12 8v2M12 14v2M12 20v2' },
  'flip-v': { d: 'M7 3l5 5 5-5H7ZM7 21l5-5 5 5H7ZM2 12h2M8 12h2M14 12h2M20 12h2' },
  straighten: { d: 'M3 19h18M4 19L19.5 8M9.5 19a5.5 5.5 0 0 0-1.01-3.18' },
  perspective: { d: 'M6 4h12l4 16H2L6 4ZM12 4v16' },
  'grid-3': { d: FRAME + 'M9 3v18M15 3v18M3 9h18M3 15h18' },
  'aspect-ratio': { d: rr(6, 2, 12, 20, 2) + rr(2, 6, 20, 12, 2) },

  /* retouch & masks */
  bandage: BANDAGE,
  heal: BANDAGE,
  'clone-stamp': CLONE,
  clone: CLONE,
  stamp: {
    d: 'M5 22h14M4 17.5V16a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v1.5a.5.5 0 0 1-.5.5h-15a.5.5 0 0 1-.5-.5ZM9.5 14v-3.5C9.5 9 8.5 8.3 8.5 6.5a3.5 3.5 0 0 1 7 0c0 1.8-1 2.5-1 4V14',
  },
  brush: {
    d: 'M9.06 11.9l8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02Z',
  },
  eraser: { d: 'M7 21l-4.3-4.3a2.4 2.4 0 0 1 0-3.4l9.6-9.6a2.4 2.4 0 0 1 3.4 0l5.6 5.6a2.4 2.4 0 0 1 0 3.4L13 21M22 21H7M5 11l9 9' },
  radial: { d: c(12, 12, 9.5) + c(12, 12, 5), tint: c(12, 12, 5) },
  linear: { d: rr(3, 3, 18, 18, 2.5) + 'M3 9h18M3 15h18', tint: 'M5.5 3h13A2.5 2.5 0 0 1 21 5.5V9H3V5.5A2.5 2.5 0 0 1 5.5 3Z' },
  pipette: { d: PIPETTE },
  eyedropper: { d: PIPETTE },
  wand: { d: 'M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8L19 13M15 9h.01M17.8 6.2L19 5M3 21l9-9M12.2 6.2L11 5' },
  sparkles: {
    d:
      'M10 3c.6 3.6 2.4 5.4 6 6-3.6.6-5.4 2.4-6 6-.6-3.6-2.4-5.4-6-6 3.6-.6 5.4-2.4 6-6Z' +
      'M18 14c.3 1.8 1.2 2.7 3 3-1.8.3-2.7 1.2-3 3-.3-1.8-1.2-2.7-3-3 1.8-.3 2.7-1.2 3-3ZM19 2.5v3M17.5 4h3',
  },
  layers: { d: 'M12 2.5L2.5 7.5 12 12.5l9.5-5L12 2.5ZM2.5 12L12 17l9.5-5M2.5 16.5L12 21.5l9.5-5' },
  target: { d: c(12, 12, 10) + c(12, 12, 6) + c(12, 12, 2) },
  subject: {
    d: 'M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2' + c(12, 10, 2.5) + 'M7.5 17.5a4.5 4.5 0 0 1 9 0',
  },

  /* develop panels */
  sliders: { d: 'M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4' },
  'bar-chart': { d: 'M3 3v16a2 2 0 0 0 2 2h16M8 17v-3M13 17V9M18 17V5' },
  waveform: { d: rr(2, 4, 20, 16, 2) + 'M5 14l3-5 3 7 3-9 3 6 2-2' },
  curve: { d: FRAME + 'M5.5 18.5C11 18.5 13 5.5 18.5 5.5' },
  droplet: { d: 'M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7Z' },
  contrast: { d: c(12, 12, 9.5), fill: 'M12 2.5a9.5 9.5 0 0 1 0 19Z' },
  palette: {
    d: 'M12 2a10 10 0 0 0 0 20c1 0 1.6-.8 1.6-1.7 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.9.7-1.7 1.7-1.7h2c3 0 5.5-2.5 5.5-5.5C22 6 17.5 2 12 2Z',
    fill: c(13.5, 6.5, 1.2) + c(17.5, 10.5, 1.2) + c(8.5, 7.5, 1.2) + c(6.5, 12.5, 1.2),
  },
  thermometer: { d: 'M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z' },
  grain: {
    fill:
      c(5, 5, 1.1) + c(11.5, 4, 1) + c(18.5, 5.5, 1.2) + c(7.5, 10.5, 1) + c(14, 9.5, 1.1) + c(20, 12, 1) +
      c(4, 16.5, 1.2) + c(10.5, 15.5, 1) + c(16.5, 15, 1.1) + c(12.5, 20.5, 1) + c(19.5, 19.5, 1.1) + c(6.5, 21, 0.9),
  },
  vignette: { d: rr(3, 5, 18, 14, 2.5), tint: rr(3, 5, 18, 14, 2.5) + ell(12, 12, 6, 4), tintRule: 'evenodd' },
  text: { d: 'M17 6H3M21 12H3M15 18H3' },
  type: { d: 'M4 7V4h16v3M9 20h6M12 4v16' },
  settings: { d: gear(8, 10, 7.4) + c(12, 12, 3) },
  keyboard: { d: rr(2, 5, 20, 14, 2) + 'M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12.5h.01M10 12.5h.01M14 12.5h.01M18 12.5h.01M7.5 16h9' },
  cpu: { d: rr(5, 5, 14, 14, 2) + rr(9, 9, 6, 6, 1) + 'M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3' },

  /* subjects (masking / analysis) */
  person: { d: c(12, 7, 4) + 'M5 21v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1' },
  face: { d: c(12, 12, 10) + 'M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01' },
  mountain: { d: 'M2 20L8.5 7l4 7 3-4.5L22 20Z' },
  car: {
    d:
      'M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2M9 17h6' +
      c(7, 17, 2) +
      c(17, 17, 2),
  },
  motorcycle: { d: c(5, 16.5, 3.5) + c(19, 16.5, 3.5) + 'M5 16.5L8.5 11H14l2.5-3.5M16 7.5h3M16.3 8.2l2.7 8.3M8.5 11l2.5 5.5h3.5' },
  leaf: { d: 'M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10ZM2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12' },
  building: {
    d: rr(4, 2, 16, 20, 1.5) + 'M9 22v-4h6v4M8.5 6h.01M12 6h.01M15.5 6h.01M8.5 10h.01M12 10h.01M15.5 10h.01M8.5 14h.01M12 14h.01M15.5 14h.01',
  },
} satisfies Record<string, IconDef>;

export type IconName = keyof typeof DEFS;
/** Every icon name, in definition order (for pickers and the gallery). */
export const ICON_NAMES = Object.keys(DEFS) as IconName[];

export function hasIcon(name: string): name is IconName {
  return Object.prototype.hasOwnProperty.call(DEFS, name);
}

export interface IconOptions {
  /** Rendered stroke width in CSS px (default 1.5, or 1.25 at ≤ 12px). */
  strokeWidth?: number;
  /** Accessible name — makes the icon role="img" instead of aria-hidden. */
  title?: string;
  /** Extra class names. */
  class?: string;
}

const templates = new Map<IconName, SVGSVGElement>();

function build(name: IconName): SVGSVGElement {
  const def: IconDef = DEFS[name];
  const root = svg('svg', {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
    class: `k-icon k-icon-${name}`,
  });
  const parent: SVGElement = def.transform ? svg('g', { transform: def.transform }) : root;
  if (def.tint) {
    parent.appendChild(
      svg('path', { d: def.tint, fill: 'currentColor', stroke: 'none', opacity: '0.22', 'fill-rule': def.tintRule ?? 'nonzero' }),
    );
  }
  if (def.fill) parent.appendChild(svg('path', { d: def.fill, fill: 'currentColor', stroke: 'none' }));
  if (def.d) parent.appendChild(svg('path', { d: def.d }));
  if (parent !== root) root.appendChild(parent);
  return root;
}

/**
 * Create an icon element. Unknown names render an empty 16px box (and warn
 * once) instead of throwing, so a typo never breaks a panel.
 */
export function icon(name: IconName, size = 16, opts: IconOptions = {}): SVGSVGElement {
  let tpl = templates.get(name);
  if (!tpl) {
    if (!hasIcon(name)) {
      console.warn(`[kit] unknown icon "${String(name)}"`);
      return svg('svg', { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': 'true', class: 'k-icon' });
    }
    tpl = build(name);
    templates.set(name, tpl);
  }
  const el = tpl.cloneNode(true) as SVGSVGElement;
  const px = opts.strokeWidth ?? (size <= 12 ? 1.25 : 1.5);
  el.setAttribute('width', String(size));
  el.setAttribute('height', String(size));
  // Stroke is in viewBox units; compensate so the rendered width is `px`.
  el.setAttribute('stroke-width', n((px * 24) / size));
  if (opts.class) el.setAttribute('class', `${el.getAttribute('class')} ${opts.class}`);
  if (opts.title) {
    el.removeAttribute('aria-hidden');
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', opts.title);
  }
  return el;
}

/** Swap the icon inside a host element (e.g. a toggle button's glyph). */
export function replaceIcon(host: Element, name: IconName, size = 16, opts?: IconOptions): SVGSVGElement {
  const next = icon(name, size, opts);
  const prev = host.querySelector(':scope > svg.k-icon');
  if (prev) prev.replaceWith(next);
  else host.prepend(next);
  return next;
}
