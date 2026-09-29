/**
 * The shell presets: what each catalogue reference's plastic is made of, as the numbers the physical material
 * takes. Colour, transmission and attenuation give the tint and its depth; the low tier (coarse pointer, BUN-0a)
 * uses `opacity` on a standard material instead of transmission.
 */
import type { DiscFinish, ShellPresetId } from './design';

export interface ShellPreset {
  id: ShellPresetId;
  label: string;
  /** The plastic's colour (also the transmitted tint). */
  colour: string;
  /** 0..1; how much of the disc shows through (high tier). */
  transmission: number;
  /** Low and translucent tiers: the gel's opacity in place of transmission (about half, so the disc reads through). */
  opacity: number;
  /** Low and translucent tiers: the saturated gel colour laid over the disc at `opacity`. */
  gel: string;
  roughness: number;
  /** Volume thickness for the attenuation, in world units (the shell is 0.048 thick). */
  thickness: number;
  ior: number;
  attenuationColor: string;
  attenuationDistance: number;
  clearcoat: number;
  /** How plainly the moulded internals read through the shell, 0..1. */
  internals: number;
  disc: DiscFinish;
  /** The moulded frame under the clear top shell (moulding.ts): the colour the references' shells read as. */
  frame: string;
  /** The clear side rail the shutter slides on, and the notch cap. */
  rail: string;
  /** Which references it comes from (internal look-dev; never shipped). */
  refs: string;
}

const smoke: Omit<ShellPreset, 'id' | 'label' | 'disc' | 'refs' | 'frame' | 'rail'> = {
  // Neutral density: the disc reads through, darkened, never coloured.
  colour: '#d6d8de',
  transmission: 0.97,
  opacity: 0.5,
  gel: '#101218',
  roughness: 0.04,
  thickness: 0.03,
  ior: 1.48,
  attenuationColor: '#3a3b44',
  attenuationDistance: 0.06,
  clearcoat: 1,
  internals: 0.6,
};

/** A tinted plastic: the body stays near clear and the attenuation colours what shows through. */
const tinted = (gel: string, attenuationColor: string, attenuationDistance: number): Omit<ShellPreset, 'id' | 'label' | 'disc' | 'refs' | 'frame' | 'rail'> => ({
  colour: '#f2f4f8',
  transmission: 0.97,
  opacity: 0.48,
  gel,
  roughness: 0.04,
  thickness: 0.03,
  ior: 1.48,
  attenuationColor,
  attenuationDistance,
  clearcoat: 1,
  internals: 0.8,
});

