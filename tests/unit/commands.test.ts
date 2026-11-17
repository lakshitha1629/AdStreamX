import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PlayerCommand } from '@adstreamx/shared-types';
import { bytesToBase64url, canonicalJson, createEd25519Verifier, isAllowed, ROLE_PERMISSIONS, signingInput, validateCommand } from '@adstreamx/command-protocol';
import { PlayerCore } from '@adstreamx/player-core';
import { AdsController, CommandController, InteractionsController, OverlaysController } from '@adstreamx/player-sdk';
import { fakeVideo, mockFetch } from './helpers/fake-media.ts';

const NOW = 1_800_000_000_000;
const opts = { now: NOW, maxClockSkewMs: 300_000, defaultTtlMs: 60_000 };
const cmd = (over: Record<string, unknown> = {}) => ({ v: 1, id: 'c1', type: 'pause', issuedAt: NOW, ...over });

test('validation: accepts a well-formed command', () => {
  const r = validateCommand(cmd({ type: 'seek', payload: { time: 12 } }), opts);
  assert.equal(r.ok, true);
});

test('validation: rejects malformed, oversized, unknown and out-of-window commands', () => {
  const cases: [unknown, string][] = [
    [null, 'INVALID'],
    [[], 'INVALID'],
    [cmd({ v: 2 }), 'INVALID'],
    [cmd({ id: 'has space' }), 'INVALID'],
    [cmd({ id: 'x'.repeat(65) }), 'INVALID'],
    [cmd({ type: 'formatDisk' }), 'INVALID'],
    [cmd({ extra: 1 }), 'INVALID'],
    [cmd({ type: 'seek', payload: { time: -1 } }), 'INVALID'],
    [cmd({ type: 'seek', payload: { time: 'soon' } }), 'INVALID'],
    [cmd({ type: 'seek' }), 'INVALID'],
    [cmd({ type: 'setVolume', payload: { volume: 2 } }), 'INVALID'],
    [cmd({ type: 'pause', payload: { sneaky: true } }), 'INVALID'],
    [cmd({ type: 'announce', payload: { text: 'x'.repeat(281) } }), 'INVALID'],
    [cmd({ type: 'updateConfig', payload: { patch: { analytics: { enabled: true } } } }), 'INVALID'],
    [cmd({ type: 'updateConfig', payload: { patch: { branding: { onload: 'x' } } } }), 'INVALID'],
    [cmd({ type: 'showOverlay', payload: { overlayId: '<script>' } }), 'INVALID'],
    [cmd({ payload: { pad: 'x'.repeat(9000) } }), 'INVALID'],
    [cmd({ issuedAt: NOW - 120_000 }), 'EXPIRED'],
    [cmd({ issuedAt: NOW - 10_000, expiresAt: NOW - 1 }), 'EXPIRED'],
    [cmd({ issuedAt: NOW + 600_000 }), 'NOT_YET_VALID'],
    [cmd({ expiresAt: NOW - 10, issuedAt: NOW }), 'INVALID'],
  ];
  for (const [c, reason] of cases) {
    const r = validateCommand(c, opts);
    assert.equal(r.ok, false, JSON.stringify(c).slice(0, 80));
    if (!r.ok) assert.equal(r.reason, reason, JSON.stringify(c).slice(0, 80));
  }
  // a prototype-polluting key is just an unknown field
  assert.equal(validateCommand(JSON.parse('{"v":1,"id":"a","type":"play","issuedAt":1800000000000,"__proto__":{"x":1}}'), opts).ok, false);
});

test('role permissions: operators cannot pause, unmute, seek or change volume', () => {
  for (const t of ['play', 'pause', 'setMuted', 'setVolume', 'seek'] as const) assert.equal(isAllowed('operator', t), false, t);
  for (const t of ['announce', 'openPoll', 'startAdBreak', 'setSource'] as const) assert.equal(isAllowed('operator', t), true, t);
  for (const t of ['setSource', 'updateConfig', 'announce', 'startAdBreak'] as const) assert.equal(isAllowed('viewer', t), false, t);
  assert.equal(isAllowed('host', 'announce'), false, 'announcements are an operator action');
  assert.ok(ROLE_PERMISSIONS.viewer.size < ROLE_PERMISSIONS.host.size);
});

