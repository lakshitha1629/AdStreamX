import { test, expect } from 'playwright/test';
import { call, create, events, openHarness, state, waitState } from './helpers.ts';

// Separate file: forcing Chrome's gesture-required autoplay policy needs its own browser.
// Headless Chrome does not enforce the autoplay policy (even with --autoplay-policy flags),
// so the policy is SIMULATED here: unmuted play() without user activation rejects with
// NotAllowedError, exactly as a real browser does. The player's reaction is what is tested.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    // Playwright's page.evaluate() counts as a user gesture, so navigator.userActivation is
    // not usable here; only real pointer/keyboard input counts as activation.
    let activated = false;
    for (const t of ['pointerdown', 'keydown']) window.addEventListener(t, () => (activated = true), { capture: true });
    const real = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      if (!this.muted && !activated) {
        return Promise.reject(new DOMException('play() failed because the user didn\'t interact with the document first.', 'NotAllowedError'));
      }
      return real.call(this);
    };
  });
});

test('unmuted autoplay blocked (simulated policy) → muted fallback; explicit fallback off → waits for gesture', async ({ page }) => {
  await openHarness(page);
  await create(page, { source: { src: '/media/mp4/short.mp4' }, autoplay: true }, 'a');
  let s = await waitState(page, 's.status === "playing"', 'a');
  expect(s.muted).toBe(true);
  expect((await events(page, 'a', 'autoplayblocked'))[0]!.e).toEqual({ mutedFallback: true });
  await call(page, 'a', 'destroy');
  await create(page, { source: { src: '/media/mp4/short.mp4' }, autoplay: true, autoplayMutedFallback: false }, 'b', 'slot-b');
  await page.waitForFunction(() => (window as unknown as { ev(n: string, t: string): unknown[] }).ev('b', 'autoplayblocked').length > 0);
  s = await state(page, 'b');
  expect(s.paused).toBe(true);
  expect(s.muted).toBe(false);
  await expect(page.locator('[data-adstreamx] .asx-bigplay')).toBeVisible();
  await page.locator('[data-adstreamx] .asx-bigplay').click(); // a real gesture
  await waitState(page, 's.status === "playing"', 'b');
});
