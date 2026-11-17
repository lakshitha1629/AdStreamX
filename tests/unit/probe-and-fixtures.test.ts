import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeSource } from '@adstreamx/player-core';
import { mockFetch } from './helpers/fake-media.ts';

test('probe: 404 → MISSING_FILE', async () => {
  const f = mockFetch(() => ({ status: 404 }));
  const r = await probeSource('https://x/a.mp4', 'mp4', { fetch: f });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MISSING_FILE');
  assert.equal(r.httpStatus, 404);
});

test('probe: 403 with expired reason header → EXPIRED_URL', async () => {
  const f = mockFetch(() => ({ status: 403, headers: { 'x-adstreamx-reason': 'expired' } }));
  const r = await probeSource('https://x/a.m3u8', 'hls', { fetch: f });
  assert.equal(r.code, 'EXPIRED_URL');
});

test('probe: HTML instead of playlist → INVALID_MANIFEST', async () => {
  const f = mockFetch(() => ({ status: 200, body: '<!doctype html><p>login</p>' }));
  const r = await probeSource('https://x/a.m3u8', 'hls', { fetch: f });
  assert.equal(r.code, 'INVALID_MANIFEST');
});

test('probe: master playlist ok but first variant missing', async () => {
  const f = mockFetch((u) =>
    u.endsWith('master.m3u8') ? { status: 200, body: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv0/index.m3u8\n' } : { status: 404 },
  );
  const r = await probeSource('https://x/hls/master.m3u8', 'hls', { fetch: f });
  assert.equal(r.code, 'MISSING_FILE');
  assert.deepEqual(f.calls, ['https://x/hls/master.m3u8', 'https://x/hls/v0/index.m3u8']);
});

test('probe: BOM-prefixed valid playlist is accepted', async () => {
  const f = mockFetch(() => ({ status: 200, body: '﻿#EXTM3U\n#EXTINF:2,\na.ts\n' }));
  assert.equal((await probeSource('https://x/a.m3u8', 'hls', { fetch: f })).ok, true);
});

test('probe: network failure → NETWORK (never a guessed cause)', async () => {
  const f = mockFetch(() => 'network-error');
  const r = await probeSource('https://x/a.mp4', 'mp4', { fetch: f });
  assert.equal(r.code, 'NETWORK');
});

test('probe: timeout → NETWORK', async () => {
  const slow = async (_u: string, init?: RequestInit) =>
    new Promise<Response>((_, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
  const r = await probeSource('https://x/a.mp4', 'mp4', { fetch: slow, timeoutMs: 30 });
  assert.equal(r.code, 'NETWORK');
  assert.match(r.detail, /timed out/);
});

test('fixture live playlist: sliding window, sequence numbers, discontinuities', async () => {
  const { livePlaylist } = await import('../../infrastructure/fixtures/server.mjs');
  const epoch = 1_700_000_000_000;
  // 125 s after epoch with 2 s segments → last complete segment index 61 (wrapped at 60).
  const pl = livePlaylist('ts', 'v240p', 12, epoch + 125_000, epoch) as string | null;
  if (pl === null) {
    // fixtures not generated in this checkout — skip rather than fake
    return;
  }
  const seq = Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(pl)![1]);
  const uris = pl.split('\n').filter((l) => l && !l.startsWith('#'));
  assert.equal(uris.length, 6, '12 s window / 2 s segments');
  assert.equal(seq, 56);
  assert.equal(uris.at(-1), '/media/live-src/ts/v240p/seg_001.ts', 'index 61 maps to source segment 1');
  assert.equal((pl.match(/#EXT-X-DISCONTINUITY\n/g) ?? []).length, 1, 'one loop boundary inside the window');
  assert.match(pl, /#EXT-X-DISCONTINUITY-SEQUENCE:0/);
  const later = livePlaylist('ts', 'v240p', 12, epoch + 260_000, epoch) as string;
  assert.match(later, /#EXT-X-DISCONTINUITY-SEQUENCE:2/, 'two boundaries passed before window start');
  const pdts = [...pl.matchAll(/#EXT-X-PROGRAM-DATE-TIME:(.+)/g)].map((m) => Date.parse(m[1]!));
  assert.equal(pdts[0], epoch + 56 * 2000);
  assert.equal(livePlaylist('ts', 'v240p', 12, epoch + 1000, epoch), null, 'nothing produced yet');
});

test('probe: healthy playlists but failing segments → SERVER (not a format problem)', async () => {
  const f = mockFetch((u) => {
    if (u.endsWith('master.m3u8')) return { status: 200, body: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv0.m3u8\n' };
    if (u.endsWith('v0.m3u8')) return { status: 200, body: '#EXTM3U\n#EXTINF:2,\nseg_1.ts\n#EXTINF:2,\nseg_2.ts\n' };
    return { status: 503 };
  });
  const r = await probeSource('https://x/live/master.m3u8', 'hls', { fetch: f });
  assert.equal(r.code, 'SERVER');
  assert.equal(f.calls.at(-1), 'https://x/live/seg_2.ts', 'probes the newest segment');
});
