import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdStreamXError, PlayerCore, type PlaybackAdapterFactory, type PlayerCoreOptions } from '@adstreamx/player-core';
import type { PlayerConfigInput, PlayerEventMap } from '@adstreamx/shared-types';
import { fakeVideo, flush, mockFetch, type FakeVideo } from './helpers/fake-media.ts';

// A test adapter that just sets src (like the native one) and records calls.
function testAdapter(log: string[]): PlaybackAdapterFactory {
  return {
    id: 'test',
    label: 'Test',
    canPlay: (kind) => kind !== 'dash',
    create: (ctx) => ({
      id: 'test',
      load(source) {
        log.push(`load ${new URL(source.src).pathname}`);
        (ctx.video as unknown as FakeVideo).src = source.src;
      },
      unload() {
        (ctx.video as unknown as FakeVideo).src = '';
      },
      getQualityLevels: () => [],
      setQuality: (id) => id === 'auto',
      getCurrentQuality: () => null,
      getAudioTracks: () => [],
      setAudioTrack: () => false,
      destroy() {
        log.push('destroy-adapter');
      },
    }),
  };
}

function setup(config: PlayerConfigInput, fetchImpl = mockFetch(() => ({ status: 200, body: '#EXTM3U\n' }))) {
  const v = fakeVideo();
  const log: string[] = [];
  const events: { t: keyof PlayerEventMap; e: unknown }[] = [];
  const opts: PlayerCoreOptions = { adapters: [testAdapter(log)], fetch: fetchImpl, random: () => 0, baseUrl: 'http://test.local/' };
  const core = new PlayerCore(v as unknown as HTMLVideoElement, { retry: { baseDelayMs: 5, maxDelayMs: 20, jitter: 0 }, ...config }, opts);
  for (const t of ['ready', 'loadstart', 'retry', 'fallback', 'error', 'sourcechange', 'destroyed', 'loadedmetadata'] as const) {
    core.on(t, (e) => events.push({ t, e }));
  }
  return { v, core, log, events, fetch: fetchImpl };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('initial load → ready resolves on metadata; VOD detected', async () => {
  const { v, core } = setup({ source: { src: '/a.mp4' } });
  assert.equal(core.getState().status, 'loading');
  v.emitMetadata(12);
  await core.ready();
  const s = core.getState();
  assert.equal(s.streamType, 'vod');
  assert.equal(s.status, 'ready');
  assert.equal(s.duration, 12);
  core.destroy();
});

test('live detected from Infinity duration', async () => {
  const { v, core } = setup({ source: { src: '/live.m3u8' } });
  v.emitMetadata(Infinity);
  await core.ready();
  assert.equal(core.getState().streamType, 'live');
  assert.equal(core.setPlaybackRate(2), false, 'no speed control on live');
  core.destroy();
});

test('recoverable failure retries with backoff, then succeeds and keeps position', async () => {
  let fail = true;
  const f = mockFetch(() => (fail ? { status: 503 } : { status: 200 }));
  const { v, core, events, log } = setup({ source: { src: '/a.mp4' } }, f);
  v.emitMetadata(30);
  await core.ready();
  v.currentTime = 12.5;
  v.emitError(2, 'network');
  await flush();
  const retry = events.find((e) => e.t === 'retry');
  assert.ok(retry, 'retry emitted');
  assert.equal((retry!.e as PlayerEventMap['retry']).error.code, 'SERVER');
  assert.equal(core.getState().status, 'recovering');
  fail = false;
  await wait(15);
  assert.deepEqual(log.filter((l) => l.startsWith('load')), ['load /a.mp4', 'load /a.mp4']);
  v.emitMetadata(30);
  assert.equal(v.currentTime, 12.5, 'VOD position restored after reload');
  core.destroy();
});

test('retries are bounded, then fatal error rejects setSource', async () => {
  const f = mockFetch(() => ({ status: 503 }));
  const { v, core, events } = setup({ retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2, jitter: 0 } }, f);
  const p = core.setSource({ src: '/a.mp4' });
  for (let i = 0; i < 3; i++) {
    v.emitError(2);
    await flush();
    await wait(5);
  }
  await assert.rejects(p, (e: unknown) => e instanceof AdStreamXError && e.code === 'SERVER' && e.info.fatal);
  assert.equal(events.filter((e) => e.t === 'retry').length, 2);
  assert.equal(core.getState().status, 'error');
  core.destroy();
});

