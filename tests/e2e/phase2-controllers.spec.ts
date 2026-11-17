import { test, expect } from 'playwright/test';
import { openHarness } from './helpers.ts';

type AnyPlayer = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type W = { AdStreamX: { create(el: Element, c: unknown, o?: unknown): AnyPlayer; createEd25519Verifier(k: unknown): unknown } };

test.beforeEach(async ({ page }) => {
  await page.request.delete('/__analytics');
});

test('analytics: off by default, consent-gated, batches reach ingest, no tokens, session_end by beacon', async ({ page }) => {
  await openHarness(page);
  const signed = await (await page.request.get('/__sign?path=mp4/short.mp4&ttl=600')).json();
  const result = await page.evaluate(async (src) => {
    const W = window as unknown as W;
    const off = W.AdStreamX.create(document.getElementById('slot-b')!, { source: { src: '/media/mp4/short.mp4' } });
    const offStats = off.analytics.getStats();
    off.destroy();

    const p = W.AdStreamX.create(document.getElementById('slot-a')!, {
      source: { src },
      muted: true,
      analytics: { enabled: true, endpoint: '/__analytics', requireConsent: true, batchSize: 5, flushIntervalMs: 1000, heartbeatIntervalMs: 5000 },
    });
    await p.ready();
    const beforeConsent = p.analytics.getStats().queued;
    p.analytics.setConsent(true);
    await p.play();
    await new Promise((r) => setTimeout(r, 6500)); // > one heartbeat
    p.pause();
    await new Promise((r) => setTimeout(r, 300)); // let the 'pause' event fire before tearing down
    await p.analytics.flush();
    const stats = p.analytics.getStats();
    const sessionId = p.analytics.sessionId;
    p.destroy(); // session_end via sendBeacon
    return { offStats, beforeConsent, stats, sessionId };
  }, signed.url);
  expect(result.offStats.enabled).toBe(false);
  expect(result.offStats.queued).toBe(0);
  expect(result.beforeConsent).toBe(0);
  expect(result.stats.watchMs).toBeGreaterThan(5000);

  await expect.poll(async () => (await (await page.request.get('/__analytics')).json()).events.map((e: { type: string }) => e.type), { timeout: 10000 }).toContain('session_end');
  const ingest = await (await page.request.get('/__analytics')).json();
  const types: string[] = ingest.events.map((e: { type: string }) => e.type);
  for (const t of ['play', 'playback_start', 'heartbeat', 'pause', 'session_end']) expect(types, t).toContain(t);
  expect(types).not.toContain('session_start'); // emitted before consent → never collected
  expect(ingest.duplicates).toBe(0);
  expect(ingest.events.every((e: { sessionId: string }) => e.sessionId === result.sessionId)).toBe(true);
  const raw = JSON.stringify(ingest.events);
  const [, , exp, sig] = (signed.url as string).split('/'); // /signed/<exp>/<sig>/mp4/short.mp4
  expect(raw).not.toContain(sig); // signature never leaves the page
  expect(raw).not.toContain(exp);
  expect(raw).not.toMatch(/sig=|token=/);
  const start = ingest.events.find((e: { type: string }) => e.type === 'playback_start');
  expect(start.data.startupMs).toBeGreaterThanOrEqual(0);
});

test('plugins: an engine fills the ads controller; impressions are deduplicated in analytics', async ({ page }) => {
  await openHarness(page);
  const r = await page.evaluate(async () => {
    const W = window as unknown as W;
    const p = W.AdStreamX.create(document.getElementById('slot-a')!, {
      source: { src: '/media/mp4/short.mp4' },
      analytics: { enabled: true, requireConsent: false },
    });
    const before = { available: p.ads.available, err: await p.ads.requestBreak({ position: 'preroll' }).catch((e: { code: string }) => e.code) };
    const seen: string[] = [];
    for (const e of ['pluginregistered', 'adbreakstart', 'adstarted', 'adcompleted', 'adbreakend']) p.on(e, () => seen.push(e));
    const unregister = p.use({
      name: 'test-ads',
      setup(ctx: AnyPlayer) {
        ctx.registerAdEngine({
          provider: 'test',
          capabilities: () => ({ linear: true, nonLinear: false, companions: false, skippable: false, vmap: false, liveBreaks: true }),
          async requestBreak(req: { position: string }) {
            const info = { breakId: 'b1', position: req.position, provider: 'test', adId: 'ad1' };
            ctx.emit('adbreakstart', { breakId: 'b1', position: req.position });
            ctx.emit('adstarted', info);
            ctx.emit('adstarted', info); // duplicate provider callback
            ctx.emit('adcompleted', info);
            ctx.emit('adbreakend', { breakId: 'b1', position: req.position, reason: 'completed' });
          },
          cancelBreak: () => false,
          skip: () => false,
          isBreakActive: () => false,
          destroy() {},
        });
        // core playback events cannot be forged by plugins
        ctx.emit('ended', {});
      },
    });
    await p.ads.requestBreak({ position: 'preroll' });
    const adStarts = p.analytics.getQueue().filter((e: { type: string }) => e.type === 'ad_start').length;
    const forged = p.analytics.getQueue().some((e: { type: string }) => e.type === 'ended');
    unregister();
    const seenSnapshot = [...seen];
    const after = p.ads.available;
    const dup = (() => {
      try {
        p.use({ name: 'test-ads', setup() {} });
        p.use({ name: 'test-ads', setup() {} });
        return 'no error';
      } catch (e) {
        return (e as Error).message;
      }
    })();
    p.destroy();
    return { before, seen: seenSnapshot, adStarts, forged, after, dup };
  });
  expect(r.before).toEqual({ available: false, err: 'FEATURE_UNAVAILABLE' });
  expect(r.seen).toEqual(['pluginregistered', 'adbreakstart', 'adstarted', 'adstarted', 'adcompleted', 'adbreakend']);
  expect(r.adStarts).toBe(1);
  expect(r.forged).toBe(false);
  expect(r.after).toBe(false);
  expect(r.dup).toContain('already registered');
});

