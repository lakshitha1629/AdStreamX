import { test, expect } from 'playwright/test';
import { addFault, call, clearFaults, create, events, expectProgress, openHarness, playMuted, state, tryCall, waitState } from './helpers.ts';

test.beforeEach(async ({ page }) => {
  await clearFaults(page);
});
test.afterEach(async ({ page }) => {
  await clearFaults(page);
});

const fastRetry = { maxAttempts: 6, baseDelayMs: 300, maxDelayMs: 2000, jitter: 0 };

test('error recovery: transient 503s at start are retried and playback starts', async ({ page }) => {
  await openHarness(page);
  await addFault(page, { match: 'short.mp4', status: 503, count: 2 });
  await create(page, { source: { src: '/media/mp4/short.mp4' }, retry: fastRetry });
  await call(page, 'a', 'ready');
  await playMuted(page);
  await expectProgress(page, 1);
  const retries = await events(page, 'a', 'retry');
  expect(retries.length).toBeGreaterThanOrEqual(1);
  expect((retries[0]!.e as { error: { code: string } }).error.code).toBe('SERVER');
  expect((await state(page)).retryAttempt).toBeLessThanOrEqual(2);
});

test('error recovery: segment outage mid-VOD → recovering → resumes near the same position', async ({ page }) => {
  await openHarness(page);
  await create(page, { source: { src: '/media/hls/vod/master.m3u8' }, retry: fastRetry, stallTimeoutMs: 3000 });
  await call(page, 'a', 'ready');
  await playMuted(page);
  await expectProgress(page, 1);
  await addFault(page, { match: '/seg_', status: 503 });
  await call(page, 'a', 'seekTo', 14); // force fetching segments that are not buffered
  const during = await waitState(page, 's.status === "recovering" || s.status === "buffering"', 'a', 20_000);
  test.info().annotations.push({ type: 'outage-status', description: during.status });
  await page.waitForTimeout(2500);
  await clearFaults(page);
  const s = await waitState(page, 's.status === "playing" && s.currentTime > 13', 'a', 30_000);
  expect(s.error).toBeNull();
  expect(s.currentTime).toBeLessThan(19);
  await expectProgress(page, 1);
  expect((await events(page, 'a', 'error')).every((e) => !(e.e as { fatal: boolean }).fatal)).toBe(true);
});

test('live-edge recovery: segment outage on a live stream recovers back at the live edge', async ({ page }) => {
  await openHarness(page);
  await create(page, { source: { src: '/live/ts/12/master.m3u8' }, retry: fastRetry, stallTimeoutMs: 4000 });
  await call(page, 'a', 'ready');
  await playMuted(page);
  await expectProgress(page, 2);
  await addFault(page, { match: '/seg_', status: 503 });
  await waitState(page, 's.status === "recovering" || s.status === "buffering"', 'a', 30_000);
  await page.waitForTimeout(3000);
  await clearFaults(page);
  const s = await waitState(page, 's.status === "playing" && s.live && s.live.atLiveEdge', 'a', 40_000);
  await expectProgress(page, 2);
  expect(s.streamType).toBe('live');
  const fatal = (await events(page, 'a', 'error')).filter((e) => (e.e as { fatal: boolean }).fatal);
  expect(fatal).toEqual([]);
  test.info().annotations.push({ type: 'retries', description: String((await events(page, 'a', 'retry')).length) });
});

test('approved fallback source plays when the primary is missing', async ({ page }) => {
  await openHarness(page);
  await create(page, { source: { src: '/media/mp4/missing.mp4' }, fallbackSources: [{ src: '/media/mp4/short.mp4', label: 'backup' }] });
  await call(page, 'a', 'ready');
  const fb = await events(page, 'a', 'fallback');
  expect(fb.length).toBe(1);
  expect((fb[0]!.e as { error: { code: string } }).error.code).toBe('MISSING_FILE');
  await playMuted(page);
  await expectProgress(page, 1);
  expect((await state(page)).sourceIndex).toBe(1);
});

const cases: [string, Record<string, unknown>, string, boolean][] = [
  ['missing file', { src: '/media/mp4/missing.mp4' }, 'MISSING_FILE', false],
  ['invalid manifest', { src: '/media/errors/invalid.m3u8' }, 'INVALID_MANIFEST', false],
  ['unsupported format', { src: '/media/errors/unsupported.xyz', type: 'video/x-adstreamx-unsupported' }, 'UNSUPPORTED_FORMAT', false],
  ['forbidden', { src: '/errors/forbidden.mp4' }, 'FORBIDDEN', false],
  ['server error (retried, then fatal)', { src: '/errors/server-error.m3u8' }, 'SERVER', true],
  ['javascript: URL', { src: 'javascript:alert(1)' }, 'INVALID_SOURCE', false],
];

for (const [label, source, code, retried] of cases) {
  test(`error message: ${label} → ${code}`, async ({ page }) => {
    await openHarness(page);
    await create(page, { retry: { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 200, jitter: 0 } });
    const r = await tryCall(page, 'a', 'setSource', source);
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.error.code).toBe(code);
    const s = await state(page);
    expect(s.status).toBe('error');
    expect(s.error!.fatal).toBe(true);
    expect((await events(page, 'a', 'retry')).length > 0).toBe(retried);
    // the viewer sees a readable message and the code, in an alert region
    const alert = page.locator('.asx-error[role=alert]');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(s.error!.message);
    await expect(alert).toContainText(code);
  });
}

test('error message: expired signed URL → EXPIRED_URL; fresh signature plays', async ({ page }) => {
  await openHarness(page);
  await create(page, {});
  const expired = await (await page.request.get('/__sign?path=hls/vod/master.m3u8&ttl=-30')).json();
  const r = await tryCall(page, 'a', 'setSource', { src: expired.url, expiresAt: expired.expiresAt });
  expect(r.ok ? null : r.error.code).toBe('EXPIRED_URL');
  await expect(page.locator('.asx-error')).toContainText('expired');
  await expect(page.locator('.asx-error-retry')).toBeHidden(); // only a fresh URL can fix this
  const fresh = await (await page.request.get('/__sign?path=hls/vod/master.m3u8&ttl=600')).json();
  await call(page, 'a', 'setSource', { src: fresh.url, expiresAt: fresh.expiresAt });
  await playMuted(page);
  await expectProgress(page, 1); // path-token signing stays valid for every segment request
});

test('retry button after a fatal error reloads the source', async ({ page }) => {
  await openHarness(page);
  await addFault(page, { match: 'short.mp4', status: 503, count: 4 });
  await create(page, { retry: { maxAttempts: 1, baseDelayMs: 50, maxDelayMs: 50, jitter: 0 } });
  const r = await tryCall(page, 'a', 'setSource', { src: '/media/mp4/short.mp4' });
  expect(r.ok ? null : r.error.code).toBe('SERVER');
  await clearFaults(page);
  await call(page, 'a', 'setMuted', true);
  await page.locator('.asx-error-retry').click();
  await waitState(page, 's.status === "playing"');
  await expectProgress(page, 1);
});
