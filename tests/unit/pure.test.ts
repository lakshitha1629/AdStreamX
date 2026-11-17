import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  backoffDelay,
  canRetry,
  catchUpDecision,
  clampDvrSeek,
  classifyHttpStatus,
  classifyMediaErrorCode,
  computeLiveInfo,
  ConfigError,
  DEFAULT_CONFIG,
  estimateLiveInfo,
  formatTime,
  inferMimeType,
  isRecoverable,
  liveEdgeTarget,
  makeError,
  originMatches,
  resolveConfig,
  sourceKind,
  TypedEmitter,
  validateSource,
} from '@adstreamx/player-core';
import { mapKey } from '@adstreamx/player-controls';

const retry = { maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 8000, jitter: 0 };

test('backoff: exponential, capped, deterministic without jitter', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((a) => backoffDelay(a, retry)), [500, 1000, 2000, 4000, 8000, 8000]);
  assert.equal(backoffDelay(0, retry), 500, 'attempt < 1 is treated as 1');
  assert.equal(backoffDelay(NaN, retry), 500);
});

test('backoff: jitter only ever shortens the delay, within bounds', () => {
  const cfg = { ...retry, jitter: 0.5 };
  assert.equal(backoffDelay(3, cfg, () => 0), 2000);
  assert.equal(backoffDelay(3, cfg, () => 1), 1000);
  for (let i = 0; i < 200; i++) {
    const d = backoffDelay(3, cfg);
    assert.ok(d >= 1000 && d <= 2000, `got ${d}`);
  }
});

test('canRetry respects maxAttempts', () => {
  assert.equal(canRetry(3, retry), true);
  assert.equal(canRetry(4, retry), false);
});

test('HTTP status classification', () => {
  assert.equal(classifyHttpStatus(404), 'MISSING_FILE');
  assert.equal(classifyHttpStatus(410), 'EXPIRED_URL');
  assert.equal(classifyHttpStatus(403), 'FORBIDDEN');
  assert.equal(classifyHttpStatus(403, { reasonHeader: 'expired' }), 'EXPIRED_URL');
  assert.equal(classifyHttpStatus(403, { expiresAt: 1000, now: 2000 }), 'EXPIRED_URL');
  assert.equal(classifyHttpStatus(403, { expiresAt: 3000, now: 2000 }), 'FORBIDDEN');
  assert.equal(classifyHttpStatus(500), 'SERVER');
  assert.equal(classifyHttpStatus(503), 'SERVER');
  assert.equal(classifyHttpStatus(429), 'NETWORK');
  assert.equal(classifyHttpStatus(418), 'UNKNOWN');
});

test('MediaError classification and recoverability', () => {
  assert.equal(classifyMediaErrorCode(2), 'NETWORK');
  assert.equal(classifyMediaErrorCode(3), 'DECODE');
  assert.equal(classifyMediaErrorCode(4), 'UNSUPPORTED_FORMAT');
  assert.equal(classifyMediaErrorCode(undefined), 'UNKNOWN');
  assert.equal(isRecoverable('NETWORK'), true);
  assert.equal(isRecoverable('STALLED'), true);
  assert.equal(isRecoverable('MISSING_FILE'), false);
  assert.equal(isRecoverable('EXPIRED_URL'), false);
  const e = makeError('EXPIRED_URL', { detail: 'x', now: 5 });
  assert.equal(e.recoverable, false);
  assert.equal(e.timestamp, 5);
  assert.ok(!/http|403|x-/i.test(e.message), 'viewer message carries no technical detail');
});

test('MIME inference and source kind', () => {
  assert.equal(inferMimeType('https://a/b/master.m3u8?token=1'), 'application/vnd.apple.mpegurl');
  assert.equal(inferMimeType('/v.MP4'), 'video/mp4');
  assert.equal(inferMimeType('/x.mpd'), 'application/dash+xml');
  assert.equal(inferMimeType('/x'), undefined);
  assert.equal(sourceKind({ src: '/a.m3u8' }), 'hls');
  assert.equal(sourceKind({ src: '/a', type: 'application/x-mpegURL' }), 'hls');
  assert.equal(sourceKind({ src: '/a.mp4' }), 'mp4');
  assert.equal(sourceKind({ src: '/a.mpd' }), 'dash');
});

