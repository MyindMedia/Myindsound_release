# Myind bridge: wire contract v1

The protocol between a release bundle (a web page inside WKWebView or Android WebView) and the native app.
Swift and Kotlin implement the native side from this document. The TypeScript source of truth is `src/types.ts`
(types, constants), `src/validate.ts` (every param and payload rule below, executable) and `src/wire.ts` (frame
encoding, ids, the meta tag). PRD: §10.2, BRG-1..4, BUN-5, BUN-6, §11.4 (WearDescriptor), §12 (LEND-5, LEND-8),
§18 DUO-7 (LayoutState), DS-22, RACK-1.

`BRIDGE_VERSION = 1`. MUST, SHOULD and MAY are used as in RFC 2119.

## 1. Roles and the trust boundary

| Piece | Where | Job |
|---|---|---|
| `native-shim.js` | Injected by native at document start | Defines `window.myind`, captures the post channel, hands keyed resolves and events to one in-page client |
| `createBridgeClient()` (`src/client.ts`) | In the bundle | Implements `MyindBridge` over the wire: ids, timeouts, validation, events |
| Native (Swift / Kotlin) | App | **The trust boundary.** Validates every request, does the work, answers via `__resolve` / `__emit` |
| `WebBridgeAdapter` (`src/web-adapter.ts`) | Website | Implements `MyindBridge` in the page with HTML audio and the site's Convex data (BUN-6); no wire |
| `MockBridge` (`src/mock.ts`) | Dev and tests | In-page fake native |

Bundles never fetch audio or call Convex (BUN-5). Everything they know comes through `MyindBridge`.

**Native MUST treat the page as untrusted.** Anything in the page can post to the message handler directly, with
any method and params, bypassing the client. Everything the client checks, native checks again.

Native MUST:
1. Accept messages only from the main frame whose `securityOrigin` is `myind-bundle://<slug>` for the release it
   loaded (iOS: `WKScriptMessage.frameInfo.isMainFrame` and `frameInfo.securityOrigin`; Android: the
   `sourceOrigin` and `isMainFrame` passed to the web message listener). Drop anything else without answering.
2. Block every navigation away from `myind-bundle://` (`WKNavigationDelegate.decidePolicyFor` → `.cancel`; Android
   `shouldOverrideUrlLoading` → true), including `window.open` and target=_blank, and inject the shim only into
   `myind-bundle://` main frames. External links go through a native method (none in v1), never navigation.
3. On Android use `WebViewCompat.addWebMessageListener(webView, "myindNative", setOf("myind-bundle://<slug>"), listener)`.
   Never `addJavascriptInterface` (it is exposed to every frame and origin).
4. Drop every pending request id on navigation, reload, and WebContent process termination
   (`webViewWebContentProcessDidTerminate`, `onRenderProcessGone`), and never resolve an id from an earlier page load.
5. Validate every method and param exactly as §4 says (BRG-1), and every id as 32 lowercase hex characters.
6. Decide every ownership, lend, wear and timing question on the server (ARCH-3); a request is a wish, not a fact.

## 2. Transport

### Injection and per-page secrets
For every page load native generates two fresh values, each 32+ lowercase hex characters from a CSPRNG
(`SecRandomCopyBytes`, `SecureRandom`), different from each other:
- **connect token**: replaces `__MYIND_CONNECT_TOKEN__` in `native-shim.js`, and is written into the bundle's entry
  HTML (the `WKURLSchemeHandler` / `shouldInterceptRequest` response for `index.html`) as the first element of
  `<head>`: `<meta name="myind-bridge" content="token=<hex>;version=<max>;min=<min>">`.
- **channel key**: replaces `__MYIND_CHANNEL_KEY__` in `native-shim.js`. Never written anywhere the page can read.

Each placeholder occurs exactly once in the file. If either is left unreplaced the shim refuses to install.

- **iOS**: load the substituted `native-shim.js` as a `WKUserScript` (`.atDocumentStart`, `forMainFrameOnly: true`)
  and register a `WKScriptMessageHandler` named `myind`.
- **Android**: `addWebMessageListener` as in §1.3, and inject the substituted shim with
  `WebViewCompat.addDocumentStartJavaScript(webView, shim, setOf("myind-bundle://<slug>"))`.

The bundle MUST create its client (`createBridgeClient()`) in its first script, before any other code runs. The
client reads the meta tag, removes it, and connects with the token.

