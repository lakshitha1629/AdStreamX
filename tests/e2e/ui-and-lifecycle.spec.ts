import { test, expect } from 'playwright/test';
import { call, create, events, expectProgress, openHarness, playMuted, state, waitState } from './helpers.ts';

test('keyboard: play/pause, seek, volume, mute, captions — only when the player has focus', async ({ page }) => {
  await openHarness(page);
  await create(page, {
    source: { src: '/media/mp4/short.mp4', textTracks: [{ src: '/media/captions/short.en.vtt', srclang: 'en', label: 'English' }] },
    muted: true,
  });
  await call(page, 'a', 'ready');
  await page.keyboard.press('k'); // focus is on <body>: must NOT control the player
  await page.waitForTimeout(300);
  expect((await state(page)).paused).toBe(true);
  await page.locator('[data-adstreamx]').focus();
  await page.keyboard.press('k');
  await waitState(page, '!s.paused');
  await page.keyboard.press('k');
  await waitState(page, 's.paused');
  const t0 = (await state(page)).currentTime;
  await page.keyboard.press('ArrowRight');
  await waitState(page, `!s.seeking && s.currentTime >= ${t0 + 4.5}`);
  await page.keyboard.press('ArrowDown'); // a volume change also unmutes
  await waitState(page, 's.volume < 0.95 && s.muted === false');
  await page.keyboard.press('m');
  await waitState(page, 's.muted === true');
  await page.keyboard.press('m');
  await waitState(page, 's.muted === false');
  await page.keyboard.press('c');
  await waitState(page, 's.textTracks[0].active');
  await page.keyboard.press('5');
  await waitState(page, '!s.seeking && Math.abs(s.currentTime - s.duration / 2) < 1');
  await page.keyboard.press('Control+f'); // modifier combos are never captured
  expect((await state(page)).fullscreen).toBe(false);
});

test('controls are keyboard reachable and every control has an accessible name', async ({ page }) => {
  await openHarness(page);
  await create(page, { source: { src: '/media/hls/vod/master.m3u8' } });
  await call(page, 'a', 'ready');
  const unnamed = await page.$$eval('[data-adstreamx] button:not([hidden]), [data-adstreamx] input', (els) =>
    els
      .filter((e) => (e as HTMLElement).offsetParent !== null)
      .filter((e) => !(e.getAttribute('aria-label') || e.textContent?.trim()))
      .map((e) => e.outerHTML.slice(0, 80)),
  );
  expect(unnamed).toEqual([]);
  // open the quality menu with the keyboard, navigate, close with Escape, focus returns
  const q = page.locator('[data-adstreamx] button[aria-label="Quality"]');
  await q.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.asx-menu[role=menu]')).toBeVisible();
  await expect(page.locator('.asx-menu-item[aria-checked=true]')).toBeFocused();
  await expect(page.locator('.asx-menu')).toContainText('browser choose the quality');
  await page.keyboard.press('Escape');
  await expect(page.locator('.asx-menu')).toBeHidden();
  await expect(q).toBeFocused();
  await expect(q).toHaveAttribute('aria-expanded', 'false');
});

test('fullscreen and theater toggles; layout adapts to a mobile viewport', async ({ page }) => {
  await openHarness(page);
  await create(page, { source: { src: '/media/mp4/short.mp4' } });
  await call(page, 'a', 'ready');
  await page.locator('[data-adstreamx] button[aria-label="Fullscreen"]').click();
  await waitState(page, 's.fullscreen === true');
  expect(await page.evaluate(() => document.fullscreenElement?.hasAttribute('data-adstreamx'))).toBe(true);
  await call(page, 'a', 'exitFullscreen');
  await waitState(page, 's.fullscreen === false');
  await page.locator('[data-adstreamx] button[aria-label="Theater mode"]').click();
  await waitState(page, 's.theater === true');
  await expect(page.locator('[data-adstreamx]')).toHaveClass(/asx-theater/);
  expect((await events(page, 'a', 'theaterchange')).length).toBe(1);
  await page.setViewportSize({ width: 375, height: 700 });
  await expect(page.locator('.asx-volume')).toBeHidden();
  await expect(page.locator('[data-adstreamx] button[aria-label="Play"]').first()).toBeVisible();
  const box = await page.locator('[data-adstreamx]').boundingBox();
  expect(box!.width).toBeLessThanOrEqual(375);
});

test('touch: double-tap right side seeks forward; vertical swipe is left to the page', async ({ browser }) => {
  const ctx = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await openHarness(page);
  await create(page, { source: { src: '/media/mp4/short.mp4' }, muted: true });
  await call(page, 'a', 'ready');
  const g = page.locator('.asx-gesture');
  const box = (await g.boundingBox())!;
  const x = box.x + box.width * 0.85;
  const y = box.y + box.height / 2;
  await page.touchscreen.tap(x, y);
  await page.waitForTimeout(80);
  await page.touchscreen.tap(x, y);
  await waitState(page, '!s.seeking && s.currentTime >= 9.5');
  const touchAction = await g.evaluate((el) => getComputedStyle(el).touchAction);
  expect(touchAction).toBe('manipulation'); // pan/scroll stays with the browser
  await ctx.close();
});

