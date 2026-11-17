import { useEffect, useState } from 'react';
import type { CommandAck, CommandRole, CommandType } from '@adstreamx/shared-types';
import { AdStreamX, type AdStreamXPlayer } from '@adstreamx/player-sdk';
import { Card } from './card.tsx';

type Ref = { current: AdStreamXPlayer | null };

/** Phase 2 Lab tools: embed code, analytics, command console. */
export function ToolPanels(props: { playerRef: Ref; url: string; commandTypes: CommandType[] }) {
  return (
    <>
      <EmbedPanel url={props.url} />
      <AnalyticsPanel playerRef={props.playerRef} />
      <CommandPanel playerRef={props.playerRef} types={props.commandTypes} />
    </>
  );
}

type Variant = 'iframe' | 'hostControl' | 'script' | 'react';

function EmbedPanel({ url }: { url: string }) {
  const [origin, setOrigin] = useState(location.origin);
  const [title, setTitle] = useState('My video');
  const [variant, setVariant] = useState<Variant>('iframe');
  const [copied, setCopied] = useState(false);
  let code: ReturnType<typeof AdStreamX.generateEmbedCode> | null = null;
  let error = '';
  try {
    const src = url.startsWith('/') ? location.origin + url : url;
    code = AdStreamX.generateEmbedCode({
      playerUrl: `${location.origin}/embed/`,
      sdkUrl: `${location.origin}/sdk/adstreamx.js`,
      config: { source: { src }, branding: { title } },
      allowedOrigins: origin.trim() ? [origin.trim()] : [],
      title,
    });
  } catch (e) {
    error = (e as Error).message;
  }
  const text = code ? code[variant] : '';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <Card title="Embed code">
      <label className="field">
        <span>Allowed host origin (exact, no wildcards)</span>
        <input className="input mono" value={origin} onChange={(e: { target: HTMLInputElement }) => setOrigin(e.target.value)} data-testid="embed-origin" />
      </label>
      <label className="field">
        <span>Title</span>
        <input className="input" value={title} onChange={(e: { target: HTMLInputElement }) => setTitle(e.target.value)} />
      </label>
      <div className="row gap" role="tablist" aria-label="Snippet type">
        {(['iframe', 'hostControl', 'script', 'react'] as Variant[]).map((v) => (
          <button key={v} type="button" role="tab" aria-selected={variant === v} className={variant === v ? 'seg active' : 'seg'} onClick={() => setVariant(v)}>
            {v === 'hostControl' ? 'iframe control' : v}
          </button>
        ))}
      </div>
      {error ? (
        <p className="err small" role="alert">{error}</p>
      ) : (
        <>
          <textarea className="input mono code" readOnly value={text} rows={8} aria-label="Embed code" data-testid="embed-code" />
          <div className="row gap">
            <button type="button" className="btn" onClick={copy}>{copied ? 'Copied ✓' : 'Copy'}</button>
            {code && <a className="btn ghost" href={code.iframeUrl} target="_blank" rel="noopener noreferrer">Open iframe player</a>}
          </div>
        </>
      )}
    </Card>
  );
}

function AnalyticsPanel({ playerRef }: { playerRef: Ref }) {
  const [enabled, setEnabled] = useState(false);
  const [consent, setConsent] = useState(false);
  const [stats, setStats] = useState<ReturnType<AdStreamXPlayer['analytics']['getStats']> | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [server, setServer] = useState<{ events: number; duplicates: number } | null>(null);
  useEffect(() => {
    const id = setInterval(() => {
      const p = playerRef.current;
      if (!p || p.destroyed) return;
      setStats(p.analytics.getStats());
      setRecent(p.analytics.getQueue().slice(-6).reverse().map((e) => `${e.type}${e.data ? ' ' + JSON.stringify(e.data) : ''}`));
    }, 500);
    return () => clearInterval(id);
  }, [playerRef]);
  const toggle = (on: boolean) => {
    const p = playerRef.current;
    if (!p) return;
    p.updateConfig({ analytics: { enabled: on, endpoint: '/__analytics', requireConsent: true, flushIntervalMs: 5000, heartbeatIntervalMs: 10000 } });
    setEnabled(on);
  };
  const giveConsent = (on: boolean) => {
    playerRef.current?.analytics.setConsent(on);
    setConsent(on);
  };
  const refreshServer = async () => {
    const r = await fetch('/__analytics').then((x) => x.json()).catch(() => null);
    setServer(r ? { events: r.events.length, duplicates: r.duplicates } : null);
  };
  return (
    <Card title="Analytics (client)">
      <label className="check"><input type="checkbox" checked={enabled} onChange={(e: { target: HTMLInputElement }) => toggle(e.target.checked)} data-testid="analytics-enabled" /> Enable collection (→ /__analytics test endpoint)</label>
      <label className="check"><input type="checkbox" checked={consent} disabled={!enabled} onChange={(e: { target: HTMLInputElement }) => giveConsent(e.target.checked)} data-testid="analytics-consent" /> Viewer consent given</label>
      {stats && (
        <dl className="kv small" data-testid="analytics-stats">
          <dt>Session</dt><dd className="mono ellipsis">{playerRef.current?.analytics.sessionId.slice(0, 8)}…</dd>
          <dt>Queued / sent</dt><dd>{stats.queued} / {stats.sent}</dd>
          <dt>Dropped</dt><dd>{stats.dropped} (rejected {stats.rejected})</dd>
          <dt>Watch time</dt><dd>{(stats.watchMs / 1000).toFixed(1)} s</dd>
          <dt>Rebuffering</dt><dd>{stats.rebufferCount}× · {(stats.rebufferMs / 1000).toFixed(1)} s</dd>
        </dl>
      )}
      <ol className="log small" style={{ maxHeight: '120px' }}>
        {recent.length === 0 ? <li className="muted">{enabled ? (consent ? 'Queue empty (sent).' : 'Waiting for consent — nothing is collected.') : 'Collection is off.'}</li> : recent.map((r, i) => <li key={i} className="mono">{r}</li>)}
      </ol>
      <div className="row gap">
        <button type="button" className="btn sm" onClick={() => playerRef.current?.analytics.flush()}>Flush now</button>
        <button type="button" className="btn sm ghost" onClick={refreshServer}>Server received</button>
        {server && <span className="small" data-testid="analytics-server">{server.events} events · {server.duplicates} dup</span>}
      </div>
    </Card>
  );
}

