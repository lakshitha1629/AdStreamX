// Public, framework-agnostic types shared by every AdStreamX package.
// Keep this file dependency-free: it is imported by the SDK, the Lab and (later) the API.

export const SCHEMA_VERSION = 1;

export type StreamType = 'vod' | 'live';

export interface TextTrackSource {
  src: string;
  srclang: string;
  label: string;
  kind?: 'subtitles' | 'captions';
  default?: boolean;
}

export interface MediaSourceConfig {
  /** Absolute or page-relative http(s) URL. */
  src: string;
  /** MIME type. Inferred from the URL extension when omitted. */
  type?: string;
  /** Force VOD/live. When omitted the player infers it from the media (duration === Infinity). */
  streamType?: StreamType;
  label?: string;
  /** Epoch ms after which the URL is known to be expired (signed URLs). */
  expiresAt?: number;
  /** Side-loaded WebVTT tracks. */
  textTracks?: TextTrackSource[];
}

export interface LiveConfig {
  /** Desired distance from the live edge, in seconds. */
  targetLatency: number;
  /** Where goLive() lands, in seconds behind the newest available media. */
  liveEdgeOffset: number;
  /** A position within this many seconds of the target counts as "at the live edge". */
  liveEdgeTolerance: number;
  /** Gently raise playbackRate to drift back toward targetLatency. */
  catchUp: boolean;
  /** Upper bound for catch-up playbackRate (e.g. 1.1). */
  maxCatchUpRate: number;
  /** If latency exceeds targetLatency + this, jump to live edge instead of speeding up. */
  maxDriftBeforeSeek: number;
  /** After a failure, return to live edge (true) or attempt the retained DVR position (false). */
  resumeAtLiveEdge: boolean;
}

export interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** 0 = deterministic; 1 = full jitter. */
  jitter: number;
}

export interface ControlsConfig {
  enabled: boolean;
  keyboard: boolean;
  gestures: boolean;
  autoHideMs: number;
  show: {
    playbackRate: boolean;
    quality: boolean;
    captions: boolean;
    audioTracks: boolean;
    pip: boolean;
    theater: boolean;
    fullscreen: boolean;
    volume: boolean;
  };
}

export interface BrandingConfig {
  accentColor: string;
  logoUrl?: string;
  logoAlt?: string;
  title?: string;
}

export type AutoplayPolicy = false | true | 'muted';

export interface PlayerConfig {
  source?: MediaSourceConfig;
  /** Approved fallbacks, tried in order after the primary source fails permanently. */
  fallbackSources: MediaSourceConfig[];
  poster?: string;
  autoplay: AutoplayPolicy;
  /** When unmuted autoplay is blocked, retry muted (true) or wait for a gesture (false). */
  autoplayMutedFallback: boolean;
  muted: boolean;
  volume: number;
  preload: 'none' | 'metadata' | 'auto';
  /** Engine id ('native', future 'hlsjs', 'videojs8') or 'auto'. */
  engine: string;
  live: LiveConfig;
  retry: RetryConfig;
  /** Give up on a load attempt that produced no metadata within this window. */
  startupTimeoutMs: number;
  /** A continuous 'waiting' state longer than this is treated as a network stall. */
  stallTimeoutMs: number;
  /** If non-empty, sources must be served from one of these origins. */
  allowedSourceOrigins: string[];
  controls: ControlsConfig;
  branding: BrandingConfig;
  analytics: AnalyticsConfig;
  commands: CommandsConfig;
  debug: boolean;
}

// ---------------------------------------------------------------------------------------
// Analytics (client collector — server ingest is Phase 8)
// ---------------------------------------------------------------------------------------
export interface AnalyticsConfig {
  /** Off by default: nothing is collected unless the host enables it. */
  enabled: boolean;
  /** HTTPS (or same-origin) endpoint receiving POSTed batches. Without it events stay local. */
  endpoint?: string;
  /** When true, nothing is queued until setConsent(true) is called. */
  requireConsent: boolean;
  batchSize: number;
  flushIntervalMs: number;
  /** Oldest events are dropped beyond this (counted in getStats().dropped). */
  maxQueue: number;
  /** 0..1, decided once per playback session. */
  sampleRate: number;
  heartbeatIntervalMs: number;
}

// ---------------------------------------------------------------------------------------
// Remote commands (live control room transport is Phase 7)
// ---------------------------------------------------------------------------------------
export interface CommandsConfig {
  /** Accept commands at all (API, iframe host, operator channel). */
  enabled: boolean;
  /** Max tolerated clock skew for issuedAt/expiresAt checks. */
  maxClockSkewMs: number;
  /** Default lifetime when a command has no expiresAt. */
  defaultTtlMs: number;
}

/**
 * Who sent a command. Viewer = the person watching (local UI); host = the embedding
 * application (trusted origin); operator = live administration, only with a verified signature.
 */
export type CommandRole = 'viewer' | 'host' | 'operator';

