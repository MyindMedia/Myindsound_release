/**
 * @myind/minidisc: the parameterised MiniDisc. A `DiscDesign` (JSON, validated) becomes a three.js cartridge
 * with the preset shell, the disc printed with the art, the label plate and the edition stamp, plus its
 * printed card sleeve; `renderSpinLoop` pre-renders the grid loop at publish time; `suggestShell` picks a
 * shell from the cover art. See README.md for the contract the portal, the backend and iOS code against.
 */
export {
  DEFAULT_ACCENT,
  DEFAULT_ACCENT2,
  DEFAULT_BLUR_PX,
  DEFAULT_SCRIM,
  DISC_DESIGN_VERSION,
  DISC_FINISHES,
  LABEL_STYLES,
  MAX_STICKERS,
  MAX_TRACKS,
  SHELL_PRESET_IDS,
  SHELL_WINDOWS,
  STICKER_KINDS,
  assertDesign,
  catalogueNumber,
  designArtRefs,
  discHasArt,
  formatDuration,
  resolveShellWindow,
  resolveTheme,
  validateDesign,
  type DiscBackdrop,
  type DiscDesign,
  type DiscFinish,
  type DiscSticker,
  type DiscTheme,
  type DiscTrack,
  type LabelStyle,
  type ResolvedTheme,
  type ShellPresetId,
  type ShellWindow,
  type StickerKind,
  type ValidationResult,
} from './design';
export { SHELL_PRESETS, SHELL_PRESET_LIST, resolvePreset, type ShellPreset } from './presets';
export {
  chroma,
  dominantColours,
  isSaturated,
  keyColour,
  rgbToHsl,
  shellForColour,
  suggestShell,
  suggestShellFromPixels,
  toHex,
  type ShellSuggestion,
  type Swatch,
} from './palette';
export { MAX_SHEET_SIDE, largestFrameSize, packSprites, spriteCell, type SpriteLayout, type SpriteSheetMeta } from './sprite';
export { STAMP_UV, buildCartridge, type BuildOptions, type BuiltCartridge, type DesignArt } from './cartridge';
export {
  cartridgeBuilder,
  cartridgeLayout,
  createMiniDisc,
  loadDesignArt,
  makeSleevePrints,
  resolveArtUrl,
  type LoadedArt,
  type MiniDisc,
  type MiniDiscOptions,
} from './minidisc';
export { ArtBackdrop, blurArt, type ArtBackdropOptions } from './backdrop';
export { renderSpinLoop, type SpinLoopOptions, type SpinLoopResult } from './spin-loop';
export { ensureFonts } from './canvas';
