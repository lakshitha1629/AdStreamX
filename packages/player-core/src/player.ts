import type {
  Capabilities,
  ExtensionEventName,
  MediaSourceConfig,
  PlayerConfig,
  PlayerConfigInput,
  PlayerErrorCode,
  PlayerErrorInfo,
  PlayerEventMap,
  PlayerState,
  StreamType,
  TrackInfo,
  Unsubscribe,
} from '@adstreamx/shared-types';
import type { AdapterSignal, PlaybackAdapter, PlaybackAdapterFactory } from './adapter.ts';
import { backoffDelay } from './backoff.ts';
import { detectCapabilities } from './capabilities.ts';
import { resolveConfig } from './config.ts';
import { TypedEmitter } from './emitter.ts';
import { AdStreamXError, classifyMediaErrorCode, makeError, MEDIA_ERR } from './errors.ts';
import { catchUpDecision, clampDvrSeek, computeLiveInfo, estimateLiveInfo, lastRange, liveEdgeTarget } from './live.ts';
import { probeSource } from './probe.ts';
import { sourceKind, validateSource, type SourceKind } from './source.ts';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface PlayerCoreOptions {
  adapters: PlaybackAdapterFactory[];
  /** Element used for fullscreen (defaults to the video's parent). */
  fullscreenElement?: HTMLElement;
  fetch?: FetchLike;
  random?: () => number;
  now?: () => number;
  baseUrl?: string;
}

const EXTENSION_EVENTS: ReadonlySet<string> = new Set<ExtensionEventName>([
  'adbreakstart', 'adbreakend', 'adrequest', 'adloaded', 'adstarted', 'adquartile', 'adcompleted', 'adskipped', 'aderror',
  'overlayshown', 'overlayclosed', 'overlayclicked',
  'polldisplayed', 'voteaccepted', 'pollresultsupdated',
  'commandreceived', 'commandapplied', 'commandrejected', 'announcement',
  'analyticsflush', 'pluginregistered',
]);

const INITIAL_STATE: PlayerState = {
  status: 'idle',
  engine: null,
  source: null,
  sourceIndex: 0,
  streamType: null,
  currentTime: 0,
  duration: 0,
  bufferedEnd: 0,
  paused: true,
  ended: false,
  seeking: false,
  buffering: false,
  volume: 1,
  muted: false,
  playbackRate: 1,
  live: null,
  qualityLevels: [],
  qualitySelection: 'auto',
  currentQuality: null,
  videoWidth: 0,
  videoHeight: 0,
  textTracks: [],
  audioTracks: [],
  fullscreen: false,
  pictureInPicture: false,
  theater: false,
  retryAttempt: 0,
  error: null,
  startupTimeMs: null,
};

/** A retry counter resets only after this much uninterrupted playback, so a stream that
 *  fails every few seconds cannot loop forever. */
const STABLE_PLAYBACK_RESET_S = 5;
const MIN_CATCHUP_SEEK_INTERVAL_MS = 5000;
/** Without DVR, catching up means re-joining the stream; never more often than this. */
const MIN_LIVE_REJOIN_INTERVAL_MS = 15000;

/**
 * Engine-agnostic player orchestrator: owns state, lifecycle, recovery and live logic for
 * one <video> element. Multiple instances on one page share nothing.
 */
export class PlayerCore {
  readonly video: HTMLVideoElement;
  private readonly emitter = new TypedEmitter<PlayerEventMap>();
  private readonly opts: PlayerCoreOptions;
  private readonly now: () => number;
  private readonly caps: Capabilities;
  private config: PlayerConfig;
  private state: PlayerState = { ...INITIAL_STATE };

  private adapter: PlaybackAdapter | null = null;
  private adapterId: string | null = null;
  private sources: MediaSourceConfig[] = [];
  private sourceIndex = 0;
  private attempt = 0;
  private loadToken = 0;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private probeCtrl: AbortController | null = null;
  private cleanup: (() => void)[] = [];
  private trackEls: HTMLTrackElement[] = [];

  private metadataLoaded = false;
  private hasPlayed = false;
  private playedThisLoad = false;
  private recovering = false;
  private transitioning = false;
  private wantPlaying = false;
  private resumeTime: number | null = null;
  private loadStartedAt = 0;
  private bufferingSince: number | null = null;
  private stableFrom: number | null = null;
  private followingLive = true;
  private lastCatchUpSeek = 0;
  private lastLatencyEmitted = -1;
  /** Join point for estimated live latency (engines without a seekable window). */
  private liveJoin: { wallMs: number; media: number; ahead: number } | null = null;
  private destroyed = false;
  private firstLoad = true;

  private readyResolved = false;
  private readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (e: unknown) => void;
  private pendingLoads = new Map<number, { resolve: () => void; reject: (e: unknown) => void }>();

  constructor(video: HTMLVideoElement, config: PlayerConfigInput = {}, opts: PlayerCoreOptions) {
    this.video = video;
    this.opts = opts;
    this.now = opts.now ?? (() => Date.now());
    this.config = resolveConfig(config);
    this.caps = detectCapabilities(opts.adapters.map((a) => a.id), video.ownerDocument);
    this.readyPromise = new Promise<void>((res, rej) => {
      this.resolveReady = () => {
        this.readyResolved = true;
        res();
      };
      this.rejectReady = rej;
    });
    this.readyPromise.catch(() => undefined); // never an unhandled rejection
    this.bindMediaEvents();
    this.applyStaticConfig();
    this.setState({ volume: video.volume, muted: video.muted });
    if (this.config.source) {
      this.sources = [this.config.source, ...this.config.fallbackSources];
      this.loadIndex(0);
    } else {
      this.resolveReady();
    }
  }

