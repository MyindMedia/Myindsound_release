import { BridgeEmitter } from './emitter';
import { idleState, nextIndex, previousIndex, silentFrame } from './playback-rules';
import {
  BridgeError,
  LEND_COMMIT_AFTER_SEC,
  SPECTRUM_BANDS,
  WAVEFORM_SAMPLES,
  type BridgeContext,
  type BridgeEvent,
  type BridgeEventMap,
  type BridgeTrack,
  type HapticKind,
  type LayoutState,
  type LendState,
  type LendStatus,
  type LifecycleState,
  type MyindBridge,
  type Ownership,
  type PlaybackFrame,
  type PlaybackState,
  type Platform,
  type Unsubscribe,
  type WearDescriptor,
} from './types';
import { validateParams } from './validate';

export interface MockTrack {
  id: string;
  position: number;
  title: string;
  durationSeconds: number;
}

export interface MockBridgeOptions {
  ownership?: Ownership;
  releaseId?: string;
  /** Default 7 when owned or lent, null otherwise. */
  editionNumber?: number | null;
  /** Default "Mock Lender" when lent, null otherwise. */
  ownerDisplayName?: string | null;
  unwrapped?: boolean;
  wear?: WearDescriptor | null;
  layout?: LayoutState;
  platform?: Platform;
  /** Server epoch ms of the drop. Default 0: already live. */
  dropAt?: number;
  now?: () => number;
  tracks?: MockTrack[];
  /** Length of a preview, in seconds. */
  previewSeconds?: number;
  /**
   * The lend. Lent copies default to 10 plays over 7 days (PRD §12.2). On an owned copy an active lend means the
   * copy is out on loan, so the owner can't play it (LOCK_WHILE_LENT).
   */
  lend?: Partial<LendState>;
  /** Shorthand for `lend.playsAllowed`. */
  lentPlays?: number;
  /** How often frames are sent while playing. Default 33 ms (30 per second). */
  frameIntervalMs?: number;
  /** Simulated native round trip for every async call. */
  latencyMs?: number;
}

export const MOCK_TRACKS: readonly MockTrack[] = [
  { id: 'mock-1', position: 1, title: 'Mock One', durationSeconds: 180 },
  { id: 'mock-2', position: 2, title: 'Mock Two', durationSeconds: 200 },
  { id: 'mock-3', position: 3, title: 'Mock Three', durationSeconds: 160 },
];

export const MOCK_LAYOUT: LayoutState = { widthPt: 393, heightPt: 852, sizeClass: 'compact', posture: 'standard' };

export interface MockCall {
  method: string;
  params: Record<string, unknown>;
}

/**
 * A bridge for local dev and tests: configurable ownership and lends, fake playback that ticks and auto-advances
 * like native, synthetic spectrum frames, and helpers that fire layout, wear, lifecycle and ownership events. The
 * ownership policy here (who may unwrap, share, lend) is a stand-in; on device the server decides (ARCH-3). The
 * lend rules follow CONTRACT.md §7: a check on every play start, a play committed after 30 s of playback.
 */
export class MockBridge implements MyindBridge {
  readonly calls: MockCall[] = [];
  readonly stats = { loads: 0, ejects: 0 };
  private readonly emitter = new BridgeEmitter();
  private readonly now: () => number;
  private readonly frameIntervalMs: number;
  private readonly latencyMs: number;
  private readonly previewSeconds: number;
  private readonly allTracks: MockTrack[];
  private ownership: Ownership;
  private editionNumber: number | null;
  private ownerDisplayName: string | null;
  private unwrapped: boolean;
  private wear: WearDescriptor | null;
  private layout: LayoutState;
  private lifecycleState: LifecycleState = 'foreground';
  private lend: LendState | null;
  private readonly platform: Platform;
  private readonly releaseId: string;
  private readonly dropAt: number;
  private volume = 1;
  private state: PlaybackState = idleState();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTick = 0;
  private advancing = false;
  /** Seconds actually played since the current track start, and whether that start's lent play is committed. */
  private listened = 0;
  private committed = false;