### What `window.myind` is
A frozen object on a non-writable, non-configurable `window` property:

| Member | Meaning |
|---|---|
| `version` / `minVersion` | The bridge versions this app build speaks (1 / 1) |
| `platform` | `"ios"` or `"android"` |
| `__resolve(key, id, result, error?)` | Native answers a request. Ignored unless `key` is the channel key |
| `__emit(key, event, payload)` | Native sends an event. Ignored unless `key` is the channel key |
| `__connect(token, receiver)` | One-shot. Needs the connect token; a wrong token throws without using up the connect. Returns the post function |

What the shim guarantees: page code cannot replace `window.myind`; cannot reroute requests by patching
`webkit.messageHandlers.myind.postMessage`, `Reflect`, `JSON` or `Function.prototype` after load (they are
captured at document start); cannot connect without the token, or connect twice; cannot forge resolves or events
without the channel key; and prototype poisoning (Array methods, inherited index setters) never touches the shim's
own queue or delivery. What it does not guarantee: page code can still post anything straight to the native handler
(§1); code that runs before the bundle's client can read the token from the meta tag; on Android the request is
serialised with the page's `JSON.stringify`, which honours `toJSON`, so page code could alter a request's content
(it could equally post its own). Native validation is the defence for all three.

### Event delivery before the bundle subscribes
Events native emits before the client connects are queued in the shim (max 64, oldest dropped, only the newest
`playback` frame kept) and handed over at connect. The client holds everything it receives until it **starts**, then
delivers in order. It starts on the first macrotask after `createBridgeClient()` returns (`setTimeout(0)`), or
earlier on an explicit `client.start()`; with `autoStart: false` only `start()` starts it. So a bundle subscribes
synchronously right after creating the client and misses nothing. State is also recoverable: `getContext()` carries
the current `layout` and `lifecycle`, and `BridgeAudioEngine` calls `getPlaybackState()` when it is created and on
every `foreground`.

One client per page load: `dispose()` is terminal, and a second connect is refused.

### JS → native: request
```json
{ "id": "9f2c4b1ae07d4c55b8c3f1e2a6d0b7c4", "method": "seek", "params": { "seconds": 42.5 } }
```
- iOS: the object itself through `webkit.messageHandlers.myind.postMessage` (arrives as `NSDictionary`).
- Android: the same object as a JSON string through `myindNative.postMessage`.
- `id`: 128 random bits from `crypto.getRandomValues` as 32 lowercase hex characters, fresh per request, never a
  counter; `null` for notify methods (§4), which native never resolves.
- `params`: always an object, `{}` when the method takes none.

### Native → JS: resolve and emit
Success: `window.myind.__resolve(key, id, result)` (`null` for void methods).
Failure: `window.myind.__resolve(key, id, null, { "code": "E_NOT_ALLOWED", "message": "..." })`.
Event: `window.myind.__emit(key, "layout", { ... })`.

- Resolve each id exactly once, and only ids from the current page load.
- iOS SHOULD use `callAsyncJavaScript("window.myind.__emit(k, e, p)", arguments: ["k": key, "e": event, "p": payload], in: nil, in: .page)`,
  which passes values without building source text. With `evaluateJavaScript`, every argument MUST be JSON-encoded,
  never interpolated raw. Android: `evaluateJavascript` with JSON-encoded arguments.
- Messages never contain PII (no emails; display names only where the contract carries them).

### Threading and ordering
- Call into the web view on the main thread only. Never from the `AVAudioEngine` tap thread: hop to main (or a
  serial queue that hands to main) with the finished frame.
- Backpressure: at most one `playback` frame in flight. If the previous evaluate for a frame has not completed,
  drop the new frame (keep only the latest); never queue frames. Resolves and other events are never dropped.
- Preserve send order: resolves and events reach the page in the order native produced them.
- `play`, `pause`, `seek`, `next`, `previous` and `setVolume` resolve once native has **accepted** the command (the
  player item or engine state is set), before the first frame that reflects it. The frame follows.
- Last `play` wins. Native keeps a play epoch: every `play`, `next`, `previous` and auto-advance increments it; work
  for an older epoch (a slow load, a lend check still in flight) is abandoned when it completes, and its request
  resolves (it was accepted) without starting audio.

## 3. Versioning (BRG-3)