  // ---------------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------------
  on<K extends keyof PlayerEventMap>(event: K, fn: (p: PlayerEventMap[K]) => void): Unsubscribe {
    return this.emitter.on(event, fn);
  }
  once<K extends keyof PlayerEventMap>(event: K, fn: (p: PlayerEventMap[K]) => void): Unsubscribe {
    return this.emitter.once(event, fn);
  }
  listenerCount(): number {
    return this.emitter.listenerCount();
  }

  /**
   * Emit an extension event (ads, overlays, polls, commands, analytics, plugins).
   * Core playback events cannot be forged through this path.
   */
  emitExtension<K extends ExtensionEventName>(event: K, payload: PlayerEventMap[K]): void {
    if (this.destroyed || !EXTENSION_EVENTS.has(event)) return;
    this.emitter.emit(event, payload);
  }

  /** Resolves once the initial source has metadata (or immediately when there is no source). */
  ready(): Promise<void> {
    return this.readyPromise;
  }

  getState(): PlayerState {
    const s = this.state;
    return {
      ...s,
      live: s.live ? { ...s.live } : null,
      qualityLevels: s.qualityLevels.map((q) => ({ ...q })),
      textTracks: s.textTracks.map((t) => ({ ...t })),
      audioTracks: s.audioTracks.map((t) => ({ ...t })),
      source: s.source ? { ...s.source } : null,
      error: s.error ? { ...s.error } : null,
    };
  }

  getConfig(): PlayerConfig {
    return structuredClone(this.config);
  }

  getCapabilities(): Capabilities {
    return { ...this.caps, engines: [...this.caps.engines] };
  }

  updateConfig(patch: PlayerConfigInput): PlayerConfig {
    this.assertAlive();
    const { source, fallbackSources, ...rest } = patch;
    this.config = resolveConfig(rest, this.config);
    if (fallbackSources) this.config.fallbackSources = resolveConfig({ fallbackSources }, this.config).fallbackSources;
    this.applyStaticConfig();
    this.emitter.emit('configupdated', { config: this.getConfig() });
    if (source) void this.setSource(source as MediaSourceConfig).catch(() => undefined);
    return this.getConfig();
  }

  async play(): Promise<void> {
    this.assertAlive();
    return this.playInternal(false);
  }

  pause(): void {
    this.assertAlive();
    this.wantPlaying = false;
    this.video.pause();
  }

  seekTo(seconds: number): void {
    this.assertAlive();
    if (!Number.isFinite(seconds)) return;
    if (!this.metadataLoaded) {
      this.resumeTime = Math.max(0, seconds);
      return;
    }
    const live = this.state.streamType === 'live' ? this.readLive() : null;
    let target: number;
    if (this.state.streamType === 'live' && (!live || !live.dvr)) return; // no DVR window to seek in
    if (live) {
      target = clampDvrSeek(seconds, live.seekableStart, live.seekableEnd);
      this.followingLive = live.seekableEnd - target <= this.config.live.liveEdgeOffset + this.config.live.liveEdgeTolerance;
      if (this.video.playbackRate !== 1) this.video.playbackRate = 1;
    } else {
      const d = this.video.duration;
      target = Math.max(0, Number.isFinite(d) ? Math.min(seconds, Math.max(0, d - 0.05)) : seconds);
    }
    this.video.currentTime = target;
  }

  /** Jump to the live edge (minus liveEdgeOffset) and resume following live. */
  goLive(): boolean {
    this.assertAlive();
    if (this.state.streamType !== 'live') return false;
    const live = this.readLive();
    if (!live) return false;
    this.followingLive = true;
    this.video.playbackRate = 1;
    if (!live.dvr) {
      if (!live.atLiveEdge) this.rejoinLive();
      else if (this.video.paused) void this.playInternal(false).catch(() => undefined);
      return true;
    }
    this.video.currentTime = liveEdgeTarget(live.seekableStart, live.seekableEnd, this.config.live.liveEdgeOffset);
    if (this.video.paused) void this.playInternal(false).catch(() => undefined);
    return true;
  }

  setVolume(v: number): void {
    this.assertAlive();
    if (!Number.isFinite(v)) return;
    this.video.volume = Math.min(1, Math.max(0, v));
    if (this.video.volume > 0 && this.video.muted) this.video.muted = false;
  }

  setMuted(m: boolean): void {
    this.assertAlive();
    this.video.muted = !!m;
  }

  /** Playback speed is a VOD feature; live uses rate only for latency catch-up. */
  setPlaybackRate(rate: number): boolean {
    this.assertAlive();
    if (this.state.streamType !== 'vod' || !Number.isFinite(rate)) return false;
    this.video.playbackRate = Math.min(4, Math.max(0.25, rate));
    return true;
  }

  setQuality(id: string): boolean {
    this.assertAlive();
    if (!this.adapter) return false;
    const ok = this.adapter.setQuality(id);
    if (ok) {
      this.setState({ qualitySelection: id, currentQuality: this.adapter.getCurrentQuality() });
      this.emitter.emit('qualitychange', { selection: id, current: this.state.currentQuality });
    }
    return ok;
  }

  /** Show a text track by id, or hide all with null. */
  setTextTrack(id: string | null): boolean {
    this.assertAlive();
    const list = this.video.textTracks;
    let found = id === null;
    for (let i = 0; i < list.length; i++) {
      const t = list[i]!;
      if (t.kind !== 'subtitles' && t.kind !== 'captions') continue;
      const match = trackId(t, i) === id;
      if (match) found = true;
      t.mode = match ? 'showing' : 'disabled';
    }
    this.refreshTracks();
    return found;
  }

