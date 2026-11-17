import type { PlayerConfigInput } from '@adstreamx/shared-types';
import { resolveConfig } from '@adstreamx/player-core';
import { isExactOrigin, isValidChannel } from './protocol.ts';

/** Configuration carried to the iframe player in the URL fragment (never sent to servers). */
export interface EmbedConfig {
  player: PlayerConfigInput;
  /** Exact origins of pages allowed to control the player via postMessage. */
  allowedOrigins: string[];
  channel?: string;
  /** Ed25519 PUBLIC keys (by kid) that may sign operator commands. Never private keys. */
  operatorKeys?: Record<string, JsonWebKey>;
}

export const MAX_EMBED_CONFIG_CHARS = 8000;

export function encodeEmbedConfig(cfg: EmbedConfig): string {
  const json = JSON.stringify(cfg);
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(json)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export type DecodedEmbedConfig = { ok: true; config: EmbedConfig } | { ok: false; error: string };

/** Decode + validate (player config, origins, channel). Never throws. */
export function decodeEmbedConfig(encoded: string): DecodedEmbedConfig {
  if (!encoded || encoded.length > MAX_EMBED_CONFIG_CHARS || !/^[A-Za-z0-9_-]+$/.test(encoded)) return { ok: false, error: 'missing or malformed config' };
  let parsed: unknown;
  try {
    const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((encoded.length + 3) % 4);
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { ok: false, error: 'config is not valid base64url JSON' };
  }
  const c = parsed as Partial<EmbedConfig>;
  if (typeof c !== 'object' || c === null) return { ok: false, error: 'config must be an object' };
  for (const k of Object.keys(c)) if (!['player', 'allowedOrigins', 'channel', 'operatorKeys'].includes(k)) return { ok: false, error: `unknown field "${k}"` };
  if (c.operatorKeys !== undefined) {
    const keys = c.operatorKeys as Record<string, unknown>;
    if (typeof keys !== 'object' || keys === null || Object.keys(keys).length > 5) return { ok: false, error: 'operatorKeys must map up to 5 key ids to public keys' };
    for (const [kid, jwk] of Object.entries(keys)) {
      const j = jwk as Record<string, unknown>;
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(kid) || j?.kty !== 'OKP' || j.crv !== 'Ed25519' || typeof j.x !== 'string' || 'd' in j) {
        return { ok: false, error: `operatorKeys.${kid} must be an Ed25519 public JWK (no private part)` };
      }
    }
  }
  if (!Array.isArray(c.allowedOrigins) || c.allowedOrigins.length > 20 || !c.allowedOrigins.every(isExactOrigin)) {
    return { ok: false, error: 'allowedOrigins must be a list of exact origins (no wildcards)' };
  }
  if (c.channel !== undefined && !isValidChannel(c.channel)) return { ok: false, error: 'invalid channel' };
  try {
    resolveConfig(c.player ?? {});
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  return { ok: true, config: { player: c.player ?? {}, allowedOrigins: c.allowedOrigins, channel: c.channel, operatorKeys: c.operatorKeys } };
}

export interface EmbedCodeOptions {
  /** URL of the hosted iframe player page, e.g. https://player.example.com/embed/ */
  playerUrl: string;
  /** URL of the SDK script for the script/React variants. */
  sdkUrl: string;
  config: PlayerConfigInput;
  /** Exact origins of the pages that will host the iframe and control it. */
  allowedOrigins: string[];
  channel?: string;
  operatorKeys?: Record<string, JsonWebKey>;
  title?: string;
  /** CSS aspect ratio, e.g. "16 / 9". */
  aspectRatio?: string;
  elementId?: string;
}

export interface EmbedCode {
  iframeUrl: string;
  iframe: string;
  hostControl: string;
  script: string;
  react: string;
}

/**
 * Copy-paste snippets. Everything user-supplied is validated, then escaped for its exact
 * context (HTML attribute, inline JSON in <script>, JS string, JSX).
 */
export function generateEmbedCode(o: EmbedCodeOptions): EmbedCode {
  const playerUrl = checkUrl(o.playerUrl, 'playerUrl');
  const sdkUrl = checkUrl(o.sdkUrl, 'sdkUrl');
  resolveConfig(o.config); // throws ConfigError with every issue
  if (!o.allowedOrigins.every(isExactOrigin)) throw new TypeError('allowedOrigins must be exact origins (no "*")');
  const channel = o.channel ?? 'default';
  if (!isValidChannel(channel)) throw new TypeError('channel must be 1–64 chars [A-Za-z0-9_-]');
  const elementId = o.elementId ?? 'adstreamx-player';
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(elementId)) throw new TypeError('elementId must be a simple HTML id');
  const aspect = o.aspectRatio ?? '16 / 9';
  if (!/^\d{1,4}\s*\/\s*\d{1,4}$/.test(aspect)) throw new TypeError('aspectRatio must look like "16 / 9"');
  const title = (o.title ?? 'Video player').slice(0, 120);

  const frag = encodeEmbedConfig({ player: o.config, allowedOrigins: o.allowedOrigins, channel, ...(o.operatorKeys ? { operatorKeys: o.operatorKeys } : {}) });
  const check = decodeEmbedConfig(frag);
  if (!check.ok) throw new TypeError(check.error);
  const iframeUrl = `${playerUrl.href.split('#')[0]}#cfg=${frag}`;
  const playerOrigin = playerUrl.origin;

  const iframe =
    `<iframe id="${elementId}" src="${escAttr(iframeUrl)}" title="${escAttr(title)}"\n` +
    `  allow="autoplay; fullscreen; picture-in-picture; encrypted-media" allowfullscreen\n` +
    `  referrerpolicy="strict-origin-when-cross-origin" loading="lazy"\n` +
    `  style="width:100%;aspect-ratio:${aspect};border:0"></iframe>`;

  const hostControl =
    `<script src="${escAttr(sdkUrl.href)}"></script>\n<script>\n` +
    `  const embed = AdStreamX.connectIframe(document.getElementById(${jsString(elementId)}), {\n` +
    `    origin: ${jsString(playerOrigin)},\n    channel: ${jsString(channel)},\n  });\n` +
    `  embed.ready().then(() => {\n    embed.on('ended', () => console.log('video ended'));\n  });\n` +
    `  // embed.play(), embed.pause(), embed.seekTo(30), embed.setVolume(0.5), embed.getState()\n</script>`;

  const script =
    `<div id="${elementId}" style="width:100%;max-width:960px"></div>\n` +
    `<script src="${escAttr(sdkUrl.href)}"></script>\n<script>\n` +
    `  const player = AdStreamX.create(document.getElementById(${jsString(elementId)}), ${inlineJson(o.config)});\n</script>`;

  const react =
    `import { AdStreamXPlayer } from '@adstreamx/react-player';\n\n` +
    `const config = ${inlineJson(o.config)};\n\n` +
    `export function Video() {\n  return <AdStreamXPlayer config={config} onError={(e) => console.warn(e.code)} />;\n}`;

  return { iframeUrl, iframe, hostControl, script, react };
}

function checkUrl(raw: string, name: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new TypeError(`${name} must be an absolute URL`);
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new TypeError(`${name} must use https (http only for localhost)`);
  if (u.username || u.password) throw new TypeError(`${name} must not contain credentials`);
  return u;
}

export function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** JSON safe to inline in a <script> block or JS/JSX source. */
export function inlineJson(v: unknown): string {
  return JSON.stringify(v, null, 2)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function jsString(s: string): string {
  return inlineJson(s);
}
