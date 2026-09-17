import { DirectionalLight, HemisphereLight, PointLight } from 'three';
import { convexErrorCode } from '../convex';
import { refreshDelayMs } from './audio-math';
import { AudioEngine } from './audio-engine';
import { createStudioEnvironment } from './cartridge-detail';
import { ComicCity } from './backdrop';
import { Deck } from './deck';
import { DISC_SOUNDS, DiscMechanics } from './disc-sounds';
import { DiscHalo } from './halo';
import { Hud } from './hud';
import { PLAY_RPM, runEjectSequence, runFloatInSequence, runInsertSequence } from './insert-sequence';
import { CartridgeInspector } from './inspect';
import { KeyController, type KeyCommand } from './keys';
import { PlayerScene } from './scene';
import { initialState, keyLatches, reduce, type DeckEvent, type DeckState } from './state';
import { loadDeckTextures } from './textures';
import type { PlayerTrack, TrackSource } from './track-source';

const PLAY_LOG_AFTER_SEC = 30;
const MIN_CALIBRATION_MS = 2000;
const SEEK_RPM_FRACTION = 0.35;
const IDLE_THROTTLE_MS = 10_000;
const VOLUME_KEY = 'myind:player-volume';

function hasWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

function storedVolume(): number {
  try {
    const value = Number(localStorage.getItem(VOLUME_KEY));
    return Number.isFinite(value) && value > 0 && value <= 1 ? value : 0.8;
  } catch {
    return 0.8;
  }
}

/** Composition root: state machine → audio, 3D deck, keys and HUD. */
export class PlayerApp {
  private readonly root: HTMLElement;
  private readonly source: TrackSource;
  private state: DeckState = initialState();
  private hud!: Hud;
  private engine!: AudioEngine;
  /** Drive sounds: spin-up, spinning loop, spin-down (fetched now, decoded once audio unlocks). */
  private readonly mechanics = new DiscMechanics();
  private keys!: KeyController;
  private scene: PlayerScene | null = null;
  private deck: Deck | null = null;
  private halo: DiscHalo | null = null;
  private inspector: CartridgeInspector | null = null;
  private city: ComicCity | null = null;
  private accentLights: { light: PointLight; intensity: number }[] = [];
  private tracks: PlayerTrack[] = [];
  private expiresAt = 0;
  private refreshTimer = 0;
  private listenedSec = 0;
  private playLogged = false;
  private mediaRetries = 0;
  private seekTimer = 0;
  private lastInput = performance.now();
  private started = false;
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor(root: HTMLElement, source: TrackSource) {
    this.root = root;
    this.source = source;
  }

  async mount(): Promise<void> {
    this.hud = new Hud(this.root, {
      onSelect: (index) => this.dispatch({ type: 'select', index }),
      onInsert: () => this.command('insert'),
      onRepeat: () => this.command('repeat'),
      onVolume: (value) => this.setVolume(value),
      onRetry: () => void this.loadTracks(),
    });
    this.engine = new AudioEngine({
      onTime: (seconds) => this.dispatch({ type: 'tick', positionSec: seconds }),
      onEnded: () => {
        this.logPlayOnce();
        this.dispatch({ type: 'trackEnded' });
      },
      onError: () => void this.recoverFromMediaError(),
    });
    const volume = storedVolume();
    this.engine.setVolume(volume);
    this.mechanics.setVolume(volume);
    this.hud.setVolume(volume);

    const sceneReady = hasWebGL() ? this.initScene().catch((err) => this.initFallback(err)) : this.initFallback();
    await Promise.all([sceneReady, this.loadTracks()]);

    this.keys = new KeyController({
      deck: this.deck,
      scene: this.scene,
      canvas: this.scene ? this.hud.canvas : null,
      buttonsHost: this.hud.keysHost,
      onCommand: (command) => this.command(command),
    });
    this.keys.setLatches(keyLatches(this.state));
    this.hud.setBootProgress(1);
    this.hud.hideBoot();
    if (this.scene) this.scene.start();
    else this.startFallbackLoop();
    for (const type of ['pointerdown', 'pointermove', 'wheel', 'keydown']) {
      window.addEventListener(type, () => (this.lastInput = performance.now()), { passive: true });
    }
    this.started = true;
    if (this.state.status === 'ejected') this.presentFloating();
  }