1. The bundle's `manifest.json` carries `bridgeVersion` (BUN-1). Before loading a bundle, native checks
   `minVersion <= manifest.bridgeVersion <= version`. Outside that range: don't load it, show the native
   "Update the app" screen.
2. The client double-checks at runtime: with the shim, against `window.myind.version` / `minVersion`; with the
   fallback (§10), against the meta tag, and an absent meta tag counts as incompatible. Incompatible: every call fails
   with `E_BRIDGE_VERSION` and nothing is posted.
3. Adding an optional field or a new event is compatible within v1 (the client ignores unknown events). Removing or
   renaming anything, changing a type or a meaning, or adding a required param is a version bump.

## 4. Methods

**Request** methods return a promise and get exactly one `__resolve`. **Notify** methods are fire-and-forget:
posted with `id: null`, never resolved; native drops invalid ones (logging the method name only).

Timeouts are client side (`DEFAULT_TIMEOUTS_MS`, [DECIDE] tune on devices); the client rejects with `E_TIMEOUT`
and ignores a late resolve.

| Method | Kind | Params | Result | Timeout | Native errors |
|---|---|---|---|---|---|
| `getContext` | request | `{}` | `BridgeContext` | 10 s | `E_OFFLINE` (no cached context) |
| `getTracks` ⚑ | request | `{}` | `BridgeTrack[]`, album order | 10 s | `E_OFFLINE` |
| `play` | request | `{ trackId, startAt? }` ⚑ | `null` | 10 s | `E_NOT_FOUND`, `E_NOT_ALLOWED`, `E_LEND_ENDED`, `E_OFFLINE` |
| `pause` | request | `{}` | `null` | 5 s | |
| `seek` | request | `{ seconds }` | `null` | 5 s | |
| `next` | request | `{}` | `null` | 10 s | `E_NOT_ALLOWED`, `E_LEND_ENDED`, `E_OFFLINE` |
| `previous` | request | `{}` | `null` | 10 s | `E_NOT_ALLOWED`, `E_LEND_ENDED`, `E_OFFLINE` |
| `getPlaybackState` | request | `{}` | `PlaybackState` | 5 s | |
| `setVolume` ⚑ | request | `{ volume }` | `null` | 5 s | |
| `markUnwrapped` | request | `{}` | `null` | 10 s | `E_NOT_ALLOWED` |
| `cartridgeLoaded` | request | `{}` | `null` | 10 s | |
| `cartridgeEjected` | request | `{}` | `null` | 10 s | |
| `requestShare` | request | `{}` | `null` | none (waits on the fan) | `E_NOT_ALLOWED` |
| `requestLend` | request | `{}` | `null` | none (waits on the fan) | `E_NOT_ALLOWED`, `E_OFFLINE` |
| `haptic` | notify | `{ kind }` | | | |
| `playSound` | notify | `{ name }` | | | |
| `close` | notify | `{}` | | | |
| `ready` ⚑ | notify | `{}` | | | |

⚑ = not in PRD §10.2; see §11. Any method may also fail with `E_UNKNOWN_METHOD`, `E_INVALID_PARAMS` or `E_INTERNAL`.

### Param rules (BRG-1; native applies the same, `src/validate.ts` is the reference)
- Unknown method → `E_UNKNOWN_METHOD`. Method names are case sensitive.
- `params` not an object, or any key not listed for the method → `E_INVALID_PARAMS`.
- `trackId`: string matching `^[A-Za-z0-9_-]{1,128}$`, and in this release's `getTracks` (else `E_NOT_FOUND`).
- `seconds`, `startAt`: finite number, `0 <= x <= 21600`. `startAt` may be absent; present, it may not be null.
- `volume`: finite number, `0 <= volume <= 1`.
- `kind`: one of `light`, `medium`, `heavy`, `rigid`, `soft`, `success`.
- `name`: string matching `^[a-z0-9][a-z0-9-]{0,63}$`; native plays only names in its own sound table, silently
  ignoring others (DS-31: Lawrence's recordings only).

### Method behaviour
- `getContext`: server state (ARCH-3), cached for offline, plus the current `layout` and `lifecycle`. `serverNow`
  is the server clock at the time of the answer, so bundles count down to `dropAt` without trusting the device clock.
- `getTracks`: what this copy can play right now. Owned, and lent (any lend status): full songs, `preview: false`.
  `preview`, and `locked` after `dropAt`: the 30 second previews, `preview: true`, `durationSeconds` = preview length
  (PRD §3A). `locked` before `dropAt`: `[]`. Never URLs, storage ids or file names (ARCH-4).
- `setVolume`: the player's own music level, 0..1, applied to the player (`AVAudioMixerNode.outputVolume` or the
  `AVPlayer.volume`; Media3 `player.volume`). Never the system volume. Native SHOULD ramp changes over ≤ 80 ms to
  avoid clicks, and keeps the level for the session.
