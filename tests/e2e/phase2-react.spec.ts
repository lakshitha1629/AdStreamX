import { test, expect, type Page } from 'playwright/test';

type W = Window & {
  __react: { set(p: Record<string, unknown>): void; log: string[]; handle(): { player: { id: string; getState(): Record<string, unknown>; getConfig(): { branding: { title?: string } } } | null } | null };
  AdStreamXActive: () => number;
};
const active = (page: Page) => page.evaluate(() => (window as unknown as W).AdStreamXActive());
const st = (page: Page) => page.evaluate(() => (window as unknown as W).__react.handle()?.player?.getState() ?? null);
const pid = (page: Page) => page.evaluate(() => (window as unknown as W).__react.handle()?.player?.id ?? null);
const set = (page: Page, p: Record<string, unknown>) => page.evaluate((x) => (window as unknown as W).__react.set(x), p);
const log = (page: Page) => page.evaluate(() => [...(window as unknown as W).__react.log]);

test('React wrapper: StrictMode-safe lifecycle, prop updates without re-creation, clean unmount', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/e2e/react.html');
  await expect.poll(() => log(page)).toContain('ready:A');
  // StrictMode mounted twice in dev; exactly one live player and one DOM root remain
  expect(await active(page)).toBe(1);
  await expect(page.locator('[data-adstreamx]')).toHaveCount(1);
  const id1 = await pid(page);
  expect((await st(page))!.duration).toBeCloseTo(12, 0);

  // source prop change → setSource on the same instance
  await set(page, { source: { src: '/media/hls/vod/master.m3u8' } });
  await expect.poll(async () => ((await st(page))!.source as { src: string } | null)?.src ?? '').toContain('/media/hls/vod/master.m3u8');
  await expect.poll(async () => (await st(page))!.duration as number).toBeGreaterThan(19);
  expect(await pid(page)).toBe(id1);
  expect(await active(page)).toBe(1);

  // config prop change → updateConfig (branding title appears in the UI)
  await set(page, { config: { muted: true, branding: { accentColor: '#ef4444', title: 'From React props' } } });
  await expect(page.locator('.asx-title')).toHaveText('From React props');
  expect(await pid(page)).toBe(id1);

  // new handler props are used without recreating the player
  await set(page, { handlerTag: 'B' });
  await page.evaluate(() => (window as unknown as W).__react.handle()!.player!.getState());
  await page.evaluate(async () => {
    const p = (window as unknown as { __react: { handle(): { player: { setMuted(m: boolean): void; play(): Promise<void> } } } }).__react.handle().player;
    p.setMuted(true);
    await p.play();
  });
  await expect.poll(() => log(page)).toContain('playing:B');
  expect(await pid(page)).toBe(id1);

  // unmount → destroyed, DOM gone; remount → exactly one fresh player
  await set(page, { mounted: false });
  await expect(page.locator('#unmounted')).toBeVisible();
  expect(await active(page)).toBe(0);
  await expect(page.locator('[data-adstreamx]')).toHaveCount(0);
  await expect(page.locator('video')).toHaveCount(0);
  await set(page, { mounted: true });
  await expect.poll(() => active(page)).toBe(1);
  expect(await pid(page)).not.toBe(id1);

  // repeated mount/unmount does not leak instances
  for (let i = 0; i < 10; i++) {
    await set(page, { mounted: false });
    await set(page, { mounted: true });
  }
  await expect.poll(() => active(page)).toBe(1);
  await expect(page.locator('[data-adstreamx]')).toHaveCount(1);
  expect(errors).toEqual([]);
});