  constructor(options: MockBridgeOptions = {}) {
    this.ownership = options.ownership ?? 'owned';
    const holds = this.ownership === 'owned' || this.ownership === 'lent';
    this.editionNumber = options.editionNumber !== undefined ? options.editionNumber : holds ? 7 : null;
    this.ownerDisplayName =
      options.ownerDisplayName !== undefined ? options.ownerDisplayName : this.ownership === 'lent' ? 'Mock Lender' : null;
    this.unwrapped = options.unwrapped ?? false;
    this.wear = options.wear ?? null;
    this.layout = options.layout ?? MOCK_LAYOUT;
    this.platform = options.platform ?? 'ios';
    this.releaseId = options.releaseId ?? 'lit';
    this.dropAt = options.dropAt ?? 0;
    this.now = options.now ?? Date.now;
    this.allTracks = (options.tracks ?? MOCK_TRACKS).map((track) => ({ ...track }));
    this.previewSeconds = options.previewSeconds ?? 30;
    this.frameIntervalMs = options.frameIntervalMs ?? 33;
    this.latencyMs = options.latencyMs ?? 0;
    this.lend =
      this.ownership === 'lent' || options.lend
        ? {
            playsAllowed: options.lentPlays ?? 10,
            playsUsed: 0,
            expiresAt: this.now() + 7 * 24 * 60 * 60_000,
            status: 'active',
            ...options.lend,
          }
        : null;
  }

  // ── Contract ──────────────────────────────────────────────────────────────────────────────────────────

  async getContext(): Promise<BridgeContext> {
    await this.record('getContext');
    return {
      releaseId: this.releaseId,
      ...this.ownershipPayload(),
      wear: this.wear,
      platform: this.platform,
      layout: { ...this.layout },
      lifecycle: this.lifecycleState,
      dropAt: this.dropAt,
      serverNow: this.now(),
    };
  }

  async getTracks(): Promise<BridgeTrack[]> {
    await this.record('getTracks');
    return this.tracks();
  }

  async play(trackId: string, startAt?: number): Promise<void> {
    const params = validateParams('play', startAt === undefined ? { trackId } : { trackId, startAt });
    await this.record('play', params);
    if (this.beforeDrop()) throw new BridgeError('E_NOT_ALLOWED', 'Release is not live yet', 'play');
    const tracks = this.tracks();
    const index = tracks.findIndex((track) => track.id === params.trackId);
    if (index < 0) throw new BridgeError('E_NOT_FOUND', 'Track is not in this release', 'play');
    if (params.startAt === undefined && this.state.trackId === params.trackId && this.state.status === 'paused') {
      this.checkLend(false);
      this.setState({ status: 'playing', rate: 1 });
      return;
    }
    this.start(tracks, index, params.startAt ?? 0);
  }

  async pause(): Promise<void> {
    await this.record('pause');
    if (this.state.status === 'playing') this.setState({ status: 'paused', rate: 0 });
  }

  async seek(seconds: number): Promise<void> {
    const params = validateParams('seek', { seconds });
    await this.record('seek', params);
    if (this.state.trackId === null) return;
    const positionSec = Math.min(params.seconds, this.state.durationSec ?? params.seconds);
    const status = this.state.status === 'ended' || this.state.status === 'stopped' ? 'paused' : this.state.status;
    this.setState({ positionSec, status });
  }

  async next(): Promise<void> {
    await this.record('next');
    const tracks = this.tracks();
    const index = nextIndex(tracks, this.currentIndex(tracks));
    if (index !== null) this.start(tracks, index, 0);
  }

  async previous(): Promise<void> {
    await this.record('previous');
    const tracks = this.tracks();
    const current = this.currentIndex(tracks);
    if (current < 0) return;
    this.start(tracks, previousIndex(current, this.state.positionSec), 0);
  }

  async getPlaybackState(): Promise<PlaybackState> {
    await this.record('getPlaybackState');
    this.advance();
    return { ...this.state };
  }

  async setVolume(volume: number): Promise<void> {
    const params = validateParams('setVolume', { volume });
    await this.record('setVolume', params);
    this.volume = params.volume;
  }

  async markUnwrapped(): Promise<void> {
    await this.record('markUnwrapped');
    if (this.ownership !== 'owned') throw new BridgeError('E_NOT_ALLOWED', 'Only the owner unwraps a copy', 'markUnwrapped');
    this.unwrapped = true;
  }

  async cartridgeLoaded(): Promise<void> {
    await this.record('cartridgeLoaded');
    if (this.holds()) this.stats.loads++;
  }

  async cartridgeEjected(): Promise<void> {
    await this.record('cartridgeEjected');
    if (this.holds()) this.stats.ejects++;
  }

  haptic(kind: HapticKind): void {
    this.calls.push({ method: 'haptic', params: validateParams('haptic', { kind }) });
  }

  playSound(name: string): void {
    this.calls.push({ method: 'playSound', params: validateParams('playSound', { name }) });
  }

  async requestShare(): Promise<void> {
    await this.record('requestShare');
    if (this.ownership !== 'owned') throw new BridgeError('E_NOT_ALLOWED', 'Only the owner shares a copy', 'requestShare');
  }

