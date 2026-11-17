import type {
  Capabilities,
  CommandAck,
  CommandRole,
  ExtensionEventName,
  MediaSourceConfig,
  PlayerConfig,
  PlayerConfigInput,
  PlayerEventMap,
  PlayerState,
  Unsubscribe,
} from '@adstreamx/shared-types';
import { AdStreamXError, ConfigError, detectCapabilities, makeError, PlayerCore, resolveConfig, type PlaybackAdapterFactory } from '@adstreamx/player-core';
import { defaultAdapters } from '@adstreamx/playback-adapters';
import { createControls, type ControlsHandle } from '@adstreamx/player-controls';
import { createEd25519Verifier, type CommandVerifier } from '@adstreamx/command-protocol';
import type { Transport } from '@adstreamx/analytics-sdk';
import { AnalyticsController } from './analytics.ts';
import { CommandController } from './commands.ts';
import { AdsController, ConfigController, InteractionsController, OverlaysController, PlaybackController } from './controllers.ts';
import type { PlayerPlugin, PluginContext } from './engines.ts';
import { connectIframe, generateEmbedCode } from './embed-client.ts';

export const VERSION = '0.2.0';

export type { MediaSourceConfig, PlayerConfig, PlayerConfigInput, PlayerEventMap, PlayerState, Capabilities, CommandAck, CommandRole };
export type { AdEngine, AdEngineCapabilities, InteractionEngine, OverlayEngine, PlayerPlugin, PluginContext } from './engines.ts';
export type { CommandVerifier };
export { AdStreamXError, ConfigError, createEd25519Verifier, connectIframe, generateEmbedCode };
export { AnalyticsController, CommandController, AdsController, ConfigController, InteractionsController, OverlaysController, PlaybackController };

export interface CreateOptions {
  /** Override the engine list (tests, or future hls.js / Video.js adapters). */
  adapters?: PlaybackAdapterFactory[];
  /** Verifies operator command signatures; without it operator commands are rejected. */
  commandVerifier?: CommandVerifier;
  /** Custom analytics transport (tests, or a host-managed pipeline). */
  analyticsTransport?: Transport;
  plugins?: PlayerPlugin[];
}

let nextId = 1;
const live = new Set<AdStreamXPlayer>();

/**
 * Public player handle.
 * Controllers: `playback`, `config`, `ads`, `overlays`, `interactions`, `analytics`, `commands`.
 * The ads/overlays/interactions controllers need an engine registered by a plugin (Phases
 * 3–5); until then `available` is false and their actions reject with FEATURE_UNAVAILABLE.
 */
export class AdStreamXPlayer {
  readonly id: string;
  readonly element: HTMLElement;
  readonly video: HTMLVideoElement;
  readonly playback: PlaybackController;
  readonly config: ConfigController;
  readonly ads = new AdsController();
  readonly overlays = new OverlaysController();
  readonly interactions = new InteractionsController();
  readonly analytics: AnalyticsController;
  readonly commands: CommandController;
  private readonly core: PlayerCore;
  private readonly controls: ControlsHandle | null;
  private readonly restore: () => void;
  private readonly offs: Unsubscribe[] = [];
  private readonly plugins = new Map<string, () => void>();

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
    this.playback = new PlaybackController(this.core);
    this.config = new ConfigController(this.core);
    this.analytics = new AnalyticsController(this.core, resolved.analytics, { transport: opts.analyticsTransport });
    this.commands = new CommandController(
      this.core,
      { ads: this.ads, overlays: this.overlays, interactions: this.interactions },
      resolved.commands,
      { verifier: opts.commandVerifier },
    );
    this.controls = createControls(root, this.core, resolved);
    this.offs.push(
      this.core.on('configupdated', ({ config: c }) => {
        this.controls?.update(c);
        this.analytics.updateConfig(c.analytics);
        this.commands.updateConfig(c.commands);
      }),
    );
    live.add(this);
    for (const p of opts.plugins ?? []) this.use(p);
  }

  // ------------------------------------------------------------------ events
  on<K extends keyof PlayerEventMap>(event: K, fn: (p: PlayerEventMap[K]) => void): Unsubscribe {
    return this.core.on(event, fn);
  }
  once<K extends keyof PlayerEventMap>(event: K, fn: (p: PlayerEventMap[K]) => void): Unsubscribe {
    return this.core.once(event, fn);
  }

  // ------------------------------------------------------------------ plugins
  /** Register a plugin (engines for ads/overlays/polls, integrations). Returns an unregister function. */
  use(plugin: PlayerPlugin): () => void {
    if (this.core.isDestroyed) throw new AdStreamXError(makeError('DESTROYED'));
    if (!plugin || typeof plugin.setup !== 'function' || !/^[a-z0-9-]{1,40}$/.test(plugin.name ?? '')) {
      throw new TypeError('plugin needs a name ([a-z0-9-]{1,40}) and a setup() function');
    }
    if (this.plugins.has(plugin.name)) throw new Error(`plugin "${plugin.name}" is already registered`);
    const provided: string[] = [];
    const owned: (() => void)[] = [];
    const ctx: PluginContext = {
      player: this,
      emit: <K extends ExtensionEventName>(event: K, payload: PlayerEventMap[K]) => this.core.emitExtension(event, payload),
      registerAdEngine: (e) => {
        this.ads.attach(e);
        provided.push('ads');
        owned.push(() => this.ads.attach(null));
      },
      registerOverlayEngine: (e) => {
        this.overlays.attach(e);
        provided.push('overlays');
        owned.push(() => this.overlays.attach(null));
      },
      registerInteractionEngine: (e) => {
        this.interactions.attach(e);
        provided.push('interactions');
        owned.push(() => this.interactions.attach(null));
      },
    };
    const cleanup = plugin.setup(ctx);
    let done = false;
    const dispose = () => {
      if (done) return;
      done = true;
      try {
        if (typeof cleanup === 'function') cleanup();
      } finally {
        for (const o of owned) o();
        this.plugins.delete(plugin.name);
      }
    };
    this.plugins.set(plugin.name, dispose);
    this.core.emitExtension('pluginregistered', { name: plugin.name, provides: provided });
    return dispose;
  }

  /** Execute a remote command as `role` (default 'host'); see docs/player/COMMANDS.md. */
  command(cmd: unknown, role: CommandRole = 'host'): Promise<CommandAck> {
    return this.commands.execute(cmd, role);
  }

  // ------------------------------------------------------------------ playback (flat API)
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

  // ------------------------------------------------------------------ inspection & configuration
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
    for (const dispose of [...this.plugins.values()]) {
      try {
        dispose();
      } catch (e) {
        console.error('[AdStreamX] plugin cleanup failed', e);
      }
    }
    this.analytics.destroy();
    for (const off of this.offs.splice(0)) off();
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

export const AdStreamX = {
  create,
  activeCount,
  getCapabilities,
  connectIframe,
  generateEmbedCode,
  createEd25519Verifier,
  VERSION,
  AdStreamXError,
  ConfigError,
};
export default AdStreamX;
