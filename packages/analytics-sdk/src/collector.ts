import type { AnalyticsConfig } from '@adstreamx/shared-types';

export const ANALYTICS_SCHEMA_VERSION = 1;

export type AnalyticsValue = string | number | boolean | null;
export interface AnalyticsEvent {
  /** Unique per event; the ingest API deduplicates on it (retries resend the same id). */
  eventId: string;
  /** Random per playback session; never persisted, never derived from user data. */
  sessionId: string;
  seq: number;
  type: string;
  /** Epoch ms, client clock. */
  ts: number;
  mediaTime?: number;
  data?: Record<string, AnalyticsValue>;
}

export interface AnalyticsBatch {
  schema: number;
  sentAt: number;
  events: AnalyticsEvent[];
}

export interface TransportResult {
  ok: boolean;
  status?: number;
}
export type Transport = (endpoint: string, body: string, opts: { beacon: boolean }) => Promise<TransportResult>;

export interface CollectorStats {
  enabled: boolean;
  sampled: boolean;
  consent: boolean;
  queued: number;
  inFlight: number;
  sent: number;
  dropped: number;
  rejected: number;
  failedAttempts: number;
  duplicatesIgnored: number;
}

export interface CollectorOptions {
  config: AnalyticsConfig;
  transport?: Transport;
  now?: () => number;
  random?: () => number;
  uuid?: () => string;
  onFlush?: (r: { count: number; ok: boolean; status?: number }) => void;
  /** For tests: disable timers (flush only when called). */
  manualTimers?: boolean;
}

const MAX_STRING = 256;
const MAX_DATA_KEYS = 24;
const MAX_BEACON_BYTES = 60 * 1024;
const MAX_DEDUPE_KEYS = 5000;

/**
 * Player-agnostic analytics queue. Collection is off unless `enabled`; with
 * `requireConsent` nothing is even queued until consent is granted, and revoking consent
 * discards anything not yet sent.
 */
export class AnalyticsCollector {
  readonly sessionId: string;
  private config: AnalyticsConfig;
  private readonly transport: Transport;
  private readonly now: () => number;
  private readonly uuid: () => string;
  private readonly onFlush?: CollectorOptions['onFlush'];
  private readonly sampled: boolean;
  private consent: boolean;
  private queue: AnalyticsEvent[] = [];
  private inFlight: AnalyticsEvent[] = [];
  private seq = 0;
  private dedupe = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private backoffUntil = 0;
  private backoffMs = 0;
  private destroyed = false;
  private stats = { sent: 0, dropped: 0, rejected: 0, failedAttempts: 0, duplicatesIgnored: 0 };
  private readonly manualTimers: boolean;

  constructor(opts: CollectorOptions) {
    this.config = { ...opts.config };
    this.transport = opts.transport ?? defaultTransport;
    this.now = opts.now ?? (() => Date.now());
    this.uuid = opts.uuid ?? (() => globalThis.crypto.randomUUID());
    this.onFlush = opts.onFlush;
    this.manualTimers = !!opts.manualTimers;
    this.sessionId = this.uuid();
    this.sampled = (opts.random ?? Math.random)() < this.config.sampleRate;
    this.consent = !this.config.requireConsent;
    this.startTimer();
  }

  /** Whether events are currently being accepted. */
  get active(): boolean {
    return !this.destroyed && this.config.enabled && this.sampled && this.consent;
  }

  setConsent(granted: boolean): void {
    this.consent = granted || !this.config.requireConsent;
    if (!this.consent) {
      this.queue = []; // revoking consent discards unsent data
    }
  }

  hasConsent(): boolean {
    return this.consent;
  }

  updateConfig(config: AnalyticsConfig): void {
    const wasRequired = this.config.requireConsent;
    this.config = { ...config };
    if (wasRequired && !config.requireConsent) this.consent = true;
    if (!wasRequired && config.requireConsent) this.setConsent(false);
    this.startTimer();
  }

  /**
   * Queue an event. `dedupeKey` makes it idempotent within the session (e.g. one impression
   * per break+creative). Returns the queued event, or null when not collected.
   */
  track(type: string, data?: Record<string, unknown>, opts: { mediaTime?: number; dedupeKey?: string } = {}): AnalyticsEvent | null {
    if (!this.active) return null;
    if (!/^[a-z][a-z0-9_]{0,48}$/.test(type)) return null;
    if (opts.dedupeKey) {
      if (this.dedupe.has(opts.dedupeKey)) {
        this.stats.duplicatesIgnored++;
        return null;
      }
      this.dedupe.add(opts.dedupeKey);
      if (this.dedupe.size > MAX_DEDUPE_KEYS) this.dedupe.delete(this.dedupe.values().next().value as string);
    }
    const ev: AnalyticsEvent = {
      eventId: this.uuid(),
      sessionId: this.sessionId,
      seq: ++this.seq,
      type,
      ts: this.now(),
    };
    if (opts.mediaTime !== undefined && Number.isFinite(opts.mediaTime)) ev.mediaTime = Math.round(opts.mediaTime * 1000) / 1000;
    const clean = sanitizeData(data);
    if (clean) ev.data = clean;
    this.queue.push(ev);
    if (this.queue.length > this.config.maxQueue) {
      const over = this.queue.length - this.config.maxQueue;
      this.queue.splice(0, over);
      this.stats.dropped += over;
    }
    if (this.queue.length >= this.config.batchSize) void this.flush();
    return ev;
  }