  /** Page open (or a retry that loads the tracks): the cartridge floats in front of the empty deck. */
  private presentFloating(): void {
    this.keys?.setInspecting(true);
    this.scene?.setTiltEnabled(false);
    if (!this.deck || !this.scene || !this.inspector) return;
    runFloatInSequence(this.deck, this.scene, this.inspector);
    this.inspector.activate();
  }

  private async initScene(): Promise<void> {
    const scene = new PlayerScene(this.hud.canvas, this.hud.frame, this.reducedMotion);
    const textures = await loadDeckTextures(scene.renderer.capabilities.getMaxAnisotropy(), (ratio) =>
      this.hud.setBootProgress(ratio * 0.9),
    );
    const deck = new Deck(textures, {
      reducedMotion: this.reducedMotion,
      environment: createStudioEnvironment(scene.renderer),
      quality: scene.coarsePointer ? 'low' : 'high',
    });
    deck.setCartridgeVisible(false);
    scene.deckRoot.add(deck.group);
    const disc = deck.discAnchor();
    const halo = new DiscHalo(disc.centre, disc.edge.x - disc.centre.x, { reducedMotion: this.reducedMotion });
    deck.group.add(halo.mesh);
    this.halo = halo;
    scene.setDeckBounds(deck.bounds);

    const city = new ComicCity({
      reducedMotion: this.reducedMotion,
      coarsePointer: scene.coarsePointer,
      pixelRatio: scene.renderer.getPixelRatio(),
    });
    scene.scene.add(city.group);
    await city.attach(scene.camera);
    scene.onResize(() => city.fit(scene.camera));

    const key = new DirectionalLight('#ffffff', 1.6);
    key.position.set(1.5, 2.5, 4);
    const pink = new PointLight('#FF3DA8', 6, 9, 1.6);
    pink.position.set(-2.2, 0.4, 1.6);
    const ice = new PointLight('#9FD8FF', 4, 9, 1.6);
    ice.position.set(2.2, -0.6, 1.4);
    scene.scene.add(new HemisphereLight('#9FD8FF', '#1a0a14', 0.9), key, pink, ice);
    this.accentLights = [pink, ice].map((light) => ({ light, intensity: light.intensity }));

    this.inspector = new CartridgeInspector({
      scene,
      deck,
      canvas: this.hud.canvas,
      stageElement: this.hud.stage,
      reducedMotion: this.reducedMotion,
      onInsert: () => this.command('insert'),
    });

    this.scene = scene;
    this.deck = deck;
    this.city = city;
    scene.onFrame((dt, elapsed) => this.onFrame(dt, elapsed));
  }

  private initFallback(err?: unknown): void {
    if (err) console.error('3D deck unavailable, using the static deck:', err);
    this.scene?.stop();
    this.scene = null;
    this.deck = null;
    this.root.classList.add('p3d--fallback');
    const image = document.createElement('img');
    image.className = 'p3d-fallback-deck';
    image.src = '/assets/images/minidisc/fallback-deck.webp';
    image.alt = 'Myind Sound MiniDisc player';
    this.hud.frame.replaceChildren(image);
  }

