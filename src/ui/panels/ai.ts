/**
 * AI tool panel: AI Auto Edit (rule-based analysis → parameters), the image
 * analysis report, and KLOUD Style (house style + personal style learning).
 * Everything runs on-device; heuristic parts are labelled as such.
 */
import type { AppContext } from '../../app/context';
import { analyzeImage, generateAutoEdit } from '../../editor/analysis';
import { KLOUD_STYLE, createStyleModel, estimateParamsFromPair, extractFeatures, predictParams, trainStyleModel } from '../../editor/ai/style';
import { enableMlBackend, getSegmentationStatus } from '../../editor/ai/segment';
import { blobToPixelBuffer } from '../../editor/io';
import { applyPartial } from '../../editor/state';
import type { ImageAnalysis, PartialParams, StyleModel, StylePair } from '../../editor/types';
import { clear, Disposer, h } from '../dom';
import { createButton, createSelect, createSlider } from '../kit';
import type { DocBinder } from './binding';
import type { ToolPanel } from './crop';
import { guarded, pickFiles } from './util';

const pct = (v: number) => `${Math.round(v * 100)}%`;

function reportRows(a: ImageAnalysis): [string, string][] {
  return [
    ['Scene', `${a.scene.label} (${pct(a.scene.confidence)})`],
    ['Exposure', `${a.exposure.verdict === 'ok' ? 'Balanced' : a.exposure.verdict === 'under' ? 'Under' : 'Over'} · ${a.exposure.evOffset >= 0 ? '+' : ''}${a.exposure.evOffset.toFixed(1)} EV`],
    ['Dynamic range', `${a.dynamicRange.stops.toFixed(1)} stops`],
    ['White balance', a.whiteBalance.castDescription || 'Neutral'],
    ['Noise', `${Math.round(a.noise.level)} / 100`],
    ['Sharpness', `${Math.round(a.sharpness.score)} / 100${a.sharpness.blurry ? ' · soft' : ''}`],
    ['Sky', a.sky.present ? `${pct(a.sky.fraction)} of frame` : 'None found'],
    ['Colour', `Colourfulness ${Math.round(a.color.colorfulness)}`],
  ];
}