test('commands: viewer/host/operator permissions, signed announcement shown, overlays unavailable', async ({ page }) => {
  await openHarness(page);
  const r = await page.evaluate(async () => {
    const W = window as unknown as W;
    const kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
    const p = W.AdStreamX.create(document.getElementById('slot-a')!, { source: { src: '/media/mp4/short.mp4' }, muted: true }, { commandVerifier: W.AdStreamX.createEd25519Verifier({ k1: jwk }) });
    await p.ready();
    const now = Date.now();
    const c = (id: string, type: string, payload?: unknown, extra: object = {}) => ({ v: 1, id, type, issuedAt: now, payload, ...extra });
    const canon = (v: unknown): string =>
      v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canon).join(',')}]`
        : `{${Object.keys(v as object).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(',')}}`;
    const sign = async (cmd: Record<string, unknown>) => {
      const s = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, new TextEncoder().encode(canon(cmd))));
      return { ...cmd, sig: btoa(String.fromCharCode(...s)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') };
    };
    const out: Record<string, unknown> = {};
    out.viewerSource = (await p.command(c('a', 'setSource', { src: '/media/hls/vod/master.m3u8' }), 'viewer')).reason;
    out.hostVolume = (await p.command(c('b', 'setVolume', { volume: 0.4 }), 'host')).status;
    await new Promise((r) => setTimeout(r, 50));
    out.volume = p.getState().volume;
    out.hostBrand = (await p.command(c('c', 'updateConfig', { patch: { branding: { title: 'Remote title' } } }), 'host')).status;
    out.hostAnalytics = (await p.command(c('d', 'updateConfig', { patch: { analytics: { enabled: true } } }), 'host')).reason;
    out.unsignedOperator = (await p.command(c('e', 'announce', { text: 'x' }), 'operator')).reason;
    out.signedOperator = (await p.command(await sign(c('f', 'announce', { text: 'Stream restarts shortly <b>bold?</b>', level: 'warning' }, { kid: 'k1' })), 'operator')).status;
    out.overlay = (await p.command(await sign(c('g', 'showOverlay', { overlayId: 'promo' }, { kid: 'k1' })), 'operator')).reason;
    out.expired = (await p.command({ ...c('h', 'pause'), issuedAt: now - 120000, expiresAt: now - 60000 }, 'viewer')).reason;
    out.history = p.commands.history().length;
    return out;
  });
  expect(r).toMatchObject({
    viewerSource: 'FORBIDDEN',
    hostVolume: 'applied',
    volume: 0.4,
    hostBrand: 'applied',
    hostAnalytics: 'INVALID',
    unsignedOperator: 'UNVERIFIED',
    signedOperator: 'applied',
    overlay: 'FEATURE_UNAVAILABLE',
    expired: 'EXPIRED',
    history: 8,
  });
  await expect(page.locator('.asx-title')).toHaveText('Remote title');
  const banner = page.locator('.asx-announce[role=status]');
  await expect(banner).toHaveText('Stream restarts shortly <b>bold?</b>'); // rendered as text, never HTML
  await expect(banner.locator('b')).toHaveCount(0);
  await expect(banner).toHaveClass(/asx-warning/);
});

test('controllers expose the documented surface', async ({ page }) => {
  await openHarness(page);
  const r = await page.evaluate(async () => {
    const W = window as unknown as W;
    const p = W.AdStreamX.create(document.getElementById('slot-a')!, { source: { src: '/media/mp4/short.mp4' } });
    await p.ready();
    const names = ['playback', 'config', 'ads', 'overlays', 'interactions', 'analytics', 'commands'].filter((k) => p[k]);
    p.playback.setVolume(0.3);
    await new Promise((r) => setTimeout(r, 50)); // state follows the media element's volumechange
    const vol = p.playback.getState().volume;
    let changed = '';
    const off = p.config.onChange((c: { branding: { title: string } }) => (changed = c.branding.title));
    p.config.update({ branding: { title: 'via controller' } });
    off();
    const results = await Promise.all([
      p.overlays.show('x').catch((e: { code: string }) => e.code),
      p.interactions.open('poll').catch((e: { code: string }) => e.code),
      p.interactions.vote('poll', ['a']).catch((e: { code: string }) => e.code),
    ]);
    p.destroy();
    return { names, vol, changed, results, listOverlays: [] };
  });
  expect(r.names).toEqual(['playback', 'config', 'ads', 'overlays', 'interactions', 'analytics', 'commands']);
  expect(r.vol).toBe(0.3);
  expect(r.changed).toBe('via controller');
  expect(r.results).toEqual(['FEATURE_UNAVAILABLE', 'FEATURE_UNAVAILABLE', 'FEATURE_UNAVAILABLE']);
});
