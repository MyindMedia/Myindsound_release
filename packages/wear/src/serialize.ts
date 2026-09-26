// Canonical JSON for a WearDescriptor (§11.6 test 1: byte identical TS and Swift).
//
// Rules (the Swift port must emit exactly this):
//  - No whitespace anywhere.
//  - Keys in this fixed order, extra keys ignored:
//      {"version","seed","level","scratches","scuffZones","labelFade","edgeWear","dustAmount"}
//      scratch: {"surface","x","y","angle","length","depth"}
//      scuff:   {"surface","x","y","radius","intensity"}
//  - `version` is a plain base 10 integer.
//  - `seed` and `surface` are lower case ASCII identifiers, written in double
//    quotes with no escaping (validated, so none is ever needed).
//  - Every other number is on the 1e-6 grid and written from its integer
//    micro-unit value m as `${floor(m / 1e6)}.${m % 1e6 zero padded to 6}`,
//    e.g. 0 -> 0.000000, 350000 -> 0.350000, 123456789 -> 123.456789.
//    Never use the platform's float formatter (JS prints 1e-7, Swift 1e-07).

import { SURFACES } from './config';
import type { WearDescriptor } from './computeWear';

const MICRO = 1_000_000;
const LOWER_SEED_RE = /^[0-9a-f]{32}$/;

/** Formats a non negative integer micro-unit value with exactly six decimals. */
export function formatMicro(m: number): string {
  if (!Number.isSafeInteger(m) || m < 0) {
    throw new RangeError(`formatMicro expects a non negative integer, got ${m}`);
  }
  return `${Math.floor(m / MICRO)}.${String(m % MICRO).padStart(6, '0')}`;
}

/** Converts a descriptor number back to micro-units, refusing anything off the 1e-6 grid. */
function num(v: number, field: string): string {
  const m = Math.round(v * MICRO);
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || m / MICRO !== v) {
    throw new RangeError(`${field} is not a non negative value on the 1e-6 grid: ${v}`);
  }
  return formatMicro(m);
}

function surface(s: string, field: string): string {
  if (!(SURFACES as readonly string[]).includes(s)) throw new RangeError(`${field} is not a known surface: ${s}`);
  return `"${s}"`;
}

/** The canonical byte string for a descriptor. */
export function serializeDescriptor(d: WearDescriptor): string {
  if (!Number.isSafeInteger(d.version) || d.version < 1) throw new RangeError(`bad version: ${d.version}`);
  if (typeof d.seed !== 'string' || !LOWER_SEED_RE.test(d.seed)) throw new RangeError('seed must be 32 lower case hex characters');
  const scratches = d.scratches
    .map(
      (s, i) =>
        `{"surface":${surface(s.surface, `scratches[${i}].surface`)},"x":${num(s.x, 'x')},"y":${num(s.y, 'y')},` +
        `"angle":${num(s.angle, 'angle')},"length":${num(s.length, 'length')},"depth":${num(s.depth, 'depth')}}`,
    )
    .join(',');
  const scuffs = d.scuffZones
    .map(
      (s, i) =>
        `{"surface":${surface(s.surface, `scuffZones[${i}].surface`)},"x":${num(s.x, 'x')},"y":${num(s.y, 'y')},` +
        `"radius":${num(s.radius, 'radius')},"intensity":${num(s.intensity, 'intensity')}}`,
    )
    .join(',');
  return (
    `{"version":${d.version},"seed":"${d.seed}","level":${num(d.level, 'level')},` +
    `"scratches":[${scratches}],"scuffZones":[${scuffs}],` +
    `"labelFade":${num(d.labelFade, 'labelFade')},"edgeWear":${num(d.edgeWear, 'edgeWear')},` +
    `"dustAmount":${num(d.dustAmount, 'dustAmount')}}`
  );
}