export type CommandType =
  | 'play'
  | 'pause'
  | 'seek'
  | 'setVolume'
  | 'setMuted'
  | 'goLive'
  | 'setQuality'
  | 'setTextTrack'
  | 'setSource'
  | 'updateConfig'
  | 'announce'
  | 'showOverlay'
  | 'hideOverlay'
  | 'openPoll'
  | 'closePoll'
  | 'startAdBreak'
  | 'cancelAdBreak';

export interface PlayerCommand {
  /** Command schema version. */
  v: 1;
  /** Stable id (idempotency key): 1–64 chars of [A-Za-z0-9_-]. */
  id: string;
  type: CommandType;
  /** Epoch ms (UTC) when issued. */
  issuedAt: number;
  /** Epoch ms (UTC) after which the command must not be applied. */
  expiresAt?: number;
  payload?: Record<string, unknown>;
  /** Detached signature (base64url Ed25519) — required for operator commands. */
  sig?: string;
  /** Key id for signature verification. */
  kid?: string;
}

export type CommandAckStatus = 'applied' | 'duplicate' | 'rejected';
export interface CommandAck {
  id: string;
  type: string;
  status: CommandAckStatus;
  /** Machine-readable reason when rejected. */
  reason?: 'INVALID' | 'EXPIRED' | 'NOT_YET_VALID' | 'FORBIDDEN' | 'UNVERIFIED' | 'FEATURE_UNAVAILABLE' | 'DISABLED' | 'FAILED';
  detail?: string;
  at: number;
}

// ---------------------------------------------------------------------------------------
// Contracts for later-phase engines (ads Phase 3, overlays Phase 4, polls Phase 5).
// Events are typed now so hosts can subscribe; they fire once an engine is registered.
// ---------------------------------------------------------------------------------------
export type AdBreakPosition = 'preroll' | 'midroll' | 'postroll' | 'live';
export interface AdBreakRequest {
  breakId?: string;
  position: AdBreakPosition;
  adTagUrl?: string;
  maxDurationMs?: number;
}
export interface AdInfo {
  breakId: string;
  position: AdBreakPosition;
  provider: string;
  adId?: string;
  creativeId?: string;
  podIndex?: number;
  podSize?: number;
  durationSec?: number;
  skippable?: boolean;
}
export interface OverlayRef {
  overlayId: string;
  overlayType: string;
}
export interface PollResults {
  pollId: string;
  version: number;
  totalVotes: number;
  options: { optionId: string; votes: number; percent: number }[];
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends (infer U)[] ? U[] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};
export type PlayerConfigInput = DeepPartial<PlayerConfig>;

export type PlayerStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'buffering'
  | 'ended'
  | 'recovering'
  | 'error'
  | 'destroyed';

export type PlayerErrorCode =
  | 'INVALID_SOURCE'
  | 'SOURCE_NOT_ALLOWED'
  | 'UNSUPPORTED_FORMAT'
  | 'MISSING_FILE'
  | 'INVALID_MANIFEST'
  | 'EXPIRED_URL'
  | 'FORBIDDEN'
  | 'NETWORK'
  | 'SERVER'
  | 'DECODE'
  | 'STARTUP_TIMEOUT'
  | 'STALLED'
  | 'PLAY_BLOCKED'
  | 'DESTROYED'
  | 'FEATURE_UNAVAILABLE'
  | 'PERMISSION_DENIED'
  | 'INVALID_COMMAND'
  | 'UNKNOWN';

export interface PlayerErrorInfo {
  code: PlayerErrorCode;
  /** Short, viewer-safe message suitable for display. */
  message: string;
  /** Technical detail for logs and diagnostics. */
  detail?: string;
  httpStatus?: number;
  /** Whether automatic retry may help. */
  recoverable: boolean;
  /** True when the player has given up on every source. */
  fatal: boolean;
  sourceUrl?: string;
  timestamp: number;
}

export interface QualityLevel {
  id: string;
  label: string;
  height?: number;
  width?: number;
  bitrate?: number;
}

export interface TrackInfo {
  id: string;
  label: string;
  language: string;
  kind: string;
  active: boolean;
}

export interface LiveInfo {
  /**
   * Seconds behind live. With a seekable window (dvr: true) this is seekableEnd - currentTime.
   * Without one (estimated: true) it is an estimate: initial buffer-ahead plus the drift
   * between wall-clock time and media time since joining (pauses, stalls).
   */
  latency: number;
  /** A seekable DVR window is exposed by the engine. */
  dvr: boolean;
  /** latency is an estimate (engine exposes no seekable range). */
  estimated: boolean;
  atLiveEdge: boolean;
  /** Size of the seekable (DVR) window in seconds. */
  dvrWindow: number;
  seekableStart: number;
  seekableEnd: number;
}

