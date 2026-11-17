import type { AnalyticsConfig, PlayerEventMap, Unsubscribe } from '@adstreamx/shared-types';
import type { PlayerCore } from '@adstreamx/player-core';
import { AnalyticsCollector, stripUrl, type AnalyticsEvent, type CollectorStats, type Transport } from '@adstreamx/analytics-sdk';

/**
 * Analytics controller: turns player events into first-party QoE events.
 * Metric definitions (docs/analytics/EVENTS.md):
 *  - startup_ms: load start → first frame (loadeddata) for the first source of the session
 *  - watch_ms: wall-clock time spent in the "playing" status (excludes paused/buffering/ads)
 *  - rebuffer_ms / rebuffer_count: buffering after playback started (startup excluded)
 */
export class AnalyticsController {
  private readonly collector: AnalyticsCollector;
  private readonly core: PlayerCore;
  private readonly now: () => number;
  private offs: Unsubscribe[] = [];
  private sessionStarted = false;
  private playbackStarted = false;
  private playingSince: number | null = null;
  private watchMs = 0;
  private watchMsReported = 0;
  private rebufferMs = 0;
  private rebufferCount = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private config: AnalyticsConfig;
  private pageHide = () => {
    this.track('page_hide', this.totals());
    this.collector.flushWithBeacon();
  };

  constructor(core: PlayerCore, config: AnalyticsConfig, opts: { transport?: Transport; now?: () => number } = {}) {
    this.core = core;
    this.config = config;
    this.now = opts.now ?? (() => Date.now());
    this.collector = new AnalyticsCollector({
      config,
      transport: opts.transport,
      now: this.now,
      onFlush: (r) => core.emitExtension('analyticsflush', r),
    });
    this.bind();
    if (typeof window !== 'undefined') window.addEventListener('pagehide', this.pageHide);
  }

  get sessionId(): string {
    return this.collector.sessionId;
  }
  setConsent(granted: boolean): void {
    this.collector.setConsent(granted);
  }
  hasConsent(): boolean {
    return this.collector.hasConsent();
  }
  /** Host-defined events (lowercase snake_case type). */
  track(type: string, data?: Record<string, unknown>, dedupeKey?: string): AnalyticsEvent | null {
    return this.collector.track(type, data, { mediaTime: this.core.getState().currentTime, dedupeKey });
  }
  flush(): Promise<{ ok: boolean; count: number }> {
    return this.collector.flush();
  }
  getQueue(): AnalyticsEvent[] {
    return this.collector.getQueue();
  }
  getStats(): CollectorStats & { watchMs: number; rebufferMs: number; rebufferCount: number } {
    this.accrueWatch();
    return { ...this.collector.getStats(), watchMs: this.watchMs, rebufferMs: this.rebufferMs, rebufferCount: this.rebufferCount };
  }
  /** @internal */
  updateConfig(config: AnalyticsConfig): void {
    this.config = config;
    this.collector.updateConfig(config);
    this.restartHeartbeat();
  }

  destroy(): void {
    this.accrueWatch();
    if (this.sessionStarted) this.track('session_end', this.totals());
    for (const off of this.offs.splice(0)) off();
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', this.pageHide);
    this.collector.destroy();
  }

  // ------------------------------------------------------------------------------------
  private on<K extends keyof PlayerEventMap>(e: K, fn: (p: PlayerEventMap[K]) => void) {
    this.offs.push(this.core.on(e, fn));
  }