- `markUnwrapped`: persists `unwrappedAt` on the entitlement; idempotent. Owner only (`E_NOT_ALLOWED` otherwise).
  Resolve once durably queued (offline is fine), not after the server round trip.
- `cartridgeLoaded` / `cartridgeEjected`: record a `load` / `eject` wear event (§11.2) with an idempotency key.
  Resolve once queued. For copies that can't wear (preview, locked) resolve without recording.
- `haptic`: DS-32 beats (rigid on insert and seat, light on key press, soft during the peel, success on the edition stamp).
- `requestShare` / `requestLend`: open the native sheet or flow; resolve when it closes (completed or dismissed).
- `close`: leave the experience; native tears down the web view.
- `ready`: the bundle's first frame is on screen; native drops the splash (NAT-3). Idempotent. If `ready` hasn't
  arrived `READY_TIMEOUT_MS` (8 s, [DECIDE]) after the load started, native shows an error screen with Retry
  (reload the bundle) and Close.

## 5. Types and encoding

```ts
BridgeContext = {
  releaseId: string; ownership: 'owned' | 'lent' | 'locked' | 'preview';
  editionNumber: number | null; ownerDisplayName: string | null;   // display name, shown when lent
  wear: WearDescriptor | null; unwrapped: boolean;
  platform: 'ios' | 'android' | 'web';
  layout: LayoutState;                                              // current value
  lifecycle: 'foreground' | 'background';                           // current value
  lend?: LendState;                                                 // required when ownership is 'lent'
  dropAt: number; serverNow: number;                                // server epoch ms
}
LendState     = { playsAllowed: int; playsUsed: int; expiresAt: number /* epoch ms */;
                  status: 'active' | 'exhausted' | 'expired' | 'returned' | 'revoked' | 'converted'; endReason?: string }
BridgeTrack   = { id: string; position: number /* 1-based */; title: string; durationSeconds: number; preview: boolean }
PlaybackState = { trackId: string | null; status: 'idle' | 'loading' | 'playing' | 'paused' | 'stopped' | 'ended' | 'error';
                  positionSec: number; durationSec?: number; rate: number /* 1 playing, 0 otherwise */ }
LayoutState   = { widthPt: number; heightPt: number; sizeClass: 'compact' | 'regular';
                  posture: 'folded' | 'open' | 'partial' | 'standard'; hingeRect?: { x; y; w; h } }
WearDescriptor = PRD §11.4 exactly (packages/wear owns computeWear and the canonical type)
```

Encoding rules (native → JS; the client enforces them and rejects with `E_INVALID_RESULT` or drops the event):
- **Optional fields** (`lend`, `endReason`, `hingeRect`, `durationSec`) SHOULD be omitted when absent. `null` is
  accepted and treated as absent (for `JSONSerialization` / `NSNull` encoders); handlers always see them omitted.
- **Required fields** are always present. Nullable ones (`editionNumber`, `ownerDisplayName`, `wear`, `trackId`) are
  sent as `null`, never omitted.
- **Numbers** are finite. NaN and Infinity are forbidden (JSON can't carry them; don't send strings instead).
  Seconds are rounded to the millisecond (3 decimals). Counts (`playsAllowed`, `playsUsed`) are integers.
- **`durationSec`** is sent only once the media duration is known (`AVPlayerItem.duration` is numeric, or from the
  track list). Never 0, NaN or a placeholder.
- `WearDescriptor` is validated item by item: every scratch and scuff zone must be a complete object.
- **Errors** are exactly `{ code, message }` with `code` from §8 and a string `message`. Anything else (a string, 0,
  `false`, an array, an unknown code) is `E_INTERNAL` in the bundle. Only a missing, `undefined` or `null` error
  means success.

## 6. Events

