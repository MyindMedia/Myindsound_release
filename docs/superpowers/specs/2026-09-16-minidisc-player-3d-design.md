# 3D MiniDisc Player — Design

- **Date:** 2026-09-16
- **Status:** Approved in chat (Parts 1–3), awaiting written-spec review
- **Context:** `Grilled.md`
- **Depends on:** `2026-09-16-convex-backend-slice1-design.md` (`tracks.listForPlayer`, `plays.log`). Development can start against a mock track source; see §3.

## 1. Goal

Replace the stream page player with a Three.js MiniDisc deck built from the Canva parts:

- a cyberpunk scene behind it
- a gold HUD floating over and around it
- a tap-to-insert animation, where the cartridge slides into the slot, the disc spins up and the music starts
- solid keys that sink when pressed and stay latched to show the deck's mode

## 2. Experience

### 2.1 Scene layers (back → front)

1. **Background:** `#07070C` base, pink `#FF3DA8` and ice `#9FD8FF` volumetric haze, a perspective neon grid floor, light rain streaks, CRT scanlines and bloom. The haze and grid glow pulse with the low-frequency band.
2. **Body** (Canva page 13): extruded solid with the window hole cut through, art on the front face, `#1A1A1A` satin plastic on the edges. Page 7 is the inner back wall; page 10 is an additive glare plane over the window.
3. **Slot door** (page 8): hinged at the top edge of the body; flips open during insertion.
4. **Cartridge group:**

   | Part | Canva page | Behaviour |
   |---|---|---|
   | Shell | 16 | Circular disc area discarded by a shader mask |
   | LIT disc | 5 | Spins |
   | Clear disc | 3 | Spins, additive |
   | Label | 2 | Fixed to the shell |

   A thin slab with translucent edges.
5. **Keys:** 6 extruded keys (page 9 cut into Pause, Stop, ◀, ▶, Play, Red) in a recessed slot along the body's lower edge.

**Camera:**
- Fixed front-on at FOV 35°.
- The deck group tilts toward the pointer: yaw ±25°, pitch ±15°, critically damped spring.
- On touch devices it sways on a slow Lissajous path. Dragging on the deck tilts it, and it springs back on release. No gyroscope.

### 2.2 States

```
booting → empty ──tap──▶ inserting → reading → playing ⇄ paused
                                                 │   ▲
                                                 ▼   │ play
                                               stopped
```

- `booting`: textures loading; HUD shows "BOOTING" with the ported `uplink-loader`.
- `empty`: slot closed, window shows the inner wall, HUD status "INSERT DISC" pulsing gold. A full-deck hit area and a visible "INSERT DISC" button both start insertion.
- The URL `?state=animate_dock` (sent by `purchase-animation.ts:346`) is accepted and treated as a normal load.

### 2.3 Insert timeline (GSAP, about 3 s)

| t (s) | Event |
|---|---|
| 0.0 | Tap handler runs: `audioEngine.unlock()`, `audio.play()` at gain 0 (must happen inside the gesture) |
| 0.0–1.0 | Cartridge flies in from above and in front of the camera, rotates to align; camera dolly in 4 % |
| 1.0–1.8 | Door flips open (0.25 s); cartridge slides down through the slot, visible through the window; seats with overshoot 0.04 and a glare flash; door closes |
| 1.8–2.6 | Status "READING" + loader; RPM readout counts 0 → 300; disc angular velocity eases in |
| 2.6 | Play key auto-presses and latches; gain ramps 0 → volume over 0.6 s; status "PLAY"; spectrum and background go live |

**Reduced motion** (`prefers-reduced-motion: reduce`, read on load and on change):
- The deck starts with the cartridge seated; there's no fly-in, rain or sway.
- The disc turns at 20 % speed.
- Tapping Play starts audio immediately.

### 2.4 Keys