test('non-recoverable failure skips retries and uses the approved fallback', async () => {
  const f = mockFetch((u) => (u.includes('missing') ? { status: 404 } : { status: 200 }));
  const { v, core, events, log } = setup({}, f);
  const p = core.setSource({ src: '/missing.mp4' }, [{ src: '/backup.mp4' }]);
  v.emitError(4);
  await flush();
  assert.equal(events.filter((e) => e.t === 'retry').length, 0);
  const fb = events.find((e) => e.t === 'fallback')!.e as PlayerEventMap['fallback'];
  assert.equal(fb.error.code, 'MISSING_FILE');
  assert.equal(fb.to, 1);
  assert.deepEqual(log.filter((l) => l.startsWith('load')), ['load /missing.mp4', 'load /backup.mp4']);
  v.emitMetadata(10);
  await p; // the original setSource promise resolves once the fallback is playing
  assert.equal(core.getState().sourceIndex, 1);
  core.destroy();
});

test('MediaError 4 with a reachable resource is UNSUPPORTED_FORMAT', async () => {
  const { v, core } = setup({}, mockFetch(() => ({ status: 200 })));
  const p = core.setSource({ src: '/a.xyz' });
  v.emitError(4);
  await assert.rejects(p, (e: AdStreamXError) => e.code === 'UNSUPPORTED_FORMAT');
  core.destroy();
});

test('demux error after metadata (seen with Chromium native live HLS) is retried, not fatal', async () => {
  const { v, core, events } = setup({ source: { src: '/live.m3u8' } }, mockFetch(() => ({ status: 200, body: '#EXTM3U\n#EXTINF:2,\ns.ts\n' })));
  v.emitMetadata(Infinity);
  await core.ready();
  v.emitError(4, 'PipelineStatus::DEMUXER_ERROR_COULD_NOT_PARSE');
  await flush();
  const r = events.find((e) => e.t === 'retry');
  assert.ok(r, 'retried');
  assert.equal((r!.e as PlayerEventMap['retry']).error.code, 'DECODE');
  assert.equal(core.getState().error?.fatal, false);
  core.destroy();
});

test('first play() on an idle non-DVR live source re-joins; pending play at metadata plays directly', async () => {
  const a = setup({ source: { src: '/live.m3u8' } });
  a.v.emitMetadata(Infinity);
  await a.core.ready();
  void a.core.play();
  await flush();
  // (setup() subscribes after the constructor's initial loadstart, so only re-joins are counted)
  assert.equal(a.events.filter((e) => e.t === 'loadstart').length, 1, 're-joined once');
  a.v.emitMetadata(Infinity);
  await flush();
  assert.equal(a.v.paused, false, 'plays straight through after the re-join');
  assert.equal(a.events.filter((e) => e.t === 'loadstart').length, 1, 'no loop');
  a.core.destroy();
  const b = setup({ source: { src: '/live.m3u8' }, autoplay: 'muted' });
  b.v.emitMetadata(Infinity);
  await flush();
  assert.equal(b.events.filter((e) => e.t === 'loadstart').length, 0, 'autoplay path does not reload');
  assert.equal(b.v.paused, false);
  b.core.destroy();
});

test('invalid / disallowed sources fail fast without touching the media element', async () => {
  const { v, core } = setup({ allowedSourceOrigins: ['https://cdn.example.com'] });
  await assert.rejects(core.setSource({ src: 'javascript:alert(1)' }), (e: AdStreamXError) => e.code === 'INVALID_SOURCE');
  await assert.rejects(core.setSource({ src: 'https://evil.example/a.mp4' }), (e: AdStreamXError) => e.code === 'SOURCE_NOT_ALLOWED');
  assert.equal(v.src, '');
  core.destroy();
});

test('stale callbacks: a slow probe for a replaced source is ignored', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const slowFetch = async () => {
    await gate;
    return new Response('', { status: 404 });
  };
  const { v, core, events } = setup({}, Object.assign(slowFetch, { calls: [] }) as never);
  void core.setSource({ src: '/first.mp4' });
  v.emitError(2); // probe for /first starts and blocks
  const second = core.setSource({ src: '/second.mp4' });
  release();
  await flush();
  v.emitMetadata(5);
  await second;
  assert.equal(events.filter((e) => e.t === 'error' || e.t === 'fallback').length, 0, 'no error leaked from the replaced source');
  assert.equal(core.getState().source?.src, 'http://test.local/second.mp4');
  assert.equal(core.getState().status, 'ready');
  core.destroy();
});

test('superseded setSource resolves quietly (no rejection for the caller)', async () => {
  const { v, core } = setup({});
  const first = core.setSource({ src: '/one.mp4' });
  const second = core.setSource({ src: '/two.mp4' });
  await first;
  v.emitMetadata(3);
  await second;
  core.destroy();
});

