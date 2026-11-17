import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CommandAck } from '@adstreamx/shared-types';
import { connectIframe, EmbedServer, envelope, type EmbeddablePlayer } from '@adstreamx/embed-protocol';
import { flush } from './helpers/fake-media.ts';

/**
 * Fake browsing contexts: postMessage(data, targetOrigin) is delivered only when
 * targetOrigin matches the receiver's origin (like a browser), with event.origin = sender
 * origin and event.source = sender window. Every targetOrigin used is recorded.
 */
class FakeWindow extends EventTarget {
  readonly origin: string;
  peer: FakeWindow | null = null;
  readonly targets: string[] = [];
  constructor(origin: string) {
    super();
    this.origin = origin;
  }
  postMessageFrom(sender: FakeWindow, data: unknown, targetOrigin: string) {
    sender.targets.push(targetOrigin);
    if (targetOrigin !== '*' && targetOrigin !== this.origin) return; // browser drops it
    const ev = new MessageEvent('message', { data: structuredClone(data), origin: sender.origin });
    Object.defineProperty(ev, 'source', { value: sender, configurable: true });
    setImmediate(() => this.dispatchEvent(ev));
  }
}

/** A window handle as seen from `from`: postMessage sends from `from` into `to`. */
function handle(from: FakeWindow, to: FakeWindow): Window {
  return { postMessage: (d: unknown, o: string) => to.postMessageFrom(from, d, o) } as unknown as Window;
}

function setup(hostOrigin: string, allowed: string[]) {
  const host = new FakeWindow(hostOrigin);
  const frame = new FakeWindow('https://player.example');
  const frameAsSeenByHost = handle(host, frame);
  const hostAsSeenByFrame = handle(frame, host);
  const commands: { cmd: unknown; role: string }[] = [];
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const player: EmbeddablePlayer = {
    getState: () => ({ status: 'playing', currentTime: 3, duration: Infinity }),
    getCapabilities: () => ({ nativeHls: true }),
    on: (e, fn) => {
      let s = listeners.get(e);
      if (!s) listeners.set(e, (s = new Set()));
      s.add(fn);
      return () => s!.delete(fn);
    },
    command: async (cmd, role) => {
      commands.push({ cmd, role });
      return { id: (cmd as { id: string }).id, type: (cmd as { type: string }).type, status: 'applied', at: 0 } as CommandAck;
    },
  };
  // events arriving at the frame window are from the host (source = host); the server
  // checks e.source === target, so give it the host FakeWindow itself as target identity.
  const server = new EmbedServer({ player, allowedOrigins: allowed, channel: 'c1', target: host as unknown as Window, self: frame as unknown as Window, version: 't' });
  // EmbedServer posts via target.postMessage → route into host window from frame
  (host as unknown as { postMessage: (d: unknown, o: string) => void }).postMessage = (d, o) => host.postMessageFrom(frame, d, o);
  const iframe = { contentWindow: frameAsSeenByHost, ownerDocument: { defaultView: host } } as unknown as HTMLIFrameElement;
  // the client checks e.source === iframe.contentWindow: make frame-originated events carry that identity
  const origDispatch = host.dispatchEvent.bind(host);
  host.dispatchEvent = (ev: Event) => {
    if ((ev as MessageEvent).source === (frame as unknown)) Object.defineProperty(ev, 'source', { value: frameAsSeenByHost });
    return origDispatch(ev);
  };
  void hostAsSeenByFrame;
  const emit = (e: string, p: unknown) => listeners.get(e)?.forEach((fn) => fn(p));
  return { host, frame, server, iframe, commands, emit, listeners };
}

