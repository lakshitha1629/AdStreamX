import type { PlayerConfig, PlayerConfigInput } from '@adstreamx/shared-types';

export const DEFAULT_CONFIG: PlayerConfig = {
  source: undefined,
  fallbackSources: [],
  poster: undefined,
  autoplay: false,
  autoplayMutedFallback: true,
  muted: false,
  volume: 1,
  preload: 'metadata',
  engine: 'auto',
  live: {
    targetLatency: 6,
    liveEdgeOffset: 3,
    liveEdgeTolerance: 2,
    catchUp: true,
    maxCatchUpRate: 1.08,
    maxDriftBeforeSeek: 12,
    resumeAtLiveEdge: true,
  },
  retry: { maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 8000, jitter: 0.3 },
  startupTimeoutMs: 15000,
  stallTimeoutMs: 8000,
  allowedSourceOrigins: [],
  controls: {
    enabled: true,
    keyboard: true,
    gestures: true,
    autoHideMs: 3000,
    show: {
      playbackRate: true,
      quality: true,
      captions: true,
      audioTracks: true,
      pip: true,
      theater: true,
      fullscreen: true,
      volume: true,
    },
  },
  branding: { accentColor: '#22d3ee', logoUrl: undefined, logoAlt: undefined, title: undefined },
  debug: false,
};

export class ConfigError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid AdStreamX config: ${issues.join('; ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep-merge `input` over `base`. Arrays and non-plain values replace. Unknown keys are reported. */
function merge(base: Record<string, unknown>, input: Record<string, unknown>, path: string, issues: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    if (!(k in base)) {
      issues.push(`unknown option "${path}${k}"`);
      continue;
    }
    const b = base[k];
    if (isPlainObject(b) && isPlainObject(v) && !['source'].includes(k)) {
      out[k] = merge(b, v, `${path}${k}.`, issues);
    } else {
      out[k] = v;
    }
  }
  return out;
}

const num = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

/** Merge user config over defaults and validate. Throws ConfigError listing every problem. */
export function resolveConfig(input: PlayerConfigInput = {}, base: PlayerConfig = DEFAULT_CONFIG): PlayerConfig {
  const issues: string[] = [];
  if (!isPlainObject(input)) throw new ConfigError(['config must be an object']);
  const c = merge(base as unknown as Record<string, unknown>, input as Record<string, unknown>, '', issues) as unknown as PlayerConfig;

  if (c.source !== undefined && (!isPlainObject(c.source) || typeof c.source.src !== 'string')) issues.push('source.src must be a string');
  if (!Array.isArray(c.fallbackSources)) issues.push('fallbackSources must be an array');
  else c.fallbackSources.forEach((s, i) => {
    if (!isPlainObject(s) || typeof s.src !== 'string') issues.push(`fallbackSources[${i}].src must be a string`);
  });
  if (![true, false, 'muted'].includes(c.autoplay as never)) issues.push('autoplay must be true, false or "muted"');
  if (!num(c.volume, 0, 1)) issues.push('volume must be between 0 and 1');
  if (!['none', 'metadata', 'auto'].includes(c.preload)) issues.push('preload must be none|metadata|auto');
  if (typeof c.engine !== 'string' || !/^[a-z0-9-]+$/.test(c.engine)) issues.push('engine must be an id like "auto" or "native"');
  if (!num(c.live.targetLatency, 0, 600)) issues.push('live.targetLatency must be 0..600 s');
  if (!num(c.live.liveEdgeOffset, 0, 600)) issues.push('live.liveEdgeOffset must be 0..600 s');
  if (!num(c.live.liveEdgeTolerance, 0, 60)) issues.push('live.liveEdgeTolerance must be 0..60 s');
  if (!num(c.live.maxCatchUpRate, 1, 1.5)) issues.push('live.maxCatchUpRate must be 1..1.5');
  if (!num(c.live.maxDriftBeforeSeek, 0, 3600)) issues.push('live.maxDriftBeforeSeek must be 0..3600 s');
  if (!num(c.retry.maxAttempts, 0, 20) || !Number.isInteger(c.retry.maxAttempts)) issues.push('retry.maxAttempts must be an integer 0..20');
  if (!num(c.retry.baseDelayMs, 0, 60000)) issues.push('retry.baseDelayMs must be 0..60000');
  if (!num(c.retry.maxDelayMs, 0, 300000)) issues.push('retry.maxDelayMs must be 0..300000');
  if (!num(c.retry.jitter, 0, 1)) issues.push('retry.jitter must be 0..1');
  if (!num(c.startupTimeoutMs, 1000, 120000)) issues.push('startupTimeoutMs must be 1000..120000');
  if (!num(c.stallTimeoutMs, 1000, 120000)) issues.push('stallTimeoutMs must be 1000..120000');
  if (!Array.isArray(c.allowedSourceOrigins) || c.allowedSourceOrigins.some((o) => typeof o !== 'string')) issues.push('allowedSourceOrigins must be string[]');
  if (typeof c.branding.accentColor !== 'string' || !/^#[0-9a-f]{3,8}$/i.test(c.branding.accentColor)) issues.push('branding.accentColor must be a hex colour');
  if (c.branding.logoUrl !== undefined && !/^https?:\/\/|^\//i.test(c.branding.logoUrl)) issues.push('branding.logoUrl must be http(s) or root-relative');
  if (!num(c.controls.autoHideMs, 0, 60000)) issues.push('controls.autoHideMs must be 0..60000');

  if (issues.length) throw new ConfigError(issues);
  return c;
}
