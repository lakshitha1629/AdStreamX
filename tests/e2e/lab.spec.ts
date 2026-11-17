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

test('Player Lab Phase 2 panels: embed code, iframe preview, command console, analytics consent', async ({ page, context }) => {
  await page.request.delete('/__analytics');
  await page.goto('/lab/');
  await page.getByLabel('Fixture preset').selectOption('mp4');
  await page.getByTestId('load').click();
  await expect(page.getByTestId('status')).toHaveText('ready');

  // embed code: iframe snippet with the configured origin, script snippet escaped
  const code = page.getByTestId('embed-code');
  await expect(code).toHaveValue(/<iframe id="adstreamx-player" src="http:\/\/127\.0\.0\.1:8080\/embed\/#cfg=/);
  await page.getByRole('tab', { name: 'script' }).click();
  await expect(code).toHaveValue(/AdStreamX\.create/);
  await page.getByTestId('embed-origin').fill('*');
  await expect(page.getByRole('alert').filter({ hasText: 'exact origins' })).toBeVisible();
  await page.getByTestId('embed-origin').fill('http://127.0.0.1:8080');
  // the generated iframe URL really boots the player
  const [popup] = await Promise.all([context.waitForEvent('page'), page.getByRole('link', { name: 'Open iframe player' }).click()]);
  await expect(popup.locator('.asx-bigplay')).toBeVisible();
  await popup.close();

  // command console: host pause applied, viewer setSource forbidden, unsigned operator rejected
  await page.locator('.asx-bigplay').click();
  await expect(page.getByTestId('status')).toHaveText('playing');
  await page.getByTestId('cmd-type').selectOption('pause');
  await page.getByTestId('cmd-send').click();
  await expect(page.getByTestId('cmd-acks')).toContainText('pause → applied');
  await expect(page.getByTestId('status')).toHaveText('paused');
  await page.getByTestId('cmd-role').selectOption('viewer');
  await page.getByTestId('cmd-type').selectOption('setSource');
  await page.getByTestId('cmd-send').click();
  await expect(page.getByTestId('cmd-acks')).toContainText('setSource → rejected (FORBIDDEN)');
  await page.getByTestId('cmd-role').selectOption('operator');
  await page.getByTestId('cmd-type').selectOption('announce');
  await page.getByTestId('cmd-send').click();
  await expect(page.getByTestId('cmd-acks')).toContainText('announce → rejected (UNVERIFIED)');

  // analytics: nothing before consent, events after
  await page.getByTestId('analytics-enabled').check();
  await page.locator('.asx-bigplay').click();
  await expect(page.getByTestId('analytics-stats')).toContainText('0 / 0');
  await page.getByTestId('analytics-consent').check();
  await page.getByTestId('cmd-role').selectOption('host');
  await page.getByTestId('cmd-type').selectOption('pause');
  await page.getByTestId('cmd-send').click();
  await page.getByRole('button', { name: 'Flush now' }).click();
  await page.getByRole('button', { name: 'Server received' }).click();
  await expect(page.getByTestId('analytics-server')).toContainText(/[1-9]\d* events · 0 dup/);
});