  setAudioTrack(id: string): boolean {
    this.assertAlive();
    const ok = this.adapter?.setAudioTrack(id) ?? false;
    if (ok) this.refreshTracks();
    return ok;
  }

  async enterFullscreen(): Promise<boolean> {
    this.assertAlive();
    const root = this.fullscreenRoot();
    const doc = this.video.ownerDocument;
    try {
      if (typeof root.requestFullscreen === 'function' && doc.fullscreenEnabled !== false) {
        await root.requestFullscreen({ navigationUI: 'hide' });
        return true;
      }
      const v = this.video as HTMLVideoElement & { webkitEnterFullscreen?: () => void };
      if (typeof v.webkitEnterFullscreen === 'function') {
        v.webkitEnterFullscreen();
        return true;
      }
    } catch (e) {
      this.log('fullscreen request rejected', e);
    }
    return false;
  }

  async exitFullscreen(): Promise<void> {
    this.assertAlive();
    const doc = this.video.ownerDocument;
    if (doc.fullscreenElement) await doc.exitFullscreen().catch(() => undefined);
    const v = this.video as HTMLVideoElement & { webkitExitFullscreen?: () => void; webkitDisplayingFullscreen?: boolean };
    if (v.webkitDisplayingFullscreen && v.webkitExitFullscreen) v.webkitExitFullscreen();
  }

  async togglePictureInPicture(): Promise<boolean> {
    this.assertAlive();
    const doc = this.video.ownerDocument as Document & { pictureInPictureElement?: Element | null; exitPictureInPicture?: () => Promise<void> };
    try {
      if (doc.pictureInPictureElement) {
        await doc.exitPictureInPicture?.();
        return false;
      }
      if (!this.caps.pictureInPicture) return false;
      await (this.video as HTMLVideoElement & { requestPictureInPicture: () => Promise<unknown> }).requestPictureInPicture();
      return true;
    } catch (e) {
      this.log('picture-in-picture rejected', e);
      return false;
    }
  }

  setTheater(on: boolean): void {
    this.assertAlive();
    if (this.state.theater === on) return;
    this.setState({ theater: on });
    this.emitter.emit('theaterchange', { theater: on });
  }

  /** Replace the source. Resolves when the new source has metadata; rejects if it fails permanently. */
  setSource(source: MediaSourceConfig, fallbacks: MediaSourceConfig[] = this.config.fallbackSources): Promise<void> {
    this.assertAlive();
    this.sources = [source, ...fallbacks];
    this.resumeTime = null;
    this.emitter.emit('sourcechange', { source: { ...source } });
    return this.loadIndex(0, { resetAttempts: true });
  }

  /** Retry after a fatal error (e.g. from an on-screen Retry button). */
  retry(): Promise<void> {
    this.assertAlive();
    if (this.sources.length === 0) return Promise.resolve();
    this.wantPlaying = true;
    return this.loadIndex(this.state.error?.fatal ? 0 : this.sourceIndex, { resetAttempts: true });
  }