export const SHELL_PRESETS: Record<ShellPresetId, ShellPreset> = {
  'smoke-black': { id: 'smoke-black', frame: '#2b2d34', rail: '#3b3c45', label: 'Smoke black', disc: 'print', refs: '04, 02, 21, 22, 29', ...smoke },
  'smoke-gold': { id: 'smoke-gold', frame: '#2b2d34', rail: '#3b3c45', label: 'Smoke black · gold disc', disc: 'gold', refs: '02, 18, 30', ...smoke },
  clear: {
    id: 'clear',
    label: 'Clear',
    frame: '#cdd4dc',
    rail: '#d8cbe2',
    colour: '#f6f8fa',
    transmission: 0.98,
    opacity: 0.26,
    gel: '#eef2f6',
    roughness: 0.04,
    thickness: 0.02,
    ior: 1.49,
    attenuationColor: '#e4ecf2',
    attenuationDistance: 0.8,
    clearcoat: 1,
    internals: 1,
    disc: 'print',
    refs: '03, 08',
  },
  'clear-pink': { id: 'clear-pink', frame: '#f0a3cc', rail: '#a98bbb', label: 'Clear pink', disc: 'print', refs: '03', ...tinted('#ff7fc4', '#ff86c6', 0.09), opacity: 0.36 },
  purple: { id: 'purple', frame: '#6c2cc8', rail: '#a98bbb', label: 'Translucent purple', disc: 'print', refs: '06, 09, 20, 27', ...tinted('#7d2ee0', '#7a2fd8', 0.032) },
  blue: { id: 'blue', frame: '#2446cc', rail: '#a98bbb', label: 'Translucent blue', disc: 'print', refs: '05', ...tinted('#1f4ff0', '#2452e8', 0.032) },
  red: { id: 'red', frame: '#cc2018', rail: '#a98bbb', label: 'Translucent red', disc: 'print', refs: '10, 32, 34', ...tinted('#e8231a', '#e2261c', 0.032) },
  'jet-black': {
    id: 'jet-black',
    label: 'Jet black',
    frame: '#121317',
    rail: '#1e1f25',
    disc: 'print',
    refs: '17, 24',
    // The darkest smoke: glossy black at the rim, the disc still plainly readable through it (the case rule).
    ...smoke,
    colour: '#aeb1b8',
    opacity: 0.62,
    gel: '#050608',
    attenuationColor: '#26272e',
    attenuationDistance: 0.042,
    internals: 0.4,
  },
  frost: {
    id: 'frost',
    label: 'Frosted silver',
    frame: '#a9afb8',
    rail: '#cbc3d6',
    disc: 'print',
    refs: '14',
    // Satin clear: the same neutral plastic as `clear`, sand-blasted, so the disc blurs grey under it.
    ...smoke,
    colour: '#e8eaee',
    opacity: 0.4,
    gel: '#9ea3ad',
    roughness: 0.34,
    attenuationColor: '#aeb3bc',
    attenuationDistance: 0.12,
    clearcoat: 0.2,
    internals: 0.9,
  },
  slate: { id: 'slate', frame: '#5d6f93', rail: '#a98bbb', label: 'Slate blue', disc: 'print', refs: '12', ...tinted('#5d6f93', '#4f6390', 0.03), opacity: 0.56 },
  'ice-blue': { id: 'ice-blue', frame: '#8fb4c9', rail: '#a98bbb', label: 'Ice blue', disc: 'print', refs: '33', ...tinted('#8fb4c9', '#7aa8c4', 0.04), opacity: 0.5, roughness: 0.12 },
  green: { id: 'green', frame: '#23a24c', rail: '#a98bbb', label: 'Translucent green', disc: 'print', refs: '19', ...tinted('#1f9a4a', '#1c9a44', 0.028) },
  lime: { id: 'lime', frame: '#9fcb2a', rail: '#a98bbb', label: 'Acid lime', disc: 'print', refs: '28', ...tinted('#a6d12a', '#9acb1c', 0.03), opacity: 0.42 },
  orange: { id: 'orange', frame: '#ec7612', rail: '#a98bbb', label: 'Translucent orange', disc: 'print', refs: '23', ...tinted('#f07a12', '#ee7a0c', 0.028) },
  rose: { id: 'rose', frame: '#d4798f', rail: '#a98bbb', label: 'Dusty rose', disc: 'print', refs: '26', ...tinted('#d4798f', '#d06a86', 0.032), opacity: 0.5, roughness: 0.1 },
  lavender: { id: 'lavender', frame: '#8e8cf2', rail: '#a98bbb', label: 'Lavender', disc: 'print', refs: '31', ...tinted('#8e8cf2', '#7f7cf0', 0.036), opacity: 0.44 },
};

export const SHELL_PRESET_LIST: ShellPreset[] = Object.values(SHELL_PRESETS);

/** A preset with the design's own tint and disc finish applied. */
export function resolvePreset(id: ShellPresetId, tint?: string, discFinish?: DiscFinish): ShellPreset {
  const base = SHELL_PRESETS[id];
  if (!tint) return discFinish ? { ...base, disc: discFinish } : base;
  return { ...base, gel: tint, frame: tint, attenuationColor: tint, attenuationDistance: 0.045, disc: discFinish ?? base.disc };
}