const EXAMPLES: Partial<Record<CommandType, string>> = {
  seek: '{"time": 5}',
  setVolume: '{"volume": 0.3}',
  setMuted: '{"muted": true}',
  setSource: '{"src": "/media/hls/vod/master.m3u8"}',
  updateConfig: '{"patch": {"branding": {"title": "Changed by command"}}}',
  announce: '{"text": "We go live in 5 minutes", "durationMs": 6000}',
  showOverlay: '{"overlayId": "promo-1"}',
  openPoll: '{"pollId": "poll-1"}',
  startAdBreak: '{"position": "live"}',
};

function CommandPanel({ playerRef, types }: { playerRef: Ref; types: CommandType[] }) {
  const [role, setRole] = useState<CommandRole>('host');
  const [type, setType] = useState<CommandType>('pause');
  const [payload, setPayload] = useState('{}');
  const [acks, setAcks] = useState<CommandAck[]>([]);
  const send = async () => {
    const p = playerRef.current;
    if (!p) return;
    let parsed: unknown;
    try {
      parsed = payload.trim() ? JSON.parse(payload) : {};
    } catch {
      const local: CommandAck = { id: '-', type, status: 'rejected', reason: 'INVALID', detail: 'payload is not JSON', at: Date.now() };
      setAcks((a) => [local, ...a].slice(0, 8));
      return;
    }
    const now = Date.now();
    const cmd = { v: 1, id: `lab-${now.toString(36)}`, type, issuedAt: now, expiresAt: now + 30000, payload: parsed };
    const ack = await p.command(cmd, role);
    setAcks((a) => [ack, ...a].slice(0, 8));
  };
  return (
    <Card title="Command console">
      <div className="row">
        <label className="field"><span>Role</span>
          <select className="input" value={role} onChange={(e: { target: HTMLSelectElement }) => setRole(e.target.value as CommandRole)} data-testid="cmd-role">
            <option value="viewer">viewer</option>
            <option value="host">host</option>
            <option value="operator">operator (needs signature)</option>
          </select>
        </label>
        <label className="field"><span>Command</span>
          <select className="input" value={type} data-testid="cmd-type" onChange={(e: { target: HTMLSelectElement }) => {
            const t = e.target.value as CommandType;
            setType(t);
            setPayload(EXAMPLES[t] ?? '{}');
          }}>
            {types.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
      </div>
      <label className="field"><span>Payload (JSON)</span>
        <textarea className="input mono code" rows={2} value={payload} onChange={(e: { target: HTMLTextAreaElement }) => setPayload(e.target.value)} data-testid="cmd-payload" />
      </label>
      <button type="button" className="btn" onClick={send} data-testid="cmd-send">Send command</button>
      <ul className="acks" data-testid="cmd-acks">
        {acks.map((a, i) => (
          <li key={i} className={`small mono ${a.status === 'rejected' ? 'err' : ''}`}>
            {a.type} → {a.status}{a.reason ? ` (${a.reason})` : ''}{a.detail ? ` · ${a.detail}` : ''}
          </li>
        ))}
      </ul>
      <p className="muted small">Operator commands are only accepted with a valid Ed25519 signature from your backend; unsigned ones are rejected here by design.</p>
    </Card>
  );
}
