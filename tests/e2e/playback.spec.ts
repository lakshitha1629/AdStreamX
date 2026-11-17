import { test, expect } from 'playwright/test';
import { call, clearFaults, create, events, expectProgress, openHarness, playMuted, state, tryCall, waitState } from './helpers.ts';

// Phase 1 gate: MP4, HLS VOD (TS + fMP4) and HLS Live (TS + fMP4) fixtures must play,
// seek, switch and clean up in a real browser.

test.beforeEach(async ({ page }) => {
  await clearFaults(page);
});

test('MP4: plays from initial load, captions selectable', async ({ page }) => {
  const errors = await openHarness(page);
  await create(page, {
    source: {
      src: '/media/mp4/short.mp4',
      textTracks: [
        { src: '/media/captions/short.en.vtt', srclang: 'en', label: 'English' },
        { src: '/media/captions/short.es.vtt', srclang: 'es', label: 'Español' },
      ],
    },
  });
  await call(page, 'a', 'ready');
  let s = await state(page);
  expect(s.streamType).toBe('vod');
  expect(s.duration).toBeCloseTo(12, 0);
  expect(s.engine).toBe('native');
  expect(s.textTracks.map((t) => t.label)).toEqual(['English', 'Español']);
  await playMuted(page);
  await expectProgress(page, 1.5);
  expect(await call(page, 'a', 'setTextTrack', s.textTracks[1]!.id)).toBe(true);
  s = await waitState(page, 's.textTracks.some(t => t.active && t.label === "Español")');
  // the browser actually loads cues for the active track
  await page.waitForFunction(() => {
    const v = document.querySelector('video')!;
    const t = [...v.textTracks].find((x) => x.mode === 'showing');
    return !!t && (t.cues?.length ?? 0) > 0;
  });
  await call(page, 'a', 'setTextTrack', null);
  await waitState(page, '!s.textTracks.some(t => t.active)');
  expect(errors).toEqual([]);
});

test('HLS VOD (MPEG-TS, 3 renditions): plays, reports duration and resolution', async ({ page }) => {
  const errors = await openHarness(page);
  await create(page, { source: { src: '/media/hls/vod/master.m3u8' } });
  await call(page, 'a', 'ready');
  const s0 = await state(page);
  expect(s0.streamType).toBe('vod');
  expect(s0.duration).toBeCloseTo(20, 0);
  await playMuted(page);
  const s = await expectProgress(page, 2);
  expect(s.videoHeight).toBeGreaterThan(0);
  expect(s.currentQuality?.height).toBe(s.videoHeight);
  // Native engine: renditions are browser-selected and not exposed for manual selection.
  expect(s.qualityLevels).toEqual([]);
  expect(await call(page, 'a', 'setQuality', 'auto')).toBe(true);
  expect(await call(page, 'a', 'setQuality', '720p')).toBe(false);
  test.info().annotations.push({ type: 'observed-rendition', description: `${s.videoWidth}x${s.videoHeight}` });
  expect(errors).toEqual([]);
});

test('HLS VOD (fMP4/CMAF): plays', async ({ page }) => {
  await openHarness(page);
  await create(page, { source: { src: '/media/hls/vod-fmp4/master.m3u8' } });
  await call(page, 'a', 'ready');
  await playMuted(page);
  await expectProgress(page, 2);
  expect((await state(page)).duration).toBeCloseTo(20, 0);
});

test('VOD seeking: seekTo, clamping, repeated play/pause/seek stays consistent', async ({ page }) => {
  await openHarness(page);
  await create(page, { source: { src: '/media/hls/vod/master.m3u8' } });
  await call(page, 'a', 'ready');
  await playMuted(page);
  await expectProgress(page, 0.5);
  await call(page, 'a', 'seekTo', 12);
  let s = await waitState(page, '!s.seeking && s.currentTime >= 12 && s.currentTime < 14');
  await expectProgress(page, 1);
  await call(page, 'a', 'seekTo', 999); // clamps to the end
  s = await waitState(page, 's.ended || s.currentTime > 19');
  await call(page, 'a', 'seekTo', 2);
  await call(page, 'a', 'play');
  await waitState(page, '!s.seeking && s.currentTime >= 2 && s.currentTime < 5 && !s.paused');
  for (let i = 0; i < 15; i++) {
    await call(page, 'a', i % 2 ? 'play' : 'pause');
    await call(page, 'a', 'seekTo', (i * 3.7) % 18);
  }
  await call(page, 'a', 'play');
  s = await waitState(page, '!s.seeking && !s.paused && s.status === "playing"');
  await expectProgress(page, 1);
  expect(s.error).toBeNull();
  expect(await call(page, 'a', 'setPlaybackRate', 1.5)).toBe(true);
  await waitState(page, 's.playbackRate === 1.5');
});

for (const [label, url] of [
  ['MPEG-TS', '/live/ts/12/master.m3u8'],
  ['fMP4/CMAF', '/live/fmp4/30/master.m3u8'],
] as const) {
  test(`HLS Live (${label}): plays, detected as live, latency reported`, async ({ page }) => {
    const errors = await openHarness(page);
    await create(page, { source: { src: url } });
    await call(page, 'a', 'ready');
    await playMuted(page);
    const s = await expectProgress(page, 4);
    expect(s.streamType).toBe('live');
    expect(s.duration).toBe(Infinity);
    expect(s.live).not.toBeNull();
    expect(s.live!.latency).toBeGreaterThanOrEqual(0);
    expect(s.live!.atLiveEdge).toBe(true);
    expect(await call(page, 'a', 'setPlaybackRate', 2)).toBe(false); // no speed control on live
    test.info().annotations.push({ type: 'live-mode', description: s.live!.dvr ? `DVR ${s.live!.dvrWindow}s` : 'no seekable window (estimated latency)' });
    expect(errors).toEqual([]);
  });
}