  private startFallbackLoop(): void {
    let last = performance.now();
    const loop = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const rect = this.hud.frame.getBoundingClientRect();
      const centre = { x: rect.left + rect.width / 2, y: rect.top + rect.height * 0.36 };
      this.hud.anchor({ x: centre.x, y: rect.top + 8 }, { ...centre, r: rect.height * 0.22 });
      this.renderHud(dt);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  private onFrame(dt: number, elapsed: number): void {
    const scene = this.scene!;
    const deck = this.deck!;
    this.city?.setAudio({ bass: this.engine.bass(), level: this.engine.level() });
    this.city?.update(dt, elapsed);
    this.keys?.update();
    deck.update(dt);
    this.halo?.update(dt, elapsed, deck.getDiscRpm() / PLAY_RPM);
    this.mechanics.setSpeed(deck.getDiscRpm() / PLAY_RPM);
    this.inspector?.update(dt, elapsed);
    // The neon accents sit near the floating cartridge and would blow out its edges.
    const presence = this.inspector?.getPresence() ?? 0;
    for (const accent of this.accentLights) accent.light.intensity = accent.intensity * (1 - 0.75 * presence);

    const slot = scene.project(deck.slotAnchor());
    const disc = deck.discAnchor();
    const centre = scene.project(disc.centre);
    const edge = scene.project(disc.edge);
    this.hud.anchor(slot, { x: centre.x, y: centre.y, r: Math.hypot(edge.x - centre.x, edge.y - centre.y) });
    if (!this.reducedMotion) {
      const tilt = scene.getTilt();
      this.hud.setTilt(tilt.yaw, tilt.pitch);
      this.city?.setParallax(tilt.yaw, tilt.pitch);
    }
    scene.setIdleThrottle(this.state.status === 'ejected' && performance.now() - this.lastInput > IDLE_THROTTLE_MS);
    this.renderHud(dt);
  }

  private renderHud(dt: number): void {
    if (this.state.status === 'playing' && this.engine.isPlaying) {
      this.listenedSec += dt;
      if (this.listenedSec >= PLAY_LOG_AFTER_SEC) this.logPlayOnce();
    }
    this.hud.render(
      {
        state: this.state,
        track: this.currentTrack(),
        rpm: this.deck ? this.deck.getDiscRpm() : this.state.status === 'playing' ? PLAY_RPM : 0,
        level: this.engine.level(),
        spectrum: this.engine.spectrum(32),
        waveform: this.engine.waveform(96),
        simulated: this.engine.simulated,
        volume: this.engine.getVolume(),
      },
    );
  }

  private currentTrack(): PlayerTrack | null {
    return this.tracks[this.state.trackIndex] ?? null;
  }

  private async loadTracks(): Promise<void> {
    try {
      const list = await this.source.list();
      if (list.tracks.length === 0) throw new Error('No tracks');
      this.tracks = list.tracks;
      this.expiresAt = list.expiresAt;
      this.hud.setTracks(list.tracks);
      this.hud.clearError();
      await this.engine.probe(list.tracks[0].streamUrl);
      this.engine.load(list.tracks[this.state.trackIndex]?.streamUrl ?? list.tracks[0].streamUrl);
      this.dispatch({ type: 'loaded', trackCount: list.tracks.length });
      this.scheduleRefresh();
    } catch (err) {
      const code = convexErrorCode(err);
      if (code === 'UNAUTHENTICATED') {
        window.location.href = `/login.html?redirect=${encodeURIComponent('/stream.html')}`;
        return;
      }
      if (code === 'NOT_ENTITLED') this.hud.showError('NO LICENSE FOUND FOR LIT', { label: 'GET LIT', href: '/' });
      else if (code === 'NOT_CONFIGURED') this.hud.showError('AUDIO OFFLINE · TRY AGAIN SOON', { label: 'RETRY' });
      else this.hud.showError('SIGNAL LOST · CHECK YOUR CONNECTION', { label: 'RETRY' });
      console.error('Track list failed:', code ?? err);
    }
  }

  private scheduleRefresh(): void {
    window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => void this.refreshLinks(), refreshDelayMs(this.expiresAt, Date.now()));
  }

  /** New signed links; the playing element keeps its current source until the next load. */
  private async refreshLinks(): Promise<boolean> {
    try {
      const list = await this.source.list();
      const byId = new Map(list.tracks.map((track) => [track.id, track.streamUrl]));
      this.tracks = this.tracks.map((track) => ({ ...track, streamUrl: byId.get(track.id) ?? track.streamUrl }));
      this.expiresAt = list.expiresAt;
      this.scheduleRefresh();
      return true;
    } catch (err) {
      console.error('Link refresh failed:', convexErrorCode(err) ?? err);
      this.refreshTimer = window.setTimeout(() => void this.refreshLinks(), 30_000);
      return false;
    }
  }

