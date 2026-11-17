import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AnalyticsConfig } from '@adstreamx/shared-types';
import { AnalyticsCollector, sanitizeData, stripUrl, type AnalyticsBatch, type Transport } from '@adstreamx/analytics-sdk';
import { DEFAULT_CONFIG } from '@adstreamx/player-core';

const cfg = (over: Partial<AnalyticsConfig> = {}): AnalyticsConfig => ({ ...DEFAULT_CONFIG.analytics, enabled: true, endpoint: '/collect', requireConsent: false, ...over });

function rig(over: Partial<AnalyticsConfig> = {}, respond: (n: number) => { ok: boolean; status?: number } | 'throw' = () => ({ ok: true, status: 202 })) {
  const sent: { batch: AnalyticsBatch; beacon: boolean }[] = [];
  let n = 0;
  let t = 1_000;
  let id = 0;
  const transport: Transport = async (_e, body, { beacon }) => {
    const r = respond(n++);
    if (r === 'throw') throw new TypeError('offline');
    sent.push({ batch: JSON.parse(body), beacon });
    return r;
  };
  const c = new AnalyticsCollector({ config: cfg(over), transport, now: () => t, uuid: () => `id-${++id}`, random: () => 0.5, manualTimers: true });
  return { c, sent, advance: (ms: number) => (t += ms) };
}

test('disabled by default: nothing collected', () => {
  const c = new AnalyticsCollector({ config: DEFAULT_CONFIG.analytics, manualTimers: true });
  assert.equal(c.active, false);
  assert.equal(c.track('play'), null);
  assert.equal(c.getStats().queued, 0);
  c.destroy();
});

test('consent: nothing queued before consent; revoking discards unsent events', () => {
  const { c } = rig({ requireConsent: true });
  assert.equal(c.track('play'), null);
  c.setConsent(true);
  assert.ok(c.track('play'));
  assert.ok(c.track('pause'));
  c.setConsent(false);
  assert.equal(c.getStats().queued, 0);
  assert.equal(c.track('play'), null);
  c.destroy();
});

test('sampling decided once per session', () => {
  const c = new AnalyticsCollector({ config: cfg({ sampleRate: 0.3 }), random: () => 0.5, manualTimers: true });
  assert.equal(c.getStats().sampled, false);
  assert.equal(c.track('play'), null);
  c.destroy();
});

test('batching: flushes at batchSize, keeps order and sequence numbers', async () => {
  const { c, sent } = rig({ batchSize: 3 });
  c.track('a1');
  c.track('a2');
  assert.equal(sent.length, 0);
  c.track('a3'); // reaches batch size → flush
  await new Promise((r) => setImmediate(r));
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]!.batch.events.map((e) => [e.type, e.seq]), [['a1', 1], ['a2', 2], ['a3', 3]]);
  assert.equal(sent[0]!.batch.schema, 1);
  assert.ok(sent[0]!.batch.events.every((e) => e.sessionId === c.sessionId));
  c.destroy();
});

test('dedupe key: an impression is tracked once per session', () => {
  const { c } = rig();
  assert.ok(c.track('ad_start', {}, { dedupeKey: 'ad_start:b1:ad1' }));
  assert.equal(c.track('ad_start', {}, { dedupeKey: 'ad_start:b1:ad1' }), null);
  assert.ok(c.track('ad_start', {}, { dedupeKey: 'ad_start:b1:ad2' }));
  assert.equal(c.getStats().duplicatesIgnored, 1);
  c.destroy();
});

test('retry: network failure re-queues the SAME event ids with backoff; 4xx drops', async () => {
  const outcomes: ({ ok: boolean; status?: number } | 'throw')[] = ['throw', { ok: false, status: 503 }, { ok: true, status: 202 }];
  const { c, sent, advance } = rig({}, (n) => outcomes[n] ?? { ok: true });
  c.track('a');
  c.track('b');
  const r1 = await c.flush();
  assert.equal(r1.ok, false);
  assert.equal(c.getStats().queued, 2);
  assert.equal((await c.flush()).count, 0, 'still backing off');
  advance(1000);
  await c.flush(); // 503
  advance(2000);
  await c.flush(); // ok
  const ids = sent.map((s) => s.batch.events.map((e) => e.eventId).join(','));
  assert.equal(ids.at(-1), 'id-2,id-3', 'eventIds unchanged across retries (server dedups)');
  assert.equal(c.getStats().sent, 2);
  assert.equal(c.getStats().failedAttempts, 2);
  c.destroy();

  const bad = rig({}, () => ({ ok: false, status: 400 }));
  bad.c.track('x');
  await bad.c.flush();
  assert.equal(bad.c.getStats().queued, 0);
  assert.equal(bad.c.getStats().rejected, 1);
  bad.c.destroy();
});

test('bounded queue drops oldest and counts it', () => {
  const { c } = rig({ endpoint: undefined, maxQueue: 10 });
  for (let i = 0; i < 25; i++) c.track('e', { i });
  const q = c.getQueue();
  assert.equal(q.length, 10);
  assert.equal(q[0]!.data!.i, 15);
  assert.equal(c.getStats().dropped, 15);
  c.destroy();
});

test('destroy sends remaining events by beacon', () => {
  const { c, sent } = rig();
  c.track('a');
  c.track('session_end');
  c.destroy();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.beacon, true);
  assert.equal(c.track('late'), null);
});

test('sanitizer: primitives only, no tokens in URLs, bounded strings and keys', () => {
  const d = sanitizeData({
    src: 'https://cdn.example.com/v/master.m3u8?token=SECRET&exp=1#t=2',
    rel: '/signed/x.mp4?sig=abc',
    obj: { nested: true },
    fn: () => 1,
    inf: Infinity,
    n: 1.23456,
    long: 'x'.repeat(1000),
    'bad key': 1,
  })!;
  assert.equal(d.src, 'https://cdn.example.com/v/master.m3u8');
  assert.equal(d.rel, '/signed/x.mp4');
  assert.equal(d.n, 1.235);
  assert.equal((d.long as string).length, 256);
  assert.ok(!('obj' in d) && !('fn' in d) && !('inf' in d) && !('bad key' in d));
  assert.equal(stripUrl('/a/b?x=1#y'), '/a/b');
  assert.equal(stripUrl('/signed/1794929368/a0a25a3440c03a239ab4f11bfb9d7312/hls/vod/master.m3u8'), '/signed/:redacted/:redacted/hls/vod/master.m3u8');
  assert.equal(stripUrl('https://cdn.example/videos/episode-2024-final/master.m3u8'), 'https://cdn.example/videos/episode-2024-final/master.m3u8', 'normal names kept');
  assert.equal(stripUrl('https://h.example:8443/p?q=1'), 'https://h.example:8443/p');
});

test('invalid event types are refused', () => {
  const { c } = rig();
  assert.equal(c.track('Bad-Type'), null);
  assert.ok(c.track('ok_type'));
  c.destroy();
});
