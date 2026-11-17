import type {
  AdBreakRequest,
  Capabilities,
  MediaSourceConfig,
  OverlayRef,
  PlayerConfig,
  PlayerConfigInput,
  PlayerState,
  PollResults,
  Unsubscribe,
} from '@adstreamx/shared-types';
import { AdStreamXError, makeError, type PlayerCore } from '@adstreamx/player-core';
import type { AdEngine, AdEngineCapabilities, InteractionEngine, OverlayEngine } from './engines.ts';

const unavailable = (what: string) =>
  new AdStreamXError(makeError('FEATURE_UNAVAILABLE', { detail: `${what}: no engine registered (planned for a later phase)` }));

/** Playback controller: the player's media operations, grouped. */
export class PlaybackController {
  private core: PlayerCore;
  constructor(core: PlayerCore) {
    this.core = core;
  }
  play(): Promise<void> {
    return this.core.play();
  }
  pause(): void {
    this.core.pause();
  }
  seekTo(seconds: number): void {
    this.core.seekTo(seconds);
  }
  setVolume(v: number): void {
    this.core.setVolume(v);
  }
  setMuted(m: boolean): void {
    this.core.setMuted(m);
  }
  setQuality(id: string): boolean {
    return this.core.setQuality(id);
  }
  setPlaybackRate(r: number): boolean {
    return this.core.setPlaybackRate(r);
  }
  goLive(): boolean {
    return this.core.goLive();
  }
  setSource(source: MediaSourceConfig, fallbacks?: MediaSourceConfig[]): Promise<void> {
    return this.core.setSource(source, fallbacks);
  }
  setTextTrack(id: string | null): boolean {
    return this.core.setTextTrack(id);
  }
  setAudioTrack(id: string): boolean {
    return this.core.setAudioTrack(id);
  }
  getState(): PlayerState {
    return this.core.getState();
  }
  getCapabilities(): Capabilities {
    return this.core.getCapabilities();
  }
}

/** Configuration controller: validated reads and partial updates. */
export class ConfigController {
  private core: PlayerCore;
  constructor(core: PlayerCore) {
    this.core = core;
  }
  get(): PlayerConfig {
    return this.core.getConfig();
  }
  update(patch: PlayerConfigInput): PlayerConfig {
    return this.core.updateConfig(patch);
  }
  onChange(fn: (c: PlayerConfig) => void): Unsubscribe {
    return this.core.on('configupdated', ({ config }) => fn(config));
  }
}

/** Advertising controller (engine arrives in Phase 3). */
export class AdsController {
  private engine: AdEngine | null = null;
  get available(): boolean {
    return this.engine !== null;
  }
  get provider(): string | null {
    return this.engine?.provider ?? null;
  }
  /** @internal */
  attach(engine: AdEngine | null): void {
    if (this.engine && this.engine !== engine) this.engine.destroy();
    this.engine = engine;
  }
  capabilities(): AdEngineCapabilities | null {
    return this.engine?.capabilities() ?? null;
  }
  async requestBreak(req: AdBreakRequest): Promise<void> {
    if (!this.engine) throw unavailable('ads');
    return this.engine.requestBreak(req);
  }
  cancelBreak(breakId?: string): boolean {
    if (!this.engine) throw unavailable('ads');
    return this.engine.cancelBreak(breakId);
  }
  skip(): boolean {
    if (!this.engine) throw unavailable('ads');
    return this.engine.skip();
  }
  isBreakActive(): boolean {
    return this.engine?.isBreakActive() ?? false;
  }
}

/** Overlay controller (engine arrives in Phase 4). */
export class OverlaysController {
  private engine: OverlayEngine | null = null;
  get available(): boolean {
    return this.engine !== null;
  }
  /** @internal */
  attach(engine: OverlayEngine | null): void {
    if (this.engine && this.engine !== engine) this.engine.destroy();
    this.engine = engine;
  }
  async show(overlayId: string): Promise<void> {
    if (!this.engine) throw unavailable('overlays');
    return this.engine.show(overlayId);
  }
  hide(overlayId: string): boolean {
    if (!this.engine) throw unavailable('overlays');
    return this.engine.hide(overlayId, 'user');
  }
  list(): OverlayRef[] {
    return this.engine?.list() ?? [];
  }
}

/** Polls & interactive elements controller (engine arrives in Phase 5). */
export class InteractionsController {
  private engine: InteractionEngine | null = null;
  get available(): boolean {
    return this.engine !== null;
  }
  /** @internal */
  attach(engine: InteractionEngine | null): void {
    if (this.engine && this.engine !== engine) this.engine.destroy();
    this.engine = engine;
  }
  async open(pollId: string): Promise<void> {
    if (!this.engine) throw unavailable('polls');
    return this.engine.open(pollId);
  }
  close(pollId: string): boolean {
    if (!this.engine) throw unavailable('polls');
    return this.engine.close(pollId);
  }
  async vote(pollId: string, optionIds: string[]): Promise<void> {
    if (!this.engine) throw unavailable('polls');
    return this.engine.vote(pollId, optionIds);
  }
  results(pollId: string): PollResults | null {
    return this.engine?.results(pollId) ?? null;
  }
}

/** @internal engine slots, used by the plugin context and the command controller. */
export interface EngineSlots {
  ads: AdsController;
  overlays: OverlaysController;
  interactions: InteractionsController;
}