test('canonical JSON is key-order independent', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: 'x' } }), '{"a":{"c":"x","d":[1,{"y":2,"z":1}]},"b":1}');
  assert.equal(canonicalJson({ a: undefined, b: null }), '{"b":null}');
  assert.throws(() => canonicalJson({ a: Infinity }));
});

async function keyPair() {
  const kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
  return { kp, jwk };
}
async function sign(c: PlayerCommand, key: CryptoKey): Promise<PlayerCommand> {
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, signingInput(c) as BufferSource));
  return { ...c, sig: bytesToBase64url(sig) };
}

test('Ed25519 verifier: valid signature passes; tampering, wrong key or unknown kid fail', async () => {
  const { kp, jwk } = await keyPair();
  const other = await keyPair();
  const verify = createEd25519Verifier({ k1: jwk });
  const base: PlayerCommand = { v: 1, id: 'op1', type: 'announce', issuedAt: NOW, kid: 'k1', payload: { text: 'Hello' } };
  const signed = await sign(base, kp.privateKey);
  assert.equal(await verify(signed), true);
  // key order of the payload does not matter (canonical form)
  assert.equal(await verify({ ...signed, payload: { text: 'Hello' } }), true);
  assert.equal(await verify({ ...signed, payload: { text: 'Hello!' } }), false, 'tampered payload');
  assert.equal(await verify({ ...signed, type: 'openPoll' }), false, 'tampered type');
  assert.equal(await verify({ ...signed, kid: 'nope' }), false, 'unknown kid');
  assert.equal(await verify(await sign(base, other.kp.privateKey)), false, 'wrong key');
  assert.equal(await verify({ ...signed, sig: 'AAAAAAAAAAAAAAAAAAAAAA' }), false, 'garbage sig');
  assert.equal(await verify(base), false, 'unsigned');
});

function controller(verifier?: (c: PlayerCommand) => Promise<boolean>) {
  const v = fakeVideo();
  const core = new PlayerCore(v as unknown as HTMLVideoElement, {}, {
    adapters: [{ id: 't', label: 't', canPlay: () => true, create: (ctx) => ({ id: 't', load: (s) => ((ctx.video as unknown as { src: string }).src = s.src), unload() {}, getQualityLevels: () => [], setQuality: (i) => i === 'auto', getCurrentQuality: () => null, getAudioTracks: () => [], setAudioTrack: () => false, destroy() {} }) }],
    fetch: mockFetch(() => ({ status: 200 })),
    baseUrl: 'http://test.local/',
  });
  const events: string[] = [];
  for (const e of ['commandreceived', 'commandapplied', 'commandrejected', 'announcement'] as const) core.on(e, () => events.push(e));
  const engines = { ads: new AdsController(), overlays: new OverlaysController(), interactions: new InteractionsController() };
  const cc = new CommandController(core, engines, { enabled: true, maxClockSkewMs: 300_000, defaultTtlMs: 60_000 }, { verifier, now: () => NOW });
  return { v, core, cc, events, engines };
}

test('controller: applies allowed commands, acks, emits events', async () => {
  const { v, core, cc, events } = controller();
  v.paused = false;
  const ack = await cc.execute(cmd({ id: 'p1', type: 'pause' }), 'viewer');
  assert.equal(ack.status, 'applied');
  assert.equal(v.paused, true);
  assert.deepEqual(events, ['commandreceived', 'commandapplied']);
  const vol = await cc.execute(cmd({ id: 'v1', type: 'setVolume', payload: { volume: 0.25 } }), 'host');
  assert.equal(vol.status, 'applied');
  assert.equal(v.volume, 0.25);
  core.destroy();
});

test('controller: idempotent — the same id is applied once, concurrent replays included', async () => {
  const { v, core, cc } = controller();
  v.volume = 1;
  const c = cmd({ id: 'same', type: 'setVolume', payload: { volume: 0.5 } });
  const [a, b] = await Promise.all([cc.execute(c, 'host'), cc.execute(c, 'host')]);
  assert.deepEqual([a.status, b.status].sort(), ['applied', 'duplicate']);
  v.volume = 0.9; // if re-applied this would go back to 0.5
  const again = await cc.execute(c, 'host');
  assert.equal(again.status, 'duplicate');
  assert.equal(v.volume, 0.9);
  core.destroy();
});

