import type { CommandAck, CommandRole, CommandType, PlayerCommand } from '@adstreamx/shared-types';

export const COMMAND_VERSION = 1;
export const MAX_COMMAND_BYTES = 8 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

type Rejection = NonNullable<CommandAck['reason']>;
export type CommandValidation = { ok: true; command: PlayerCommand } | { ok: false; reason: Rejection; detail: string; id?: string; type?: string };

/**
 * Which roles may issue which commands.
 *  - viewer: only what the person watching could do with the on-screen controls.
 *  - host: the embedding application (trusted origin) — viewer actions + source/branding/overlays.
 *  - operator: live administration (signed). Deliberately NO play/pause/mute/volume/seek:
 *    an operator must not forcibly pause, unmute or move viewers' playback.
 */
export const ROLE_PERMISSIONS: Record<CommandRole, ReadonlySet<CommandType>> = {
  viewer: new Set<CommandType>(['play', 'pause', 'seek', 'setVolume', 'setMuted', 'goLive', 'setQuality', 'setTextTrack']),
  host: new Set<CommandType>([
    'play', 'pause', 'seek', 'setVolume', 'setMuted', 'goLive', 'setQuality', 'setTextTrack',
    'setSource', 'updateConfig', 'showOverlay', 'hideOverlay',
  ]),
  operator: new Set<CommandType>([
    'goLive', 'setSource', 'announce', 'showOverlay', 'hideOverlay', 'openPoll', 'closePoll', 'startAdBreak', 'cancelAdBreak',
  ]),
};

export function isAllowed(role: CommandRole, type: CommandType): boolean {
  return ROLE_PERMISSIONS[role]?.has(type) ?? false;
}

type FieldSpec =
  | { kind: 'number'; min?: number; max?: number; optional?: boolean }
  | { kind: 'boolean'; optional?: boolean }
  | { kind: 'string'; max: number; min?: number; optional?: boolean; pattern?: RegExp; nullable?: boolean }
  | { kind: 'enum'; values: readonly string[]; optional?: boolean }
  | { kind: 'object'; validate: (v: unknown) => string | null; optional?: boolean };

const safeId = { kind: 'string', max: 64, min: 1, pattern: ID_RE } as const;

/** Viewer-safe config subset a host may change remotely: branding and control visibility only. */
function validateConfigPatch(v: unknown): string | null {
  if (!isPlainObject(v)) return 'must be an object';
  for (const k of Object.keys(v)) if (k !== 'branding' && k !== 'controls') return `"${k}" cannot be changed by command`;
  if (v.branding !== undefined) {
    if (!isPlainObject(v.branding)) return 'branding must be an object';
    for (const [k, val] of Object.entries(v.branding)) {
      if (!['accentColor', 'title', 'logoUrl', 'logoAlt'].includes(k)) return `branding.${k} is not allowed`;
      if (typeof val !== 'string' || val.length > 300) return `branding.${k} must be a short string`;
    }
  }
  if (v.controls !== undefined) {
    if (!isPlainObject(v.controls)) return 'controls must be an object';
    for (const k of Object.keys(v.controls)) if (k !== 'show') return `controls.${k} is not allowed`;
    const show = v.controls.show;
    if (show !== undefined) {
      if (!isPlainObject(show)) return 'controls.show must be an object';
      for (const [k, val] of Object.entries(show)) if (typeof val !== 'boolean') return `controls.show.${k} must be boolean`;
    }
  }
  return null;
}

export const PAYLOAD_SCHEMAS: Record<CommandType, Record<string, FieldSpec>> = {
  play: {},
  pause: {},
  goLive: {},
  seek: { time: { kind: 'number', min: 0, max: 1e7 } },
  setVolume: { volume: { kind: 'number', min: 0, max: 1 } },
  setMuted: { muted: { kind: 'boolean' } },
  setQuality: { id: { kind: 'string', max: 64, min: 1 } },
  setTextTrack: { id: { kind: 'string', max: 64, min: 1, nullable: true } },
  setSource: {
    src: { kind: 'string', max: 2048, min: 1 },
    type: { kind: 'string', max: 100, optional: true },
    streamType: { kind: 'enum', values: ['vod', 'live'], optional: true },
  },
  updateConfig: { patch: { kind: 'object', validate: validateConfigPatch } },
  announce: {
    text: { kind: 'string', max: 280, min: 1 },
    level: { kind: 'enum', values: ['info', 'warning'], optional: true },
    durationMs: { kind: 'number', min: 1000, max: 60000, optional: true },
  },
  showOverlay: { overlayId: safeId },
  hideOverlay: { overlayId: safeId },
  openPoll: { pollId: safeId },
  closePoll: { pollId: safeId },
  startAdBreak: {
    breakId: { ...safeId, optional: true },
    position: { kind: 'enum', values: ['preroll', 'midroll', 'postroll', 'live'], optional: true },
  },
  cancelAdBreak: { breakId: { ...safeId, optional: true } },
};