  /** Send one batch. Safe to call concurrently (only one request in flight). */
  async flush(): Promise<TransportResult & { count: number }> {
    const endpoint = this.config.endpoint;
    if (!endpoint || this.inFlight.length > 0 || this.queue.length === 0) return { ok: true, count: 0 };
    if (this.now() < this.backoffUntil) return { ok: false, count: 0 };
    const batch = this.queue.splice(0, this.config.batchSize);
    this.inFlight = batch;
    let result: TransportResult;
    try {
      result = await this.transport(endpoint, JSON.stringify(this.makeBatch(batch)), { beacon: false });
    } catch {
      result = { ok: false };
    }
    this.inFlight = [];
    if (result.ok) {
      this.stats.sent += batch.length;
      this.backoffMs = 0;
      this.backoffUntil = 0;
    } else if (result.status !== undefined && result.status >= 400 && result.status < 500 && result.status !== 408 && result.status !== 429) {
      this.stats.rejected += batch.length; // the server refused this payload: retrying will not help
    } else {
      this.stats.failedAttempts++;
      if (this.consent) this.queue.unshift(...batch); // retry later with the SAME eventIds
      this.backoffMs = Math.min(60000, this.backoffMs ? this.backoffMs * 2 : 1000);
      this.backoffUntil = this.now() + this.backoffMs;
    }
    this.onFlush?.({ count: batch.length, ok: result.ok, status: result.status });
    return { ...result, count: batch.length };
  }

  /** Best-effort send of everything queued, for page hide / unload. */
  flushWithBeacon(): number {
    const endpoint = this.config.endpoint;
    if (!endpoint || this.queue.length === 0) return 0;
    let sent = 0;
    while (this.queue.length) {
      const chunk: AnalyticsEvent[] = [];
      let bytes = 64;
      while (this.queue.length && bytes + JSON.stringify(this.queue[0]).length < MAX_BEACON_BYTES) {
        const ev = this.queue.shift()!;
        bytes += JSON.stringify(ev).length + 1;
        chunk.push(ev);
      }
      if (!chunk.length) chunk.push(this.queue.shift()!);
      void this.transport(endpoint, JSON.stringify(this.makeBatch(chunk)), { beacon: true });
      sent += chunk.length;
    }
    this.stats.sent += sent;
    return sent;
  }

  getQueue(): AnalyticsEvent[] {
    return this.queue.map((e) => ({ ...e, data: e.data ? { ...e.data } : undefined }));
  }

  getStats(): CollectorStats {
    return {
      enabled: this.config.enabled,
      sampled: this.sampled,
      consent: this.consent,
      queued: this.queue.length,
      inFlight: this.inFlight.length,
      ...this.stats,
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    if (this.active) this.flushWithBeacon();
    this.destroyed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.queue = [];
  }

  private makeBatch(events: AnalyticsEvent[]): AnalyticsBatch {
    return { schema: ANALYTICS_SCHEMA_VERSION, sentAt: this.now(), events };
  }

  private startTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.manualTimers || this.destroyed || !this.config.enabled) return;
    this.timer = setInterval(() => void this.flush(), this.config.flushIntervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }
}

/** Primitive values only; strings truncated; URLs lose query string and fragment (tokens). */
export function sanitizeData(data: Record<string, unknown> | undefined): Record<string, AnalyticsValue> | undefined {
  if (!data) return undefined;
  const out: Record<string, AnalyticsValue> = {};
  let n = 0;
  for (const [k, v] of Object.entries(data)) {
    if (n >= MAX_DATA_KEYS) break;
    if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(k)) continue;
    let val: AnalyticsValue;
    if (v === null || typeof v === 'boolean') val = v;
    else if (typeof v === 'number') {
      if (!Number.isFinite(v)) continue;
      val = Math.round(v * 1000) / 1000;
    } else if (typeof v === 'string') val = (looksLikeUrl(v) ? stripUrl(v) : v).slice(0, MAX_STRING);
    else continue;
    out[k] = val;
    n++;
  }
  return n ? out : undefined;
}

function looksLikeUrl(s: string): boolean {
  return /^(https?:)?\/\//i.test(s) || /^\/[^\s]*\?/.test(s);
}

/**
 * Keep origin + path; drop query and fragment (often auth tokens) and redact path segments
 * that look like tokens or expiry stamps (path-token signed URLs: /signed/<exp>/<sig>/…).
 */
export function stripUrl(u: string): string {
  let base: string;
  let path: string;
  try {
    const url = new URL(u, 'http://relative.invalid');
    base = url.origin === 'http://relative.invalid' ? '' : url.origin;
    path = url.pathname;
  } catch {
    base = '';
    path = u.split(/[?#]/)[0] ?? '';
  }
  return base + path.split('/').map((seg) => (isTokenLike(seg) ? ':redacted' : seg)).join('/');
}

function isTokenLike(seg: string): boolean {
  if (/^\d{9,}$/.test(seg)) return true; // epoch-style expiry
  if (/^[0-9a-f]{16,}$/i.test(seg)) return true; // hex digests / HMACs
  // base64url-style secrets: long, mixed case and digits (normal slugs are lowercase words)
  return seg.length >= 24 && /^[A-Za-z0-9_=-]+$/.test(seg) && /[A-Z]/.test(seg) && /[a-z]/.test(seg) && /\d/.test(seg);
}

const defaultTransport: Transport = async (endpoint, body, { beacon }) => {
  if (beacon && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    const ok = navigator.sendBeacon(endpoint, new Blob([body], { type: 'application/json' }));
    return { ok };
  }
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    keepalive: body.length < 60000,
    credentials: 'omit',
  });
  return { ok: res.ok, status: res.status };
};