  /** Detach the current source and return to idle. */
  unload(): void {
    this.assertAlive();
    this.loadToken++;
    this.settlePending(this.loadToken - 1, 'resolve');
    this.clearAllTimers();
    this.probeCtrl?.abort();
    this.wantPlaying = false;
    this.teardownMedia();
    this.sources = [];
    this.metadataLoaded = false;
    this.recovering = false;
    this.state = { ...INITIAL_STATE, volume: this.video.volume, muted: this.video.muted, theater: this.state.theater, fullscreen: this.state.fullscreen };
    this.emitter.emit('sourcechange', { source: null });
    this.setState({ status: 'idle' });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.loadToken++;
    this.clearAllTimers();
    this.probeCtrl?.abort();
    for (const fn of this.cleanup.splice(0)) fn();
    this.teardownMedia();
    this.adapter?.destroy();
    this.adapter = null;
    this.destroyed = true;
    for (const [, p] of this.pendingLoads) p.resolve();
    this.pendingLoads.clear();
    if (!this.readyResolved) this.rejectReady(new AdStreamXError(makeError('DESTROYED')));
    this.state = { ...this.state, status: 'destroyed' };
    this.emitter.emit('statechange', { state: this.getState(), changed: ['status'] });
    this.emitter.emit('destroyed', {});
    this.emitter.dispose();
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  // ---------------------------------------------------------------------------------
  // Loading & recovery
  // ---------------------------------------------------------------------------------
  private loadIndex(index: number, o: { resetAttempts?: boolean; carryFrom?: number } = {}): Promise<void> {
    const prevToken = this.loadToken;
    const token = ++this.loadToken;
    // A retry/fallback continues the same logical load: carry its pending promise over.
    // Any other new load supersedes the previous one, which resolves quietly.
    const continuation = o.carryFrom !== undefined;
    const carried = continuation ? this.pendingLoads.get(o.carryFrom!) : undefined;
    if (continuation) this.pendingLoads.delete(o.carryFrom!);
    else {
      this.settlePending(prevToken, 'resolve');
      this.recovering = false; // a fresh load is not a recovery of the previous source
    }
    this.clearAllTimers();
    this.probeCtrl?.abort();
    this.probeCtrl = null;
    if (o.resetAttempts) this.attempt = 0;
    this.sourceIndex = index;

    let promise: Promise<void>;
    if (carried) {
      this.pendingLoads.set(token, carried);
      promise = Promise.resolve();
    } else {
      promise = new Promise<void>((resolve, reject) => this.pendingLoads.set(token, { resolve, reject }));
      promise.catch(() => undefined);
    }

    const raw = this.sources[index];
    const v = validateSource(raw, { baseUrl: this.opts.baseUrl ?? this.video.ownerDocument.baseURI, allowedOrigins: this.config.allowedSourceOrigins });
    if (!v.ok) {
      this.fail(token, makeError(v.code, { detail: v.detail, sourceUrl: raw?.src, now: this.now() }), { skipRetry: true });
      return promise;
    }
    const source = v.source;
    const kind = sourceKind(source);
    const factory = this.pickAdapter(kind);
    if (!factory) {
      const detail =
        this.config.engine === 'auto'
          ? `no installed engine can play ${kind} here (engines: ${this.caps.engines.join(', ') || 'none'})`
          : `engine "${this.config.engine}" cannot play ${kind} in this browser`;
      this.fail(token, makeError('UNSUPPORTED_FORMAT', { detail, sourceUrl: source.src, now: this.now() }), { skipRetry: true });
      return promise;
    }

    this.transitioning = true;
    this.teardownMedia();
    if (this.adapterId !== factory.id) {
      this.adapter?.destroy();
      this.adapter = factory.create({
        video: this.video,
        config: this.config,
        signal: (s) => this.onAdapterSignal(token, s),
        log: (m, d) => this.log(`[${factory.id}] ${m}`, d),
      });
      this.adapterId = factory.id;
    }
    this.metadataLoaded = false;
    this.playedThisLoad = false;
    this.followingLive = true;
    this.liveJoin = null;
    this.bufferingSince = null;
    this.stableFrom = null;
    this.setState({
      status: this.recovering ? 'recovering' : 'loading',
      engine: factory.id,
      source: { ...source },
      sourceIndex: index,
      streamType: source.streamType ?? null,
      duration: 0,
      bufferedEnd: 0,
      live: null,
      qualityLevels: [],
      qualitySelection: 'auto',
      currentQuality: null,
      buffering: false,
      ended: false,
      error: this.recovering ? this.state.error : null,
      retryAttempt: this.attempt,
    });
    this.addTextTracks(source);
    this.loadStartedAt = this.now();
    this.emitter.emit('loadstart', { source: { ...source }, engine: factory.id, attempt: this.attempt });
    this.adapter!.load(source, kind);

    const autoplay = this.firstLoad && this.config.autoplay !== false;
    this.firstLoad = false;
    if (autoplay) {
      if (this.config.autoplay === 'muted') this.video.muted = true;
      this.wantPlaying = true;
    }
    if (this.config.preload !== 'none' || this.wantPlaying) this.armStartupTimer(token);
    if (this.wantPlaying) void this.playInternal(autoplay).catch(() => undefined);
    return promise;
  }

  private pickAdapter(kind: SourceKind): PlaybackAdapterFactory | null {
    const list = this.opts.adapters;
    if (this.config.engine !== 'auto') {
      const f = list.find((a) => a.id === this.config.engine);
      return f && f.canPlay(kind, this.caps) ? f : null;
    }
    return list.find((a) => !a.experimental && a.canPlay(kind, this.caps)) ?? null;
  }

  private armStartupTimer(token: number): void {
    if (this.startupTimer) return;
    this.startupTimer = this.later(() => {
      this.startupTimer = null;
      if (token !== this.loadToken || this.metadataLoaded) return;
      void this.diagnoseAndFail(token, 'STARTUP_TIMEOUT', `no metadata after ${this.config.startupTimeoutMs} ms`);
    }, this.config.startupTimeoutMs);
  }

  /** Media element reported an error, or a watchdog fired: probe, classify, then recover. */
  private async diagnoseAndFail(token: number, fallbackCode: PlayerErrorCode, detail: string, mediaCode?: number): Promise<void> {
    if (token !== this.loadToken || this.destroyed) return;
    const source = this.sources[this.sourceIndex];
    if (!source) return;
    this.recovering = true;
    this.setState({ status: 'recovering' });
    this.probeCtrl?.abort();
    const ctrl = (this.probeCtrl = new AbortController());
    const kind = sourceKind(source);
    let code = fallbackCode;
    let httpStatus: number | undefined;
    let probeDetail = '';
    // The engine already parsed this source once: a later demux/decode failure is a
    // pipeline fault (observed with Chromium's native live HLS), not an unplayable format.
    const afterMetadata = this.metadataLoaded;
    if (mediaCode !== MEDIA_ERR.DECODE) {
      const r = await probeSource(this.state.source?.src ?? source.src, kind, {
        fetch: this.opts.fetch,
        expiresAt: source.expiresAt,
        signal: ctrl.signal,
        timeoutMs: 5000,
      });
      if (token !== this.loadToken || this.destroyed) return;
      probeDetail = r.detail;
      if (!r.ok && r.code) {
        code = r.code;
        httpStatus = r.httpStatus;
      } else if (r.ok && mediaCode === MEDIA_ERR.SRC_NOT_SUPPORTED) {
        code = afterMetadata ? 'DECODE' : 'UNSUPPORTED_FORMAT'; // reachable but not playable
      }
    }
    const recoverable = afterMetadata && (code === 'DECODE' || code === 'UNSUPPORTED_FORMAT') ? true : undefined;
    this.fail(
      token,
      makeError(code, { detail: [detail, probeDetail].filter(Boolean).join(' | '), httpStatus, sourceUrl: source.src, now: this.now(), recoverable }),
    );
  }

  private fail(token: number, err: PlayerErrorInfo, o: { skipRetry?: boolean } = {}): void {
    if (token !== this.loadToken || this.destroyed) return;
    this.clearAllTimers();
    this.captureResumePosition();
    const cfg = this.config.retry;
    if (!o.skipRetry && err.recoverable && this.attempt < cfg.maxAttempts) {
      this.attempt++;
      const delayMs = backoffDelay(this.attempt, cfg, this.opts.random);
      this.recovering = true;
      this.setState({ status: 'recovering', error: err, retryAttempt: this.attempt });
      this.emitter.emit('error', err);
      this.emitter.emit('retry', { attempt: this.attempt, delayMs, error: err });
      this.later(() => {
        if (token !== this.loadToken) return;
        this.loadIndex(this.sourceIndex, { carryFrom: token });
      }, delayMs);
      return;
    }
    if (this.sourceIndex + 1 < this.sources.length) {
      const to = this.sourceIndex + 1;
      this.emitter.emit('error', err);
      this.emitter.emit('fallback', { from: this.sourceIndex, to, source: { ...this.sources[to]! }, error: err });
      this.recovering = true;
      this.loadIndex(to, { resetAttempts: true, carryFrom: token });
      return;
    }
    const fatal = { ...err, fatal: true };
    this.recovering = false;
    this.transitioning = false;
    this.teardownMedia();
    this.setState({ status: 'error', error: fatal, buffering: false });
    this.emitter.emit('error', fatal);
    this.settlePending(token, 'reject', new AdStreamXError(fatal));
    if (!this.readyResolved) this.rejectReady(new AdStreamXError(fatal));
  }

  /** Re-load the current live source, which an engine without DVR starts at the live edge. */
  private rejoinLive(): void {
    this.lastCatchUpSeek = this.now();
    this.resumeTime = null;
    this.wantPlaying = true;
    void this.loadIndex(this.sourceIndex, { resetAttempts: true }).catch(() => undefined);
  }

  private captureResumePosition(): void {
    if (!this.metadataLoaded) return;
    const t = this.video.currentTime;
    if (this.state.streamType === 'vod' && t > 0) this.resumeTime = t;
    if (this.state.streamType === 'live') this.resumeTime = this.config.live.resumeAtLiveEdge || this.followingLive ? null : t;
  }

  private settlePending(token: number, how: 'resolve' | 'reject', err?: unknown): void {
    const p = this.pendingLoads.get(token);
    if (!p) return;
    this.pendingLoads.delete(token);
    if (how === 'resolve') p.resolve();
    else p.reject(err);
  }

  private async playInternal(isAutoplay: boolean, fromMetadata = false): Promise<void> {
    this.wantPlaying = true;
    if (this.state.error?.fatal && this.sources.length) {
      await this.retry();
      return;
    }
    // A live source that was loaded but never started is re-joined instead of resumed:
    // Chromium's native HLS (verified on 153) fails with DEMUXER_ERROR_COULD_NOT_PARSE when
    // play() comes >~150 ms after loadedmetadata (docs/KNOWN_ISSUES.md#chromium-native-hls),
    // and a viewer pressing play on live expects the live edge anyway. Only applies when the
    // engine exposes no DVR window; a play() already pending at metadata time plays directly.
    if (
      !fromMetadata &&
      this.state.streamType === 'live' &&
      this.metadataLoaded &&
      !this.playedThisLoad &&
      !this.readLive()?.dvr
    ) {
      this.rejoinLive();
      return;
    }
    try {
      await this.video.play();
    } catch (e) {
      const name = (e as DOMException)?.name;
      if (name === 'AbortError') return; // superseded by a load/pause — not an error
      if (name === 'NotAllowedError') {
        if (isAutoplay && this.config.autoplayMutedFallback && !this.video.muted) {
          this.video.muted = true;
          this.emitter.emit('autoplayblocked', { mutedFallback: true });
          try {
            await this.video.play();
            return;
          } catch {
            /* fall through */
          }
        } else {
          this.emitter.emit('autoplayblocked', { mutedFallback: false });
        }
        this.wantPlaying = false;
        this.setState({ status: this.deriveStatus() });
        throw new AdStreamXError(makeError('PLAY_BLOCKED', { detail: String((e as Error).message), now: this.now() }));
      }
      if (name === 'NotSupportedError') return; // the media 'error' event drives recovery
      throw e;
    }
  }

  // ---------------------------------------------------------------------------------
  // Media element events
  // ---------------------------------------------------------------------------------
  private bindMediaEvents(): void {
    const v = this.video;
    const on = (target: EventTarget, type: string, fn: (e: Event) => void) => {
      target.addEventListener(type, fn);
      this.cleanup.push(() => target.removeEventListener(type, fn));
    };
    const token = () => this.loadToken;

    on(v, 'loadedmetadata', () => this.onLoadedMetadata(token()));
    on(v, 'loadeddata', () => {
      if (this.state.startupTimeMs === null || this.recovering) this.setState({ startupTimeMs: this.now() - this.loadStartedAt });
    });
    on(v, 'durationchange', () => this.syncTime());
    on(v, 'play', () => {
      if (!this.transitioning) this.wantPlaying = true;
      this.setState({ paused: false, status: this.deriveStatus() });
      this.emitter.emit('play', {});
    });
    on(v, 'playing', () => {
      this.hasPlayed = true;
      this.playedThisLoad = true;
      this.endBuffering();
      if (this.recovering) {
        this.recovering = false;
        this.setState({ error: null });
      }
      this.stableFrom = v.currentTime;
      if (this.state.streamType === 'live' && !this.liveJoin && !hasSeekableWindow(v)) {
        this.liveJoin = { wallMs: this.now(), media: v.currentTime, ahead: Math.max(0, bufferedAhead(v)) };
      }
      this.setState({ paused: false, ended: false, status: this.deriveStatus() });
      this.emitter.emit('playing', {});
    });
    on(v, 'pause', () => {
      // Browsers also fire 'pause' when playback dies with an error; that is not the viewer
      // pausing, so the intent to play must survive into recovery.
      if (!this.transitioning && !v.ended && !v.error && !this.recovering) this.wantPlaying = false;
      this.clearStallTimer();
      this.setState({ paused: true, status: this.deriveStatus() });
      this.emitter.emit('pause', {});
    });
    on(v, 'ended', () => {
      this.wantPlaying = false;
      this.endBuffering();
      this.setState({ ended: true, paused: true, status: 'ended' });
      this.emitter.emit('ended', {});
    });
    on(v, 'seeking', () => {
      this.setState({ seeking: true });
      this.emitter.emit('seeking', { target: v.currentTime });
    });
    on(v, 'seeked', () => {
      this.setState({ seeking: false, ended: v.ended });
      this.syncTime();
      this.emitter.emit('seeked', { currentTime: v.currentTime });
    });
    on(v, 'timeupdate', () => this.onTimeUpdate());
    on(v, 'progress', () => this.syncBuffered());
    on(v, 'waiting', () => this.startBuffering(token()));
    on(v, 'canplay', () => this.endBuffering());
    on(v, 'volumechange', () => {
      this.setState({ volume: v.volume, muted: v.muted });
      this.emitter.emit('volumechange', { volume: v.volume, muted: v.muted });
    });
    on(v, 'ratechange', () => {
      this.setState({ playbackRate: v.playbackRate });
      this.emitter.emit('ratechange', { playbackRate: v.playbackRate });
    });
    on(v, 'resize', () => {
      this.setState({ videoWidth: v.videoWidth, videoHeight: v.videoHeight });
      // Engines that switch renditions on their own (native ABR) report it via resize.
      const current = this.adapter?.getCurrentQuality() ?? null;
      if (current && current.id !== this.state.currentQuality?.id) {
        this.setState({ currentQuality: current });
        this.emitter.emit('qualitychange', { selection: this.state.qualitySelection, current });
      }
    });
    on(v, 'error', () => {
      const t = token();
      if (!this.state.source || this.destroyed) return;
      const me = v.error;
      // An error after teardown (src removed) is expected noise.
      if (!v.currentSrc && !v.getAttribute('src')) return;
      void this.diagnoseAndFail(t, classifyMediaErrorCode(me?.code), `MediaError ${me?.code ?? '?'}: ${me?.message ?? ''}`.trim(), me?.code);
    });
    on(v, 'enterpictureinpicture', () => this.setPip(true));
    on(v, 'leavepictureinpicture', () => this.setPip(false));
    on(v, 'webkitbeginfullscreen', () => this.setFullscreen(true));
    on(v, 'webkitendfullscreen', () => this.setFullscreen(false));
    on(v.ownerDocument, 'fullscreenchange', () => {
      const fe = v.ownerDocument.fullscreenElement;
      this.setFullscreen(!!fe && (fe === this.fullscreenRoot() || fe === v));
    });
    const tt = v.textTracks;
    if (tt) {
      on(tt, 'change', () => this.refreshTracks());
      on(tt, 'addtrack', () => this.refreshTracks());
      on(tt, 'removetrack', () => this.refreshTracks());
    }
    const at = (v as HTMLVideoElement & { audioTracks?: EventTarget }).audioTracks;
    if (at && typeof at.addEventListener === 'function') {
      on(at, 'change', () => this.refreshTracks());
      on(at, 'addtrack', () => this.refreshTracks());
    }
  }

  private onLoadedMetadata(token: number): void {
    if (token !== this.loadToken || this.destroyed) return;
    this.metadataLoaded = true;
    this.transitioning = false;
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.timers.delete(this.startupTimer);
      this.startupTimer = null;
    }
    const v = this.video;
    const streamType: StreamType = this.state.source?.streamType ?? (v.duration === Infinity ? 'live' : 'vod');
    this.setState({ streamType, videoWidth: v.videoWidth, videoHeight: v.videoHeight });

    if (streamType === 'live') {
      const live = this.readLive();
      if (live && live.dvr) {
        if (this.resumeTime !== null && !this.config.live.resumeAtLiveEdge && this.resumeTime >= live.seekableStart) {
          v.currentTime = clampDvrSeek(this.resumeTime, live.seekableStart, live.seekableEnd);
          this.followingLive = false;
        } else {
          v.currentTime = liveEdgeTarget(live.seekableStart, live.seekableEnd, this.config.live.liveEdgeOffset);
        }
      }
    } else if (this.resumeTime !== null && this.resumeTime > 0) {
      const d = v.duration;
      v.currentTime = Number.isFinite(d) ? Math.min(this.resumeTime, Math.max(0, d - 0.1)) : this.resumeTime;
    }
    this.resumeTime = null;
    if (v.playbackRate !== 1 && streamType === 'live') v.playbackRate = 1;
    this.syncTime();
    this.refreshTracks();
    if (this.adapter) {
      const levels = this.adapter.getQualityLevels();
      this.setState({ qualityLevels: levels, currentQuality: this.adapter.getCurrentQuality() });
      this.emitter.emit('qualitylevels', { levels });
    }
    if (this.recovering && !this.wantPlaying) {
      // Recovered into a paused state (the viewer had paused): nothing left to wait for.
      this.recovering = false;
      this.setState({ error: null });
    }
    this.setState({ status: this.deriveStatus() });
    this.emitter.emit('loadedmetadata', { duration: v.duration, streamType });
    this.settlePending(token, 'resolve');
    if (!this.readyResolved) {
      this.resolveReady();
      this.emitter.emit('ready', { state: this.getState() });
    }
    if (this.wantPlaying && v.paused) void this.playInternal(false, true).catch(() => undefined);
  }