  private async recoverFromMediaError(): Promise<void> {
    const track = this.currentTrack();
    const status = this.state.status;
    if (!track || status === 'booting' || status === 'ejecting' || status === 'ejected') return;
    if (this.mediaRetries < 2 && (await this.refreshLinks())) {
      this.mediaRetries++;
      const resumeAt = this.engine.currentTime;
      this.engine.load(this.currentTrack()!.streamUrl, resumeAt);
      if (this.state.status === 'playing') void this.engine.play();
      return;
    }
    this.mediaRetries = 0;
    this.hud.flashStatus('READ ERROR');
    this.dispatch({ type: 'next' });
  }

  private setVolume(value: number): void {
    this.engine.setVolume(value);
    this.mechanics.setVolume(value);
    try {
      localStorage.setItem(VOLUME_KEY, String(value));
    } catch {
      /* Private mode: volume just isn't remembered. */
    }
  }

  private command(command: KeyCommand): void {
    this.lastInput = performance.now();
    const status = this.state.status;
    switch (command) {
      case 'insert':
        this.dispatch({ type: 'insert' });
        return;
      case 'toggle':
        if (status === 'playing') this.dispatch({ type: 'pause' });
        else if (status === 'ejected') this.dispatch({ type: 'insert' });
        else this.dispatch({ type: 'play' });
        return;
      case 'play':
        this.dispatch({ type: 'play' });
        return;
      case 'pause':
        this.dispatch({ type: 'pause' });
        return;
      case 'stop':
        this.dispatch({ type: 'stop' });
        return;
      case 'prev':
        this.dispatch({ type: 'prev' });
        return;
      case 'next':
        this.dispatch({ type: 'next' });
        return;
      case 'red':
        this.dispatch({ type: 'eject' });
        return;
      case 'repeat':
        this.dispatch({ type: 'toggleRepeat' });
        return;
    }
  }

  /** Runs synchronously so audio unlock happens inside the user's gesture. */
  private dispatch(event: DeckEvent): void {
    const prev = this.state;
    const next = reduce(prev, event);
    if (next === prev) return;
    this.state = next;
    if (event.type !== 'tick') {
      this.applyEffects(prev, next, event);
      this.keys?.setLatches(keyLatches(next));
    }
  }

