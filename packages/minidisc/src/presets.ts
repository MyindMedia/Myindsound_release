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
  /** Which references it comes from (internal look-dev; never shipped). */
  refs: string;
}

const smoke: Omit<ShellPreset, 'id' | 'label' | 'disc' | 'refs'> = {
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
const tinted = (gel: string, attenuationColor: string, attenuationDistance: number): Omit<ShellPreset, 'id' | 'label' | 'disc' | 'refs'> => ({
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
  'smoke-black': { id: 'smoke-black', label: 'Smoke black', disc: 'print', refs: '04, 02', ...smoke },
  'smoke-gold': { id: 'smoke-gold', label: 'Smoke black · gold disc', disc: 'gold', refs: '02', ...smoke },
  clear: {
    id: 'clear',
    label: 'Clear',
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
  'clear-pink': { id: 'clear-pink', label: 'Clear pink', disc: 'print', refs: '03', ...tinted('#ff7fc4', '#ff86c6', 0.09), opacity: 0.36 },
  purple: { id: 'purple', label: 'Translucent purple', disc: 'print', refs: '06, 09', ...tinted('#7d2ee0', '#7a2fd8', 0.032) },
  blue: { id: 'blue', label: 'Translucent blue', disc: 'print', refs: '05', ...tinted('#1f4ff0', '#2452e8', 0.032) },
  red: { id: 'red', label: 'Translucent red', disc: 'print', refs: '10', ...tinted('#e8231a', '#e2261c', 0.032) },
};

export const SHELL_PRESET_LIST: ShellPreset[] = Object.values(SHELL_PRESETS);

/** A preset with the design's own tint and disc finish applied. */
export function resolvePreset(id: ShellPresetId, tint?: string, discFinish?: DiscFinish): ShellPreset {
  const base = SHELL_PRESETS[id];
  if (!tint) return discFinish ? { ...base, disc: discFinish } : base;
  return { ...base, gel: tint, attenuationColor: tint, attenuationDistance: 0.045, disc: discFinish ?? base.disc };
}

