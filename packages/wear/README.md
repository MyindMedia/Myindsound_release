# @myind/wear

The wear model from PRD §11: `computeWear(seed, stats, version, { wearSafeZones })` returns a
`WearDescriptor`, and `serializeDescriptor(d)` turns it into canonical bytes. Convex, the web
bundles and the Swift port (`packages/wear-swift`, P7) must all produce **byte identical**
`serializeDescriptor` output for the same input. `wear-vectors.json` is the proof: 186 frozen
cases (158 descriptors + 28 rejected inputs), SHA-256 recorded in `wear-vectors.sha256`.

This README is the porting contract. When the code and this file disagree, the frozen vectors win.

```ts
import { computeWear, serializeDescriptor } from '@myind/wear';

const d = computeWear(entitlement.wearSeed, entitlement.wearStats, entitlement.wearModelVersion, {
  wearSafeZones: manifest.wearSafeZones, // optional
});
```

No runtime dependencies. Tests run from the repo root with `npm test` (vitest project `wear`).

## 1. Inputs and validation

Checked in this order; the first failure throws. Nothing is clamped or reinterpreted.

| Input | Rule | Error message contains |
|---|---|---|
| `version` | a JS `number` that is an integer and a key of `WEAR_MODELS` (only `1` today). `1.5`, `NaN`, `"1"`, `2` all throw. A port whose version type is an integer must reject a non integer JSON value (e.g. `1.5`) with the same error rather than truncate it. | `wearModelVersion` |
| `seed` | exactly 32 UTF-16 code units, each one of the ASCII characters `0-9`, `a-f`, `A-F` (JS: `/^[0-9a-fA-F]{32}$/`, no `u` flag; `$` does not match before a trailing newline). Case insensitive; the output uses lower case. Non ASCII look alikes (fullwidth `０`, Arabic-Indic `٠`), combining marks, whitespace and a trailing `\n` are rejected. Swift: `seed.utf16.count == 32 && seed.utf16.allSatisfy(isASCIIHex)`. | `wearSeed` |
| `stats.playSeconds`, `lentPlaySeconds`, `loads`, `ejects` | each read **once** into a local copy; the copy must be a JS `number`, finite, and not `< 0`. **`-0` is accepted and behaves exactly as `0`** (it passes `v < 0` false, and every later step gives the same result). Missing fields, `null` and strings throw. All later steps use only the copies. | `wearStats` |
| `options` | omitted or `undefined`: no zones. Otherwise must be a non null object. | `wearSafeZones` |
| `options.wearSafeZones` | absent or `undefined`: no zones. Otherwise must be a dense array (a JS hole throws); `null` throws. Each entry must be a non null object with `surface` exactly one of `shell`, `window`, `label`, `disc` (lower case) and `x`, `y`, `w`, `h` each a finite JS `number` in `0..1` inclusive. `x + w` and `y + h` **may exceed 1** (the zone runs off the surface; harmless). Extra keys are ignored. | `wearSafeZones` |

Negative or non finite stats are **rejected, not clamped**: they can only come from a server bug,
and clamping would hide it. Huge finite stats are fine (the curve saturates; see §2).

## 2. Level (PRD §11.3), the only floating point step

Constants for version 1 (`src/config.ts`): `MAX_WEAR = 1.0`, `K = 0.004` [DECIDE],
`LENT_WEIGHT = 1.0` [DECIDE], `SECONDS_PER_PLAY = 180`, `LOAD_WEIGHT = EJECT_WEIGHT = 0.5`.

IEEE 754 double, evaluated **with exactly this grouping**, no fused multiply add
(Swift does not contract by default; do not use `.addingProduct` or `fma`):

```
eff   = ((playSeconds + LENT_WEIGHT * lentPlaySeconds) / SECONDS_PER_PLAY
         + LOAD_WEIGHT * loads) + EJECT_WEIGHT * ejects
x     = K * eff
level = MAX_WEAR * (1 - expNeg(x))
levelMicro = floor(level * 1000000 + 0.5)            // round half up to the 1e-6 grid
levelMicro = min(max(levelMicro, 0), floor(MAX_WEAR * 1000000 + 0.5))
```

