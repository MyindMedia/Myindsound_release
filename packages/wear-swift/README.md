# MyindWear (Swift port of `@myind/wear`)

SwiftPM library `MyindWear` (swift-tools-version 5.9, iOS 17+, macOS 14+, no dependencies).
Clean-room port of PRD section 11 from `packages/wear/README.md` and `packages/wear/wear-vectors.json`
only; the TypeScript sources were not consulted. Byte identical `serializeDescriptor` output is
proven by the frozen vectors (186/186, SHA-256 asserted in the tests).

```swift
import MyindWear

let d = try computeWear(
  seed: entitlement.wearSeed,
  stats: WearStats(playSeconds: 4500, lentPlaySeconds: 0, loads: 3, ejects: 2),
  version: entitlement.wearModelVersion,
  safeZones: manifest.wearSafeZones.map { WearSafeZone(surface: $0.surface, x: $0.x, y: $0.y, w: $0.w, h: $0.h) }
)
let bytes = try serializeDescriptor(d)   // same bytes as Convex and the web bundles
```

Invalid input throws `WearError` (`invalidVersion`, `invalidSeed`, `invalidStats`, `invalidSafeZones`);
`message` carries the same marker words as the TypeScript package (`wearModelVersion`, `wearSeed`,
`wearStats`, `wearSafeZones`). `serializeDescriptor` throws `nonCanonicalValue` if a descriptor
value is not an exact `m / 1e6` (README section 7); descriptors from `computeWear` never are.

## Layout

- `Sources/MyindWear/Config.swift`: `WearModelConfig`, `WEAR_MODEL_V1`, `WEAR_MODELS` registry.
- `Sources/MyindWear/PRNG.swift`: `Xoshiro128StarStar` + `fmix32` seed derivation.
- `Sources/MyindWear/Descriptor.swift`: `WearStats`, `WearSafeZone`, `WearDescriptor`, `WearError`.
- `Sources/MyindWear/ComputeWear.swift`: `expNeg`, level, draws, clearance, reveal, `computeWear`.
- `Sources/MyindWear/Serialize.swift`: `serializeDescriptor` / `serializeDescriptorBytes`.

## Tests

```
swift test                     # macOS, prints "wear-vectors: 186/186 passed"
xcodebuild -scheme MyindWear -destination 'generic/platform=iOS Simulator' build
```

**Vectors are read by path, not copied.** `Tests/MyindWearTests/Vectors.swift` resolves
`../../../wear/wear-vectors.json` from `#filePath`, so there is one frozen file and nothing to drift.
Set `MYIND_WEAR_VECTORS=/path/to/wear-vectors.json` when the package is built outside the monorepo.
`FROZEN_SHA256` and `FROZEN_CASE_COUNT` in `Vectors.swift` mirror `packages/wear/wear-vectors.sha256`
and the README's count; a changed file fails `testVectorFileIsFrozen` before any case runs.

Inputs a typed decoder cannot hold (`version: 1.5`, a string or null stat, a null zone) are
rejected by the decoder itself, which records the failing input family; the test checks that
family equals the case's `expectedError` (README section 8). 15 rejected cases reach `computeWear`,
13 stop at the decoder.

`VectorTests` run every case byte for byte and check the 28 rejected inputs throw. `PropertyTests`
cover PRD 11.6 tests 2 (prefix superset), 3 (ceilings), 9 (no output inside a safe zone) and the
edge inset (every scratch segment and scuff circle inside the surface) over
8 seeds x 5 zone sets x 27-step monotone stat ladders, plus serializer, validation and `expNeg` checks.
`PRNGTests` hold the README known answers.