test('trusted host: handshake, state, commands as host, events — never "*"', async () => {
  const s = setup('https://news.example', ['https://news.example']);
  const client = connectIframe(s.iframe, { origin: 'https://player.example', channel: 'c1', timeoutMs: 500 });
  const ready = await client.ready();
  assert.equal(ready.version, 't');
  assert.deepEqual(await client.getState(), { status: 'playing', currentTime: 3, duration: null });
  const ack = await client.pause();
  assert.equal(ack.status, 'applied');
  assert.equal(s.commands[0]!.role, 'host');
  const got: unknown[] = [];
  client.on('ended', (p) => got.push(p));
  await flush(10);
  s.emit('ended', {});
  await flush(10);
  assert.equal(got.length, 1);
  const op = await client.operatorCommand({ v: 1, id: 'op', type: 'announce', issuedAt: 0, payload: { text: 'x' } }).catch((e) => e);
  assert.equal(s.commands.at(-1)!.role, 'operator', 'operatorCommand is passed on as operator (signature checked by the player)');
  void op;
  assert.ok(!s.frame.targets.includes('*'), 'embed never posts to "*"');
  assert.ok(!s.host.targets.includes('*'), 'client never posts to "*"');
  assert.ok(s.frame.targets.every((t) => t === 'https://news.example'));
  client.destroy();
  s.server.destroy();
});

test('untrusted host: hello says not trusted; no state, no commands, no events', async () => {
  const s = setup('https://evil.example', ['https://news.example']);
  const client = connectIframe(s.iframe, { origin: 'https://player.example', channel: 'c1', timeoutMs: 300 });
  await assert.rejects(client.ready(), (e: { code: string }) => e.code === 'NOT_TRUSTED');
  await assert.rejects(client.getState(), (e: { code: string }) => e.code === 'TIMEOUT');
  await assert.rejects(client.play(), (e: { code: string }) => e.code === 'TIMEOUT');
  assert.equal(s.commands.length, 0);
  assert.equal(s.listeners.size, 0, 'no subscriptions created');
  assert.deepEqual(s.server.getStats().rejected, { 'https://evil.example': s.server.getStats().rejected['https://evil.example'] });
  client.destroy();
  s.server.destroy();
});

test('empty allowlist means nobody can control the embed (no implicit wildcard)', async () => {
  const s = setup('https://news.example', []);
  const client = connectIframe(s.iframe, { origin: 'https://player.example', channel: 'c1', timeoutMs: 300 });
  await assert.rejects(client.ready(), (e: { code: string }) => e.code === 'NOT_TRUSTED');
  assert.equal(s.commands.length, 0);
  client.destroy();
  s.server.destroy();
});

test('messages from the wrong window, origin or channel are ignored', async () => {
  const s = setup('https://news.example', ['https://news.example']);
  const stranger = new FakeWindow('https://news.example');
  // right origin, wrong source window
  s.frame.postMessageFrom(stranger, envelope('c1', 'request', { id: 'x1', method: 'command', payload: { command: { v: 1, id: 'z', type: 'pause', issuedAt: 0 } } }), 'https://player.example');
  // right window, wrong channel
  s.frame.postMessageFrom(s.host, envelope('c2', 'request', { id: 'x2', method: 'command', payload: { command: { v: 1, id: 'y', type: 'pause', issuedAt: 0 } } }), 'https://player.example');
  await flush(10);
  assert.equal(s.commands.length, 0);
  s.server.destroy();
});

test('client rejects wildcard / malformed origins up front', () => {
  const iframe = { contentWindow: null, ownerDocument: { defaultView: new FakeWindow('https://a.example') } } as unknown as HTMLIFrameElement;
  assert.throws(() => connectIframe(iframe, { origin: '*' }), /exact origin/);
  assert.throws(() => connectIframe(iframe, { origin: 'https://a.example/path' }), /exact origin/);
  assert.throws(() => connectIframe(iframe, { origin: 'https://a.example', channel: 'bad channel' }), /channel/);
});

test('rate limiting per origin', async () => {
  const s = setup('https://news.example', ['https://news.example']);
  const client = connectIframe(s.iframe, { origin: 'https://player.example', channel: 'c1', timeoutMs: 1000 });
  await client.ready();
  const results = await Promise.allSettled(Array.from({ length: 150 }, () => client.getState()));
  const limited = results.filter((r) => r.status === 'rejected' && (r.reason as { code: string }).code === 'RATE_LIMITED').length;
  assert.ok(limited > 0, 'some requests were rate limited');
  assert.ok(limited < 150, 'a burst is allowed');
  client.destroy();
  s.server.destroy();
});
