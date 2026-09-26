// Versioned constants for the wear model (PRD §11.3, §11.4).
//
// A config is frozen once shipped. Changing any value below changes the
// descriptor for existing copies, so it needs a NEW wearModelVersion entry,
// never an edit to an old one (WEAR-5, §11.2: never reinterpret old versions).
//
// Every range is in integer micro-units (1e-6) so the scratch geometry is
// derived with integer arithmetic only and a Swift port can match byte for byte.

export const SURFACES = ['shell', 'window', 'label', 'disc'] as const;
export type Surface = (typeof SURFACES)[number];

/** [lo, hi) in micro-units. A draw maps uniformly onto this half-open range. */
export type MicroRange = readonly [lo: number, hi: number];

/** Integer weights per surface, in SURFACES order. */
export type SurfaceWeights = readonly [shell: number, window: number, label: number, disc: number];

export interface WearConfig {
  version: number;
  /** Ceiling of the saturating curve (§11.3). */
  MAX_WEAR: number;
  /** Curve steepness (§11.3). [DECIDE] tune with visual tests. */
  K: number;
  /** Weight of borrower play seconds (§11.3). [DECIDE] */
  LENT_WEIGHT: number;
  /** Seconds that count as one play (§11.3). */
  SECONDS_PER_PLAY: number;
  /** Plays added per cartridge load and per eject (§11.3). */
  LOAD_WEIGHT: number;
  EJECT_WEIGHT: number;
  /** Scratch count = floor(level * MAX_SCRATCHES) (§11.4). */
  MAX_SCRATCHES: number;
  /** Scuff count = floor(level * MAX_SCUFF_ZONES). Not fixed by the PRD; v1 choice. */
  MAX_SCUFF_ZONES: number;
  /** Candidate placements pre-drawn per slot, tried in order against safe zones. */
  PLACEMENT_ATTEMPTS: number;
  /** Extra clearance around every safe zone, micro-units of surface UV. */
  SAFE_ZONE_MARGIN_MICRO: number;
  /** labelFade = LABEL_FADE_MAX * level, max 0.35 keeps text legible (§11.4). */
  LABEL_FADE_MAX_MICRO: number;
  /** dustAmount = DUST_MAX * level, max 0.3 (§11.4). */
  DUST_MAX_MICRO: number;
  /** edgeWear = EDGE_WEAR_MAX * level, 0..1 (§11.4). */
  EDGE_WEAR_MAX_MICRO: number;
  scratch: {
    surfaceWeights: SurfaceWeights;
    /** Full segment length in surface UV units. Drawn before the centre. */
    length: MicroRange;
    /** Degrees in surface UV space, 0 <= angle < 180 (a scratch is a line segment). */
    angle: MicroRange;
    /**
     * Gap kept between the scratch's bounding circle and every surface edge.
     * The centre is drawn from [inset + h, 1e6 - inset - h) with h = ceil(length / 2),
     * so the whole segment lies inside the surface at any angle.
     */
    edgeInset: number;
    depth: MicroRange;
  };
  scuff: {
    surfaceWeights: SurfaceWeights;
    /** Drawn before the centre. */
    radius: MicroRange;
    /** Centre drawn from [inset + radius, 1e6 - inset - radius): the circle lies inside the surface. */
    edgeInset: number;
    intensity: MicroRange;
  };
}

export const WEAR_MODEL_V1: WearConfig = Object.freeze({
  version: 1,
  MAX_WEAR: 1.0,
  K: 0.004, // [DECIDE] PRD §23 default
  LENT_WEIGHT: 1.0, // [DECIDE] PRD §23 default
  SECONDS_PER_PLAY: 180,
  LOAD_WEIGHT: 0.5,
  EJECT_WEIGHT: 0.5,
  MAX_SCRATCHES: 40,
  MAX_SCUFF_ZONES: 12,
  PLACEMENT_ATTEMPTS: 8,
  SAFE_ZONE_MARGIN_MICRO: 5_000, // 0.005
  LABEL_FADE_MAX_MICRO: 350_000, // 0.35
  DUST_MAX_MICRO: 300_000, // 0.3
  EDGE_WEAR_MAX_MICRO: 1_000_000, // 1.0
  scratch: Object.freeze({
    surfaceWeights: Object.freeze([35, 20, 15, 30] as const),
    length: Object.freeze([20_000, 180_000] as const),
    angle: Object.freeze([0, 180_000_000] as const),
    edgeInset: 10_000, // 0.01
    depth: Object.freeze([150_000, 1_000_000] as const),
  }),
  scuff: Object.freeze({
    surfaceWeights: Object.freeze([45, 10, 10, 35] as const),
    radius: Object.freeze([20_000, 90_000] as const),
    edgeInset: 20_000, // 0.02
    intensity: Object.freeze([100_000, 600_000] as const),
  }),
}) as WearConfig;

/** All shipped versions. Add new versions here; never edit an existing entry. */
export const WEAR_MODELS: Readonly<Record<number, WearConfig>> = Object.freeze({
  1: WEAR_MODEL_V1,
});

export const CURRENT_WEAR_MODEL_VERSION = 1;

/**
 * Throws for any version that is not an integer JS number present in WEAR_MODELS
 * (so 1.5, NaN, '1' and 2 all throw). Never falls back to another version.
 */
export function getWearConfig(version: number): WearConfig {
  // typeof check first: '1' or a boxed number must not reach the lookup.
  if (typeof version !== 'number' || !Number.isInteger(version) || !Object.prototype.hasOwnProperty.call(WEAR_MODELS, version)) {
    throw new RangeError(`Unknown wearModelVersion: ${String(version)}`);
  }
  return WEAR_MODELS[version];
}