  private applyEffects(prev: DeckState, next: DeckState, event: DeckEvent): void {
    const track = this.tracks[next.trackIndex];

    // Red key: fade out, spin down, and hand the cartridge to the inspector.
    if (next.status === 'ejecting' && prev.status !== 'ejecting') {
      window.clearTimeout(this.seekTimer);
      this.halo?.hide();
      this.engine.fadeOutAndStop(0.35);
      if ((this.deck?.getDiscRpm() ?? 0) > 5) this.mechanics.spinDown();
      this.resetListen();
      this.keys?.setInspecting(true);
      this.scene?.setTiltEnabled(false);
      if (this.deck && this.scene && this.inspector) {
        runEjectSequence(this.deck, this.scene, this.inspector, {
          onEjected: () => this.dispatch({ type: 'ejected' }),
        });
      } else {
        this.dispatch({ type: 'ejected' });
      }
      return;
    }
    if (next.status === 'ejected') {
      if (prev.status === 'ejecting') this.inspector?.activate();
      else if (this.started) this.presentFloating();
      return;
    }

    if (prev.status === 'ejected' && next.status === 'inserting') {
      if (track) this.engine.load(track.streamUrl);
      this.engine.unlock();
      this.mechanics.attach(this.engine.context);
      this.resetListen();
      this.halo?.boot();
      this.inspector?.release();
      this.keys?.setInspecting(false);
      this.scene?.setTiltEnabled(true);
      if (this.deck && this.scene) {
        runInsertSequence(this.deck, this.scene, {
          onInserted: () => this.dispatch({ type: 'inserted' }),
          onSpinUp: () => this.mechanics.spinUp(),
          onReady: () => this.dispatch({ type: 'ready' }),
        });
      } else {
        this.mechanics.spinUp();
        this.dispatch({ type: 'inserted' });
        this.dispatch({ type: 'ready' });
      }
      return;
    }

    // Track selection: pause, recalibrate the laser (sound, halo, disc dip) for at least 2 s, then play.
    if (next.status === 'seeking' && (prev.status !== 'seeking' || next.trackIndex !== prev.trackIndex)) {
      window.clearTimeout(this.seekTimer);
      this.engine.pause();
      this.resetListen();
      this.mediaRetries = 0;
      if (track) this.engine.load(track.streamUrl);
      const waitMs = Math.max(MIN_CALIBRATION_MS, this.engine.playCalibration() * 1000);
      this.halo?.boot(waitMs / 1000);
      // Picked while paused or stopped: the disc was still, so the motor starts again under the calibration.
      if ((this.deck?.getDiscRpm() ?? PLAY_RPM) < 5) this.mechanics.spinUp(DISC_SOUNDS.spinUp.resumeFrom);
      this.deck?.setDiscRpm(PLAY_RPM * SEEK_RPM_FRACTION);
      const index = next.trackIndex;
      const stillSeeking = () => this.state.status === 'seeking' && this.state.trackIndex === index;
      this.seekTimer = window.setTimeout(() => {
        if (!stillSeeking()) return;
        this.deck?.setDiscRpm(PLAY_RPM);
        this.seekTimer = window.setTimeout(() => stillSeeking() && this.dispatch({ type: 'seeked' }), 800);
      }, waitMs - 800);
      return;
    }
    if (prev.status === 'seeking' && next.status !== 'seeking') {
      window.clearTimeout(this.seekTimer);
      if (next.status === 'playing') {
        this.halo?.dissipate();
        void this.engine.play();
        this.engine.fadeIn(0.5);
        this.deck?.setDiscRpm(PLAY_RPM);
      } else {
        this.halo?.hide();
        if (next.status === 'stopped') this.engine.stop();
        this.spinDownDisc();
      }
      return;
    }

    const trackChanged = next.trackIndex !== prev.trackIndex;
    const restarted =
      !trackChanged && next.positionSec === 0 && ['prev', 'select', 'trackEnded'].includes(event.type);
    if ((trackChanged || restarted) && track && next.status !== 'inserting') {
      this.resetListen();
      this.mediaRetries = 0;
      if (trackChanged) this.engine.load(track.streamUrl);
      else this.engine.element.currentTime = 0;
    }

    if (next.status === 'playing' && (prev.status !== 'playing' || trackChanged || restarted)) {
      if (prev.status === 'reading') {
        this.halo?.dissipate();
        this.keys?.press('play');
        void this.engine.play();
        this.engine.fadeIn(0.6);
      } else {
        void this.engine.play();
        if (prev.status !== 'playing') this.engine.setVolume(this.engine.getVolume());
      }
      // After the insert, the spin-up curve is already finishing; a resume spins the still disc back up.
      if (prev.status === 'paused' || prev.status === 'stopped') this.spinUpDisc();
      else if (prev.status !== 'reading') this.deck?.setDiscRpm(PLAY_RPM);
    } else if (next.status === 'paused' && prev.status !== 'paused') {
      this.engine.pause();
      this.spinDownDisc();
    } else if (next.status === 'stopped' && prev.status !== 'stopped') {
      this.engine.stop();
      this.spinDownDisc();
    }
  }

  /** Pause, stop or the end of the album: the disc winds down with the spin-down sound. */
  private spinDownDisc(): void {
    const rpm = this.deck?.getDiscRpm() ?? 0;
    if (rpm <= 5) {
      this.deck?.setDiscRpm(0);
      return;
    }
    this.deck?.playRpmCurve(DISC_SOUNDS.spinDown.rpm, rpm);
    this.mechanics.spinDown();
  }

  /** Resuming a loaded disc: spin-up without the loading clunks; the music starts straight away. */
  private spinUpDisc(): void {
    const from = DISC_SOUNDS.spinUp.resumeFrom;
    this.deck?.playRpmCurve(DISC_SOUNDS.spinUp.rpm, PLAY_RPM, from);
    this.mechanics.spinUp(from);
  }

  private resetListen(): void {
    this.listenedSec = 0;
    this.playLogged = false;
  }

  private logPlayOnce(): void {
    const track = this.currentTrack();
    if (this.playLogged || !track) return;
    this.playLogged = true;
    this.source.logPlay(track.id).catch((err) => console.warn('Play log failed:', convexErrorCode(err) ?? err));
  }
}