  async requestLend(): Promise<void> {
    await this.record('requestLend');
    if (this.ownership !== 'owned' || this.lend?.status === 'active') {
      throw new BridgeError('E_NOT_ALLOWED', 'Only the owner lends a copy, one lend at a time', 'requestLend');
    }
  }

  close(): void {
    this.calls.push({ method: 'close', params: {} });
    this.stopTimer();
  }

  ready(): void {
    this.calls.push({ method: 'ready', params: {} });
  }

  on<E extends BridgeEvent>(event: E, handler: (payload: BridgeEventMap[E]) => void): Unsubscribe {
    return this.emitter.on(event, handler);
  }

  // ── Test and dev helpers ──────────────────────────────────────────────────────────────────────────────

  get playback(): PlaybackState {
    this.advance();
    return { ...this.state };
  }

  get lendState(): LendState | null {
    return this.lend && { ...this.lend };
  }

  /** Plays left on the lend (DS-22 `PLAYS 03`), or null when there is no lend. */
  get playsRemaining(): number | null {
    return this.lend ? Math.max(0, this.lend.playsAllowed - this.lend.playsUsed) : null;
  }

  get currentVolume(): number {
    return this.volume;
  }

  listenerCount(event: BridgeEvent): number {
    return this.emitter.listenerCount(event);
  }

  setOwnership(ownership: Ownership, extra: { editionNumber?: number | null; ownerDisplayName?: string | null; lend?: LendState | null } = {}): void {
    this.ownership = ownership;
    if (extra.editionNumber !== undefined) this.editionNumber = extra.editionNumber;
    if (extra.ownerDisplayName !== undefined) this.ownerDisplayName = extra.ownerDisplayName;
    if (extra.lend !== undefined) this.lend = extra.lend && { ...extra.lend };
    if (ownership === 'locked' && this.state.status === 'playing') this.halt();
    this.emitter.emit('ownership', this.ownershipPayload());
  }

  /** The server ended the lend (returned, revoked, converted, or expiry noticed): native stops and tells the bundle. */
  endLend(status: Exclude<LendStatus, 'active'>, endReason?: string): void {
    if (!this.lend) throw new Error('No lend to end');
    this.lend = { ...this.lend, status, ...(endReason ? { endReason } : {}) };
    if (this.ownership === 'lent' && this.state.status === 'playing') this.halt();
    this.emitter.emit('ownership', this.ownershipPayload());
  }

  setLayout(layout: LayoutState): void {
    this.layout = { ...layout };
    this.emitter.emit('layout', { ...layout });
  }

  setWear(wear: WearDescriptor): void {
    this.wear = wear;
    this.emitter.emit('wear', wear);
  }

  lifecycle(state: LifecycleState): void {
    this.lifecycleState = state;
    this.emitter.emit('lifecycle', { state });
  }

  dispose(): void {
    this.stopTimer();
    this.emitter.clear();
  }

  // ── Internals ─────────────────────────────────────────────────────────────────────────────────────────

  private ownershipPayload() {
    return {
      ownership: this.ownership,
      editionNumber: this.editionNumber,
      ownerDisplayName: this.ownerDisplayName,
      unwrapped: this.unwrapped,
      ...(this.lend ? { lend: { ...this.lend } } : {}),
    };
  }

