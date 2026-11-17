import type { PlayerCommand } from '@adstreamx/shared-types';

/**
 * Canonical JSON: object keys sorted recursively, no whitespace. Signer (server) and verifier
 * (player) must produce byte-identical input, so this is the only serialisation used for
 * signatures. Arrays keep their order; undefined values are omitted (as in JSON).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>)
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

/** The exact bytes that are signed: the command without its `sig`. */
export function signingInput(cmd: PlayerCommand): Uint8Array {
  const { sig: _sig, ...unsigned } = cmd;
  return new TextEncoder().encode(canonicalJson(unsigned));
}

export function base64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export type CommandVerifier = (cmd: PlayerCommand) => Promise<boolean>;

/**
 * Verifier for operator commands signed with Ed25519. Only PUBLIC keys are given to the
 * player (keyed by `kid`), so nothing secret ships in the SDK. Uses WebCrypto (browsers with
 * Ed25519 support, Node ≥ 22). Unknown kid, malformed or wrong signature → false.
 */
export function createEd25519Verifier(publicKeys: Record<string, JsonWebKey>): CommandVerifier {
  const subtle = globalThis.crypto?.subtle;
  const cache = new Map<string, Promise<CryptoKey | null>>();
  const keyFor = (kid: string) => {
    let p = cache.get(kid);
    if (!p) {
      const jwk = publicKeys[kid];
      p = jwk && subtle
        ? subtle.importKey('jwk', { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, { name: 'Ed25519' }, false, ['verify']).catch(() => null)
        : Promise.resolve(null);
      cache.set(kid, p);
    }
    return p;
  };
  return async (cmd) => {
    if (!subtle || !cmd.sig || !cmd.kid) return false;
    const key = await keyFor(cmd.kid);
    if (!key) return false;
    try {
      const sig = base64urlToBytes(cmd.sig);
      return await subtle.verify({ name: 'Ed25519' }, key, sig as BufferSource, signingInput(cmd) as BufferSource);
    } catch {
      return false;
    }
  };
}