test('source validation rejects unsafe URLs', () => {
  const base = 'https://site.example/page';
  for (const bad of ['javascript:alert(1)', 'data:video/mp4;base64,AAAA', 'file:///etc/passwd', 'ftp://x/y.mp4', '', '   ']) {
    const r = validateSource({ src: bad }, { baseUrl: base });
    assert.equal(r.ok, false, bad);
  }
  const creds = validateSource({ src: 'https://user:pw@cdn.example/a.mp4' }, { baseUrl: base });
  assert.equal(creds.ok, false);
  const ok = validateSource({ src: '/media/a.m3u8' }, { baseUrl: base });
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.equal(ok.source.src, 'https://site.example/media/a.m3u8');
    assert.equal(ok.source.type, 'application/vnd.apple.mpegurl');
  }
  const badTrack = validateSource({ src: '/a.mp4', textTracks: [{ src: 'javascript:x', srclang: 'en', label: 'x' }] }, { baseUrl: base });
  assert.equal(badTrack.ok, false);
});

test('source origin allowlist (approved sources)', () => {
  const opts = { baseUrl: 'https://site.example/', allowedOrigins: ['https://cdn.example.com', 'https://*.media.example.org'] };
  assert.ok(validateSource({ src: 'https://cdn.example.com/a.mp4' }, opts).ok);
  assert.ok(validateSource({ src: 'https://eu.media.example.org/a.m3u8' }, opts).ok);
  const r = validateSource({ src: 'https://evil.example.net/a.mp4' }, opts);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'SOURCE_NOT_ALLOWED');
  assert.equal(originMatches(new URL('https://media.example.org/x'), 'https://*.media.example.org'), false, 'wildcard needs a subdomain');
  assert.equal(originMatches(new URL('http://cdn.example.com/x'), 'https://cdn.example.com'), false, 'scheme must match');
  assert.equal(originMatches(new URL('https://cdn.example.com:8443/x'), 'https://cdn.example.com'), false, 'port must match');
  assert.equal(originMatches(new URL('https://cdn.example.com.evil.net/x'), 'https://cdn.example.com'), false);
});

test('live maths: latency, edge detection, window', () => {
  const cfg = { liveEdgeOffset: 3, liveEdgeTolerance: 2 };
  const a = computeLiveInfo(95, 40, 100, cfg);
  assert.equal(a.latency, 5);
  assert.equal(a.atLiveEdge, true);
  assert.equal(a.dvrWindow, 60);
  assert.equal(a.dvr, true);
  assert.equal(computeLiveInfo(90, 40, 100, cfg).atLiveEdge, false);
  assert.equal(liveEdgeTarget(40, 100, 3), 97);
  assert.equal(liveEdgeTarget(99, 100, 3), 99, 'never before window start');
  assert.equal(clampDvrSeek(10, 40, 100), 40);
  assert.equal(clampDvrSeek(200, 40, 100), 99.5);
  assert.equal(clampDvrSeek(NaN, 40, 100), 99.5);
});

test('estimated live info (engine without seekable window)', () => {
  const e = estimateLiveInfo(0.5, 4, { liveEdgeTolerance: 2 });
  assert.equal(e.dvr, false);
  assert.equal(e.estimated, true);
  assert.equal(e.latency, 4.5);
  assert.equal(e.atLiveEdge, true);
  assert.equal(estimateLiveInfo(9, 4, { liveEdgeTolerance: 2 }).atLiveEdge, false);
  assert.equal(estimateLiveInfo(-3, 4, { liveEdgeTolerance: 2 }).latency, 4, 'negative drift clamps to 0');
});