| Event | Payload | When |
|---|---|---|
| `playback` | `PlaybackFrame` (wire form below) | Every status or track change (immediately), and up to 60 per second while playing (BRG-4) |
| `layout` | `LayoutState` | On load and every size, size class, posture or hinge change (DUO-7) |
| `wear` | `WearDescriptor` | When the descriptor changes, including the server value replacing a provisional one (WEAR-9, WEAR-10) |
| `lifecycle` | `{ state: 'background' \| 'foreground' }` | App or scene phase change (BRG-2); bundles pause rendering in background |
| `ownership` | `{ ownership, editionNumber, ownerDisplayName, unwrapped, lend? }` | Lend ended or returned, purchase completed, drop went live |

The client drops malformed payloads and ignores unknown event names (warning only), so a newer native can add events.
Handlers receive a deep-frozen copy shared by every handler of that emit.

### Playback frames (BRG-4)
On the wire a frame is `PlaybackState` plus integers, so a frame is under 1 KB:

| Field | Wire | Handlers get |
|---|---|---|
| `bands` | 64 integers 0..255, log spaced 40 Hz–16 kHz | 0..1 (÷255) |
| `waveform` | 128 integers -127..127, evenly spaced time-domain samples | -1..1 (÷127) |
| `level` | integer 0..255, RMS of the tap buffer | 0..1 |
| `bass` | integer 0..255, mean 40–160 Hz level | 0..1 |

- Source: an `AVAudioEngine` tap on the main mixer (Android: a Media3 `AudioProcessor`). Band mapping matches
  `logBins` in `src/player3d/audio-math.ts` (FFT 2048, smoothing ≈ 0.78, as the web analyser).
- While not playing, send one silent frame (all zeros) on the change and nothing after.
- Cap at 60 per second; drop rather than queue (§2). Stop entirely while the web view is backgrounded.
- `encodeFrame` / `decodeFrame` in `src/wire.ts` are the reference.

## 7. Playback semantics (native, web adapter and mock all follow these)

- `play(trackId)`: if `trackId` is the loaded track and `paused`, resume from the current position. Otherwise load it
  and play from 0 (including the loaded track when `ended`, `stopped`, `idle` or already playing).
- `play(trackId, startAt)`: load (or keep) that track and start at `startAt` with no audible jump (seek before the
  first audio renders). `startAt: 0` always starts from the top, even if that track is paused elsewhere.
- `pause`: idempotent; pausing when not playing resolves.
- `seek(seconds)`: clamps to `[0, durationSec]`; keeps the play state (`ended` and `stopped` become `paused`); a
  no-op with no track loaded. Seeking to the very end ends the track.
- End of a track: native starts the next track in album order by itself (it must keep going on the lock screen with
  the web view suspended) and sends a frame with the new `trackId`. After the last track: `status: 'ended'`,
  `positionSec = durationSec`, `rate: 0`. Repeat lives in the bundle's deck (`state.ts`): it calls `play(first)`.
- `next`: the following track from 0; at the last track, a no-op. `previous`: restart the current track if it is past
  3 s (`PREVIOUS_RESTART_THRESHOLD_SEC`, same as the deck) or is the first; otherwise the previous track from 0.
- `stopped` is native halting on its own (a lend ended): position 0, `rate: 0`, and only an explicit `play` starts again.
- Lock screen and Control Center (RACK-5) use the same operations and send the same frames. `BridgeAudioEngine`
  reports changes it didn't ask for through `onNativeChange`.
- Play events for wear (WEAR-6..9) are recorded natively; the bundle never reports plays.

### Lends on the wire (LEND-5, LEND-8, DS-22, RACK-1)
- A borrower's copy is `ownership: 'lent'` with `lend` always present. When the lend ends it stays `'lent'`, with
  `lend.status` set to the terminal state (`exhausted`, `expired`, `returned`, `revoked`, `converted`) and
  `endReason` when the server has one. Never `'locked'`: the bundle must be able to tell "your lend ended" from
  "not released yet". Plays left for the LCD (`PLAYS 03`) = `playsAllowed - playsUsed`.
- An owner's copy that is out on an active lend (LOCK_WHILE_LENT) is `'owned'` with `lend` describing that lend;
  `play` rejects with `E_NOT_ALLOWED` until it is returned.
