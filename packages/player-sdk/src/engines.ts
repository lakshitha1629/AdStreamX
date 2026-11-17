import type {
  AdBreakRequest,
  ExtensionEventName,
  OverlayRef,
  PlayerEventMap,
  PollResults,
} from '@adstreamx/shared-types';
import type { AdStreamXPlayer } from './index.ts';

/**
 * Engine contracts implemented by later phases (Phase 3 ads, Phase 4 overlays, Phase 5
 * polls). Controllers delegate to a registered engine; without one they report
 * `available: false` and reject with FEATURE_UNAVAILABLE — nothing is simulated.
 */
export interface AdEngineCapabilities {
  linear: boolean;
  nonLinear: boolean;
  companions: boolean;
  skippable: boolean;
  vmap: boolean;
  liveBreaks: boolean;
}
export interface AdEngine {
  readonly provider: string;
  capabilities(): AdEngineCapabilities;
  requestBreak(req: AdBreakRequest): Promise<void>;
  /** Cancel a pending (not yet playing) break. */
  cancelBreak(breakId?: string): boolean;
  /** Skip the current ad if the provider says it is skippable now. */
  skip(): boolean;
  isBreakActive(): boolean;
  destroy(): void;
}

export interface OverlayEngine {
  show(overlayId: string): Promise<void>;
  hide(overlayId: string, reason: 'user' | 'command'): boolean;
  list(): OverlayRef[];
  destroy(): void;
}

export interface InteractionEngine {
  open(pollId: string): Promise<void>;
  close(pollId: string): boolean;
  vote(pollId: string, optionIds: string[]): Promise<void>;
  results(pollId: string): PollResults | null;
  destroy(): void;
}

export interface PluginContext {
  readonly player: AdStreamXPlayer;
  /** Emit an extension event (ads/overlays/polls/…); core playback events cannot be emitted. */
  emit<K extends ExtensionEventName>(event: K, payload: PlayerEventMap[K]): void;
  registerAdEngine(engine: AdEngine): void;
  registerOverlayEngine(engine: OverlayEngine): void;
  registerInteractionEngine(engine: InteractionEngine): void;
}

export interface PlayerPlugin {
  /** Unique per player: 1–40 chars [a-z0-9-]. */
  readonly name: string;
  /** Return a cleanup function; it runs on unregister or player destroy. */
  setup(ctx: PluginContext): void | (() => void);
}