Swapping the two operands of a single `+` or `*` is exact in IEEE 754 and allowed. Regrouping is
not: `play/180 + lent/180`, adding loads and ejects first, `(loads + ejects) * 0.5`, `* (1/180)`,
or folding `K` into each term all change the result, and each is a mutant the vectors kill (§9).

Overflow is fine: `Number.MAX_VALUE + Number.MAX_VALUE` is `+Infinity`, and `expNeg(+Infinity) = 0`.
NaN cannot arise from validated input; if it ever does, `expNeg` and the rounding step throw
instead of returning a value.

`expNeg` replaces `exp(-x)`, because platform `exp` implementations differ in the last bit.
It uses only `+ - * /`, which IEEE 754 rounds identically everywhere:

```
expNeg(x):
  if x is NaN or x < 0: throw
  if !(x < 64) return 0         // x >= 64, including +Infinity
  r = x / 1024
  p = 1.0
  for k = 12 down to 1: p = 1 - (r * p) / k      // k as a Double
  repeat 10 times: p = p * p
  return p
```

The `rounding edge ...` and `mixed flip ...` vectors put `playSeconds` on the two adjacent doubles
either side of a quantum flip, the mixed ones with non zero lent, loads and ejects. Every regrouping
listed above fails at least one of them; `scripts/mutants.ts` proves it on every test run.

## 3. PRNG

`xoshiro128**` 1.1, 32 bit unsigned integers only (`src/prng.ts` has the same text as comments).

Seed derivation:
1. Lower case the seed. Split into four 8 hex char groups, left to right. Group `i` is a
   big endian `UInt32` `w[i]`.
2. `s[i] = fmix32(w[i] ^ (0x9E3779B9 &* UInt32(i + 1)))`, i.e. XOR with
   `0x9E3779B9, 0x3C6EF372, 0xDAA66D2B, 0x78DDE6E4`.
3. `fmix32(h)`: `h ^= h >> 16; h &*= 0x85EBCA6B; h ^= h >> 13; h &*= 0xC2B2AE35; h ^= h >> 16`.
4. If all four `s[i]` are 0 (only seed `9e3779b93c6ef372daa66d2b78dde6e4` does this; it is a
   vector), set `s[0] = 0x9E3779B9`.

Step:
```
result = rotl(s1 &* 5, 7) &* 9
t = s1 << 9
s2 ^= s0; s3 ^= s1; s1 ^= s2; s0 ^= s3
s2 ^= t
s3 = rotl(s3, 11)
```
Known answer from state `[1, 2, 3, 4]`: `11520, 0, 5927040, 70819200, 2031721883, ...`.

## 4. Draws (integers only)

All geometry is in integer micro-units (1e-6). Use `Int64`/`UInt64` in Swift. All products stay below 2^53.

- `drawMicro(u, [lo, hi)) = lo + floor((u >> 8) * (hi - lo) / 2^24)`
- `drawSurface(u, weights)`: `r = floor((u >> 8) * sum(weights) / 2^24)`, then walk
  `shell, window, label, disc` subtracting weights until `r < weight`. Because `u >> 8 < 2^24`,
  `r < sum(weights)` always, so the walk always returns; the fall-through after the loop is
  unreachable (the TS throws there only as an assertion).

Ranges for version 1 (micro-units, half open):

| Field | Scratch | Scuff |
|---|---|---|
| surface weights (shell, window, label, disc) | 35, 20, 15, 30 | 45, 10, 10, 35 |
| length | 20000..180000 | |
| angle (degrees) | 0..180000000 | |
| radius | | 20000..90000 |
| edge inset | 10000 | 20000 |
| x, y (centre) | `[inset + half, 1000000 - inset - half)`, `half = floor((length + 1) / 2)` (= ceil(length / 2)) | `[inset + radius, 1000000 - inset - radius)` |
| depth | 150000..1000000 | |
| intensity | | 100000..600000 |

The centre range keeps geometry **inside the surface**: every scratch end point lies within
`[inset, 1 - inset]` on both axes at any angle (the circle of radius `length / 2` around the centre
does), and every scuff circle lies within `[inset, 1 - inset]` squared.