test('controller: viewer cannot run host/operator commands; host cannot announce', async () => {
  const { core, cc, events } = controller();
  const r1 = await cc.execute(cmd({ id: 's1', type: 'setSource', payload: { src: '/x.mp4' } }), 'viewer');
  assert.equal(r1.reason, 'FORBIDDEN');
  const r2 = await cc.execute(cmd({ id: 'a1', type: 'announce', payload: { text: 'hi' } }), 'host');
  assert.equal(r2.reason, 'FORBIDDEN');
  assert.ok(!events.includes('announcement'));
  core.destroy();
});

test('controller: operator commands need a verifier and a valid signature', async () => {
  const { kp, jwk } = await keyPair();
  const none = controller();
  const r0 = await none.cc.execute(cmd({ id: 'o0', type: 'announce', payload: { text: 'x' } }), 'operator');
  assert.equal(r0.reason, 'UNVERIFIED');
  none.core.destroy();

  const { core, cc, events } = controller(createEd25519Verifier({ k1: jwk }));
  const forged = await cc.execute({ ...cmd({ id: 'o1', type: 'announce', payload: { text: 'forged' } }), kid: 'k1', sig: 'A'.repeat(86) }, 'operator');
  assert.equal(forged.reason, 'UNVERIFIED');
  const good = await sign({ v: 1, id: 'o1', type: 'announce', issuedAt: NOW, kid: 'k1', payload: { text: 'Starting soon' } }, kp.privateKey);
  const ok = await cc.execute(good, 'operator');
  assert.equal(ok.status, 'applied', 'a forged command with the same id must not block the genuine one');
  assert.ok(events.includes('announcement'));
  const pauseSigned = await sign({ v: 1, id: 'o2', type: 'pause', issuedAt: NOW, kid: 'k1' }, kp.privateKey);
  assert.equal((await cc.execute(pauseSigned, 'operator')).reason, 'FORBIDDEN', 'even signed, operators cannot pause viewers');
  core.destroy();
});

test('controller: ad/overlay/poll commands report FEATURE_UNAVAILABLE without an engine; work with one', async () => {
  const { kp, jwk } = await keyPair();
  const { core, cc, engines } = controller(createEd25519Verifier({ k1: jwk }));
  const req = await sign({ v: 1, id: 'ad1', type: 'startAdBreak', issuedAt: NOW, kid: 'k1', payload: { position: 'live' } }, kp.privateKey);
  assert.equal((await cc.execute(req, 'operator')).reason, 'FEATURE_UNAVAILABLE');
  const calls: string[] = [];
  engines.ads.attach({
    provider: 'test',
    capabilities: () => ({ linear: true, nonLinear: false, companions: false, skippable: true, vmap: false, liveBreaks: true }),
    requestBreak: async (r) => void calls.push(`break:${r.position}`),
    cancelBreak: () => true,
    skip: () => false,
    isBreakActive: () => false,
    destroy() {},
  });
  const req2 = await sign({ v: 1, id: 'ad2', type: 'startAdBreak', issuedAt: NOW, kid: 'k1', payload: { position: 'live' } }, kp.privateKey);
  assert.equal((await cc.execute(req2, 'operator')).status, 'applied');
  assert.deepEqual(calls, ['break:live']);
  core.destroy();
});

test('controller: disabled → everything rejected; history is bounded and copied', async () => {
  const { core, cc } = controller();
  cc.updateConfig({ enabled: false, maxClockSkewMs: 0, defaultTtlMs: 60_000 });
  assert.equal((await cc.execute(cmd({ id: 'd1' }), 'host')).reason, 'DISABLED');
  cc.updateConfig({ enabled: true, maxClockSkewMs: 0, defaultTtlMs: 60_000 });
  for (let i = 0; i < 120; i++) await cc.execute(cmd({ id: `h${i}`, type: 'goLive' }), 'viewer');
  const h = cc.history();
  assert.equal(h.length, 100);
  h[0]!.status = 'applied';
  assert.notEqual(cc.history()[0]!.status, 'applied');
  core.destroy();
});
