import { test, expect } from 'playwright/test';
import { clearFaults } from './helpers.ts';

test.beforeEach(async ({ page }) => clearFaults(page));
test.afterEach(async ({ page }) => clearFaults(page));

test('Player Lab: load presets, inspect state, simulate faults, download diagnostics, reset', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/lab/');
  const status = page.getByTestId('status');
  await expect(status).toHaveText('idle');

  // VOD preset
  await page.getByLabel('Fixture preset').selectOption('mp4');
  await page.getByTestId('load').click();
  await expect(status).toHaveText('ready');
  await page.locator('.asx-bigplay').click();
  await expect(status).toHaveText('playing');
  await expect(page.getByTestId('event-log')).toContainText('loadedmetadata');

  // Live preset with diagnostics
  await page.getByLabel('Fixture preset').selectOption('live-ts');
  await page.getByTestId('load').click();
  await expect(status).toHaveText(/playing|ready/);
  await expect(page.getByTestId('live')).toContainText('Latency');

  // Fault simulator: outage produces recovery activity, clearing it recovers
  await page.getByRole('button', { name: 'All segments → 503 (outage)' }).click();
  await expect(page.locator('.faults')).toContainText('/seg_');
  await expect(status).toHaveText(/recovering|buffering/, { timeout: 30_000 });
  await page.getByRole('button', { name: 'Clear faults' }).click();
  await expect(status).toHaveText('playing', { timeout: 40_000 });

  // Error preset shows the error in the inspector
  await page.getByLabel('Fixture preset').selectOption('missing');
  await page.getByTestId('load').click();
  await expect(status).toHaveText('error');
  await expect(page.getByTestId('state')).toContainText('MISSING_FILE');

  // Diagnostics download
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download diagnostics' }).click()]);
  const json = JSON.parse(await (await dl.createReadStream()).toArray().then((c) => Buffer.concat(c).toString('utf8')));
  expect(json.capabilities.engines).toContain('native');
  expect(json.events.length).toBeGreaterThan(5);
  expect(json.state.error.code).toBe('MISSING_FILE');

  // Responsive preview
  await page.getByRole('button', { name: 'Mobile 375' }).click();
  await expect.poll(async () => (await page.locator('[data-adstreamx]').boundingBox())!.width).toBeLessThanOrEqual(375);

  // Reset recreates the player and clears the log
  await page.getByRole('button', { name: 'Reset' }).click();
  await expect(status).toHaveText('idle');
  await expect(page.locator('[data-adstreamx]')).toHaveCount(1);
  expect(errors).toEqual([]);
});
