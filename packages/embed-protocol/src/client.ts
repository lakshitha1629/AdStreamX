import type { CommandAck, CommandType, PlayerCommand } from '@adstreamx/shared-types';
import { envelope, isExactOrigin, isValidChannel, parseEnvelope, type Envelope, type RequestMethod, type SubscribableEvent } from './protocol.ts';

export interface ConnectOptions {
  /** Exact origin serving the embed page, e.g. "https://player.example.com". Never "*". */
  origin: string;
  /** Must match the channel in the embed URL (default "default"). */
  channel?: string;
  /** Per-request timeout (default 5000 ms). */
  timeoutMs?: number;
}

export class EmbedRequestError extends Error {
  readonly code: string;
  readonly payload?: unknown;
  constructor(code: string, message: string, payload?: unknown) {
    super(message);
    this.name = 'EmbedRequestError';
    this.code = code;
    this.payload = payload;
  }
}

/** Host-page handle for one embedded player iframe. */
export interface EmbedClient {
  /** Resolves once the embed answered a hello as trusted (rejects if not trusted). */
  ready(): Promise<{ version: string }>;
  request<T = unknown>(method: RequestMethod, payload?: unknown): Promise<T>;
  on(event: SubscribableEvent, fn: (payload: unknown) => void): () => void;
  getState<T = Record<string, unknown>>(): Promise<T>;
  command(type: CommandType, payload?: Record<string, unknown>, opts?: { ttlMs?: number }): Promise<CommandAck>;
  /** Relay a command signed by your backend (operator role, signature required). */
  operatorCommand(signed: PlayerCommand): Promise<CommandAck>;
  play(): Promise<CommandAck>;
  pause(): Promise<CommandAck>;
  seekTo(time: number): Promise<CommandAck>;
  setVolume(volume: number): Promise<CommandAck>;
  setMuted(muted: boolean): Promise<CommandAck>;
  goLive(): Promise<CommandAck>;
  setSource(src: string, opts?: { type?: string; streamType?: 'vod' | 'live' }): Promise<CommandAck>;
  destroy(): void;
}

let seq = 0;
const rid = () => `${Date.now().toString(36)}${(++seq).toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/**
 * Connect to an AdStreamX iframe. Only messages from that iframe's window AND the exact
 * expected origin AND our channel are accepted; requests are posted with that origin as
 * targetOrigin, never "*".
 */
export function connectIframe(iframe: HTMLIFrameElement, opts: ConnectOptions): EmbedClient {
  if (!isExactOrigin(opts.origin)) throw new TypeError('connectIframe: origin must be an exact origin like "https://player.example.com" (no "*")');
  const channel = opts.channel ?? 'default';
  if (!isValidChannel(channel)) throw new TypeError('connectIframe: channel must be 1–64 chars [A-Za-z0-9_-]');
  const timeoutMs = opts.timeoutMs ?? 5000;
  const win = iframe.ownerDocument.defaultView!;
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  let readyResolve!: (v: { version: string }) => void;
  let readyReject!: (e: unknown) => void;
  let readySettled = false;
  const readyP = new Promise<{ version: string }>((res, rej) => {
    readyResolve = (v) => {
      readySettled = true;
      res(v);
    };
    readyReject = (e) => {
      readySettled = true;
      rej(e);
    };
  });
  readyP.catch(() => undefined);
  let destroyed = false;

  const onMessage = (e: MessageEvent) => {
    if (destroyed || e.source !== iframe.contentWindow || e.origin !== opts.origin) return;
    const msg = parseEnvelope(e.data);
    if (!msg || msg.channel !== channel) return;
    if (msg.kind === 'ready' && !readySettled) void hello();
    else if (msg.kind === 'response' && msg.replyTo) {
      const p = pending.get(msg.replyTo);
      if (!p) return;
      pending.delete(msg.replyTo);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.payload);
      else p.reject(new EmbedRequestError(msg.error?.code ?? (msg.payload as CommandAck)?.reason ?? 'REJECTED', msg.error?.message ?? (msg.payload as CommandAck)?.detail ?? 'request rejected', msg.payload));
    } else if (msg.kind === 'event' && msg.name) {
      for (const fn of listeners.get(msg.name) ?? []) {
        try {
          fn(msg.payload);
        } catch (err) {
          console.error('[AdStreamX embed] listener threw', err);
        }
      }
    }
  };
  win.addEventListener('message', onMessage);

  const send = (method: RequestMethod, payload?: unknown): Promise<unknown> => {
    if (destroyed) return Promise.reject(new EmbedRequestError('DESTROYED', 'client destroyed'));
    const target = iframe.contentWindow;
    if (!target) return Promise.reject(new EmbedRequestError('NO_WINDOW', 'iframe has no window'));
    const id = rid();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new EmbedRequestError('TIMEOUT', `${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      target.postMessage(envelope(channel, 'request', { id, method, payload }) satisfies Envelope, opts.origin);
    });
  };

  const hello = async () => {
    try {
      const r = (await send('hello')) as { trusted: boolean; version?: string };
      if (r?.trusted) {
        readyResolve({ version: r.version ?? '' });
        const events = [...listeners.keys()];
        if (events.length) await send('subscribe', { events });
      } else readyReject(new EmbedRequestError('NOT_TRUSTED', 'this page origin is not in the embed allowlist'));
    } catch (e) {
      if (!readySettled && (e as EmbedRequestError).code !== 'TIMEOUT') readyReject(e);
    }
  };

  // The iframe may already be loaded (ready event missed): poll with hello until settled.
  const helloTimer = setInterval(() => {
    if (readySettled || destroyed) return clearInterval(helloTimer);
    void hello();
  }, 500);
  void hello();

  const command = (type: CommandType, payload?: Record<string, unknown>, o: { ttlMs?: number } = {}) => {
    const issuedAt = Date.now();
    const cmd: PlayerCommand = { v: 1, id: rid(), type, issuedAt, expiresAt: issuedAt + (o.ttlMs ?? 30000), payload: payload ?? {} };
    return send('command', { command: cmd }) as Promise<CommandAck>;
  };

  return {
    ready: () => readyP,
    request: <T>(m: RequestMethod, p?: unknown) => send(m, p) as Promise<T>,
    on(event, fn) {
      let set = listeners.get(event);
      if (!set) {
        listeners.set(event, (set = new Set()));
        if (readySettled) void send('subscribe', { events: [event] }).catch(() => undefined);
      }
      set.add(fn);
      return () => {
        set!.delete(fn);
        if (set!.size === 0) {
          listeners.delete(event);
          void send('unsubscribe', { events: [event] }).catch(() => undefined);
        }
      };
    },
    getState: <T>() => send('getState') as Promise<T>,
    command,
    operatorCommand: (signed) => send('operatorCommand', { command: signed }) as Promise<CommandAck>,
    play: () => command('play'),
    pause: () => command('pause'),
    seekTo: (time) => command('seek', { time }),
    setVolume: (volume) => command('setVolume', { volume }),
    setMuted: (muted) => command('setMuted', { muted }),
    goLive: () => command('goLive'),
    setSource: (src, o = {}) => command('setSource', { src, ...o }),
    destroy() {
      destroyed = true;
      clearInterval(helloTimer);
      win.removeEventListener('message', onMessage);
      for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new EmbedRequestError('DESTROYED', 'client destroyed'));
      }
      pending.clear();
      listeners.clear();
    },
  };
}
