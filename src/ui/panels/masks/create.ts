/**
 * Mask component factories, labels and the "Create new mask" / "Add" menus.
 *
 * Canvas-drawn components (brush, linear, radial, ranges, object) are created
 * here with sensible defaults and the matching `ctx.maskDrawTool` is armed so
 * the viewer can let the user draw / refine them. An 'object' component is
 * created WITHOUT point/box: the viewer fills in `ai.point` / `ai.box` of the
 * active mask's pending object component (see docs/CONTRACT_CHANGES.md).
 */
import type { MaskDrawTool } from '@/app/context';
import type { AiMaskTarget, MaskComponent, MaskComponentKind, MaskMode } from '@/editor/types';
import type { IconName, MenuItem } from '@/ui/kit';

export type MaskChoice = { kind: 'ai'; target: AiMaskTarget } | { kind: Exclude<MaskComponentKind, 'ai'> };

export const AI_LABEL: Record<AiMaskTarget, string> = {
  subject: 'Subject',
  background: 'Background',
  sky: 'Sky',
  person: 'Person',
  face: 'Face',
  skin: 'Skin',
  hair: 'Hair',
  clothes: 'Clothes',
  object: 'Object',
  motorcycle: 'Motorcycle',
  car: 'Car',
};

const KIND_LABEL: Record<Exclude<MaskComponentKind, 'ai'>, string> = {
  brush: 'Brush',
  linear: 'Linear Gradient',
  radial: 'Radial Gradient',
  'color-range': 'Color Range',
  'luminance-range': 'Luminance Range',
  'depth-range': 'Depth Range',
};

export const MODE_LABEL: Record<MaskMode, string> = { add: 'Add', subtract: 'Subtract', intersect: 'Intersect' };

export function choiceLabel(c: MaskChoice): string {
  return c.kind === 'ai' ? AI_LABEL[c.target] : KIND_LABEL[c.kind];
}

export function componentLabel(c: MaskComponent): string {
  return c.kind === 'ai' ? AI_LABEL[c.ai?.target ?? 'subject'] : KIND_LABEL[c.kind];
}

export function componentIcon(c: MaskComponent | MaskChoice): IconName {
  if (c.kind === 'ai') {
    const t = 'target' in c ? c.target : (c.ai?.target ?? 'subject');
    return t === 'sky' ? 'cloud' : t === 'background' ? 'image' : t === 'car' ? 'car' : t === 'motorcycle' ? 'motorcycle' : t === 'object' ? 'target' : t === 'face' ? 'face' : ['person', 'skin', 'hair', 'clothes'].includes(t) ? 'person' : 'subject';
  }
  return c.kind === 'brush' ? 'brush' : c.kind === 'linear' ? 'linear' : c.kind === 'radial' ? 'radial' : c.kind === 'color-range' ? 'pipette' : c.kind === 'luminance-range' ? 'contrast' : 'layers';
}

/** Draw tool the viewer should arm for a component (none for pure AI targets). */
export function drawToolFor(c: MaskComponent | MaskChoice): MaskDrawTool {
  switch (c.kind) {
    case 'brush':
    case 'linear':
    case 'radial':
    case 'color-range':
    case 'luminance-range':
    case 'depth-range':
      return c.kind;
    case 'ai': {
      const t = 'target' in c ? c.target : c.ai?.target;
      return t === 'object' ? 'object' : 'none';
    }
  }
}

/** New component with defaults that already produce a visible, editable mask. */
export function newComponent(id: string, choice: MaskChoice, mode: MaskMode): MaskComponent {
  const base = { id, mode, invert: false };
  switch (choice.kind) {
    case 'ai':
      return { ...base, kind: 'ai', ai: { target: choice.target } };
    case 'brush':
      return { ...base, kind: 'brush', brush: { strokes: [] } };
    case 'linear':
      // Full effect at the top fading out by 60% height (a typical sky grad).
      return { ...base, kind: 'linear', linear: { x0: 0.5, y0: 0.15, x1: 0.5, y1: 0.6 } };
    case 'radial':
      return { ...base, kind: 'radial', radial: { cx: 0.5, cy: 0.5, rx: 0.28, ry: 0.28, angle: 0, feather: 50 } };
    case 'color-range':
      return { ...base, kind: 'color-range', colorRange: { samples: [], range: 50 } };
    case 'luminance-range':
      return { ...base, kind: 'luminance-range', luminanceRange: { min: 0.6, max: 1, featherLow: 0.15, featherHigh: 0 } };
    case 'depth-range':
      return { ...base, kind: 'depth-range', depthRange: { min: 0, max: 0.35, feather: 0.15 } };
  }
}

/** Menu of every mask kind; `pick` is called with the chosen kind. */
export function maskMenuItems(pick: (c: MaskChoice) => void, aiHint?: string): MenuItem[] {
  const ai = (target: AiMaskTarget): MenuItem => ({ label: AI_LABEL[target], icon: componentIcon({ kind: 'ai', target }), hint: aiHint, onSelect: () => pick({ kind: 'ai', target }) });
  const kind = (k: Exclude<MaskComponentKind, 'ai'>): MenuItem => ({ label: KIND_LABEL[k], icon: componentIcon({ kind: k }), onSelect: () => pick({ kind: k }) });
  return [
    ai('subject'),
    ai('sky'),
    ai('background'),
    {
      label: 'People',
      icon: 'person',
      submenu: [ai('person'), ai('face'), ai('skin'), ai('hair'), ai('clothes')],
    },
    {
      label: 'Objects',
      icon: 'target',
      submenu: [{ label: 'Select Object', icon: 'target', hint: 'Click or drag', onSelect: () => pick({ kind: 'ai', target: 'object' }) }, ai('motorcycle'), ai('car')],
    },
    { kind: 'separator' },
    kind('brush'),
    kind('linear'),
    kind('radial'),
    { kind: 'separator' },
    {
      label: 'Range',
      icon: 'sliders',
      submenu: [
        { label: 'Color', icon: 'pipette', onSelect: () => pick({ kind: 'color-range' }) },
        { label: 'Luminance', icon: 'contrast', onSelect: () => pick({ kind: 'luminance-range' }) },
        { label: 'Depth', icon: 'layers', onSelect: () => pick({ kind: 'depth-range' }) },
      ],
    },
  ];
}