export const COMMAND_TYPES = Object.keys(PAYLOAD_SCHEMAS) as CommandType[];

/**
 * Strict structural validation + time window. Unknown fields anywhere are rejected so a
 * command cannot smuggle extra data past the schema.
 */
export function validateCommand(raw: unknown, opts: { now: number; maxClockSkewMs: number; defaultTtlMs: number }): CommandValidation {
  if (!isPlainObject(raw)) return { ok: false, reason: 'INVALID', detail: 'command must be an object' };
  const id = typeof raw.id === 'string' ? raw.id : undefined;
  const type = typeof raw.type === 'string' ? raw.type : undefined;
  const bad = (detail: string, reason: Rejection = 'INVALID'): CommandValidation => ({ ok: false, reason, detail, id, type });
  let size = 0;
  try {
    size = JSON.stringify(raw).length;
  } catch {
    return bad('not serialisable');
  }
  if (size > MAX_COMMAND_BYTES) return bad(`larger than ${MAX_COMMAND_BYTES} bytes`);
  for (const k of Object.keys(raw)) {
    if (!['v', 'id', 'type', 'issuedAt', 'expiresAt', 'payload', 'sig', 'kid'].includes(k)) return bad(`unknown field "${k}"`);
  }
  if (raw.v !== COMMAND_VERSION) return bad(`unsupported version ${String(raw.v)}`);
  if (!id || !ID_RE.test(id)) return bad('id must be 1–64 chars of [A-Za-z0-9_-]');
  if (!type || !(type in PAYLOAD_SCHEMAS)) return bad(`unknown type "${String(raw.type)}"`);
  if (typeof raw.issuedAt !== 'number' || !Number.isFinite(raw.issuedAt)) return bad('issuedAt must be epoch ms');
  if (raw.expiresAt !== undefined && (typeof raw.expiresAt !== 'number' || !Number.isFinite(raw.expiresAt))) return bad('expiresAt must be epoch ms');
  if (raw.sig !== undefined && (typeof raw.sig !== 'string' || !/^[A-Za-z0-9_-]{16,200}$/.test(raw.sig))) return bad('sig must be base64url');
  if (raw.kid !== undefined && (typeof raw.kid !== 'string' || !ID_RE.test(raw.kid))) return bad('kid is invalid');

  const issuedAt = raw.issuedAt;
  const expiresAt = (raw.expiresAt as number | undefined) ?? issuedAt + opts.defaultTtlMs;
  if (expiresAt <= issuedAt) return bad('expiresAt must be after issuedAt');
  if (issuedAt > opts.now + opts.maxClockSkewMs) return bad('issuedAt is in the future', 'NOT_YET_VALID');
  if (opts.now > expiresAt) return bad('command expired', 'EXPIRED');

  const payload = raw.payload ?? {};
  if (!isPlainObject(payload)) return bad('payload must be an object');
  const schema = PAYLOAD_SCHEMAS[type as CommandType];
  for (const k of Object.keys(payload)) if (!(k in schema)) return bad(`payload.${k} is not allowed for ${type}`);
  for (const [k, spec] of Object.entries(schema)) {
    const err = checkField(payload[k], spec);
    if (err) return bad(`payload.${k} ${err}`);
  }
  return {
    ok: true,
    command: {
      v: 1,
      id,
      type: type as CommandType,
      issuedAt,
      expiresAt: raw.expiresAt as number | undefined,
      payload: payload as Record<string, unknown>,
      sig: raw.sig as string | undefined,
      kid: raw.kid as string | undefined,
    },
  };
}

function checkField(v: unknown, spec: FieldSpec): string | null {
  if (v === undefined) return spec.optional ? null : 'is required';
  switch (spec.kind) {
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v)) return 'must be a number';
      if (spec.min !== undefined && v < spec.min) return `must be ≥ ${spec.min}`;
      if (spec.max !== undefined && v > spec.max) return `must be ≤ ${spec.max}`;
      return null;
    case 'boolean':
      return typeof v === 'boolean' ? null : 'must be boolean';
    case 'string':
      if (v === null && spec.nullable) return null;
      if (typeof v !== 'string') return 'must be a string';
      if (v.length > spec.max || v.length < (spec.min ?? 0)) return `length must be ${spec.min ?? 0}–${spec.max}`;
      if (spec.pattern && !spec.pattern.test(v)) return 'has invalid characters';
      return null;
    case 'enum':
      return spec.values.includes(v as string) ? null : `must be one of ${spec.values.join('|')}`;
    case 'object':
      return spec.validate(v);
  }
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}