  private onTimeUpdate(): void {
    const v = this.video;
    this.syncTime();
    if (this.recovering && !v.paused && v.readyState >= 3) {
      this.recovering = false;
      this.setState({ error: null, status: this.deriveStatus() });
    }
    // Reset the retry budget after a stretch of healthy playback.
    if (this.attempt > 0 && this.stableFrom !== null && v.currentTime - this.stableFrom >= STABLE_PLAYBACK_RESET_S) {
      this.attempt = 0;
      this.setState({ retryAttempt: 0 });
    }
    if (this.state.streamType === 'live') this.liveTick();
    this.emitter.emit('timeupdate', { currentTime: v.currentTime, duration: v.duration });
  }

  private liveTick(): void {
    const v = this.video;
    const live = this.readLive();
    if (!live) return;
    if (!live.dvr) {
      // No seekable window: the only way back to the edge is to re-join the stream.
      if (this.followingLive && this.config.live.catchUp && !v.paused && !this.state.buffering &&
          live.latency - this.config.live.targetLatency > this.config.live.maxDriftBeforeSeek &&
          this.now() - this.lastCatchUpSeek > MIN_LIVE_REJOIN_INTERVAL_MS) {
        this.rejoinLive();
      }
      return;
    }
    // Viewer's retained DVR position fell out of the window: move to the oldest available media.
    if (!v.seeking && v.currentTime < live.seekableStart - 1) {
      v.currentTime = live.seekableStart + 1;
      return;
    }
    if (this.followingLive && !v.paused && !v.seeking && !this.state.buffering) {
      const d = catchUpDecision(live.latency, this.config.live);
      if (d.action === 'rate' && Math.abs(v.playbackRate - d.rate) > 0.004) v.playbackRate = d.rate;
      else if (d.action === 'seek' && this.now() - this.lastCatchUpSeek > MIN_CATCHUP_SEEK_INTERVAL_MS) {
        this.lastCatchUpSeek = this.now();
        v.currentTime = liveEdgeTarget(live.seekableStart, live.seekableEnd, this.config.live.liveEdgeOffset);
      }
    } else if (!this.followingLive && v.playbackRate !== 1) {
      v.playbackRate = 1;
    }
  }

