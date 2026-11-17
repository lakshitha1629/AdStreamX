import type { AdBreakPosition, CommandAck, CommandRole, CommandsConfig, PlayerCommand, PlayerConfigInput } from '@adstreamx/shared-types';
import type { PlayerCore } from '@adstreamx/player-core';
import { AdStreamXError } from '@adstreamx/player-core';
import { isAllowed, validateCommand, type CommandVerifier } from '@adstreamx/command-protocol';
import type { EngineSlots } from './controllers.ts';

const MAX_REMEMBERED = 500;

/** Shape of validated payloads (validateCommand has already checked each field per type). */
interface Payload {
  time: number;
  volume: number;
  muted: boolean;
  id: string | null;
  src: string;
  type?: string;
  streamType?: 'vod' | 'live';
  patch: PlayerConfigInput;
  text: string;
  level?: 'info' | 'warning';
  durationMs?: number;
  overlayId: string;
  pollId: string;
  breakId?: string;
  position?: AdBreakPosition;
}
const MAX_HISTORY = 100;

/**
 * Remote command controller. Pipeline for every command:
 *   validate (schema, size, version, time window) → role permission → operator signature
 *   → idempotency (same id is never applied twice) → apply → ack + event.
 * Transport-agnostic: the iframe bridge (host role) and, later, the live-control socket
 * (operator role) both call execute().
 */
export class CommandController {
  private readonly core: PlayerCore;
  private readonly engines: EngineSlots;
  private config: CommandsConfig;
  private verifier: CommandVerifier | null;
  private readonly now: () => number;
  private seen = new Map<string, CommandAck>();
  private inProgress = new Map<string, Promise<CommandAck>>();
  private log: CommandAck[] = [];