- **Native runs `startLentPlay(lendId, trackId)` online on every play start** of a lent copy: `play`, `next`,
  `previous`, a restart (`previous` past 3 s, `play` of a non-paused track, any `startAt`), and **every auto-advance**.
  A resume of a paused track also re-checks that the lend is still active and unexpired (without counting a play).
  No network → `E_OFFLINE`; lent audio is never cached for offline (LEND-5).
- A play is committed (`commitLentPlay`, `playsUsed + 1`) once that track start has actually **played 30 s**
  (`LEND_COMMIT_AFTER_SEC`; paused time doesn't count; seeking doesn't count). Never at the start.
- **When a check fails, or the server ends the lend while the copy is open** (push, poll, or any call answered with an
  ended lend), native: (1) stops audio at once; (2) sends a `playback` frame with `status: 'stopped'`,
  `positionSec: 0`, `rate: 0`; (3) emits `ownership` with the ended `lend`; (4) rejects the triggering request, if
  any, with `E_LEND_ENDED`; (5) shows the LEND-8 end screen for `exhausted` or `expired` (the owner's disc, edition
  number, "Get your own copy"). Mid album, the auto-advance that failed produces exactly this sequence; the track
  that used the last play is allowed to finish first.
- Every later `play`, `next` or `previous` rejects with `E_LEND_ENDED`.

## 8. Error codes

| Code | Raised by | Meaning |
|---|---|---|
| `E_UNKNOWN_METHOD` | native, client | Method not in the contract (BRG-1) |
| `E_INVALID_PARAMS` | native, client | Params failed §4 rules |
| `E_NOT_ALLOWED` | native | Server-side ownership forbids it (locked before drop, owner's copy out on loan, …) |
| `E_LEND_ENDED` | native | A lent copy whose lend has ended (§7) |
| `E_NOT_FOUND` | native | `trackId` not in this release |
| `E_NOT_SUPPORTED` | native, web adapter | Not on this platform (lending on the web) |
| `E_OFFLINE` | native | Needs the network, no offline copy (always for lent plays) |
| `E_BRIDGE_VERSION` | client | BRG-3 mismatch |
| `E_INTERNAL` | native, client | Anything else; also any error that is not `{ code, message }` |
| `E_INVALID_RESULT` | client | Native's result broke §5 |
| `E_UNKNOWN_EVENT` | client | `on()` with an event outside §6 |
| `E_TIMEOUT` | client | No resolve within the method's timeout |
| `E_TRANSPORT` | client | No native bridge, no connect token, connect refused, or posting threw |
| `E_DISPOSED` | client | Client disposed with the call pending |

## 9. Web adapter wiring (BUN-6)

`new WebBridgeAdapter({ createEngine, providers })`, all injected (the package imports nothing from the site):
- `createEngine: (events) => new AudioEngine(events)`. The real `src/player3d/audio-engine.ts` satisfies
  `WebAudioEngine` unchanged and is tested under Web Audio and media-element stubs.
- The adapter calls `engine.probe(firstUrl)` when it first lists tracks, so AudioEngine can route through Web Audio
  (a real spectrum). Call `adapter.unlock()` inside the user gesture that starts audio (`BridgeAudioEngine.unlock()`
  does). If the gesture came before the probe, the next start routes the element and un-mutes it.
- Every start and resume calls `engine.fadeIn(START_FADE_SEC)`: AudioEngine's gain starts at 0 and `unlock` mutes an
  unrouted element, so this is what makes it audible. `setVolume` drives `engine.setVolume`.
- `providers.getContext()`: from the site's Convex client (entitlement, edition, wear, unwrapped, lend, `dropAt`,
  `serverNow`); the adapter adds `platform: 'web'`, a window-derived `layout` and a visibility-derived `lifecycle`.
- `providers.getTracks()`: `{ tracks, expiresAt, preview }`, e.g. from `LitStreamSource.list()` plus `access.mode`.
  Stream URLs stay inside the adapter; links are refetched before a load within 10 minutes of expiry.
- Optional: `markUnwrapped`, `cartridgeLoaded`, `cartridgeEjected`, `logPlay` (once per track start after 30 s or at
  its end), `requestShare`, `requestLend` (absent → `E_NOT_SUPPORTED`: lending needs the app), `close`, `haptic`,
  `playSound`, `ready`.

## 10. Fallback transport