export function createAiPanel(ctx: AppContext, b: DocBinder): ToolPanel {
  const d = new Disposer();
  const el = h('div', { class: 'k-pnl-tool k-pnl-ai' });
  let strength = 100;
  let styleStrength = 100;
  let modelId = KLOUD_STYLE.id;
  const report = h('div', { class: 'k-pnl-report' });

  const models = (): StyleModel[] => [KLOUD_STYLE, ...ctx.styleModels.value.filter((m) => m.id !== KLOUD_STYLE.id)];
  const currentModel = () => models().find((m) => m.id === modelId) ?? KLOUD_STYLE;

  const runAuto = () =>
    guarded(ctx.toast, 'AI Auto Edit', async () => {
      const doc = ctx.doc.value;
      if (!doc) return;
      ctx.busy.set({ active: true, label: 'Analysing photo…' });
      await new Promise((r) => setTimeout(r, 16));
      try {
        const a = analyzeImage(doc.analysisProxy, doc.meta);
        renderReport(a);
        const edit = generateAutoEdit(a, doc.meta, { strength, idFactory: () => ctx.newId('ai') });
        doc.store.replace(applyPartial(doc.store.params, edit), `AI Auto Edit (${strength}%)`);
        ctx.toast(`AI Auto Edit applied — scene: ${a.scene.label}`, 'success');
      } finally {
        ctx.busy.set({ active: false });
      }
    });

  const renderReport = (a: ImageAnalysis) => {
    clear(report);
    for (const [k, v] of reportRows(a)) report.append(h('div', { class: 'k-pnl-report__row' }, h('span', null, k), h('span', null, v)));
    for (const note of a.notes.slice(0, 4)) report.append(h('p', { class: 'k-pnl-note' }, note));
  };

  const styleEdit = (): PartialParams | null => {
    const doc = ctx.doc.value;
    if (!doc) return null;
    return predictParams(currentModel(), extractFeatures(doc.analysisProxy, doc.meta), styleStrength);
  };

  const applyStyle = () =>
    guarded(ctx.toast, 'KLOUD Style', () => {
      const doc = ctx.doc.value;
      const edit = styleEdit();
      if (!doc || !edit) return;
      ctx.previewParams.set(null);
      doc.store.replace(applyPartial(doc.store.params, edit), `${currentModel().name} Style (${styleStrength}%)`);
    });

  const pairsFor = async (id: string): Promise<StylePair[]> => (await ctx.db.getAll<StylePair>('stylePairs')).filter((p) => p.modelId === id);

  const ensureUserModel = async (): Promise<StyleModel> => {
    const m = currentModel();
    if (!m.builtin) return m;
    const model = createStyleModel('My Style');
    await ctx.saveStyleModel(model);
    modelId = model.id;
    renderStyle();
    return model;
  };

  const addPair = () =>
    guarded(ctx.toast, 'Add training pair', async () => {
      const files = await pickFiles('image/*', true);
      if (files.length !== 2) {
        ctx.toast('Choose two files: the original and your edited version (same framing).', 'info');
        return;
      }
      const [origFile, editFile] = files.sort((x, y) => x.lastModified - y.lastModified);
      const model = await ensureUserModel();
      const [orig, edited] = await Promise.all([blobToPixelBuffer(origFile, 512), blobToPixelBuffer(editFile, 512)]);
      const pair: StylePair = {
        id: ctx.newId('pair'),
        modelId: model.id,
        name: origFile.name,
        originalThumb: null,
        editedThumb: null,
        features: extractFeatures(orig),
        params: estimateParamsFromPair(orig, edited),
        source: 'pair',
        weight: 1,
        created: Date.now(),
      };
      await ctx.db.put('stylePairs', pair.id, pair);
      ctx.toast(`Added "${origFile.name}" to ${model.name}.`, 'success');
      renderStyle();
    });

  const learnThis = () =>
    guarded(ctx.toast, 'Learn from this edit', async () => {
      const doc = ctx.doc.value;
      if (!doc) return;
      const model = await ensureUserModel();
      const pair: StylePair = {
        id: ctx.newId('pair'),
        modelId: model.id,
        name: doc.record.name,
        originalThumb: null,
        editedThumb: null,
        features: extractFeatures(doc.analysisProxy, doc.meta),
        params: doc.store.params as PartialParams,
        source: 'app-edit',
        weight: 1.5,
        created: Date.now(),
      };
      await ctx.db.put('stylePairs', pair.id, pair);
      ctx.toast(`Saved this edit to ${model.name}.`, 'success');
      renderStyle();
    });

  const train = () =>
    guarded(ctx.toast, 'Train style', async () => {
      const model = currentModel();
      if (model.builtin) {
        ctx.toast('Add a training pair first — that creates your own style model.', 'info');
        return;
      }
      const pairs = await pairsFor(model.id);
      const trained = trainStyleModel(model, pairs);
      await ctx.saveStyleModel(trained);
      ctx.toast(`${trained.name} trained on ${trained.pairCount} example${trained.pairCount === 1 ? '' : 's'}.`, 'success');
      renderStyle();
    });

  const styleBox = h('div', { class: 'k-pnl-sub' });
  let styleD = new Disposer();
  function renderStyle(): void {
    styleD.dispose();
    styleD = new Disposer();
    clear(styleBox);
    const sel = createSelect<string>({
      ariaLabel: 'Style model',
      size: 'sm',
      block: true,
      value: modelId,
      options: models().map((m) => ({ value: m.id, label: m.builtin ? `${m.name} (built-in)` : `${m.name} · ${m.pairCount} pairs` })),
      onChange: (v) => {
        modelId = v;
      },
    });
    const slider = createSlider({
      label: 'Style strength',
      min: 0,
      max: 150,
      step: 1,
      value: styleStrength,
      defaultValue: 100,
      unit: '%',
      fill: 'min',
      onInput: (v) => {
        styleStrength = v;
        const doc = ctx.doc.value;
        const edit = styleEdit();
        if (doc && edit) ctx.previewParams.set(applyPartial(doc.store.params, edit));
      },
      onChange: () => ctx.previewParams.set(null),
    });
    const apply = createButton({ label: 'Apply style', icon: 'sparkles', variant: 'primary', size: 'sm', onClick: () => void applyStyle() });
    const pair = createButton({ label: 'Add pair…', icon: 'upload', size: 'sm', onClick: () => void addPair() });
    const learn = createButton({ label: 'Learn this edit', icon: 'bookmark', size: 'sm', onClick: () => void learnThis() });
    const trainBtn = createButton({ label: 'Train', icon: 'refresh', size: 'sm', onClick: () => void train() });
    styleD.add(() => [sel, slider, apply, pair, learn, trainBtn].forEach((c) => c.destroy()));
    styleBox.append(
      h('div', { class: 'k-pnl-sub__head' }, h('span', { class: 'k-pnl-sub__title' }, 'KLOUD Style')),
      sel.el,
      slider.el,
      h('div', { class: 'k-pnl-row k-pnl-row--buttons' }, apply.el),
      h('p', { class: 'k-pnl-note' }, 'Teach it your look: add original + edited pairs, or save edits you like, then Train. It predicts settings for new photos from what it learned.'),
      h('div', { class: 'k-pnl-row k-pnl-row--buttons' }, pair.el, learn.el, trainBtn.el),
    );
  }

  const autoSlider = createSlider({ label: 'Strength', min: 0, max: 150, step: 1, value: 100, defaultValue: 100, unit: '%', fill: 'min', onChange: (v) => (strength = v), onInput: (v) => (strength = v) });
  const autoBtn = createButton({ label: 'AI Auto Edit', icon: 'wand', variant: 'primary', size: 'sm', block: true, onClick: () => void runAuto() });
  const analyseBtn = createButton({
    label: 'Analyse only',
    icon: 'bar-chart',
    size: 'sm',
    onClick: () =>
      void guarded(ctx.toast, 'Analysis', () => {
        const doc = ctx.doc.value;
        if (doc) renderReport(analyzeImage(doc.analysisProxy, doc.meta));
      }),
  });
  const segStatus = h('p', { class: 'k-pnl-note' });
  const updateSeg = () => {
    const s = getSegmentationStatus();
    segStatus.textContent = `Segmentation: ${s.backend}. ${s.message ?? ''}`;
  };
  updateSeg();
  const mlBtn = createButton({
    label: 'Enable on-device ML models',
    icon: 'cpu',
    size: 'sm',
    onClick: () =>
      void enableMlBackend().then((ok) => {
        updateSeg();
        ctx.toast(ok ? 'On-device ML models ready.' : 'ML models are unavailable here; heuristic masks stay active.', ok ? 'success' : 'info');
      }),
  });
  d.add(() => [autoSlider, autoBtn, analyseBtn, mlBtn].forEach((c) => c.destroy()));
  d.add(() => styleD.dispose());

  el.append(
    h('div', { class: 'k-pnl-sub__head' }, h('span', { class: 'k-pnl-sub__title' }, 'AI Auto Edit')),
    h('p', { class: 'k-pnl-note' }, 'Analyses exposure, dynamic range, white balance, noise, sharpness, subject and sky, then sets tone, colour, detail and masks. Runs on this device.'),
    autoSlider.el,
    h('div', { class: 'k-pnl-row k-pnl-row--buttons' }, autoBtn.el, analyseBtn.el),
    report,
    h('div', { class: 'k-pnl-sep' }),
    styleBox,
    h('div', { class: 'k-pnl-sep' }),
    h('div', { class: 'k-pnl-sub__head' }, h('span', { class: 'k-pnl-sub__title' }, 'Segmentation')),
    segStatus,
    mlBtn.el,
  );
  renderStyle();
  d.add(ctx.styleModels.subscribe(() => renderStyle()));
  d.add(b.onDoc(() => clear(report)));

  return { el, dispose: () => d.dispose() };
}