| Key | Action | Latch |
|---|---|---|
| Pause | Pause | Latched while paused |
| Stop | Stop, rewind to 0, disc spins down over 1.2 s | Momentary; pops Play and Pause up |
| ◀ | Previous track (restart the current one if > 3 s in) | Momentary |
| ▶ | Next track (wraps only when repeat is on) | Momentary |
| Play | Play | Latched while playing |
| Red | Toggle repeat (album) | Latched while repeat is on |

- **Press animation:** key travels 60 % of its depth in 80 ms (ease-out) with a front-face darkening. A momentary key returns in 140 ms; a latched key stays at 45 % depth.
- **Input:** raycast pointer hits on key meshes. Each key also has a real visually-hidden `<button>` (see §6).

### 2.5 HUD

- **Style:** 1 px gold hairlines, corner brackets, faint scanline shimmer, a 120 ms flicker on state change.
- **Font:** Inter for titles; JetBrains Mono (numerals only, `font-variant-numeric: tabular-nums`) for readouts.
- **Tilt:** panels sit in a CSS 3D layer whose transform follows the deck tilt through CSS custom properties `--tilt-x` and `--tilt-y`, updated each frame.

**Anchored to the deck** (screen position projected from 3D each frame):
- **Disc ring:** SVG ring around the window with 60 tick marks; a highlight sweeps around it at the disc's current RPM.
- **Status line:** just above the slot.

**Desktop (> 900 px wide):**

| Position | Panel |
|---|---|
| Left | Tracklist: `01`–`06`, title, length. The current track glows gold with a 3-bar CSS equalizer. Each row is a button that jumps and plays |
| Right | Readouts: `TIME 01:24 / 04:12` · `TRACK 02/06` · `RPM` (live) · `SIGNAL` (RMS level bar) · `FORMAT MP3` · `REPEAT ON/OFF` · vertical gold volume fader |
| Below deck | Spectrum: 32 log-spaced bars on a 2D canvas, gold at the top fading to pink; a flat line when not playing |

- Errors (link refresh failed, not entitled, network) show in orange on the status line.

**Phone (≤ 640 px portrait):**
1. **Top strip:** status · time · track · RPM.
2. **Deck:** about 55 vh.
3. **Spectrum:** under the deck.
4. **Tracklist:** a bottom sheet collapsed to `TRACKLIST 02/06 ▲`, opened by tap or swipe.
5. **Volume:** hidden.

- **641–900 px:** tracklist becomes the bottom sheet; readouts stay on the right, compact.

## 3. Architecture

Everything lives in `src/player3d/`. Each module has one job; the pure logic is framework-free and unit-tested.

| Module | Responsibility | Depends on |
|---|---|---|
| `state.ts` | Pure deck state machine: states, events (`insert`, `play`, `pause`, `stop`, `next`, `prev`, `toggleRepeat`, `trackEnded`), and derived key latch map. No DOM/Three | — |
| `track-source.ts` | Interface `TrackSource { list(): Promise<PlayerTrack[]>; refresh(trackId): Promise<PlayerTrack> }`. `ConvexTrackSource` (calls `tracks.listForPlayer`) and `MockTrackSource` (local demo file `public/assets/audio/Cook-Demo.mp3`, for dev before slice 1 lands) | `src/convex.ts` |
| `audio-engine.ts` | Owns the `HTMLAudioElement` (`crossOrigin="anonymous"`) and `AudioContext` graph `MediaElementSource → Gain → Analyser(fftSize 2048) → destination`. API: `unlock()`, `load(url)`, `play()`, `pause()`, `stop()`, `fadeTo(v, s)`, `spectrum(32)`, `level()`, `bass()`. Link refresh when `expiresAt − now < 600 s` or on a media error | — |
| `textures.ts` | Loads WebP textures (sRGB, max anisotropy); reports progress | three |
| `scene.ts` | Renderer (antialias, DPR cap 2 / 1.5 on coarse pointers), camera, resize, render loop, visibility pause, tilt spring, reduced-motion flag, post-processing (half-res bloom + scanline pass ported from ThreeUI `crt`) | three |
| `background.ts` | Haze gradient, grid floor shader, instanced rain (1 200 desktop / 400 phone, 0 reduced), audio-reactive uniforms | three |
| `deck.ts` | Builds body, door, cartridge and key meshes. Exposes `cartridge`, `door`, `discs`, `keys[6]`, `setDiscRpm(rpm)`, `setKeyDepth(i, depth)`, `windowAnchor()` / `slotAnchor()` world positions for the HUD | three, textures |
| `insert-sequence.ts` | Builds the GSAP timeline of §2.3 against `deck` + `scene`; exposes labels and callbacks `onStatus`, `onReadyToPlay` | `window.gsap` |
| `keys.ts` | Raycasting, hidden buttons, keyboard shortcuts → `state` events; animates key depth from the latch map | deck, state |
| `hud.ts` | Renders and updates the HUD DOM, spectrum canvas, bottom sheet and CSS tilt variables | state, audio-engine |
| `fallback.ts` | No WebGL2/WebGL: `<img>` of composite page 11 + the HUD + HTML keys | — |
| `player-app.ts` | Composition root: wires modules, logs plays via `plays.log` at 30 s of listening or track end (whichever first, once per track load) | all above |

