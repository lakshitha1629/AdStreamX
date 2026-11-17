import { test, expect, type Page } from 'playwright/test';
import { webcrypto } from 'node:crypto';

// Origins: the player is served from :8080; the trusted host page from :8081; an untrusted
// page from :8082 (separate origins on the same fixture server — playwright.config.ts).
const PLAYER = 'http://127.0.0.1:8080';
const HOST = 'http://127.0.0.1:8081';
const EVIL = 'http://127.0.0.1:8082';

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const canonical = (v: unknown): string =>
  v === null || typeof v !== 'object'
    ? JSON.stringify(v)
    : Array.isArray(v)
      ? `[${v.map(canonical).join(',')}]`
      : `{${Object.keys(v as object).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;

async function operatorKey() {
  const kp = (await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as unknown as CryptoKeyPair;
  const jwk = await webcrypto.subtle.exportKey('jwk', kp.publicKey);
  const sign = async (cmd: Record<string, unknown>) => {
    const sig = Buffer.from(await webcrypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, Buffer.from(canonical(cmd)))).toString('base64url');
    return { ...cmd, sig };
  };
  return { jwk, sign };
}

function embedUrl(cfg: Record<string, unknown>) {
  return `${PLAYER}/embed/#cfg=${b64url(JSON.stringify(cfg))}`;
}

async function openHost(page: Page, origin: string, url: string, channel = 'c1', id = 'f1') {
  await page.goto(`${origin}/e2e/host.html`);
  await page.evaluate(([u, o, c, i]) => (window as unknown as { setup: (...a: string[]) => void }).setup(u!, o!, c!, i!), [url, PLAYER, channel, id]);
}

const client = (page: Page, method: string, ...args: unknown[]) =>
  page.evaluate(
    async ([m, a]) => {
      const c = (window as unknown as { cl: () => Record<string, (...x: unknown[]) => Promise<unknown>> }).cl();
      try {
        return { ok: true, v: await c[m as string]!(...(a as unknown[])) };
      } catch (e) {
        return { ok: false, code: (e as { code?: string }).code, payload: (e as { payload?: unknown }).payload };
      }
    },
    [method, args] as const,
  );

const frameState = (page: Page, id = 'f1') =>
  page.frameLocator(`#${id}`).locator('body').evaluate(() => (window as unknown as { __adstreamxEmbed: { player: { getState(): Record<string, unknown> } } }).__adstreamxEmbed.player.getState());

test('trusted cross-origin host controls the iframe player via protocol v1', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const { jwk, sign } = await operatorKey();
  await openHost(page, HOST, embedUrl({
    player: { source: { src: '/media/mp4/short.mp4' }, muted: true, allowedSourceOrigins: [PLAYER] },
    allowedOrigins: [HOST],
    channel: 'c1',
    operatorKeys: { k1: jwk },
  }));
  const ready = await client(page, 'ready');
  expect(ready.ok).toBe(true);

  // events subscription
  await page.evaluate(() => {
    const c = (window as unknown as { cl: () => { on: (e: string, f: (p: unknown) => void) => void } }).cl();
    for (const e of ['playing', 'pause', 'seeked', 'announcement', 'commandrejected']) c.on(e, (p) => (window as unknown as { __evts: unknown[] }).__evts.push({ e, p }));
  });
  expect((await client(page, 'play')).ok).toBe(true);
  await expect.poll(async () => (await frameState(page)).currentTime as number, { timeout: 15000 }).toBeGreaterThan(1);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __evts: { e: string }[] }).__evts.some((x) => x.e === 'playing'))).toBe(true);

  expect((await client(page, 'seekTo', 6)).ok).toBe(true);
  await expect.poll(async () => (await frameState(page)).currentTime as number).toBeGreaterThanOrEqual(6);
  expect((await client(page, 'pause')).ok).toBe(true);
  await expect.poll(async () => (await frameState(page)).paused).toBe(true);
  const st = (await client(page, 'getState')) as { ok: boolean; v: { paused: boolean; duration: unknown } };
  expect(st.v.paused).toBe(true);

  // host may switch to an approved source, not to an arbitrary one
  expect((await client(page, 'setSource', '/media/hls/vod/master.m3u8')).ok).toBe(true);
  await expect.poll(async () => String((await frameState(page)).source && ((await frameState(page)).source as { src: string }).src)).toContain('/media/hls/vod/master.m3u8');
  const evil = await client(page, 'setSource', 'https://evil.example/hijack.mp4');
  expect(evil.ok).toBe(false);
  expect((evil.payload as { reason: string }).reason).toBe('FAILED');

  // host cannot use operator-only commands
  const ann = await client(page, 'command', 'announce', { text: 'host pretending to be operator' });
  expect(ann.ok).toBe(false);
  expect((ann.payload as { reason: string }).reason).toBe('FORBIDDEN');

  // operator commands: forged → UNVERIFIED; signed → applied and shown inside the iframe
  const now = Date.now();
  const forged = await client(page, 'operatorCommand', { v: 1, id: 'op-1', type: 'announce', issuedAt: now, kid: 'k1', sig: 'A'.repeat(86), payload: { text: 'forged' } });
  expect((forged.payload as { reason: string }).reason).toBe('UNVERIFIED');
  const signed = await sign({ v: 1, id: 'op-1', type: 'announce', issuedAt: now, expiresAt: now + 60000, kid: 'k1', payload: { text: 'We go live in 5 minutes' } });
  const okOp = await client(page, 'operatorCommand', signed);
  expect(okOp.ok).toBe(true);
  await expect(page.frameLocator('#f1').locator('.asx-announce')).toHaveText('We go live in 5 minutes');
  // replaying the same signed command is acknowledged as a duplicate, not re-applied
  const replay = await client(page, 'operatorCommand', signed);
  expect((replay.v as { status: string }).status).toBe('duplicate');
  // signed, but operators may not pause viewers
  const pauseSigned = await sign({ v: 1, id: 'op-2', type: 'pause', issuedAt: now, kid: 'k1' });
  expect(((await client(page, 'operatorCommand', pauseSigned)).payload as { reason: string }).reason).toBe('FORBIDDEN');
  expect(errors).toEqual([]);
});