export interface PlayerState {
  status: PlayerStatus;
  engine: string | null;
  source: MediaSourceConfig | null;
  /** Index into [primary, ...fallbackSources]. */
  sourceIndex: number;
  streamType: StreamType | null;
  currentTime: number;
  duration: number;
  bufferedEnd: number;
  paused: boolean;
  ended: boolean;
  seeking: boolean;
  buffering: boolean;
  volume: number;
  muted: boolean;
  playbackRate: number;
  live: LiveInfo | null;
  qualityLevels: QualityLevel[];
  /** 'auto' or the id of a manually selected level. */
  qualitySelection: string;
  /** Rendition currently displayed, if the engine reports it. */
  currentQuality: QualityLevel | null;
  videoWidth: number;
  videoHeight: number;
  textTracks: TrackInfo[];
  audioTracks: TrackInfo[];
  fullscreen: boolean;
  pictureInPicture: boolean;
  theater: boolean;
  retryAttempt: number;
  error: PlayerErrorInfo | null;
  startupTimeMs: number | null;
}

export interface Capabilities {
  mp4H264: boolean;
  nativeHls: boolean;
  mediaSource: boolean;
  managedMediaSource: boolean;
  fullscreen: boolean;
  /** iOS-style fullscreen on the <video> element only. */
  videoElementFullscreen: boolean;
  pictureInPicture: boolean;
  audioTrackApi: boolean;
  videoTrackApi: boolean;
  textTracks: boolean;
  touch: boolean;
  engines: string[];
}

export interface PlayerEventMap {
  ready: { state: PlayerState };
  loadstart: { source: MediaSourceConfig; engine: string; attempt: number };
  loadedmetadata: { duration: number; streamType: StreamType };
  play: Record<string, never>;
  playing: Record<string, never>;
  pause: Record<string, never>;
  ended: Record<string, never>;
  seeking: { target: number };
  seeked: { currentTime: number };
  timeupdate: { currentTime: number; duration: number };
  bufferingstart: { currentTime: number };
  bufferingend: { currentTime: number; durationMs: number };
  volumechange: { volume: number; muted: boolean };
  ratechange: { playbackRate: number };
  qualitychange: { selection: string; current: QualityLevel | null };
  qualitylevels: { levels: QualityLevel[] };
  texttrackchange: { tracks: TrackInfo[] };
  audiotrackchange: { tracks: TrackInfo[] };
  liveedgereached: { latency: number };
  livelatencychange: { latency: number; atLiveEdge: boolean };
  fullscreenchange: { fullscreen: boolean };
  pictureinpicturechange: { pictureInPicture: boolean };
  theaterchange: { theater: boolean };
  autoplayblocked: { mutedFallback: boolean };
  retry: { attempt: number; delayMs: number; error: PlayerErrorInfo };
  fallback: { from: number; to: number; source: MediaSourceConfig; error: PlayerErrorInfo };
  sourcechange: { source: MediaSourceConfig | null };
  error: PlayerErrorInfo;
  statechange: { state: PlayerState; changed: (keyof PlayerState)[] };
  configupdated: { config: PlayerConfig };
  destroyed: Record<string, never>;

  // advertising (fired by an ad engine — Phase 3)
  adbreakstart: { breakId: string; position: AdBreakPosition };
  adbreakend: { breakId: string; position: AdBreakPosition; reason: 'completed' | 'skipped' | 'error' | 'cancelled' | 'timeout' | 'nofill' };
  adrequest: { breakId: string; position: AdBreakPosition; provider: string };
  adloaded: AdInfo;
  adstarted: AdInfo;
  adquartile: AdInfo & { quartile: 1 | 2 | 3 };
  adcompleted: AdInfo;
  adskipped: AdInfo;
  aderror: { breakId?: string; provider: string; code: string; message: string };
  // overlays (Phase 4)
  overlayshown: OverlayRef;
  overlayclosed: OverlayRef & { reason: 'user' | 'expired' | 'command' | 'replaced' };
  overlayclicked: OverlayRef & { targetUrl?: string };
  // polls & interactions (Phase 5)
  polldisplayed: { pollId: string };
  voteaccepted: { pollId: string; optionIds: string[] };
  pollresultsupdated: PollResults;
  // commands & announcements
  commandreceived: { id: string; type: string; role: CommandRole };
  commandapplied: CommandAck;
  commandrejected: CommandAck;
  announcement: { id: string; text: string; level: 'info' | 'warning'; durationMs: number };
  // analytics
  analyticsflush: { count: number; ok: boolean; status?: number };
  // plugins
  pluginregistered: { name: string; provides: string[] };
}

/** Events that plugins and controllers may emit (core playback events stay core-only). */
export type ExtensionEventName =
  | 'adbreakstart' | 'adbreakend' | 'adrequest' | 'adloaded' | 'adstarted' | 'adquartile' | 'adcompleted' | 'adskipped' | 'aderror'
  | 'overlayshown' | 'overlayclosed' | 'overlayclicked'
  | 'polldisplayed' | 'voteaccepted' | 'pollresultsupdated'
  | 'commandreceived' | 'commandapplied' | 'commandrejected' | 'announcement'
  | 'analyticsflush' | 'pluginregistered';

export type PlayerEventName = keyof PlayerEventMap;
export type Unsubscribe = () => void;
