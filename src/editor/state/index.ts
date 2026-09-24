/**
 * state/ — EditorStore, params math, labels, Lightroom XMP, edit sidecars.
 *
 * Usage notes for other modules:
 * - `store.params` is an immutable snapshot (deep-frozen in dev). Never mutate
 *   it; use set()/update()/replace(). Functions here that return EditParams
 *   (normalizeParams, applyPartial, lerpParams, cloneParams…) return
 *   independent objects you may mutate before handing them to the store.
 * - Wrap pointer drags in beginGesture()/endGesture(): one history entry, and
 *   ChangeInfo.interactive = true until the final non-interactive notification.
 * - For high-frequency edits of big arrays (brush strokes) prefer set(path)
 *   (copy-on-write along the path) over update() (clones everything).
 * - `setPath` MUTATES its target (lodash `_.set` semantics); `setIn` is the
 *   immutable variant.
 */
import type { StateModule } from '@/editor/contracts';
import { EditorStore } from './store';
import { applyPartial, diffPaths, GROUP_PATHS, isDefaultParams, modifiedGroups, pickGroups } from './groups';
import { cloneParams, normalizeParams } from './normalize';
import { getPath, setPath } from './paths';
import { lerpParams } from './lerp';
import { labelForPath } from './labels';
import { paramsToXmp, xmpToParams } from './xmp';
import { parseEditFile, serializeEditFile } from './editfile';

export { EditorStore, COALESCE_MS, DEFAULT_MAX_HISTORY, SERIALIZED_HISTORY } from './store';
export {
  applyPartial,
  diffPaths,
  filterPartial,
  GROUP_PATHS,
  groupsForPath,
  groupsFromPartial,
  isDefaultParams,
  modifiedGroups,
  pickGroups,
  sanitizePartial,
} from './groups';
export { cloneParams, fixConsistency, normalizeParams } from './normalize';
export { deepEqual, deepFreeze, deepMerge, getPath, isPlainObject, reconcile, setIn, setPath } from './paths';
export { lerpCurve, lerpParams, lerpWheel } from './lerp';
export { changeLabel, formatValue, humanize, labelForPath, labelForPathWithMaskName } from './labels';
export { clampToSpec, specForPath } from './specs';
export {
  crsValuesToParams,
  kelvinToRelative,
  paramsToXmp,
  readCrsValues,
  relativeToKelvin,
  xmpToEditParams,
  xmpToParams,
  type CrsValues,
  type XmpReadResult,
  type XmpValue,
  type XmpWriteOptions,
} from './xmp';
export { EDIT_FILE_EXTENSION, parseEditFile, serializeEditFile } from './editfile';

export const stateModule = {
  EditorStore,
  GROUP_PATHS,
  cloneParams,
  getPath,
  setPath,
  normalizeParams,
  applyPartial,
  pickGroups,
  lerpParams,
  diffPaths,
  isDefaultParams,
  modifiedGroups,
  labelForPath,
  paramsToXmp,
  xmpToParams,
  serializeEditFile,
  parseEditFile,
} satisfies StateModule;