If the handler exists but the shim didn't install (misconfigured user script, unreplaced placeholders), the client
defines `window.myind` itself with the same signatures. It holds events until start like the shim path, reads the
version range from the meta tag (absent → `E_BRIDGE_VERSION` on every call), and catches every receiver exception
so nothing throws back into native. It has no channel key, so page code can forge resolves and events: production
native MUST make shim injection work and SHOULD treat a page that answers without it as broken.

## 11. Additions to PRD §10.2 (lead-approved or PRD-required)

1. **`getTracks()`**: BUN-5 forbids fetching the tracklist and §10.2 has no other source.
2. **`ready()`** (NAT-3) and the `READY_TIMEOUT_MS` splash timeout.
3. **`setVolume(volume)`** (lead-approved): the player's own level; the HUD slider works in the app.
4. **`play(trackId, startAt?)`** (lead-approved): starting mid-track without a seek jump.
5. **`lend` in the context and `ownership` event, `E_LEND_ENDED`, `stopped` status** (lead-approved, §7).
6. **`lifecycle` in the context**, so a lost event can't wedge the bundle.
7. **Keyed `__resolve(key, id, result, error?)` / `__emit(key, event, payload)` and `__connect(token, receiver)`**:
   §10.2 shows `__resolve(id, result)`; the key, token and error argument are the trust model above.
8. **`on()` returns an unsubscribe function** instead of `void` (PRD-shaped callers are unaffected).
9. **Android uses `addWebMessageListener`** (`myindNative`), where PRD §19 says `@JavascriptInterface`.
10. Open: NFR-6 ("simple controls overlay toggled from native") still has no event.

## 12. BUN-0 integration: what the site player and the LIT bundle do

`BridgeTrackSource` satisfies `TrackSource`, and `BridgeAudioEngine` satisfies `PlayerEngine`
(`Omit<AudioEngine, 'element'>`), both checked at compile time (`test/bridge-track-source.test.ts`, `test/bun0.test.ts`).
Done, with the site behaving exactly as before (every option defaults to today's behaviour):

1. `PlayerOptions.createEngine?(events: PlayerEngineEvents): PlayerEngine` in `src/player3d/player-app.ts`, default
   `new AudioEngine(events)`. The track source was already injected (`new PlayerApp(root, source, options)`).
2. `AudioEngine.seek(seconds)`; `player-app.ts` calls `engine.seek(0)` where it wrote `element.currentTime = 0`.
3. Lock screen and native auto-advance: the player passes `onNativeChange` to the engine and maps it to the deck event
   `{ type: 'sync', index, status: 'playing' | 'paused' | 'stopped' }` (`state.ts`), which moves a seated deck to
   native's track and play state with no calibration or spin-up, and sends nothing back to native. `loading` counts
   as playing, `ended` and `stopped` as stopped. The site's AudioEngine never calls it.
4. `bundles/lit/boot.ts` (the composition root): `cartridgeLoaded()` when the cartridge seats (the deck's `inserted`),
   `cartridgeEjected()` on `ejected`, `markUnwrapped()` when the packaging has left the frame (owner's copy only),
   haptics on the DS-32 beats (soft through the peel, success as the edition is revealed, rigid on insert and seat,
   light on a key press) via `PlayerOptions.onMoment`, `ready()` two frames after `mount()`, `wrapped: !context.unwrapped`
   (RACK-3), the LCD line from `context.lend` / the `ownership` event (`PLAYS 03`, `LEND ENDED`, `ON LOAN`, shown in
   place of NO DISC and flashed on seat), the edition stamped on the cartridge label (`edition-stamp.ts`), and rendering
   stopped on `lifecycle: background` (BRG-2).
5. `PlayerOptions.handoff: false` skips `playback-handoff.ts` (no stream URLs stored). The HUD's GET LIT calls
   `close()` for now (no purchase method in v1, §11); its SIGN IN link only appears for `signed-out` previews, which the
   bridge never produces.
6. `loadTracks()` reads a Convex `{ code }` or a `BridgeError.code` (`E_LEND_ENDED`, `E_NOT_ALLOWED`, `E_OFFLINE`).
   `player-app.ts` imports `ConvexError` from `convex/values` instead of `../convex`, so the bundle carries no Convex or
   Clerk client.

Still open: the wear renderer (the bundle ignores `context.wear` and the `wear` event until PRD §11.4's renderer
exists), and a purchase method for GET LIT.