**Also changed:**
- `stream.ts` shrinks to: init Clerk + Convex, require sign-in, `new PlayerApp({ source: new ConvexTrackSource() }).mount('#player-root')`. The docking, calibration, intro-overlay, simulated-progress and `DiskPlayerAnimator` code is removed from the stream page.
- `stream.html`: the old player markup, the Unicorn Studio script and the `disk-player.ts` script are removed; `#player-root` and the HUD skeleton are added. `src/disk-player.ts` and Unicorn Studio stay for the other pages that use them (`purchase-animation.ts`, `index.html`, etc.).

**Dependencies:**
- `three` (npm, pinned).
- GSAP stays on the existing CDN tag.
- `vitest` (dev).
- `sharp` (dev) for textures.

## 4. Assets

- **Source:** `~/Downloads/CD PLYAER MYINDSOUND/transparent/{1..18}.png` (Canva design `DAHAUDNdp9k`, transparent export, 2026-09-16).
- **Build:** `scripts/build-player-textures.ts` (sharp, idempotent) writes `public/assets/images/minidisc/`:

  | Output | Source | Max size |
  |---|---|---|
  | `body.webp` | 13 | 2048 |
  | `inner-wall.webp` | 7 | 1024 |
  | `glare.webp` | 10 | 1024 |
  | `door.webp` | 8 | 1024 |
  | `shell.webp` | 16 | 2048 |
  | `disc.webp` | 5 | 2048 |
  | `disc-clear.webp` | 3 | 1024 |
  | `label.webp` | 2 | 1024 |
  | `key-{pause,stop,prev,next,play,red}.webp` | 9, cropped | 512 |
  | `fallback-deck.webp` | 11 | 1600 |

  Quality 86, alpha preserved. **Budget ≤ 4 MB total**; the build fails if exceeded.
- **Geometry:** crop rectangles for the 6 keys and the disc-mask circle (centre and radius) are measured once from pages 9 and 16 and stored as constants in `deck.ts`, with the measuring script committed. The body outline and window hole come from page 13's alpha channel, traced to a simplified path (≤ 64 points) at build time and stored as JSON.
- **To re-export after a Canva edit:** Canva MCP `export-design` with `DAHAUDNdp9k`, PNG, `transparent_background: true`, then rerun the build script.

## 5. Audio details

- `unlock()` must run synchronously in the insert tap handler: `ctx.resume()`, `audio.play()`. The fade happens on the `GainNode`, because iOS ignores `audio.volume`.
- **CORS probe:** before routing a new URL through Web Audio, `fetch(url, { method: "HEAD", mode: "cors" })`.
  - On failure, bypass the graph (direct element playback) and drive the spectrum and level from a simulated signal.
  - Show `SIGNAL SIM` in the readouts so the fallback is visible.
  - This prevents the silent-output failure `MediaElementSource` has with non-CORS media.
