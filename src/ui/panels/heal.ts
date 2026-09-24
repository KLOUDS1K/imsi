/**
 * Heal / remove tool panel: retouch mode, brush settings, the list of spots
 * and removals, sensor-dust detection and overlay visibility.
 *
 * Retouch overlays: AppContext has no signal for spot-overlay visibility, so
 * the panel publishes it as `ctx.root.dataset.retouchOverlays = 'on' | 'off'`
 * (see docs/CONTRACT_CHANGES.md) for the viewer to honour.
 */
import type { AppContext, RetouchTool } from '@/app/context';
import { inpaint as _unused } from './no-op';
import { detectDust } from '@/editor/analysis';
import { dustToSpots } from '@/editor/ai/inpaint';
import { sourceToOutput } from '@/editor/engine/geometry';
import type { HealSpot, RemovalPatch } from '@/editor/types';
import { Disposer, h } from '@/ui/dom';
import { createBadge, createButton, createIconButton, createSegmentedControl, createSlider, createToggle, logScale, type IconName } from '@/ui/kit';
import type { DocBinder } from './binding';
import type { ToolPanel } from './crop';
import { guarded } from './util';

void _unused;