  constructor(core: PlayerCore, engines: EngineSlots, config: CommandsConfig, opts: { verifier?: CommandVerifier; now?: () => number } = {}) {
    this.core = core;
    this.engines = engines;
    this.config = config;
    this.verifier = opts.verifier ?? null;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Install the operator-signature verifier (e.g. createEd25519Verifier(publicKeys)). */
  setVerifier(v: CommandVerifier | null): void {
    this.verifier = v;
  }
  /** @internal */
  updateConfig(c: CommandsConfig): void {
    this.config = c;
  }
  history(): CommandAck[] {
    return this.log.map((a) => ({ ...a }));
  }

  execute(raw: unknown, role: CommandRole): Promise<CommandAck> {
    const id = typeof (raw as { id?: unknown })?.id === 'string' ? (raw as { id: string }).id : '';
    // concurrent delivery of the same id (e.g. reconnect replay) shares one execution
    const running = id ? this.inProgress.get(id) : undefined;
    if (running) return running.then((a) => ({ ...a, status: 'duplicate' as const }));
    const p = this.run(raw, role).finally(() => this.inProgress.delete(id));
    if (id) this.inProgress.set(id, p);
    return p;
  }

  private async run(raw: unknown, role: CommandRole): Promise<CommandAck> {
    const at = this.now();
    if (!this.config.enabled) return this.reject(raw, 'DISABLED', 'commands are disabled', at);
    const v = validateCommand(raw, { now: at, maxClockSkewMs: this.config.maxClockSkewMs, defaultTtlMs: this.config.defaultTtlMs });
    if (!v.ok) return this.reject(raw, v.reason, v.detail, at);
    const cmd = v.command;

    const prior = this.seen.get(cmd.id);
    if (prior) return { ...prior, status: 'duplicate', at };

    this.core.emitExtension('commandreceived', { id: cmd.id, type: cmd.type, role });
    if (!isAllowed(role, cmd.type)) return this.finish(cmd, 'rejected', at, 'FORBIDDEN', `${role} may not ${cmd.type}`);
    if (role === 'operator') {
      if (!this.verifier) return this.finish(cmd, 'rejected', at, 'UNVERIFIED', 'no verifier configured');
      let ok = false;
      try {
        ok = await this.verifier(cmd);
      } catch {
        ok = false;
      }
      if (!ok) return this.finish(cmd, 'rejected', at, 'UNVERIFIED', 'signature invalid');
    }
    try {
      await this.apply(cmd);
    } catch (e) {
      const code = e instanceof AdStreamXError ? e.code : undefined;
      return this.finish(cmd, 'rejected', at, code === 'FEATURE_UNAVAILABLE' ? 'FEATURE_UNAVAILABLE' : 'FAILED', (e as Error).message);
    }
    return this.finish(cmd, 'applied', at);
  }

  private async apply(cmd: PlayerCommand): Promise<void> {
    const p = (cmd.payload ?? {}) as unknown as Payload;
    const c = this.core;
    switch (cmd.type) {
      case 'play':
        return c.play();
      case 'pause':
        return c.pause();
      case 'seek':
        return c.seekTo(p.time);
      case 'setVolume':
        return c.setVolume(p.volume);
      case 'setMuted':
        return c.setMuted(p.muted);
      case 'goLive':
        if (!c.goLive()) throw new Error('not a live stream');
        return;
      case 'setQuality':
        if (!c.setQuality(p.id ?? '')) throw new Error('quality not available');
        return;
      case 'setTextTrack':
        if (!c.setTextTrack(p.id)) throw new Error('unknown text track');
        return;
      case 'setSource':
        // allowedSourceOrigins still applies inside setSource (approved sources only)
        return c.setSource({ src: p.src, type: p.type, streamType: p.streamType });
      case 'updateConfig':
        c.updateConfig(p.patch);
        return;
      case 'announce':
        c.emitExtension('announcement', { id: cmd.id, text: p.text, level: p.level ?? 'info', durationMs: p.durationMs ?? 8000 });
        return;
      case 'showOverlay':
        return this.engines.overlays.show(p.overlayId);
      case 'hideOverlay':
        if (!this.engines.overlays.hide(p.overlayId)) throw new Error('overlay not shown');
        return;
      case 'openPoll':
        return this.engines.interactions.open(p.pollId);
      case 'closePoll':
        if (!this.engines.interactions.close(p.pollId)) throw new Error('poll not open');
        return;
      case 'startAdBreak':
        return this.engines.ads.requestBreak({ breakId: p.breakId, position: p.position ?? 'live' });
      case 'cancelAdBreak':
        if (!this.engines.ads.cancelBreak(p.breakId)) throw new Error('no pending break');
        return;
    }
  }

  private reject(raw: unknown, reason: NonNullable<CommandAck['reason']>, detail: string, at: number): CommandAck {
    const r = raw as { id?: unknown; type?: unknown } | null;
    const ack: CommandAck = {
      id: typeof r?.id === 'string' ? r.id.slice(0, 64) : '',
      type: typeof r?.type === 'string' ? r.type.slice(0, 32) : '',
      status: 'rejected',
      reason,
      detail,
      at,
    };
    this.record(ack, false);
    this.core.emitExtension('commandrejected', ack);
    return ack;
  }

  private finish(cmd: PlayerCommand, status: 'applied' | 'rejected', at: number, reason?: CommandAck['reason'], detail?: string): CommandAck {
    const ack: CommandAck = { id: cmd.id, type: cmd.type, status, at, ...(reason ? { reason } : {}), ...(detail ? { detail } : {}) };
    // Only applied ids are remembered: a replay never applies twice, and a forged command
    // sent first under a guessed id cannot block the genuine one.
    this.record(ack, status === 'applied');
    this.core.emitExtension(status === 'applied' ? 'commandapplied' : 'commandrejected', ack);
    return ack;
  }

  private record(ack: CommandAck, remember: boolean): void {
    if (remember && ack.id) {
      this.seen.set(ack.id, ack);
      if (this.seen.size > MAX_REMEMBERED) this.seen.delete(this.seen.keys().next().value as string);
    }
    this.log.push(ack);
    if (this.log.length > MAX_HISTORY) this.log.shift();
  }
}