- **Track end:** with repeat off, advance until the last track, then stop and pop the keys. With repeat on, wrap.
- **Volume:** fader default 0.8; persisted in `localStorage` (wrapped in try/catch).

## 6. Accessibility

- Visually hidden `<button>`s for all 6 keys, in DOM order Pause, Stop, Previous, Next, Play, Repeat. Latching keys use `aria-pressed`. Focus shows a gold outline on the HUD key legend and brightens the 3D key.
- **Keyboard:** Space play/pause, ←/→ previous/next, S stop, R repeat, Enter/Space on "INSERT DISC".
- The status line is `aria-live="polite"`. The tracklist is a list of buttons with `aria-current="true"` on the playing track.
- The canvas is `aria-hidden="true"`; all information in it is mirrored in the HUD DOM.
- HUD text contrast ≥ 4.5:1 against a `rgba(7,7,12,0.72)` panel scrim.

## 7. Performance

- **Target:** 60 fps on a 2021 iPhone (iPhone 13) and a mid-range Android; LCP of the HUD skeleton < 2.5 s on 4G.
- **Rendering:** stops when `document.hidden`; drops to 30 fps when `empty` and there has been no input for 10 s.
- **Budgets:** JS added ≤ 180 KB gzip (three + player); textures ≤ 4 MB; one WebGL context on the page.
- **Fallbacks:** WebGL context lost or unavailable → `fallback.ts`. Frame time > 24 ms averaged over 3 s on a coarse pointer → disable bloom and halve the rain.

## 8. Error handling

| Condition | Behaviour |
|---|---|
| Signed out | Existing `requireAuth` redirect to `/login` |
| `NOT_ENTITLED` | Deck stays `empty`; status (orange) "NO LICENSE FOUND"; link to `/` purchase |
| Link fetch or refresh fails | Retry ×2 with 1 s / 3 s backoff, then "SIGNAL LOST · TAP TO RETRY" |
| Audio decode error | Skip to the next track, status flash "READ ERROR" |
| Texture load failure | `fallback.ts` |

## 9. Testing

- **Unit (vitest):**
  - `state.ts`: all transitions; latch map per state; repeat interactions; prev restart threshold.
  - `audio-engine.ts` refresh scheduling (fake timers).
  - Time formatting.
  - Spectrum log-bin mapping.
- **Browser verification:**
  - 1440×900, 390×844 and reduced-motion runs.
  - Screenshots of `empty`, mid-insert (t = 1.4 s), `playing`, `paused` + repeat latched.
  - Console clean.
  - Keyboard-only run through all keys and tracks.
- **Performance:** Chrome Performance panel with 4× CPU throttling on the 390 px run; frame time recorded in the PR.
- **Real device:** Lawrence plays through on an iPhone once it's deployed to a Netlify deploy preview.

## 10. Acceptance criteria

- [ ] One tap on "INSERT DISC" runs the §2.3 sequence and audio is audible on iPhone Safari, Chrome and Firefox.
- [ ] Each key visibly sinks when pressed. Play, Pause and Red stay latched according to §2.4, and Stop pops them.
- [ ] The spectrum moves with real audio from R2 (not `SIGNAL SIM`) on the production domain.
- [ ] Desktop and phone layouts match §2.5 with no horizontal scroll at 390 px.
- [ ] Reduced motion shows no fly-in, rain or sway, and still plays.
- [ ] Keyboard and screen-reader users can insert, play, pause, stop, skip, toggle repeat and pick a track.
- [ ] Textures ≤ 4 MB, added JS ≤ 180 KB gzip, 60 fps on the throttled 390 px run.
- [ ] No hardcoded audio URLs remain in the repo.

## 11. Out of scope

- Seek bar and now-playing panel.
- Eject.
- Key sounds.
- Gyroscope.
- Rebuilding the home-page purchase reveal.
- Multi-album cartridge switching (product slug is hardcoded to `lit` for now).
- Unused Canva pages 1, 4, 6, 12, 14, 15, 17, 18.
