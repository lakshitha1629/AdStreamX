import type { Capabilities, MediaSourceConfig, PlayerConfig, QualityLevel, TrackInfo } from '@adstreamx/shared-types';
import type { SourceKind } from './source.ts';

/** Notifications an adapter sends to the core. */
export type AdapterSignal =
  | { type: 'qualitylevels'; levels: QualityLevel[] }
  | { type: 'qualitychange'; current: QualityLevel | null }
  | { type: 'audiotracks' }
  | { type: 'error'; fatal: boolean; detail: string; httpStatus?: number };

export interface AdapterContext {
  video: HTMLVideoElement;
  config: PlayerConfig;
  signal: (s: AdapterSignal) => void;
  log: (msg: string, data?: unknown) => void;
}

/**
 * A playback engine. The core owns the <video> element and lifecycle; an adapter only
 * knows how to get a given source playing in that element and to expose engine-level
 * features (renditions, audio tracks). See docs/adr/0003-playback-adapters.md.
 */
export interface PlaybackAdapter {
  readonly id: string;
  load(source: MediaSourceConfig & { type: string | undefined }, kind: SourceKind): void;
  /** Stop network activity and detach the current source. Must be idempotent. */
  unload(): void;
  getQualityLevels(): QualityLevel[];
  /** 'auto' or a level id. Returns false when the engine cannot honour the request. */
  setQuality(id: string): boolean;
  getCurrentQuality(): QualityLevel | null;
  getAudioTracks(): TrackInfo[];
  setAudioTrack(id: string): boolean;
  destroy(): void;
}

export interface PlaybackAdapterFactory {
  readonly id: string;
  readonly label: string;
  /** Experimental adapters are never chosen by engine: 'auto'. */
  readonly experimental?: boolean;
  canPlay(kind: SourceKind, caps: Capabilities): boolean;
  create(ctx: AdapterContext): PlaybackAdapter;
}