test('muted autoplay: autoplay "muted" starts without a gesture', async ({ page }) => {
  await openHarness(page);
  await create(page, { source: { src: '/media/mp4/short.mp4' }, autoplay: 'muted' });
  const s = await waitState(page, 's.status === "playing"');
  expect(s.muted).toBe(true);
});

test('cleanup: repeated create/destroy leaves no players, DOM, listeners or heap growth', async ({ page }) => {
  await openHarness(page);
  const cdp = await page.context().newCDPSession(page);
  const heap = async () => {
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.collectGarbage');
    return (await cdp.send('Runtime.getHeapUsage')).usedSize;
  };
  const cycle = (n: number) =>
    page.evaluate(async (count) => {
      const W = window as unknown as { AdStreamX: { create(el: Element, c: unknown): { on(t: string, f: () => void): () => void; ready(): Promise<void>; play(): Promise<void>; destroy(): void; listenerCount(): number } } };
      const host = document.getElementById('slot-b')!;
      let maxListeners = 0;
      for (let i = 0; i < count; i++) {
        const p = W.AdStreamX.create(host, { source: { src: i % 2 ? '/media/mp4/short.mp4' : '/media/hls/vod/master.m3u8' }, muted: true });
        p.on('playing', () => undefined);
        await p.ready();
        await p.play().catch(() => undefined);
        await new Promise((r) => setTimeout(r, 30));
        maxListeners = Math.max(maxListeners, p.listenerCount());
        p.destroy();
        if (p.listenerCount() !== 0) throw new Error('listeners left after destroy');
      }
      return maxListeners;
    }, n);
  await cycle(10); // warm-up (JIT, caches)
  const before = await heap();
  await cycle(40);
  const after = await heap();
  const growthMb = (after - before) / 1024 / 1024;
  test.info().annotations.push({ type: 'heap-growth-40-cycles', description: `${growthMb.toFixed(2)} MB` });
  expect(await page.evaluate(() => (window as unknown as { AdStreamX: { activeCount(): number } }).AdStreamX.activeCount())).toBe(0);
  expect(await page.locator('#slot-b *').count()).toBe(0);
  expect(await page.locator('video').count()).toBe(0);
  expect(growthMb).toBeLessThan(5);
});

test('destroy during load and during playback is safe', async ({ page }) => {
  const errors = await openHarness(page);
  await create(page, { source: { src: '/live/ts/12/master.m3u8' } }, 'a');
  await call(page, 'a', 'destroy'); // immediately, mid-load
  await create(page, { source: { src: '/media/hls/vod/master.m3u8' } }, 'b', 'slot-b');
  await call(page, 'b', 'ready');
  await playMuted(page, 'b');
  await expectProgress(page, 0.5, 'b');
  await call(page, 'b', 'destroy');
  await page.waitForTimeout(500);
  expect(errors).toEqual([]);
  expect((await events(page, undefined, 'destroyed')).length).toBe(2);
  expect(await page.locator('video').count()).toBe(0);
});

test('wrapping an existing <video> restores it on destroy', async ({ page }) => {
  await openHarness(page);
  const r = await page.evaluate(async () => {
    const v = document.createElement('video');
    v.id = 'host-video';
    v.controls = true;
    document.body.appendChild(v);
    const W = window as unknown as { AdStreamX: { create(el: Element, c: unknown): { ready(): Promise<void>; destroy(): void; element: HTMLElement } } };
    const p = W.AdStreamX.create(v, { source: { src: '/media/mp4/short.mp4' } });
    await p.ready();
    const wrapped = v.parentElement === p.element && !v.controls;
    p.destroy();
    return { wrapped, restored: v.parentElement === document.body && v.controls === true, roots: document.querySelectorAll('[data-adstreamx]').length };
  });
  expect(r).toEqual({ wrapped: true, restored: true, roots: 0 });
});

test('config validation rejects unsafe values before touching the page', async ({ page }) => {
  await openHarness(page);
  const r = await page.evaluate(() => {
    const W = window as unknown as { AdStreamX: { create(el: Element, c: unknown): unknown } };
    try {
      W.AdStreamX.create(document.getElementById('slot-a')!, { branding: { logoUrl: 'javascript:alert(1)' }, volume: 3 });
      return 'created';
    } catch (e) {
      return { name: (e as Error).name, issues: (e as { issues: string[] }).issues, leftovers: document.querySelectorAll('[data-adstreamx]').length };
    }
  });
  expect(r).toMatchObject({ name: 'ConfigError', leftovers: 0 });
  expect((r as { issues: string[] }).issues.length).toBe(2);
});
