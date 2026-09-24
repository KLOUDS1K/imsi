# Contract change requests

Append-only. Prefix each entry with the module name.


- [engine-fx] GeometryModule has no PhotoMeta, but lens distortion (profile auto-detect) needs it. Worked around
  without changing the interface: `engine/geometry.ts` also exports `setGeometryMeta(meta | null)` (engine-core or
  the shell should call it whenever a photo is opened) and every mapping function takes an OPTIONAL trailing
  `lens?: LensCorrection` argument that overrides it. Without either, lens correction is resolved from `params.lens`
  with an empty meta (manual distortion + explicit profileId still apply). Proposal: add an optional
  `lens?: LensCorrection` last parameter to the GeometryModule signatures.
- [engine-fx] PassDef.inputs: fx passes list only the standard samplers the orchestrator binds by name
  (uInput, uPatch, uOverlay); samplers named in `blurs[].uniform` are NOT repeated in `inputs`.
- [engine-fx] Removal patches: `PATCH_COMPOSITE_PASS` is run once per `params.retouch.removals[i]` with
  `extra.iteration = i` (uPatch = that patch's pixels uploaded as plain RGBA8 UNORM; the shader decodes sRGB).
  Proposal: add `patch?: RemovalPatch` to PassExtra if engine-core prefers passing it explicitly.
- [engine-fx] Mask overlay warping: a second PassDef `GEOMETRY_OVERLAY_PASS` (same shader, uOverlayMode = 1) warps
  the R channel of uOverlay into output space (.rgb = coverage, .a = image coverage). GEOMETRY_PASS output alpha is
  straight (non-premultiplied) image coverage with a 1-px anti-aliased border; outside the image = vec4(0).
- [engine-fx] Frame size convention: frame = oriented source size (straighten/transform keep the canvas; the
  crop tool uses maxValidCrop/isCropValid for "constrain to image"). `aspectRatioValue` is literal
  ('4:3' = 4/3 regardless of photo orientation; 'original' = frame aspect) — swap by choosing the inverse preset or
  'custom'. Transform order about the centre: keystone (vertical, then horizontal) → aspect → rotate
  (crop.angle + transform.rotate) → scale → offsets. Lateral CA: red/blue sampled at the green source position
  scaled radially by caRed/caBlue about the image centre. `transform.upright` is not interpreted by geometry
  (auto-upright writes its result into vertical/horizontal/rotate).

- [state] Clarifications of existing contracts (no signature changes):
  - `ChangeInfo.paths` carries the exact changed dot paths for set/update/replace/undo/redo/history/snapshot/reset;
    only `load()` sends `['*']`. `paths: []` means a metadata-only change (history cleared, snapshot created /
    renamed / deleted): params are unchanged. Treat paths as prefixes (`'masks'` = the whole mask list changed).
  - After `endGesture()` the store emits one final notification with `interactive: false` (union of the gesture's
    paths) so the renderer can do its full-quality pass. `beginGesture()` while a gesture is active is a no-op.
  - `update(label, fn)` coalesces by label by default (pass `coalesceKey: null` for a guaranteed new entry).
  - `setPath(obj, path, value)` MUTATES `obj` (lodash `_.set` semantics) and returns it; `setIn` (extra export) is the
    copy-on-write variant. `store.params` is deep-frozen in dev builds — never mutate it.
  - `paramsToXmp(params, meta?, opts?)` takes an extra optional `opts` ({ name, group, groups, … }) to write a
    Lightroom develop preset; `xmpToParams` additionally returns `group` and `conditions` when present.

- [engine-color] Clarifications for the orchestrator (no signature changes):
  - `DEVELOP_PASS.isIdentity()` is always false — it is the linear → display-referred (sRGB-encoded) conversion.
    With default params it is exactly `linearToSrgb(in)`. `PRE_PASS` / `LOCAL_PASS` report identity normally.
  - `uCurveLut`: upload `buildDevelopCurveLut(params)` (RGBA32F, `CURVE_LUT_SIZE`×1 = 1024×1) and cache it by
    `curveLutKey(params)`. The shader only uses `texelFetch`, so the texture's filter mode does not matter.
  - Blur sigmas are functions of params: a blur whose effect is neutral returns `BLUR_SIGMAS.collapsed` (0.75
    reference px) so all unused requests share one tiny blur. Please do not assume sigmas are constant.
  - Blur sharing: every engine-color blur request has a uniquely named prepass (`color.guide.linear`,
    `color.guide.display`, `color.fringe.source`, `color.detail.source`), so DEVELOP and LOCAL blurs never mix with
    each other or with other modules' blurs of a sampler that is also called `uInput`. LOCAL runs once per mask
    and `uInput` changes between invocations; sharing LOCAL blurs across the masks of one frame (keyed by the source
    NAME) is acceptable (they then describe the image before the first mask), but keying by the actual texture is
    more exact. Guide prepasses write negative values (log luminance) and need a float target (RGBA16F).
  - Blur samplers (`uGuideS/M/L`, `uFringeBlur`, `uLocalGuideS/M/L`, `uDetailBlur`) are declared only in
    `blurs[]`, not repeated in `inputs` (same convention as engine-fx).
  - Uniforms use only float / bool / vecN (no arrays, no matrices), so any introspecting setter works.

- [ui-kit] Suggest adding two theme-dependent tokens to `src/theme/tokens.css`: `--k-raised` (active segment /
  pressed toolbar button: `--k-surface` on light, `--k-surface-3` on dark — on the dark theme `--k-surface` and
  `--k-surface-2` are almost identical, so a "raised" segment would be invisible) and `--k-knob` (switch knob:
  `--k-surface` on light, `--k-text-2` on dark). Until then `src/theme/base.css` derives both from existing tokens
  with the same light/dark selectors as tokens.css; if they move into tokens.css, delete that block from base.css.
- [ui-kit] For the shell: `ctx.toast` / `ctx.confirm` / `ctx.prompt` map 1:1 onto `createToaster().show`,
  `confirmDialog(ConfirmOptions)` and `promptDialog(PromptOptions)` from `@/ui/kit`; `ctx.busy` can feed
  `createBusyLine().set` directly (same `{ active, label?, progress? }` shape).