  private async record(method: string, params: Record<string, unknown> = {}): Promise<void> {
    this.calls.push({ method, params: { ...params } });
    if (this.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
  }

  private holds(): boolean {
    return this.ownership === 'owned' || this.ownership === 'lent';
  }

  private beforeDrop(): boolean {
    return this.ownership === 'locked' && this.now() < this.dropAt;
  }

  /** Owned and lent copies play the full songs; preview, and locked after the drop, play previews (PRD §3A). */
  private tracks(): BridgeTrack[] {
    if (this.beforeDrop()) return [];
    const preview = !this.holds();
    return this.allTracks.map((track) => ({
      ...track,
      durationSeconds: preview ? Math.min(track.durationSeconds, this.previewSeconds) : track.durationSeconds,
      preview,
    }));
  }

  private currentIndex(tracks: BridgeTrack[]): number {
    return tracks.findIndex((track) => track.id === this.state.trackId);
  }

  /**
   * `startLentPlay` (LEND-5), run before every play start, auto-advance and restart included, and before a resume.
   * A failed check ends the lend: stop, a `stopped` frame, then `ownership` with the ended lend.
   */
  private checkLend(isStart: boolean): void {
    const lend = this.lend;
    if (!lend) return;
    if (this.ownership === 'owned') {
      if (lend.status === 'active') throw new BridgeError('E_NOT_ALLOWED', 'This copy is out on loan', 'play');
      return;
    }
    if (this.ownership !== 'lent') return;
    let ended: LendStatus | null = lend.status === 'active' ? null : lend.status;
    if (!ended && this.now() >= lend.expiresAt) ended = 'expired';
    if (!ended && isStart && lend.playsUsed >= lend.playsAllowed) ended = 'exhausted';
    if (!ended) return;
    if (lend.status === 'active') this.endLend(ended as Exclude<LendStatus, 'active'>);
    else if (this.state.status === 'playing') this.halt();
    throw new BridgeError('E_LEND_ENDED', `The lend has ended (${ended})`, 'play');
  }

  private start(tracks: BridgeTrack[], index: number, startAt: number, advanceFirst = true): void {
    this.checkLend(true);
    const track = tracks[index];
    this.listened = 0;
    this.committed = false;
    const patch = {
      trackId: track.id,
      status: 'playing' as const,
      positionSec: Math.min(startAt, track.durationSeconds),
      durationSec: track.durationSeconds,
      rate: 1,
    };
    if (advanceFirst) this.setState(patch);
    else this.apply(patch);
  }

  /** Native stops on its own: rewound, `stopped`, needs an explicit play. */
  private halt(): void {
    this.setState({ status: 'stopped', positionSec: 0, rate: 0 });
  }

  private setState(patch: Partial<PlaybackState>): void {
    this.advance();
    this.apply(patch);
  }

  /** Commits a change without advancing first (advance itself transitions through here, so it can't recurse). */
  private apply(patch: Partial<PlaybackState>): void {
    this.state = { ...this.state, ...patch };
    this.lastTick = this.now();
    if (this.state.status === 'playing') this.startTimer();
    else this.stopTimer();
    this.emitter.emit('playback', this.frame());
  }

  /** Moves the position on by the time elapsed; commits a lent play at 30 s; at the end of a track, moves on. */
  private advance(): void {
    // Transitions below call back into setState; the position is already committed by then.
    if (this.advancing) return;
    const at = this.now();
    if (this.state.status !== 'playing') {
      this.lastTick = at;
      return;
    }
    const elapsed = ((at - this.lastTick) / 1000) * this.state.rate;
    const duration = this.state.durationSec ?? Infinity;
    const positionSec = this.state.positionSec + elapsed;
    this.lastTick = at;
    this.listened += Math.min(elapsed, Math.max(0, duration - this.state.positionSec));
    if (this.ownership === 'lent' && this.lend && !this.committed && this.listened >= LEND_COMMIT_AFTER_SEC) {
      this.committed = true;
      this.lend = { ...this.lend, playsUsed: this.lend.playsUsed + 1 };
    }
    if (positionSec < duration) {
      this.state = { ...this.state, positionSec };
      return;
    }
    this.state = { ...this.state, positionSec: duration };
    this.advancing = true;
    try {
      this.finishTrack();
    } finally {
      this.advancing = false;
    }
  }

  private finishTrack(): void {
    const tracks = this.tracks();
    const index = nextIndex(tracks, this.currentIndex(tracks));
    if (index !== null) {
      try {
        this.start(tracks, index, 0, false);
      } catch (err) {
        // The lend check failed: it already stopped and told the bundle.
        if (!(err instanceof BridgeError)) throw err;
      }
      return;
    }
    this.apply({ status: 'ended', positionSec: this.state.durationSec ?? this.state.positionSec, rate: 0 });
  }

  private tick = (): void => {
    const before = this.state;
    this.advance();
    // A track change or the end already sent its own frame.
    if (this.state.status === 'playing' && this.state.trackId === before.trackId) this.emitter.emit('playback', this.frame());
  };

  private startTimer(): void {
    if (this.timer === null) this.timer = setInterval(this.tick, this.frameIntervalMs);
  }

  private stopTimer(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Synthetic but deterministic: a function of the position, so tests can assert on it. */
  private frame(): PlaybackFrame {
    if (this.state.status !== 'playing') return silentFrame(this.state);
    const t = this.state.positionSec;
    const bands = Array.from({ length: SPECTRUM_BANDS }, (_, i) => {
      const falloff = 1 - i / (SPECTRUM_BANDS * 1.25);
      return Math.max(0, Math.min(1, falloff * (0.45 + 0.35 * Math.sin(t * 2.1 + i * 0.7))));
    });
    const waveform = Array.from({ length: WAVEFORM_SAMPLES }, (_, i) => 0.4 * Math.sin((i / WAVEFORM_SAMPLES) * 22 + t * 9));
    return {
      ...this.state,
      bands,
      waveform,
      level: 0.3 + 0.1 * Math.sin(t * 5),
      bass: 0.35 + 0.3 * Math.max(0, Math.sin(t * Math.PI * 3)),
    };
  }
}