  private bind(): void {
    this.on('loadstart', ({ source, engine, attempt }) => {
      if (attempt > 0) return;
      if (!this.sessionStarted) {
        this.sessionStarted = true;
        this.track('session_start', { engine, src: stripUrl(source.src) });
      } else {
        this.playbackStarted = false;
        this.track('source_change', { engine, src: stripUrl(source.src) });
      }
    });
    this.on('loadedmetadata', ({ duration, streamType }) =>
      this.track('media_info', { streamType, duration: Number.isFinite(duration) ? duration : null }),
    );
    this.on('statechange', ({ state, changed }) => {
      if (!changed.includes('status')) return;
      if (state.status === 'playing') {
        if (this.playingSince === null) this.playingSince = this.now();
        if (!this.playbackStarted) {
          this.playbackStarted = true;
          this.track('playback_start', { startupMs: state.startupTimeMs, height: state.videoHeight || null });
        }
      } else {
        this.accrueWatch();
        this.playingSince = null;
      }
    });
    this.on('play', () => this.track('play'));
    this.on('pause', () => this.track('pause'));
    this.on('seeked', ({ currentTime }) => this.track('seek', { to: currentTime }));
    this.on('bufferingend', ({ durationMs }) => {
      if (!this.playbackStarted || durationMs <= 0) return;
      this.rebufferMs += durationMs;
      this.rebufferCount++;
      this.track('rebuffer', { durationMs });
    });
    this.on('qualitychange', ({ current }) => this.track('quality_change', { height: current?.height ?? null, bitrate: current?.bitrate ?? null }));
    this.on('error', (e) => this.track('error', { code: e.code, fatal: e.fatal, httpStatus: e.httpStatus ?? null }));
    this.on('retry', ({ attempt, error }) => this.track('retry', { attempt, code: error.code }));
    this.on('fallback', ({ to }) => this.track('fallback', { to }));
    this.on('ended', () => this.track('ended', this.totals()));
    this.on('liveedgereached', ({ latency }) => this.track('live_edge', { latency }));
    // extension events → one event each; impressions/starts are idempotent per break+creative
    this.on('adrequest', (e) => this.track('ad_request', { breakId: e.breakId, position: e.position, provider: e.provider }));
    this.on('adstarted', (e) => this.track('ad_start', adData(e), `ad_start:${e.breakId}:${e.adId ?? e.creativeId ?? e.podIndex ?? 0}`));
    this.on('adquartile', (e) => this.track('ad_quartile', { ...adData(e), quartile: e.quartile }, `ad_q${e.quartile}:${e.breakId}:${e.adId ?? e.podIndex ?? 0}`));
    this.on('adcompleted', (e) => this.track('ad_complete', adData(e), `ad_complete:${e.breakId}:${e.adId ?? e.podIndex ?? 0}`));
    this.on('adskipped', (e) => this.track('ad_skip', adData(e), `ad_skip:${e.breakId}:${e.adId ?? e.podIndex ?? 0}`));
    this.on('aderror', (e) => this.track('ad_error', { breakId: e.breakId ?? null, provider: e.provider, code: e.code }));
    this.on('overlayshown', (e) => this.track('overlay_impression', { overlayId: e.overlayId, overlayType: e.overlayType }));
    this.on('overlayclicked', (e) => this.track('overlay_click', { overlayId: e.overlayId, overlayType: e.overlayType }));
    this.on('voteaccepted', (e) => this.track('poll_vote', { pollId: e.pollId, options: e.optionIds.length }));
    this.restartHeartbeat();
    // The core starts loading its initial source inside its constructor, before this
    // controller subscribes: record that session start now.
    const st = this.core.getState();
    if (st.source && !this.sessionStarted) {
      this.sessionStarted = true;
      this.track('session_start', { engine: st.engine, src: stripUrl(st.source.src) });
    }
  }

  private restartHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (!this.config.enabled) return;
    this.heartbeat = setInterval(() => {
      this.accrueWatch();
      const delta = this.watchMs - this.watchMsReported;
      if (delta <= 0) return;
      this.watchMsReported = this.watchMs;
      this.track('heartbeat', { watchMsDelta: Math.round(delta) });
    }, this.config.heartbeatIntervalMs);
  }

  private accrueWatch(): void {
    if (this.playingSince !== null) {
      const t = this.now();
      this.watchMs += t - this.playingSince;
      this.playingSince = t;
    }
  }

  private totals() {
    this.accrueWatch();
    return { watchMs: Math.round(this.watchMs), rebufferMs: Math.round(this.rebufferMs), rebufferCount: this.rebufferCount };
  }
}

function adData(e: PlayerEventMap['adstarted']) {
  return {
    breakId: e.breakId,
    position: e.position,
    provider: e.provider,
    adId: e.adId ?? null,
    creativeId: e.creativeId ?? null,
    podIndex: e.podIndex ?? null,
    skippable: e.skippable ?? null,
  };
}
