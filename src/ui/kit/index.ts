/**
 * KLOUD UI kit — vanilla-DOM components in the kloud.photography language.
 *
 * Importing the kit brings the theme tokens and base styles (reset, typography
 * utilities .k-h1 / .k-desc / .k-label / .k-badge / .k-num / .k-divider /
 * .k-wordmark …). Every component is a `createX(options)` factory returning
 * `{ el, …api, destroy() }` — insert `el`, keep the handle, call destroy() on
 * unmount (removes listeners and detaches `el`).
 *
 * Conventions shared by all value controls:
 * - `setValue(v, silent = false)`: pass `silent: true` when syncing from the
 *   store so no callbacks fire.
 * - Sliders / wheels report `onGestureStart → onInput* → onChange → onGestureEnd`
 *   per user interaction (drag, wheel burst, key burst, typed value, reset);
 *   wire onGestureStart/End to EditorStore.beginGesture/endGesture for one
 *   history step per interaction.
 * - Keyboard handlers stop propagation for keys they consume, so app-level
 *   shortcuts (arrows = next photo…) don't fire while a control has focus.
 */
import '../../theme/tokens.css';
import '../../theme/base.css';

export type { Component, Placement, Side, AnchorLike } from './util';
export {
  clamp,
  decimalsOf,
  roundTo,
  snapTo,
  formatNumber,
  parseNumber,
  formatShortcut,
  shortcutParts,
  isMac,
  prefersReducedMotion,
  loadLocal,
  saveLocal,
  positionFloating,
  portalRoot,
  focusableIn,
  kitId,
  onDoubleTap,
  onLongPress,
  MINUS,
} from './util';

export { icon, replaceIcon, hasIcon, ICON_NAMES } from './icons';
export type { IconName, IconOptions } from './icons';

export {
  getThemeChoice,
  storedThemeChoice,
  applyTheme,
  initTheme,
  toggleTheme,
  resolvedTheme,
  onThemeChange,
  readToken,
  THEME_STORAGE_KEY,
} from './theme';
export type { ThemeChoice, ResolvedTheme } from './theme';

export { createSlider, logScale } from './slider';
export type { Slider, SliderOptions, SliderScale } from './slider';
export { createRangeSlider } from './range-slider';
export type { RangeSlider, RangeSliderOptions, Range } from './range-slider';
export {
  temperatureGradient,
  tintGradient,
  hueGradient,
  bandHueGradient,
  saturationGradient,
  luminanceGradient,
  greyGradient,
} from './gradients';

export { createSection } from './section';
export type { Section, SectionOptions } from './section';

export { createButton, createIconButton, createSegmentedControl } from './button';
export type {
  Button,
  ButtonOptions,
  ButtonVariant,
  ButtonSize,
  IconButton,
  IconButtonOptions,
  SegmentedControl,
  SegmentedControlOptions,
  SegmentOption,
} from './button';

export {
  createToggle,
  createCheckbox,
  createRadioGroup,
  createSelect,
  createNumberInput,
  createTextInput,
  createSearchInput,
} from './controls';
export type {
  Toggle,
  ToggleOptions,
  Checkbox,
  CheckboxOptions,
  RadioGroup,
  RadioGroupOptions,
  ChoiceOption,
  Select,
  SelectOptions,
  SelectGroup,
  NumberInput,
  NumberInputOptions,
  TextInput,
  TextInputOptions,
  SearchInput,
  SearchInputOptions,
} from './controls';

export { createTabs } from './tabs';
export type { Tabs, TabsOptions, TabDef } from './tabs';

export { attachTooltip, hideTooltip } from './tooltip';
export type { TooltipHandle, TooltipOptions } from './tooltip';

export { openPopover, closeAllPopovers } from './popover';
export type { Popover, PopoverOptions } from './popover';
export { openMenu, attachMenu, attachContextMenu } from './menu';
export type { MenuItem, MenuAction, MenuSeparator, MenuHeader, MenuOptions, MenuHandle, AttachMenuOptions } from './menu';

export { openDialog, confirmDialog, promptDialog } from './dialog';
export type { Dialog, DialogOptions, DialogAction } from './dialog';

export { createToaster } from './toast';
export type { Toaster, ToasterOptions, ToastKind } from './toast';

export { createProgressBar, createSpinner, createBusyLine } from './progress';
export type { ProgressBar, ProgressBarOptions, SpinnerOptions, BusyLine } from './progress';

export { createBadge, createKbd } from './chips';
export type { Badge, BadgeOptions, BadgeTone } from './chips';

export { createRatingStars, createColorLabelPicker, createFlagToggle, COLOR_LABELS } from './rating';
export type {
  RatingStars,
  RatingStarsOptions,
  ColorLabelPicker,
  ColorLabelPickerOptions,
  FlagToggle,
  FlagToggleOptions,
} from './rating';

export { createColorWheel, createGradeWheelControl, hueSatToCss } from './color-wheel';
export type { ColorWheel, ColorWheelOptions, HueSat, GradeWheelControl, GradeWheelControlOptions } from './color-wheel';

export { createSwatch, createColorInput, normalizeHex } from './swatch';
export type { Swatch, SwatchOptions, ColorInput, ColorInputOptions } from './swatch';

export { createFolderTile, createEmptyState, folderArt } from './folder';
export type { FolderTile, FolderTileOptions, FolderSize, FolderGlyph, EmptyStateOptions } from './folder';

export { createDrawer, createBottomSheet } from './sheet';
export type { Drawer, DrawerOptions, BottomSheet, BottomSheetOptions } from './sheet';

export { createSplitter } from './splitter';
export type { Splitter, SplitterOptions } from './splitter';

export {
  createToolbar,
  toolbarGroup,
  toolbarSpacer,
  toolbarDivider,
  createNavArrows,
  createBreadcrumb,
  createWordmark,
  createNavItem,
  createSectionLabel,
  createStatusBar,
  createThemeToggle,
} from './layout';
export type {
  ToolbarOptions,
  NavArrows,
  NavArrowsOptions,
  Breadcrumb,
  Crumb,
  NavItem,
  NavItemOptions,
  ThemeToggleOptions,
} from './layout';