test('untrusted origin cannot read or control the iframe player', async ({ page }) => {
  await openHost(page, EVIL, embedUrl({ player: { source: { src: '/media/mp4/short.mp4' }, muted: true }, allowedOrigins: [HOST], channel: 'c1' }));
  const ready = await client(page, 'ready');
  expect(ready.ok).toBe(false);
  expect(ready.code).toBe('NOT_TRUSTED');
  for (const m of ['getState', 'play', 'pause']) {
    const r = await client(page, m);
    expect(r.ok, m).toBe(false);
    expect(r.code, m).toBe('TIMEOUT'); // silently ignored, nothing disclosed
  }
  await page.waitForTimeout(500);
  const s = await frameState(page);
  expect(s.paused).toBe(true);
  expect(s.currentTime).toBe(0);
});

test('several embeds on one page stay isolated by channel', async ({ page }) => {
  await page.goto(`${HOST}/e2e/host.html`);
  for (const [id, ch] of [['f1', 'a'], ['f2', 'b']]) {
    const url = embedUrl({ player: { source: { src: '/media/mp4/short.mp4' }, muted: true }, allowedOrigins: [HOST], channel: ch });
    await page.evaluate(([u, o, c, i]) => (window as unknown as { setup: (...a: string[]) => void }).setup(u!, o!, c!, i!), [url, PLAYER, ch!, id!]);
  }
  await page.evaluate(() => (window as unknown as { cl: (i: string) => { ready(): Promise<unknown> } }).cl('f1').ready());
  await page.evaluate(() => (window as unknown as { cl: (i: string) => { ready(): Promise<unknown> } }).cl('f2').ready());
  await page.evaluate(() => (window as unknown as { cl: (i: string) => { play(): Promise<unknown> } }).cl('f2').play());
  await expect.poll(async () => (await frameState(page, 'f2')).currentTime as number, { timeout: 15000 }).toBeGreaterThan(0.5);
  expect((await frameState(page, 'f1')).paused).toBe(true);
});

test('embed page refuses invalid configuration with a readable message', async ({ page }) => {
  await page.goto(`${PLAYER}/embed/`);
  await expect(page.getByRole('alert')).toContainText('No player configuration');
  await page.goto(embedUrl({ player: {}, allowedOrigins: ['*'] }));
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('exact origins');
  await page.goto(embedUrl({ player: { volume: 7 }, allowedOrigins: [] }));
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('volume');
  // quick ?src= preview mode plays without remote control
  await page.goto(`${PLAYER}/embed/?src=/media/mp4/short.mp4`);
  await expect(page.locator('.asx-bigplay')).toBeVisible();
});

test('the Player Lab cannot be framed by another origin; the embed page can', async ({ page }) => {
  await page.goto(`${HOST}/e2e/host.html`);
  const res = await page.request.get(`${PLAYER}/lab/`);
  expect(res.headers()['content-security-policy']).toBe("frame-ancestors 'self'");
  const embedRes = await page.request.get(`${PLAYER}/embed/`);
  expect(embedRes.headers()['content-security-policy']).toBeUndefined();
});