## 5. Fixed sequence, safe zones and reveal (PRD §11.4)

The stream layout never depends on level or safe zones:

1. **Scratch slots** `i = 0..39` (`MAX_SCRATCHES`). Each slot draws `PLACEMENT_ATTEMPTS = 8`
   candidates, **always all 8**, each as 6 `UInt32` in this order:
   **surface, length, angle, x, y, depth** (x and y use the range that depends on length).
2. **Scuff slots** `j = 0..11` (`MAX_SCUFF_ZONES`), after all scratch slots. 8 candidates each,
   5 `UInt32` in this order: **surface, radius, x, y, intensity**.

Total: 1920 + 480 = 2400 PRNG outputs per call.

A slot takes its **first** candidate that clears every safe zone on the same surface; the other
candidates are still drawn. If none of the 8 clears, the slot is **empty** (skipped):

```
for each slot:
  chosen = null
  for a in 0 ..< 8:
    c = drawCandidate()                        // always, even after a candidate was chosen
    if chosen == null && !hitsAnyZone(c): chosen = c
  slots.append(chosen)                          // null = empty slot
```

Because every candidate is always drawn, a safe zone only changes the slots that would have hit
it; every other slot is untouched.

**Clearance test** (integers). A zone is the **closed** rectangle `[x, x + w] x [y, y + h]`,
converted outwards to the micro grid with IEEE double products:
`x0 = floor(x * 1e6)`, `y0 = floor(y * 1e6)`, `x1 = ceil((x + w) * 1e6)`, `y1 = ceil((y + h) * 1e6)`.
Note `ceil((x + w) * 1e6)`: add in double first, then multiply, then ceil (not `ceil(x) + ceil(w)`).
For a candidate with centre `(cx, cy)` and diameter `d` (`d = length` for a scratch, `2 * radius`
for a scuff), with `margin = 5000`:

```
reach = d + 2 * margin
dx = 2 * max(x0 - cx, 0, cx - x1)
dy = 2 * max(y0 - cy, 0, cy - y1)
hit = dx*dx + dy*dy <= reach*reach            // touching counts as a hit
```

For a scratch this tests the circle around the whole segment, so it holds for **any** angle,
needs no trigonometry, and a renderer's affine UV mapping cannot break it. The `edge ...` vectors
place a zone edge exactly at `reach`, one micro inside and outside it, and on non grid values, so
`<` for `<=`, a wrong margin, and round/floor/ceil slips on any edge each fail a vector.

**Reveal.** `scratchCount = floor(levelMicro * 40 / 1e6)` and
`scuffCount = floor(levelMicro * 12 / 1e6)` (integer division; `floor(level * 40)` on the double
level gives the same count for every one of the 1,000,001 possible levels, so either is fine).
Output the non empty slots among the first `scratchCount` (resp. `scuffCount`) slots, in slot
order. So a higher level is always a prefix superset of a lower one (PRD test 2), and the scratch
count is exactly `floor(level * 40)` unless a safe zone emptied a slot.

**Geometry meaning.** Surface UV space, both axes 0..1. A scratch runs from
`(x, y) - (length / 2) * (cos a, sin a)` to `(x, y) + (length / 2) * (cos a, sin a)`,
`a = angle` degrees from +x towards +y. Safe zone `x, y` are the top left corner.

## 6. Other fields

Round half up, integer only: `scale(max) = floor((levelMicro * max + 500000) / 1000000)`.

| Field | Value (micro) | Ceiling |
|---|---|---|
| `labelFade` | `scale(350000)` | 0.35 |
| `edgeWear` | `scale(1000000)` | 1.0 |
| `dustAmount` | `scale(300000)` | 0.3 |

## 7. Descriptor values and canonical serialization (`serializeDescriptor`)

**What the descriptor carries.** Every non integer field of the TS `WearDescriptor` is a double
`v = m / 1e6`, where `m` is the integer micro value computed above. `serializeDescriptor` recovers
`m = Math.round(v * 1e6)` (exact, because `v * 1e6` is within one ulp of the integer `m`) and throws
unless `m >= 0`, `m` is a safe integer and `m / 1e6 === v`. A port may instead carry `m` directly
and format it; the bytes are the same.

