# @myind/minidisc

The parameterised three.js MiniDisc. A `DiscDesign` (JSON) becomes the release's cartridge (preset shell,
printed disc, label plate, edition stamp, LIT's screws / hub / coat / iridescent sheen, wear) and its printed card
sleeve. The same module drives the generic release bundle (`bundles/release`), the portal's live preview, the
preset gallery and the publish-time spin loops. Peer dependency: `three` (the repo's).

Grilled.md: "Release portal + generated discs". PRD §4A (design system), §10 (bundles, BUN-1..6), §11.4 (wear).

## The contract: `DiscDesign` v1

Stored by the portal and the backend (`products.design`), shipped in the release zip as `design/design.json`.
Schema: [`schema/disc-design.schema.json`](schema/disc-design.schema.json). Validator: `validateDesign` /
`assertDesign` (`src/design.ts`, dependency free; `scripts/build-bundle.mjs` imports it under Node).

```jsonc
{
  "v": 1,
  "slug": "blood",                       // ^[a-z0-9][a-z0-9-]{0,63}$ — names the zip
  "title": "BLOOD", "artist": "Tha Myind", "year": 2026,
  "tracks": [{ "n": 1, "title": "Blood", "durationSec": 201 }],   // 1..40, unique n
  "coverArt": "blood/cover.png",         // relative to this file, or absolute; square, >= 1024 px
  "discArt": "blood/disc.png",           // optional, defaults to coverArt
  "shell": "red",                        // smoke-black | clear | clear-pink | purple | blue | red | smoke-gold
  "shellTint": "#E63024",                // optional #RRGGBB, recolours the preset's plastic
  "shellWindow": "auto",                 // auto | clear | tinted | opaque (see "The disc window")
  "labelStyle": "sticker",               // metal | sticker | none
  "labelText": "BLOOD\nTHA MYIND\nMD 08", // optional lines; defaults to title, artist, "MD nn · DIGITAL AUDIO · year"
  "accent": "#F2E9E1", "accent2": "#E63024",   // optional print accents (default gold / cream)
  "discFinish": "print",                 // optional: print | gold | silver (smoke-gold defaults to gold)
  "stickers": [{ "kind": "advisory", "x": 0.74, "y": 0.8, "w": 0.2, "rotation": -3 }],  // <= 8; kinds text | advisory | badge; shell UV, origin top left
  "theme": {                             // PRD §4A.8, plus the player backdrop
    "accent": "#E63024", "accent2": "#F2E9E1", "lcdTint": "#FFB21F",
    "backdropImage": "city.png",         // products.theme.backdropImage; backdrop.image wins when both are set
    "backdrop": { "image": "blood/cover.png", "blurPx": 12, "scrim": 0.62 }   // defaults: the cover, 12, 0.62
  }
}
```

`resolveTheme(design)` fills every default. Relative art paths resolve against the design file (`resolveArtUrl`).

## Exported API (`src/index.ts`)

| Export | What |
|---|---|
| `validateDesign(value): { ok, design } \| { ok: false, errors[] }`, `assertDesign(value)` | The contract check; every error as `path: problem`. |
| `resolveTheme(design)`, `resolveShellWindow(design)`, `discHasArt(design)`, `designArtRefs(design)`, `catalogueNumber(design)`, `formatDuration(sec)` | Helpers the prints, the shell and the build script share. |
| `SHELL_PRESET_IDS`, `SHELL_WINDOWS`, `SHELL_PRESETS`, `SHELL_PRESET_LIST`, `resolvePreset(id, tint?, finish?)` | The shell presets (material numbers per catalogue reference) and the window modes. |
| `suggestShell(image)` → `{ shell, tint?, key, swatches }` | Browser: median cut over a 64 px downscale, mapped to the nearest preset. `suggestShellFromPixels(rgba)` is the pure version; `dominantColours`, `keyColour`, `shellForColour` underneath. |
| `loadDesignArt(design, base?)` → `{ cover, disc, backdrop }` | Loads every image the design names. |
| `createMiniDisc(design, art, opts)` → `MiniDisc` | Standalone cartridge + sleeve: `group`, `cartridge`, `spin(rps)`, `update(dt)`, `setWear(descriptor)`, `setEdition(n)`, `setSleeve(on, drop)`, `built`, `dispose()`. Options: `environment`, `quality: 'high' \| 'low'` (BUN-0a), `transmission`, `sleeve`, `sleeveDrop`, `wearSafeZones`, `anisotropy`. |
| `buildCartridge(design, art, input, opts)` → `BuiltCartridge` | Builds into a deck `CartridgeBuilderInput` (`src/player3d/deck.ts`): `spinning`, `hitTarget`, `plateRect`, `setWear`, `setEdition`, `dispose`. |
| `cartridgeBuilder(design, art, opts, onBuilt)` | The `PlayerOptions.cartridge` hook for `PlayerApp`. |
| `makeSleevePrints(design, art, opts)` → `{ poster, prints }` | The sleeve's cover, generated back (tracklist, imprint, barcode strip) and spines, for `DiscWrap` / `PlayerOptions.sleeve`. |
| `ArtBackdrop(options)` | `Backdrop` for `PlayerOptions.createBackdrop`: the cover blurred (`blurPx` at 390 pt), under an ink `scrim`, slow drift (still under Reduce Motion), bass pulse. `blurArt(image, blurPx)` is the canvas step. |
| `renderSpinLoop(design, opts)` → `Promise<SpinLoopResult>` | Browser only. `{ sheet: { webp: Blob \| null, png: Blob, meta }, still: Blob }`; `meta = { frames, cols, rows, frameW, frameH, sheetW, sheetH, fps, format }`. Options: `frames` (36), `frameSize` (512, shrunk to fit 4096 px), `fps` (24), `stillSize` (1024), `art`, `base`, `sleeveDrop` (0.55), `turnDeg` (14), `edition`, `webpQuality`. |
| `packSprites(frames, w, h, maxSide?)`, `spriteCell(layout, i)`, `largestFrameSize(frames, preferred)` | The sheet maths (tested). |
| `STAMP_UV`, `ensureFonts()` | Where the edition stamp sits on the plate; waits for Inter / JetBrains Mono when the page declares them. |

The cartridge is built in LIT's space and z layout (`CartridgeBuilderInput`), so the deck's spindle, window,
inspector, insert and eject timelines take it unchanged. Shells: `MeshPhysicalMaterial` transmission + thickness +
attenuation + IOR + clearcoat on the high tier; a translucent standard material on the coarse-pointer tier; with
`transmission: false` (the spin loop, over alpha) a translucent physical material. Screw wells are cut through the
physical material with the same `uWells` uniforms LIT's SHELL shader uses, so `addCartridgeDetail` and
`CartridgeWear` (`src/player3d/wear-render.ts`) work on it as they do on LIT.

Fonts: the prints are typeset in Inter and JetBrains Mono. The page must declare them (`bundles/release/fonts.css`,
`dev/fonts.css`); call `ensureFonts()` before building, as the bundle does.

## The disc window (Lawrence's rule)

- **A disc with a design** (it has art: `coverArt` or `discArt`, so every generated release): the case is CLEAR over
  the disc. The window zone (the circle the disc spins in, as in refs 03 and 08) goes to a clear pane, so the
  printed disc, the hub and the ribs are plainly visible and spinning; the rest of the shell carries the preset's
  tint.
- **A blank disc** (no art): the case may be opaque or solid tinted (ref 10).

`shellWindow` (default `auto`) derives it: `auto` → `clear` when the disc has art, else `opaque`; `clear` and
`tinted` (the preset's plastic over the disc too) and `opaque` (a solid shell, the disc hidden) are the explicit
overrides. `resolveShellWindow(design)` is the rule; the shell shader (`cartridge.ts` `withShellShader`) opens the
pane: inside the window the body goes white, the tint's attenuation falls away and transmission goes to 1 (or the
gel's alpha drops on the tiers without transmission).

## Presets

| id | plastic | references (internal look-dev only, never shipped) |
|---|---|---|
| `smoke-black` | dark smoke, disc reads through | 04, 02 |
| `smoke-gold` | smoke black with a gold-pressed disc | 02 |
| `clear` | clear, internals and chassis visible | 03, 08 |
| `clear-pink` | clear with a pink cast | 03 |
| `purple` | translucent purple | 06, 09 |
| `blue` | translucent blue | 05 |
| `red` | translucent red | 10 |

Label plates: `metal` (brushed steel shutter plate, 02/03), `sticker` (paper plate in the accent, 04/06/09/10),
`none` (08, 07; the edition stamp goes on the shell's lower right corner).

## The release bundle

`bundles/release` is the generic bundle (BUN-4): the same bridge contract and behaviour as `bundles/lit`, with the
cartridge, sleeve and backdrop generated from the design. `bundles/release/bundle.json` carries the generic
version and the wear safe zones (the stamp on the plate, and on the shell for `labelStyle: 'none'`).

```
npm run bundle:release -- --design packages/minidisc/samples/blood.json
  → dist-bundles/blood-1.0.0.zip + dist-bundles/blood-1.0.0.manifest.json
```

The script validates the design, copies it and its art into `design/` (art rewritten to basenames, URLs
rejected: everything ships inside the zip), and adds `generator` and `design: { title, artist, year, shell,
labelStyle, theme }` to the manifest. The harness: `npm run dev:release`, then
`http://localhost:5173/dev.html?design=blood[&mode=sleeve&unwrapped][&load][&edition=7][&wear=0.5]`.

## Dev pages

`npm run minidisc:preview` (port 5178):
- `preview.html?design=<sample>[&sleeve][&edition=N]`: every preset side by side on the sample's art, spinning;
  a sleeve mode; WEAR toggle; RENDER SPIN LOOP writes `shots/<slug>-spin.{webp,png,json}` and `<slug>-still.png`.
- `make-art.html`: draws the samples' original placeholder covers (gradients, noise and type only) into
  `samples/<slug>/cover.png`.

Samples: `samples/blood.json` (red, sticker), `samples/reflections.json` (smoke black, metal plate),
`samples/let-him-cook.json` (clear pink, sticker). Screenshots in `shots/`.

## Tests

`npm test` runs `test/design.test.ts` (validation, schema agreement, theme defaults), `test/palette.test.ts`
(median cut, the shell mapping on synthetic swatches) and `test/sprite.test.ts` (sheet packing).