test('latency catch-up decisions', () => {
  const cfg = { ...DEFAULT_CONFIG.live, targetLatency: 6, liveEdgeTolerance: 2, maxDriftBeforeSeek: 12, maxCatchUpRate: 1.1 };
  assert.deepEqual(catchUpDecision(7, cfg), { action: 'rate', rate: 1 });
  const mid = catchUpDecision(13, cfg);
  assert.equal(mid.action, 'rate');
  if (mid.action === 'rate') assert.ok(mid.rate > 1 && mid.rate <= 1.1);
  assert.deepEqual(catchUpDecision(19, cfg), { action: 'seek' });
  assert.deepEqual(catchUpDecision(19, { ...cfg, catchUp: false }), { action: 'none' });
  // monotonic: further behind never means a slower rate
  let prev = 1;
  for (let l = 6; l <= 18; l += 0.5) {
    const d = catchUpDecision(l, cfg);
    if (d.action !== 'rate') break;
    assert.ok(d.rate >= prev);
    prev = d.rate;
  }
});

test('formatTime', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(65.9), '1:05');
  assert.equal(formatTime(3725), '1:02:05');
  assert.equal(formatTime(NaN), '0:00');
  assert.equal(formatTime(-4), '0:00');
});

test('config: defaults, deep merge, validation', () => {
  const c = resolveConfig({ live: { targetLatency: 10 }, retry: { maxAttempts: 2 } });
  assert.equal(c.live.targetLatency, 10);
  assert.equal(c.live.liveEdgeOffset, DEFAULT_CONFIG.live.liveEdgeOffset, 'siblings kept');
  assert.equal(c.retry.maxAttempts, 2);
  assert.notEqual(c.live, DEFAULT_CONFIG.live, 'defaults are not mutated/shared');
  assert.throws(() => resolveConfig({ volume: 2 }), ConfigError);
  assert.throws(() => resolveConfig({ branding: { accentColor: 'red; background:url(x)' } }), ConfigError);
  assert.throws(() => resolveConfig({ branding: { logoUrl: 'javascript:alert(1)' } }), ConfigError);
  assert.throws(() => resolveConfig({ retry: { maxAttempts: 1.5 } }), ConfigError);
  try {
    resolveConfig({ nope: 1, volume: -1 } as never);
    assert.fail('should throw');
  } catch (e) {
    assert.ok(e instanceof ConfigError);
    assert.equal(e.issues.length, 2, 'all problems reported together');
  }
  const layered = resolveConfig({ volume: 0.5 }, c);
  assert.equal(layered.live.targetLatency, 10, 'layering keeps prior values');
});

test('emitter: unsubscribe, once, listener isolation, dispose', () => {
  const errors: string[] = [];
  const em = new TypedEmitter<{ a: number; b: string }>((ev) => errors.push(ev));
  const seen: number[] = [];
  const off = em.on('a', (n) => seen.push(n));
  em.on('a', () => {
    throw new Error('boom');
  });
  em.once('a', (n) => seen.push(n * 10));
  em.emit('a', 1);
  em.emit('a', 2);
  off();
  em.emit('a', 3);
  assert.deepEqual(seen, [1, 10, 2]);
  assert.deepEqual(errors, ['a', 'a', 'a'], 'throwing listener reported, others still ran');
  assert.equal(em.listenerCount('a'), 1);
  em.dispose();
  assert.equal(em.listenerCount(), 0);
  em.on('b', () => assert.fail('no listeners after dispose'));
  em.emit('b', 'x');
});

test('keyboard map', () => {
  assert.deepEqual(mapKey({ key: ' ' }), { type: 'togglePlay' });
  assert.deepEqual(mapKey({ key: 'ArrowLeft' }), { type: 'seekBy', seconds: -5 });
  assert.deepEqual(mapKey({ key: 'l' }), { type: 'seekBy', seconds: 10 });
  assert.deepEqual(mapKey({ key: '7' }), { type: 'seekPercent', percent: 70 });
  assert.deepEqual(mapKey({ key: 'F' }), { type: 'toggleFullscreen' });
  assert.equal(mapKey({ key: 'f', ctrlKey: true }), null, 'never steals browser shortcuts');
  assert.equal(mapKey({ key: 'r', metaKey: true }), null);
  assert.equal(mapKey({ key: 'x' }), null);
});