  private readLive() {
    const r = lastRange(this.video.seekable);
    if (r && r[1] - r[0] > 0) return computeLiveInfo(this.video.currentTime, r[0], r[1], this.config.live);
    if (this.state.streamType !== 'live') return null;
    if (!this.liveJoin) return estimateLiveInfo(0, bufferedAhead(this.video), this.config.live);
    const drift = (this.now() - this.liveJoin.wallMs) / 1000 - (this.video.currentTime - this.liveJoin.media);
    return estimateLiveInfo(drift, this.liveJoin.ahead, this.config.live);
  }

  private syncTime(): void {
    const v = this.video;
    const patch: Partial<PlayerState> = { currentTime: v.currentTime, duration: v.duration };
    if (this.state.streamType === 'live') {
      const live = this.readLive();
      patch.live = live;
      if (live) {
        const prev = this.state.live;
        if (live.atLiveEdge && prev && !prev.atLiveEdge) this.emitter.emit('liveedgereached', { latency: live.latency });
        if (Math.abs(live.latency - this.lastLatencyEmitted) >= 0.25 || (prev && prev.atLiveEdge !== live.atLiveEdge)) {
          this.lastLatencyEmitted = live.latency;
          this.emitter.emit('livelatencychange', { latency: live.latency, atLiveEdge: live.atLiveEdge });
        }
      }
    }
    this.setState(patch);
    this.syncBuffered();
  }

