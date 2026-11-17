import type { CommandAck, CommandRole } from '@adstreamx/shared-types';
import { envelope, isExactOrigin, parseEnvelope, RateLimiter, SUBSCRIBABLE_EVENTS, toWire, type Envelope, type SubscribableEvent } from './protocol.ts';

/** The subset of the player the embed bridge needs (keeps this package SDK-independent). */
export interface EmbeddablePlayer {
  getState(): unknown;
  getCapabilities(): unknown;
  on(event: string, fn: (payload: unknown) => void): () => void;
  command(cmd: unknown, role: CommandRole): Promise<CommandAck>;
}

export interface EmbedServerOptions {
  player: EmbeddablePlayer;
  /** Exact origins allowed to control this embed. Empty = nobody (no wildcard, ever). */
  allowedOrigins: string[];
  channel: string;
  /** Window of the embedding page (window.parent). */
  target: Window;
  /** Window to listen on (the iframe's own window). */
  self: Window;
  version: string;
  rateLimitPerSecond?: number;
}

/**
 * Runs inside the iframe. Every request must come from `target` (the parent window), carry
 * our channel and originate from an allowlisted exact origin. Replies and events are posted
 * with that exact origin as targetOrigin, so data can never leak to another origin even if
 * the parent navigates.
 */
export class EmbedServer {
  private readonly o: EmbedServerOptions;
  private readonly allowed: Set<string>;
  private readonly limiter: RateLimiter;
  private readonly subs = new Map<string, Map<SubscribableEvent, () => void>>();
  private readonly onMessage = (e: MessageEvent) => this.handle(e);
  private destroyed = false;
  /** Rejected-origin diagnostics (count per origin), visible via getStats(). */
  private rejected = new Map<string, number>();

  constructor(o: EmbedServerOptions) {
    this.o = o;
    this.allowed = new Set(o.allowedOrigins.filter(isExactOrigin));
    this.limiter = new RateLimiter(o.rateLimitPerSecond ?? 50, (o.rateLimitPerSecond ?? 50) * 2);
    o.self.addEventListener('message', this.onMessage);
    // Announce readiness to each allowed origin explicitly; the browser drops it if the
    // parent is a different origin, so nothing is disclosed to an unknown embedder.
    for (const origin of this.allowed) this.post(origin, envelope(o.channel, 'ready', { payload: { version: o.version, protocol: 1 } }));
  }

  getStats() {
    return { allowedOrigins: [...this.allowed], subscribers: [...this.subs.keys()], rejected: Object.fromEntries(this.rejected) };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.o.self.removeEventListener('message', this.onMessage);
    for (const m of this.subs.values()) for (const off of m.values()) off();
    this.subs.clear();
  }

  private async handle(e: MessageEvent): Promise<void> {
    if (this.destroyed || e.source !== this.o.target) return;
    const msg = parseEnvelope(e.data);
    if (!msg || msg.kind !== 'request' || msg.channel !== this.o.channel) return;
    const origin = e.origin;
    const trusted = this.allowed.has(origin);
    if (!trusted) {
      this.rejected.set(origin, (this.rejected.get(origin) ?? 0) + 1);
      // Only a minimal hello answer goes back to an untrusted origin: no state, no events.
      if (msg.method === 'hello' && isExactOrigin(origin)) this.reply(origin, msg, true, { trusted: false, protocol: 1 });
      return;
    }
    if (!this.limiter.take(origin)) return this.fail(origin, msg, 'RATE_LIMITED', 'too many messages');
    try {
      switch (msg.method) {
        case 'hello':
          return this.reply(origin, msg, true, { trusted: true, protocol: 1, version: this.o.version, events: SUBSCRIBABLE_EVENTS });
        case 'getState':
          return this.reply(origin, msg, true, this.o.player.getState());
        case 'getCapabilities':
          return this.reply(origin, msg, true, this.o.player.getCapabilities());
        case 'subscribe':
        case 'unsubscribe': {
          const names = (msg.payload as { events?: unknown })?.events;
          if (!Array.isArray(names) || names.length > SUBSCRIBABLE_EVENTS.length || names.some((n) => !SUBSCRIBABLE_EVENTS.includes(n))) {
            return this.fail(origin, msg, 'INVALID', 'events must be a list of subscribable event names');
          }
          if (msg.method === 'subscribe') this.subscribe(origin, names as SubscribableEvent[]);
          else this.unsubscribe(origin, names as SubscribableEvent[]);
          return this.reply(origin, msg, true, { events: [...(this.subs.get(origin)?.keys() ?? [])] });
        }
        case 'command':
        case 'operatorCommand': {
          const cmd = (msg.payload as { command?: unknown })?.command;
          // operatorCommand still needs a valid signature — enforced by the command controller.
          const ack = await this.o.player.command(cmd, msg.method === 'operatorCommand' ? 'operator' : 'host');
          return this.reply(origin, msg, ack.status !== 'rejected', ack);
        }
      }
    } catch (err) {
      return this.fail(origin, msg, 'FAILED', (err as Error).message);
    }
  }

  private subscribe(origin: string, names: SubscribableEvent[]): void {
    let m = this.subs.get(origin);
    if (!m) this.subs.set(origin, (m = new Map()));
    for (const name of names) {
      if (m.has(name)) continue;
      m.set(
        name,
        this.o.player.on(name, (payload) => this.post(origin, envelope(this.o.channel, 'event', { name, payload: toWire(payload ?? {}) }))),
      );
    }
  }

  private unsubscribe(origin: string, names: SubscribableEvent[]): void {
    const m = this.subs.get(origin);
    if (!m) return;
    for (const n of names) {
      m.get(n)?.();
      m.delete(n);
    }
  }

  private reply(origin: string, req: Envelope, ok: boolean, payload: unknown): void {
    this.post(origin, envelope(this.o.channel, 'response', { replyTo: req.id, ok, payload: toWire(payload ?? null) }));
  }

  private fail(origin: string, req: Envelope, code: string, message: string): void {
    this.post(origin, envelope(this.o.channel, 'response', { replyTo: req.id, ok: false, error: { code, message } }));
  }

  private post(origin: string, msg: Envelope): void {
    try {
      this.o.target.postMessage(msg, origin);
    } catch {
      /* parent gone */
    }
  }
}
