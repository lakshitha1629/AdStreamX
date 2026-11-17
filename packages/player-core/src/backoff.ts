import type { RetryConfig } from '@adstreamx/shared-types';

/**
 * Exponential backoff delay for retry `attempt` (1-based).
 * delay = min(maxDelay, base * 2^(attempt-1)), then reduced by up to `jitter` fraction.
 * jitter=0 is fully deterministic (used by tests); jitter=1 is "full jitter".
 */
export function backoffDelay(attempt: number, cfg: RetryConfig, random: () => number = Math.random): number {
  if (!Number.isFinite(attempt) || attempt < 1) attempt = 1;
  const exp = cfg.baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(cfg.maxDelayMs, exp);
  const j = Math.min(1, Math.max(0, cfg.jitter));
  const r = Math.min(1, Math.max(0, random()));
  return Math.round(capped * (1 - j * r));
}

/** True while another attempt is allowed. */
export function canRetry(attemptsMade: number, cfg: RetryConfig): boolean {
  return attemptsMade < cfg.maxAttempts;
}
