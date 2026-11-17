import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeEmbedConfig,
  encodeEmbedConfig,
  envelope,
  escAttr,
  generateEmbedCode,
  inlineJson,
  isExactOrigin,
  MAX_MESSAGE_BYTES,
  parseEnvelope,
  RateLimiter,
} from '@adstreamx/embed-protocol';

test('exact origins only — no wildcard, no path, no null', () => {
  assert.equal(isExactOrigin('https://site.example'), true);
  assert.equal(isExactOrigin('http://localhost:8080'), true);
  for (const bad of ['*', 'null', 'https://site.example/', 'https://site.example/path', 'https://*.site.example', 'javascript:alert(1)', '', 42]) {
    assert.equal(isExactOrigin(bad), false, String(bad));
  }
});

test('envelope parsing rejects anything that is not a valid v1 message', () => {
  const ok = envelope('default', 'request', { id: 'r1', method: 'getState' });
  assert.ok(parseEnvelope(ok));
  const bad: unknown[] = [
    null,
    'string',
    { ...ok, protocol: 'other' },
    { ...ok, version: 2 },
    { ...ok, channel: 'bad channel' },
    { ...ok, kind: 'execute' },
    { ...ok, method: 'eval' },
    { ...ok, id: undefined },
    { ...ok, payload: 'x'.repeat(MAX_MESSAGE_BYTES) },
    envelope('default', 'response', {}),
  ];
  for (const b of bad) assert.equal(parseEnvelope(b), null, JSON.stringify(b)?.slice(0, 60));
});

test('rate limiter: burst then refill', () => {
  let t = 0;
  const rl = new RateLimiter(10, 5, () => t);
  let n = 0;
  for (let i = 0; i < 20; i++) if (rl.take('o')) n++;
  assert.equal(n, 5);
  t += 500; // +5 tokens
  n = 0;
  for (let i = 0; i < 20; i++) if (rl.take('o')) n++;
  assert.equal(n, 5);
  assert.equal(rl.take('other'), true, 'per-key buckets');
});

test('embed config round-trip and validation', () => {
  const enc = encodeEmbedConfig({ player: { source: { src: 'https://cdn.example/a.m3u8' }, branding: { title: 'Ünïcode ✓' } }, allowedOrigins: ['https://host.example'], channel: 'c1' });
  const d = decodeEmbedConfig(enc);
  assert.ok(d.ok);
  if (d.ok) assert.equal(d.config.player.branding?.title, 'Ünïcode ✓');
  const bad = [
    encodeEmbedConfig({ player: {}, allowedOrigins: ['*'] }),
    encodeEmbedConfig({ player: { volume: 5 }, allowedOrigins: [] }),
    encodeEmbedConfig({ player: {}, allowedOrigins: [], channel: '../x' }),
    encodeEmbedConfig({ player: {}, allowedOrigins: [], extra: 1 } as never),
    'not*base64',
    'A'.repeat(9000),
  ];
  for (const b of bad) assert.equal(decodeEmbedConfig(b).ok, false, b.slice(0, 40));
});

test('embed code generator: valid snippets, escaped, validated', () => {
  const code = generateEmbedCode({
    playerUrl: 'https://player.example.com/embed/',
    sdkUrl: 'https://player.example.com/sdk/adstreamx.js',
    config: { source: { src: 'https://cdn.example.com/a.m3u8' }, branding: { title: '"><script>alert(1)</script>' } },
    allowedOrigins: ['https://news.example.org'],
    title: 'A "quoted" <title>',
  });
  assert.match(code.iframe, /^<iframe id="adstreamx-player" src="https:\/\/player\.example\.com\/embed\/#cfg=[A-Za-z0-9_-]+"/);
  assert.ok(code.iframe.includes('title="A &quot;quoted&quot; &lt;title&gt;"'));
  assert.ok(!code.script.includes('</script><script>'), 'no script breakout');
  assert.ok(code.script.includes('\\u003cscript\\u003e'));
  assert.ok(!code.react.includes('<script>'));
  assert.ok(code.hostControl.includes('origin: "https://player.example.com"'));
  assert.ok(!code.hostControl.includes("'*'") && !code.hostControl.includes('"*"'));
  // the config in the fragment decodes back to what was given
  const d = decodeEmbedConfig(code.iframeUrl.split('#cfg=')[1]!);
  assert.ok(d.ok && d.config.allowedOrigins[0] === 'https://news.example.org');

  assert.throws(() => generateEmbedCode({ playerUrl: 'http://player.example.com/embed/', sdkUrl: 'https://x.example/s.js', config: {}, allowedOrigins: [] }), /https/);
  assert.throws(() => generateEmbedCode({ playerUrl: 'https://p.example/', sdkUrl: 'https://x.example/s.js', config: {}, allowedOrigins: ['*'] }), /exact/);
  assert.throws(() => generateEmbedCode({ playerUrl: 'https://p.example/', sdkUrl: 'https://x.example/s.js', config: { volume: 9 }, allowedOrigins: [] }), /volume/);
  assert.throws(() => generateEmbedCode({ playerUrl: 'https://p.example/', sdkUrl: 'https://x.example/s.js', config: {}, allowedOrigins: [], elementId: 'a"b' }), /id/);
  assert.ok(generateEmbedCode({ playerUrl: 'http://localhost:8080/embed/', sdkUrl: 'http://localhost:8080/sdk/adstreamx.js', config: {}, allowedOrigins: [] }));
});

test('escaping helpers', () => {
  assert.equal(escAttr(`a"b'c<d>&`), 'a&quot;b&#39;c&lt;d&gt;&amp;');
  assert.equal(inlineJson('</script>\u2028'), '"\\u003c/script\\u003e\\u2028"');
});