- No whitespace. Keys in exactly this order; extra keys ignored:
  - descriptor: `version, seed, level, scratches, scuffZones, labelFade, edgeWear, dustAmount`
  - scratch: `surface, x, y, angle, length, depth`
  - scuff: `surface, x, y, radius, intensity`
- `version`: base 10 integer. `seed`, `surface`: lower case ASCII in double quotes (never needs escaping).
- Every other number: from its micro value `m`, write `floor(m / 1e6)`, `.`, then `m % 1e6`
  zero padded to 6 digits. `0 -> 0.000000`, `350000 -> 0.350000`, `123456789 -> 123.456789`.
  Never use the platform float formatter.

Example (zero stats):
```
{"version":1,"seed":"0123456789abcdef0123456789abcdef","level":0.000000,"scratches":[],"scuffZones":[],"labelFade":0.000000,"edgeWear":0.000000,"dustAmount":0.000000}
```

## 8. Test vectors (frozen, append only)

`wear-vectors.json`: `{ format: 1, note, cases: [{ name, tags, input: { version, seed, stats, wearSafeZones? }, expected? , expectedError? }] }`.
For each case, call `computeWear(input.seed, input.stats, input.version, { wearSafeZones: input.wearSafeZones })`:
`serializeDescriptor` of the result must equal `expected` byte for byte, or the call must throw an
error whose message contains `expectedError`.

- An absent `wearSafeZones` key means no zones. `null`, non objects, arrays and the like appear only
  in `error` cases. JSON has no holes, so the sparse array rule is covered by the TS unit tests only.
- Stats may be written `-0` (JSON negative zero); decode it as a double `-0.0`. Those cases expect the
  zero-stats descriptor.
- Some error cases carry values a typed decoder cannot hold (a string or `null` stat, a missing stat
  field, `version: 1.5`, zones that are not arrays of objects). A port should treat "cannot decode
  this input" as the rejection and check that the case is an `error` case with that
  `expectedError` family.

Tags: `zero, tiny, mid, saturated, lent-heavy, handling-only, huge, threshold, rounding-edge,
mixed-edge, zone-edge, safe-zones, no-safe-zones, error`.

**Freeze.** `test/vectors.test.ts` checks the file's SHA-256 against `wear-vectors.sha256` and the
exact case count (`FROZEN_CASE_COUNT`). `npx tsx packages/wear/scripts/gen-vectors.ts` regenerates
every case and exits 1 if any existing case's input or expected bytes would change, if a case was
removed, or if new cases are pending. `--force` only **appends** new cases at the end (and rewrites
the SHA file); it still refuses any change to an existing case. Changing a v1 output requires a new
`wearModelVersion` (§10).

## 9. Mutation harness

`npx tsx packages/wear/scripts/mutants.ts` (also run by `test/mutants.test.ts`) copies `src/` to a
temp dir, applies one plausible porting mistake, and runs every vector. It exits 1 if the unmutated
copy fails any vector or if any mutant passes all of them. Current result: **56 mutants, 56
killed**, covering the level grouping, `exp` choice, rounding, fades, reveal, clearance `<`/`<=`,
margin 0/4999/5001, every zone edge rounding (round, floor, ceil sum, off by one), stream layout
(break after accept, draw order, scuffs first, no inset), seed parsing and validation, and
serializer padding.

Rewrites that are exact (and therefore allowed) are listed in `EQUIVALENT` in that file with the
evidence: commuting one operation, `Math.round` for the level rounding, a float form of
`drawMicro`, `floor(level * 40)` on the double, and Taylor term count / reciprocal tweaks inside
`expNeg` (these can differ only where the level already rounds to 1.000000).

## 10. Versioning

A new formula, constant or range is a new entry in `WEAR_MODELS` with a new version number. Never
edit version 1: stored copies carry `wearModelVersion` and must render the same forever. Unknown
versions throw.