  private syncBuffered(): void {
    const b = this.video.buffered;
    const t = this.video.currentTime;
    let end = 0;
    for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.5 && b.end(i) >= t) end = b.end(i);
    if (end !== this.state.bufferedEnd) this.setState({ bufferedEnd: end });
  }

  private startBuffering(token: number): void {
    if (this.state.buffering || !this.state.source) return;
    this.bufferingSince = this.now();
    this.setState({ buffering: true, status: this.deriveStatus(true) });
    this.emitter.emit('bufferingstart', { currentTime: this.video.currentTime });
    this.clearStallTimer();
    if (!this.metadataLoaded) return; // startup is covered by the startup timer
    this.stallTimer = this.later(() => {
      this.stallTimer = null;
      if (token !== this.loadToken || !this.state.buffering || this.video.paused) return;
      void this.diagnoseAndFail(token, 'STALLED', `waiting for ${this.config.stallTimeoutMs} ms`);
    }, this.config.stallTimeoutMs);
  }

  private endBuffering(): void {
    this.clearStallTimer();
    if (!this.state.buffering) return;
    const durationMs = this.bufferingSince ? this.now() - this.bufferingSince : 0;
    this.bufferingSince = null;
    this.setState({ buffering: false });
    this.setState({ status: this.deriveStatus() });
    this.emitter.emit('bufferingend', { currentTime: this.video.currentTime, durationMs });
  }

  private onAdapterSignal(token: number, s: AdapterSignal): void {
    if (token !== this.loadToken || this.destroyed) return;
    switch (s.type) {
      case 'qualitylevels':
        this.setState({ qualityLevels: s.levels });
        this.emitter.emit('qualitylevels', { levels: s.levels });
        break;
      case 'qualitychange':
        this.setState({ currentQuality: s.current });
        this.emitter.emit('qualitychange', { selection: this.state.qualitySelection, current: s.current });
        break;
      case 'audiotracks':
        this.refreshTracks();
        break;
      case 'error':
        if (s.fatal) void this.diagnoseAndFail(token, 'NETWORK', s.detail);
        break;
    }
  }

  // ---------------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------------
  private deriveStatus(buffering = this.state.buffering): PlayerState['status'] {
    const v = this.video;
    if (this.destroyed) return 'destroyed';
    if (this.state.error?.fatal) return 'error';
    if (this.recovering) return 'recovering';
    if (!this.state.source) return 'idle';
    if (!this.metadataLoaded) return 'loading';
    if (v.ended) return 'ended';
    if (buffering && !v.paused) return 'buffering';
    if (v.paused) return this.hasPlayed ? 'paused' : 'ready';
    return 'playing';
  }

  private setState(patch: Partial<PlayerState>): void {
    if (this.destroyed) return;
    const changed: (keyof PlayerState)[] = [];
    const next = { ...this.state } as Record<string, unknown>;
    for (const [k, v] of Object.entries(patch) as [keyof PlayerState, unknown][]) {
      const prev = this.state[k];
      if (prev === v) continue;
      if (typeof v === 'object' && v !== null && JSON.stringify(prev) === JSON.stringify(v)) continue;
      if (typeof v === 'number' && typeof prev === 'number' && Number.isNaN(v) && Number.isNaN(prev)) continue;
      next[k] = v;
      changed.push(k);
    }
    if (!changed.length) return;
    this.state = next as unknown as PlayerState;
    this.emitter.emit('statechange', { state: this.state, changed });
  }

  private refreshTracks(): void {
    const v = this.video;
    const text: TrackInfo[] = [];
    for (let i = 0; i < (v.textTracks?.length ?? 0); i++) {
      const t = v.textTracks[i]!;
      if (t.kind !== 'subtitles' && t.kind !== 'captions') continue;
      text.push({ id: trackId(t, i), label: t.label || t.language || `Track ${i + 1}`, language: t.language, kind: t.kind, active: t.mode === 'showing' });
    }
    const audio = this.adapter?.getAudioTracks() ?? [];
    const prevText = JSON.stringify(this.state.textTracks);
    const prevAudio = JSON.stringify(this.state.audioTracks);
    this.setState({ textTracks: text, audioTracks: audio });
    if (JSON.stringify(text) !== prevText) this.emitter.emit('texttrackchange', { tracks: text });
    if (JSON.stringify(audio) !== prevAudio) this.emitter.emit('audiotrackchange', { tracks: audio });
  }

  private addTextTracks(source: MediaSourceConfig): void {
    for (const t of source.textTracks ?? []) {
      const el = this.video.ownerDocument.createElement('track');
      el.kind = t.kind ?? 'subtitles';
      el.src = t.src;
      el.srclang = t.srclang;
      el.label = t.label;
      if (t.default) el.default = true;
      this.video.appendChild(el);
      this.trackEls.push(el);
    }
  }

  private teardownMedia(): void {
    this.adapter?.unload();
    for (const el of this.trackEls.splice(0)) el.remove();
  }

  private applyStaticConfig(): void {
    const v = this.video;
    v.preload = this.config.preload;
    v.playsInline = true;
    if (this.config.poster) v.poster = this.config.poster;
    else v.removeAttribute('poster');
    if (this.config.muted) v.muted = true;
    v.volume = this.config.volume;
  }

  private setPip(on: boolean): void {
    if (this.state.pictureInPicture === on) return;
    this.setState({ pictureInPicture: on });
    this.emitter.emit('pictureinpicturechange', { pictureInPicture: on });
  }

  private setFullscreen(on: boolean): void {
    if (this.state.fullscreen === on) return;
    this.setState({ fullscreen: on });
    this.emitter.emit('fullscreenchange', { fullscreen: on });
  }

  private fullscreenRoot(): HTMLElement {
    return this.opts.fullscreenElement ?? this.video.parentElement ?? this.video;
  }

  private later(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const id = setTimeout(() => {
      this.timers.delete(id);
      if (!this.destroyed) fn();
    }, ms);
    this.timers.add(id);
    return id;
  }

  private clearStallTimer(): void {
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.timers.delete(this.stallTimer);
      this.stallTimer = null;
    }
  }

  private clearAllTimers(): void {
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
    this.startupTimer = null;
    this.stallTimer = null;
  }

  private assertAlive(): void {
    if (this.destroyed) throw new AdStreamXError(makeError('DESTROYED'));
  }

  private log(msg: string, data?: unknown): void {
    // eslint-disable-next-line no-console
    if (this.config.debug) console.debug(`[AdStreamX] ${msg}`, data ?? '');
  }
}

function hasSeekableWindow(v: HTMLVideoElement): boolean {
  const r = lastRange(v.seekable);
  return !!r && r[1] - r[0] > 0;
}

function bufferedAhead(v: HTMLVideoElement): number {
  const b = v.buffered;
  for (let i = 0; i < b.length; i++) if (b.start(i) <= v.currentTime + 0.5 && b.end(i) >= v.currentTime) return b.end(i) - v.currentTime;
  return 0;
}

function trackId(t: TextTrack, index: number): string {
  return t.id || `text-${index}`;
}