test('startup timeout triggers diagnosis and retry', async () => {
  const f = mockFetch(() => ({ status: 200 }));
  const { core, events } = setup({ startupTimeoutMs: 1000, retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitter: 0 } }, f);
  void core.setSource({ src: '/slow.mp4' });
  await wait(1100);
  await flush();
  const r = events.find((e) => e.t === 'retry');
  assert.ok(r);
  assert.equal((r!.e as PlayerEventMap['retry']).error.code, 'STARTUP_TIMEOUT');
  core.destroy();
});

test('autoplay blocked → muted fallback', async () => {
  const { v, core } = setup({ autoplay: true, source: { src: '/a.mp4' } });
  // setup() already started the first load; patch play() before the microtask runs is too late,
  // so drive a second instance with play() rejecting once.
  core.destroy();
  const s2 = setupWithBlockedFirstPlay();
  await flush();
  assert.deepEqual(s2.blocked, [{ mutedFallback: true }]);
  assert.equal(s2.v.muted, true);
  assert.equal(s2.v.paused, false);
  s2.core.destroy();
  assert.ok(v);
});

function setupWithBlockedFirstPlay() {
  const v = fakeVideo();
  let n = 0;
  const op = v.play.bind(v);
  v.play = () => (++n === 1 ? Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' })) : op());
  const blocked: PlayerEventMap['autoplayblocked'][] = [];
  const core = new PlayerCore(v as unknown as HTMLVideoElement, { autoplay: true }, { adapters: [testAdapter([])], fetch: mockFetch(() => ({ status: 200 })), baseUrl: 'http://test.local/' });
  core.on('autoplayblocked', (e) => blocked.push(e));
  void core.setSource({ src: '/a.mp4' });
  return { v, core, blocked };
}

test('explicit play() blocked → PLAY_BLOCKED, no silent mute', async () => {
  const { v, core } = setup({ source: { src: '/a.mp4' } });
  v.emitMetadata(5);
  v.playRejects = 'NotAllowedError';
  await assert.rejects(core.play(), (e: AdStreamXError) => e.code === 'PLAY_BLOCKED');
  assert.equal(v.muted, false);
  core.destroy();
});

test('destroy: idempotent, clears listeners and timers, rejects pending ready, blocks API', async () => {
  const { v, core, events, log } = setup({ source: { src: '/a.mp4' } });
  const ready = core.ready();
  core.destroy();
  core.destroy();
  await assert.rejects(ready, (e: AdStreamXError) => e.code === 'DESTROYED');
  assert.equal(core.listenerCount(), 0);
  assert.equal(events.filter((e) => e.t === 'destroyed').length, 1);
  assert.ok(log.includes('destroy-adapter'));
  assert.equal(v.src, '');
  await assert.rejects(core.play(), (e: AdStreamXError) => e.code === 'DESTROYED');
  assert.throws(() => core.pause(), AdStreamXError);
  // late media events after destroy are ignored, no throw
  v.emitMetadata(5);
  v.emitError(2);
  await flush();
});

test('VOD seek clamps to duration; live seek without DVR is a no-op', async () => {
  const a = setup({ source: { src: '/a.mp4' } });
  a.v.emitMetadata(10);
  a.core.seekTo(50);
  assert.ok(a.v.currentTime <= 10);
  a.core.seekTo(-5);
  assert.equal(a.v.currentTime, 0);
  a.core.destroy();
  const b = setup({ source: { src: '/l.m3u8' } });
  b.v.emitMetadata(Infinity);
  b.v.currentTime = 4;
  b.core.seekTo(1);
  assert.equal(b.v.currentTime, 4, 'no seekable window → seek ignored');
  b.core.destroy();
});

test('live with DVR window: goLive targets edge minus offset', async () => {
  const { v, core } = setup({ source: { src: '/l.m3u8' }, live: { liveEdgeOffset: 3 } });
  v.seekable.ranges = [[100, 160]];
  v.emitMetadata(Infinity);
  assert.equal(v.currentTime, 157, 'joins at edge - offset');
  core.seekTo(120);
  assert.equal(v.currentTime, 120);
  v.fire('seeked');
  assert.equal(core.getState().live?.atLiveEdge, false);
  assert.equal(core.getState().live?.latency, 40);
  core.goLive();
  assert.equal(v.currentTime, 157);
  core.seekTo(10);
  assert.equal(v.currentTime, 100, 'clamped to DVR start');
  core.destroy();
});

test('multiple instances are isolated', async () => {
  const a = setup({ source: { src: '/a.mp4' } });
  const b = setup({ source: { src: '/b.mp4' } });
  a.v.emitMetadata(5);
  a.core.destroy();
  b.v.emitMetadata(7);
  await b.core.ready();
  assert.equal(b.core.getState().duration, 7);
  assert.equal(b.core.isDestroyed, false);
  b.core.destroy();
});
