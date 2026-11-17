// AdStreamX iframe embed protocol, version 1 (docs/player/EMBED_PROTOCOL.md).

export const PROTOCOL_NAME = 'adstreamx-embed';
export const PROTOCOL_VERSION = 1;
export const MAX_MESSAGE_BYTES = 16 * 1024;

export type EnvelopeKind = 'request' | 'response' | 'event' | 'ready';

export type RequestMethod =
  | 'hello'
  | 'getState'
  | 'getCapabilities'
  | 'subscribe'
  | 'unsubscribe'
  | 'command'
  | 'operatorCommand';

export const REQUEST_METHODS: readonly RequestMethod[] = ['hello', 'getState', 'getCapabilities', 'subscribe', 'unsubscribe', 'command', 'operatorCommand'];

/** Events a host may subscribe to (high-frequency ones are opt-in, never default). */
export const SUBSCRIBABLE_EVENTS = [
  'ready', 'loadstart', 'loadedmetadata', 'play', 'playing', 'pause', 'ended', 'seeking', 'seeked', 'timeupdate',
  'bufferingstart', 'bufferingend', 'volumechange', 'ratechange', 'qualitychange', 'texttrackchange', 'audiotrackchange',
  'liveedgereached', 'livelatencychange', 'fullscreenchange', 'pictureinpicturechange', 'theaterchange', 'autoplayblocked',
  'retry', 'fallback', 'sourcechange', 'error', 'configupdated', 'destroyed',
  'adbreakstart', 'adbreakend', 'adrequest', 'adloaded', 'adstarted', 'adquartile', 'adcompleted', 'adskipped', 'aderror',
  'overlayshown', 'overlayclosed', 'overlayclicked', 'polldisplayed', 'voteaccepted', 'pollresultsupdated',
  'commandapplied', 'commandrejected', 'announcement',
] as const;
export type SubscribableEvent = (typeof SUBSCRIBABLE_EVENTS)[number];

export interface Envelope {
  protocol: typeof PROTOCOL_NAME;
  version: typeof PROTOCOL_VERSION;
  /** Pairs a host with one specific embed (several players can live on one page). */
  channel: string;
  kind: EnvelopeKind;
  /** Request id (kind=request) — echoed as replyTo in the response. */
  id?: string;
  replyTo?: string;
  method?: RequestMethod;
  /** Event name (kind=event). */
  name?: string;
  ok?: boolean;
  payload?: unknown;
  error?: { code: string; message: string };
}

const CHANNEL_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidChannel(c: unknown): c is string {
  return typeof c === 'string' && CHANNEL_RE.test(c);
}

/**
 * Structural validation of an incoming message. Anything that is not a well-formed v1
 * envelope is ignored silently (pages receive unrelated postMessage traffic all the time).
 */
export function parseEnvelope(data: unknown): Envelope | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  if (d.protocol !== PROTOCOL_NAME) return null;
  if (d.version !== PROTOCOL_VERSION) return null;
  if (!isValidChannel(d.channel)) return null;
  if (!['request', 'response', 'event', 'ready'].includes(d.kind as string)) return null;
  let size: number;
  try {
    size = JSON.stringify(d).length;
  } catch {
    return null;
  }
  if (size > MAX_MESSAGE_BYTES) return null;
  if (d.kind === 'request') {
    if (typeof d.id !== 'string' || !ID_RE.test(d.id)) return null;
    if (!REQUEST_METHODS.includes(d.method as RequestMethod)) return null;
  }
  if (d.kind === 'response' && (typeof d.replyTo !== 'string' || !ID_RE.test(d.replyTo))) return null;
  if (d.kind === 'event' && (typeof d.name !== 'string' || d.name.length > 40)) return null;
  return d as unknown as Envelope;
}

export function envelope(channel: string, kind: EnvelopeKind, rest: Partial<Envelope> = {}): Envelope {
  return { protocol: PROTOCOL_NAME, version: PROTOCOL_VERSION, channel, kind, ...rest };
}

/** Exact origin: scheme://host[:port], no path, no wildcard. */
export function isExactOrigin(o: unknown): o is string {
  // '*' is a legal host character to the URL parser, so wildcards must be refused explicitly.
  if (typeof o !== 'string' || o.includes('*') || o === 'null') return false;
  try {
    const u = new URL(o);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === o;
  } catch {
    return false;
  }
}

/** JSON-safe deep copy (drops functions, converts Infinity/NaN to null) for postMessage. */
export function toWire<T>(v: T): unknown {
  return JSON.parse(JSON.stringify(v, (_k, val) => (typeof val === 'number' && !Number.isFinite(val) ? null : val)));
}

/** Simple token bucket per key. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  private readonly perSecond: number;
  private readonly burst: number;
  private readonly now: () => number;
  constructor(perSecond: number, burst: number, now: () => number = () => Date.now()) {
    this.perSecond = perSecond;
    this.burst = burst;
    this.now = now;
  }
  take(key: string): boolean {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.burst, at: t };
    b.tokens = Math.min(this.burst, b.tokens + ((t - b.at) / 1000) * this.perSecond);
    b.at = t;
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    this.buckets.set(key, b);
    return ok;
  }
}