test('HLS Live: plays across a playlist loop discontinuity', async ({ page }) => {
  await openHarness(page);
  // Pin the live clock so the next loop boundary (segment index 60) is produced ~6 s after join.
  const epoch = Date.now() - 114_000;
  await create(page, { source: { src: `/live/ts/12/at${epoch}/master.m3u8` } });
  await call(page, 'a', 'ready');
  await playMuted(page);
  await expectProgress(page, 14, 'a', 40_000);
  const s = await state(page);
  expect(s.error).toBeNull();
  expect((await events(page, 'a', 'error')).length).toBe(0);
});

test('HLS Live: pausing drifts behind live; Go Live returns to the edge', async ({ page }) => {
  await openHarness(page);
  await create(page, { source: { src: '/live/ts/12/master.m3u8' }, live: { liveEdgeTolerance: 2, catchUp: false } });
  await call(page, 'a', 'ready');
  await playMuted(page);
  await expectProgress(page, 2);
  await call(page, 'a', 'pause');
  await page.waitForTimeout(6000);
  await call(page, 'a', 'play');
  let s = await waitState(page, 's.status === "playing" && s.live && s.live.atLiveEdge === false');
  expect(s.live!.latency).toBeGreaterThan(4);
  expect(await call(page, 'a', 'goLive')).toBe(true);
  s = await waitState(page, 's.status === "playing" && s.live && s.live.atLiveEdge === true', 'a', 20_000);
  await expectProgress(page, 1);
  expect(s.error).toBeNull();
  const edge = await events(page, 'a', 'liveedgereached');
  test.info().annotations.push({ type: 'liveedgereached-events', description: String(edge.length) });
});

test('source switching: MP4 → HLS VOD → Live → MP4 lands on the last source', async ({ page }) => {
  await openHarness(page);
  await create(page, { source: { src: '/media/mp4/short.mp4' } });
  await call(page, 'a', 'ready');
  await playMuted(page);
  await expectProgress(page, 0.5);
  await call(page, 'a', 'setSource', { src: '/media/hls/vod/master.m3u8' });
  let s = await waitState(page, 's.streamType === "vod" && s.duration > 19');
  // the 'play' intent carries across source changes
  await expectProgress(page, 1);
  await call(page, 'a', 'setSource', { src: '/live/ts/12/master.m3u8' });
  s = await waitState(page, 's.streamType === "live"');
  await expectProgress(page, 1);
  await call(page, 'a', 'setSource', { src: '/media/mp4/short.mp4' });
  s = await waitState(page, 's.streamType === "vod" && s.duration < 13');
  expect(s.source!.src).toMatch(/short\.mp4$/);
  expect(s.live).toBeNull();
});

test('source switching: rapid replacement while loading never shows a stale source', async ({ page }) => {
  await openHarness(page);
  await create(page, {});
  const r = await page.evaluate(async () => {
    const p = (window as unknown as { __players: Record<string, { setSource(s: unknown): Promise<void> }> }).__players.a!;
    const all = [
      p.setSource({ src: '/media/hls/vod/master.m3u8' }),
      p.setSource({ src: '/live/ts/12/master.m3u8' }),
      p.setSource({ src: '/media/mp4/does-not-exist.mp4' }),
      p.setSource({ src: '/media/hls/vod-fmp4/master.m3u8' }),
    ];
    const settled = await Promise.allSettled(all);
    return settled.map((x) => x.status);
  });
  expect(r).toEqual(['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled']);
  const s = await waitState(page, 's.status === "ready" || s.status === "paused"');
  expect(s.source!.src).toMatch(/vod-fmp4\/master\.m3u8$/);
  expect(s.error).toBeNull();
  expect((await events(page, 'a', 'error')).length).toBe(0); // the 404 source was superseded before it failed
});

test('multiple isolated player instances on one page', async ({ page }) => {
  await openHarness(page);
  await create(page, { source: { src: '/media/mp4/short.mp4' } }, 'a', 'slot-a');
  await create(page, { source: { src: '/media/hls/vod/master.m3u8' } }, 'b', 'slot-b');
  await call(page, 'a', 'ready');
  await call(page, 'b', 'ready');
  await playMuted(page, 'a');
  await playMuted(page, 'b');
  await expectProgress(page, 1, 'a');
  await expectProgress(page, 1, 'b');
  await call(page, 'a', 'pause');
  await expectProgress(page, 1, 'b');
  expect((await state(page, 'a')).paused).toBe(true);
  await call(page, 'a', 'setVolume', 0.2);
  expect((await state(page, 'b')).volume).toBe(1);
  await call(page, 'a', 'destroy');
  await expectProgress(page, 1, 'b');
  expect(await page.locator('[data-adstreamx]').count()).toBe(1);
  const destroyedCall = await tryCall(page, 'a', 'play');
  expect(destroyedCall.ok).toBe(false);
  expect(destroyedCall.ok ? null : destroyedCall.error.code).toBe('DESTROYED');
});
