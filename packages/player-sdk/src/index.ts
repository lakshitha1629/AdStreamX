import type {
  Capabilities,
  MediaSourceConfig,
  PlayerConfig,
  PlayerConfigInput,
  PlayerEventMap,
  PlayerState,
  Unsubscribe,
} from '@adstreamx/shared-types';
import { AdStreamXError, ConfigError, detectCapabilities, PlayerCore, resolveConfig, type PlaybackAdapterFactory } from '@adstreamx/player-core';
import { defaultAdapters } from '@adstreamx/playback-adapters';
import { createControls, type ControlsHandle } from '@adstreamx/player-controls';

export const VERSION = '0.1.0';

export type { MediaSourceConfig, PlayerConfig, PlayerConfigInput, PlayerEventMap, PlayerState, Capabilities };
export { AdStreamXError, ConfigError };

export interface CreateOptions {
  /** Override the engine list (tests, or future hls.js / Video.js adapters). */
  adapters?: PlaybackAdapterFactory[];
}

let nextId = 1;
const live = new Set<AdStreamXPlayer>();

/**
 * Public player handle. Phase 1/2 scope: playback + configuration.
 * Ads, overlays, polls, analytics and remote-command controllers are later phases and
 * are intentionally absent (not stubbed) — see docs/IMPLEMENTATION_CHECKLIST.md.
 */
export class AdStreamXPlayer {
  readonly id: string;
  readonly element: HTMLElement;
  readonly video: HTMLVideoElement;
  private readonly core: PlayerCore;
  private readonly controls: ControlsHandle | null;
  private readonly restore: () => void;
  private offConfig: Unsubscribe;

  constructor(target: HTMLElement, config: PlayerConfigInput, opts: CreateOptions = {}) {
    const doc = target.ownerDocument;
    const resolved = resolveConfig(config); // throws ConfigError before the page is touched
    this.id = `asx-${nextId++}`;
    const root = doc.createElement('div');
    root.dataset.adstreamx = this.id;
    let video: HTMLVideoElement;
    if (target instanceof HTMLVideoElement) {
      // Wrap an existing <video>; put it back on destroy.
      const parent = target.parentNode!;
      const marker = doc.createComment('adstreamx');
      parent.insertBefore(marker, target);
      parent.insertBefore(root, target);
      root.appendChild(target);
      video = target;
      const hadControls = target.controls;
      this.restore = () => {
        target.controls = hadControls;
        target.classList.remove('asx-video');
        marker.parentNode?.insertBefore(target, marker);
        marker.remove();
        root.remove();
      };
    } else {
      video = doc.createElement('video');
      target.appendChild(root);
      root.appendChild(video);
      this.restore = () => root.remove();
    }
    video.classList.add('asx-video');
    video.controls = false;
    video.setAttribute('playsinline', '');
    this.element = root;
    this.video = video;

    this.core = new PlayerCore(video, resolved, { adapters: opts.adapters ?? defaultAdapters, fullscreenElement: root });
    this.controls = createControls(root, this.core, resolved);
    if (!resolved.controls.enabled) this.controls.update(resolved);
    this.offConfig = this.core.on('configupdated', ({ config: c }) => this.controls?.update(c));
    live.add(this);
  }

  // events
  on<K extends keyof PlayerEventMap>(event: K, fn: (p: PlayerEventMap[K]) => void): Unsubscribe {
    return this.core.on(event, fn);
  }
  once<K extends keyof PlayerEventMap>(event: K, fn: (p: PlayerEventMap[K]) => void): Unsubscribe {
    return this.core.once(event, fn);
  }

  // playback
  ready(): Promise<void> {
    return this.core.ready();
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
  setVolume(volume: number): void {
    this.core.setVolume(volume);
  }
  setMuted(muted: boolean): void {
    this.core.setMuted(muted);
  }
  setQuality(id: string): boolean {
    return this.core.setQuality(id);
  }
  setPlaybackRate(rate: number): boolean {
    return this.core.setPlaybackRate(rate);
  }
  goLive(): boolean {
    return this.core.goLive();
  }
  setSource(source: MediaSourceConfig, fallbacks?: MediaSourceConfig[]): Promise<void> {
    return this.core.setSource(source, fallbacks);
  }
  unload(): void {
    this.core.unload();
  }
  retry(): Promise<void> {
    return this.core.retry();
  }
  setTextTrack(id: string | null): boolean {
    return this.core.setTextTrack(id);
  }
  setAudioTrack(id: string): boolean {
    return this.core.setAudioTrack(id);
  }
  enterFullscreen(): Promise<boolean> {
    return this.core.enterFullscreen();
  }
  exitFullscreen(): Promise<void> {
    return this.core.exitFullscreen();
  }
  togglePictureInPicture(): Promise<boolean> {
    return this.core.togglePictureInPicture();
  }
  setTheater(on: boolean): void {
    this.core.setTheater(on);
  }

  // inspection & configuration
  getState(): PlayerState {
    return this.core.getState();
  }
  getCapabilities(): Capabilities {
    return this.core.getCapabilities();
  }
  getConfig(): PlayerConfig {
    return this.core.getConfig();
  }
  updateConfig(patch: PlayerConfigInput): PlayerConfig {
    return this.core.updateConfig(patch);
  }
  get destroyed(): boolean {
    return this.core.isDestroyed;
  }
  /** Diagnostics: total live listeners on this instance (used by leak tests). */
  listenerCount(): number {
    return this.core.listenerCount();
  }

  destroy(): void {
    if (this.core.isDestroyed) return;
    this.offConfig();
    this.controls?.destroy();
    this.core.destroy();
    this.restore();
    live.delete(this);
  }
}

export function create(target: HTMLElement | string, config: PlayerConfigInput = {}, opts?: CreateOptions): AdStreamXPlayer {
  const el = typeof target === 'string' ? document.querySelector<HTMLElement>(target) : target;
  if (!el) throw new Error(`AdStreamX.create: element not found (${String(target)})`);
  return new AdStreamXPlayer(el, config, opts);
}

/** Number of players created and not yet destroyed (leak diagnostics). */
export function activeCount(): number {
  return live.size;
}

export function getCapabilities(): Capabilities {
  return detectCapabilities(defaultAdapters.map((a) => a.id));
}

export const AdStreamX = { create, activeCount, getCapabilities, VERSION, AdStreamXError, ConfigError };
export default AdStreamX;
