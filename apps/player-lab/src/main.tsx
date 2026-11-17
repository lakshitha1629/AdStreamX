import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { MediaSourceConfig, PlayerEventName, PlayerState, StreamType } from '@adstreamx/shared-types';
import { AdStreamX, type AdStreamXPlayer } from '@adstreamx/player-sdk';
import { SHORTCUTS } from '@adstreamx/player-controls';
import { FAULTS, PRESETS, type Preset } from './presets.ts';

const LOGGED_EVENTS: PlayerEventName[] = [
  'ready', 'loadstart', 'loadedmetadata', 'play', 'playing', 'pause', 'ended', 'seeking', 'seeked',
  'bufferingstart', 'bufferingend', 'volumechange', 'ratechange', 'qualitychange', 'qualitylevels',
  'texttrackchange', 'audiotrackchange', 'liveedgereached', 'livelatencychange', 'fullscreenchange',
  'pictureinpicturechange', 'theaterchange', 'autoplayblocked', 'retry', 'fallback', 'sourcechange',
  'error', 'configupdated', 'destroyed', 'timeupdate',
];
const NOISY = new Set<PlayerEventName>(['timeupdate', 'livelatencychange', 'volumechange']);
const MAX_LOG = 3000;

interface LogEntry {
  n: number;
  t: string;
  event: string;
  payload: unknown;
}

type Viewport = 'desktop' | 'tablet' | 'mobile';
const VIEWPORT_WIDTH: Record<Viewport, string> = { desktop: '100%', tablet: '768px', mobile: '375px' };

function App() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<AdStreamXPlayer | null>(null);
  const logRef = useRef<LogEntry[]>([]);
  const seq = useRef(0);
  const [instance, setInstance] = useState(0);
  const [state, setState] = useState<PlayerState | null>(null);
  const [logVersion, setLogVersion] = useState(0);
  const [showNoisy, setShowNoisy] = useState(false);
  const [logFilter, setLogFilter] = useState('');
  const [presetId, setPresetId] = useState('hls-vod');
  const [url, setUrl] = useState(PRESETS.find((p) => p.id === 'hls-vod')!.source.src);
  const [mode, setMode] = useState<'auto' | StreamType>('auto');
  const [engine, setEngine] = useState('auto');
  const [autoplayMuted, setAutoplayMuted] = useState(false);
  const [viewport, setViewport] = useState<Viewport>('desktop');
  const [cfg, setCfg] = useState({ targetLatency: 6, liveEdgeOffset: 3, catchUp: true, maxAttempts: 4, accent: '#22d3ee', title: 'AdStreamX Player Lab' });
  const [fixtureServer, setFixtureServer] = useState<boolean | null>(null);
  const [faults, setFaults] = useState<{ id: string; match: string; status?: number; delayMs?: number; abort?: boolean; remaining: number; hits: number }[]>([]);
  const [notice, setNotice] = useState('');
  const caps = useMemo(() => AdStreamX.getCapabilities(), []);
  const preset = PRESETS.find((p) => p.id === presetId);

  const log = useCallback((event: string, payload: unknown) => {
    const entry: LogEntry = { n: ++seq.current, t: new Date().toISOString().slice(11, 23), event, payload };
    logRef.current.push(entry);
    if (logRef.current.length > MAX_LOG) logRef.current.splice(0, logRef.current.length - MAX_LOG);
    setLogVersion((v) => v + 1);
  }, []);

  // ---- player lifecycle (one instance per `instance` key; StrictMode-safe)
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const p = AdStreamX.create(host, {
      engine,
      autoplay: autoplayMuted ? 'muted' : false,
      live: { targetLatency: cfg.targetLatency, liveEdgeOffset: cfg.liveEdgeOffset, catchUp: cfg.catchUp },
      retry: { maxAttempts: cfg.maxAttempts },
      branding: { accentColor: cfg.accent, title: cfg.title },
      debug: true,
    });
    playerRef.current = p;
    const offs = LOGGED_EVENTS.map((e) => p.on(e, (payload) => log(e, payload)));
    log('lab:create', { id: p.id, engine });
    const timer = setInterval(() => setState(p.getState()), 250);
    return () => {
      clearInterval(timer);
      offs.forEach((off) => off());
      p.destroy();
      playerRef.current = null;
      log('lab:destroy', { id: p.id });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance]);

  // ---- fixture server detection & fault list polling
  useEffect(() => {
    fetch('/health').then((r) => r.json()).then((j) => setFixtureServer(!!j.ok)).catch(() => setFixtureServer(false));
  }, []);
  const refreshFaults = useCallback(() => {
    fetch('/__faults').then((r) => (r.ok ? r.json() : [])).then(setFaults).catch(() => setFaults([]));
  }, []);
  useEffect(() => {
    if (!fixtureServer) return;
    refreshFaults();
    const id = setInterval(refreshFaults, 2000);
    return () => clearInterval(id);
  }, [fixtureServer, refreshFaults]);

  const resolveSource = async (p: Preset | undefined, src: string): Promise<{ source: MediaSourceConfig; fallbacks: MediaSourceConfig[] }> => {
    const base: MediaSourceConfig = p && p.source.src === src ? { ...p.source } : { src };
    if (p?.signTtl !== undefined && p.source.src === src) {
      const r = await fetch(`/__sign?path=${encodeURIComponent(src)}&ttl=${p.signTtl}`).then((x) => x.json());
      base.src = r.url;
      base.expiresAt = r.expiresAt;
    }
    if (mode !== 'auto') base.streamType = mode;
    return { source: base, fallbacks: p && p.source.src === src ? (p.fallbacks ?? []) : [] };
  };

  const load = async () => {
    const p = playerRef.current;
    if (!p) return;
    setNotice('');
    try {
      if (p.getConfig().engine !== engine) p.updateConfig({ engine });
      const { source, fallbacks } = await resolveSource(preset, url.trim());
      log('lab:load', { source, fallbacks });
      await p.setSource(source, fallbacks);
    } catch (e) {
      setNotice(`Load failed: ${(e as Error).message}`);
    }
  };

  const applyConfig = () => {
    const p = playerRef.current;
    if (!p) return;
    try {
      p.updateConfig({
        live: { targetLatency: cfg.targetLatency, liveEdgeOffset: cfg.liveEdgeOffset, catchUp: cfg.catchUp },
        retry: { maxAttempts: cfg.maxAttempts },
        branding: { accentColor: cfg.accent, title: cfg.title },
      });
      setNotice('Configuration applied.');
    } catch (e) {
      setNotice((e as Error).message);
    }
  };

  const addFault = async (body: object) => {
    await fetch('/__faults', { method: 'POST', headers: { 'content-type': 'application/json', 'x-adstreamx-test': '1' }, body: JSON.stringify(body) });
    log('lab:fault', body);
    refreshFaults();
  };
  const clearFaults = async () => {
    await fetch('/__faults', { method: 'DELETE', headers: { 'x-adstreamx-test': '1' } });
    log('lab:fault-clear', {});
    refreshFaults();
  };

  const reset = async () => {
    logRef.current = [];
    seq.current = 0;
    setLogVersion((v) => v + 1);
    if (fixtureServer) await clearFaults();
    setInstance((i) => i + 1);
    setNotice('Player recreated, log and faults cleared.');
  };

  const downloadDiagnostics = () => {
    const p = playerRef.current;
    const data = {
      generatedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      sdkVersion: AdStreamX.VERSION,
      capabilities: caps,
      config: p?.getConfig() ?? null,
      state: p?.getState() ?? null,
      faults,
      events: logRef.current,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `adstreamx-diagnostics-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const visibleLog = useMemo(() => {
    const f = logFilter.trim().toLowerCase();
    return logRef.current
      .filter((e) => showNoisy || !NOISY.has(e.event as PlayerEventName))
      .filter((e) => !f || e.event.toLowerCase().includes(f) || JSON.stringify(e.payload).toLowerCase().includes(f))
      .slice(-300)
      .reverse();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logVersion, showNoisy, logFilter]);

  const s = state;
  return (
    <div className="lab">
      <header className="lab-header">
        <div className="brand">
          <span className="logo-dot" aria-hidden="true" />
          <h1>AdStreamX <span>Player Lab</span></h1>
          <span className="badge">SDK {AdStreamX.VERSION}</span>
        </div>
        <ul className="caps" aria-label="Browser capabilities">
          {(
            [
              ['MP4/H.264', caps.mp4H264],
              ['Native HLS', caps.nativeHls],
              ['MSE', caps.mediaSource],
              ['Fullscreen', caps.fullscreen || caps.videoElementFullscreen],
              ['PiP', caps.pictureInPicture],
              ['audioTracks API', caps.audioTrackApi],
            ] as [string, boolean][]
          ).map(([k, v]) => (
            <li key={k} className={v ? 'yes' : 'no'}>{v ? '✓' : '✕'} {k}</li>
          ))}
        </ul>
      </header>

      <main className="lab-main">
        <section className="stage" aria-label="Player preview">
          <div className="stage-toolbar" role="group" aria-label="Preview size">
            {(['desktop', 'tablet', 'mobile'] as Viewport[]).map((v) => (
              <button key={v} type="button" className={viewport === v ? 'seg active' : 'seg'} aria-pressed={viewport === v} onClick={() => setViewport(v)}>
                {v === 'desktop' ? 'Desktop' : v === 'tablet' ? 'Tablet 768' : 'Mobile 375'}
              </button>
            ))}
          </div>
          <div className="frame" style={{ maxWidth: VIEWPORT_WIDTH[viewport] }}>
            <div ref={hostRef} data-testid="player-host" />
          </div>
          <details className="shortcuts">
            <summary>Keyboard shortcuts</summary>
            <dl>{SHORTCUTS.map(([k, d]) => [<dt key={k + 't'}>{k}</dt>, <dd key={k + 'd'}>{d}</dd>])}</dl>
          </details>

          <Card title="Event log" actions={
            <>
              <input className="input sm" placeholder="Filter…" value={logFilter} onChange={(e: { target: HTMLInputElement }) => setLogFilter(e.target.value)} aria-label="Filter events" />
              <label className="check"><input type="checkbox" checked={showNoisy} onChange={(e: { target: HTMLInputElement }) => setShowNoisy(e.target.checked)} /> timeupdate</label>
              <button type="button" className="btn ghost" onClick={() => { logRef.current = []; setLogVersion((v) => v + 1); }}>Clear log</button>
              <button type="button" className="btn ghost" onClick={downloadDiagnostics}>Download diagnostics</button>
            </>
          }>
            <ol className="log" data-testid="event-log" aria-live="off">
              {visibleLog.length === 0 && <li className="muted">No events yet.</li>}
              {visibleLog.map((e) => (
                <li key={e.n} className={`ev ev-${e.event.replace(/[^a-z]/gi, '')}`}>
                  <span className="ev-t">{e.t}</span>
                  <span className="ev-name">{e.event}</span>
                  <code className="ev-p">{summarize(e.payload)}</code>
                </li>
              ))}
            </ol>
          </Card>
        </section>

        <aside className="panels">
          <Card title="Source">
            <label className="field">
              <span>Fixture preset</span>
              <select className="input" value={presetId} onChange={(e: { target: HTMLSelectElement }) => {
                const p = PRESETS.find((x) => x.id === e.target.value);
                setPresetId(e.target.value);
                if (p) setUrl(p.source.src);
              }}>
                {(['VOD', 'Live', 'Recovery', 'Errors'] as const).map((g) => (
                  <optgroup key={g} label={g}>
                    {PRESETS.filter((p) => p.group === g).map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                  </optgroup>
                ))}
                <option value="custom">Custom URL…</option>
              </select>
            </label>
            <label className="field">
              <span>Video URL</span>
              <input className="input mono" value={url} data-testid="source-url" onChange={(e: { target: HTMLInputElement }) => { setUrl(e.target.value); setPresetId('custom'); }} spellCheck={false} />
            </label>
            <div className="row">
              <label className="field">
                <span>Mode</span>
                <select className="input" value={mode} onChange={(e: { target: HTMLSelectElement }) => setMode(e.target.value as 'auto' | StreamType)}>
                  <option value="auto">Auto-detect</option>
                  <option value="vod">VOD</option>
                  <option value="live">Live</option>
                </select>
              </label>
              <label className="field">
                <span>Engine</span>
                <select className="input" value={engine} onChange={(e: { target: HTMLSelectElement }) => setEngine(e.target.value)}>
                  <option value="auto">auto</option>
                  {caps.engines.map((id) => <option key={id} value={id}>{id}</option>)}
                </select>
              </label>
            </div>
            <label className="check"><input type="checkbox" checked={autoplayMuted} onChange={(e: { target: HTMLInputElement }) => setAutoplayMuted(e.target.checked)} /> Muted autoplay on next reset</label>
            <div className="row gap">
              <button type="button" className="btn primary" data-testid="load" onClick={load}>Load</button>
              <button type="button" className="btn" onClick={() => playerRef.current?.unload()}>Unload</button>
              <button type="button" className="btn ghost" onClick={reset}>Reset</button>
            </div>
            {preset?.note && <p className="muted small">{preset.note}</p>}
            {notice && <p className="notice" role="status">{notice}</p>}
          </Card>

          <Card title="Playback state">
            {s ? (
              <dl className="kv" data-testid="state">
                <dt>Status</dt><dd><span className={`pill st-${s.status}`} data-testid="status">{s.status}</span></dd>
                <dt>Engine</dt><dd>{s.engine ?? '—'}</dd>
                <dt>Stream</dt><dd>{s.streamType ?? '—'}</dd>
                <dt>Source</dt><dd className="mono ellipsis" title={s.source?.src}>{s.source ? `#${s.sourceIndex} ${shortUrl(s.source.src)}` : '—'}</dd>
                <dt>Time</dt><dd className="mono">{s.currentTime.toFixed(2)} / {Number.isFinite(s.duration) ? s.duration.toFixed(2) : '∞'}</dd>
                <dt>Buffered to</dt><dd className="mono">{s.bufferedEnd.toFixed(2)}</dd>
                <dt>Video</dt><dd className="mono">{s.videoWidth}×{s.videoHeight}</dd>
                <dt>Volume</dt><dd>{Math.round(s.volume * 100)}%{s.muted ? ' (muted)' : ''}</dd>
                <dt>Rate</dt><dd>{s.playbackRate}×</dd>
                <dt>Retry</dt><dd>{s.retryAttempt}</dd>
                <dt>Startup</dt><dd>{s.startupTimeMs !== null ? `${s.startupTimeMs} ms` : '—'}</dd>
                {s.error && (<><dt>Error</dt><dd className="err">{s.error.code}{s.error.fatal ? ' (fatal)' : ''}<br /><small>{s.error.detail}</small></dd></>)}
              </dl>
            ) : <p className="muted">Creating player…</p>}
          </Card>

          <Card title="Live & DVR">
            {s?.streamType === 'live' && s.live ? (
              <>
                <dl className="kv" data-testid="live">
                  <dt>Latency</dt><dd className="mono">{s.live.estimated ? '≈ ' : ''}{s.live.latency.toFixed(2)} s</dd>
                  <dt>At live edge</dt><dd>{s.live.atLiveEdge ? 'yes' : 'no'}</dd>
                  <dt>DVR</dt><dd>{s.live.dvr ? `${s.live.dvrWindow.toFixed(1)} s window` : 'not exposed by engine'}</dd>
                  {s.live.dvr && (<><dt>Seekable</dt><dd className="mono">{s.live.seekableStart.toFixed(1)} – {s.live.seekableEnd.toFixed(1)}</dd></>)}
                </dl>
                {!s.live.dvr && <p className="muted small">This engine exposes no seekable range, so DVR scrubbing is unavailable and latency is estimated from drift since joining. Go Live re-joins the stream.</p>}
                <button type="button" className="btn" onClick={() => playerRef.current?.goLive()}>Go Live</button>
              </>
            ) : <p className="muted small">Load a live preset to see latency and DVR diagnostics.</p>}
            <div className="row">
              <label className="field"><span>Target latency (s)</span><input className="input" type="number" min={0} max={60} value={cfg.targetLatency} onChange={(e: { target: HTMLInputElement }) => setCfg({ ...cfg, targetLatency: Number(e.target.value) })} /></label>
              <label className="field"><span>Live-edge offset (s)</span><input className="input" type="number" min={0} max={60} value={cfg.liveEdgeOffset} onChange={(e: { target: HTMLInputElement }) => setCfg({ ...cfg, liveEdgeOffset: Number(e.target.value) })} /></label>
            </div>
            <label className="check"><input type="checkbox" checked={cfg.catchUp} onChange={(e: { target: HTMLInputElement }) => setCfg({ ...cfg, catchUp: e.target.checked })} /> Latency catch-up</label>
          </Card>

          <Card title="Quality & tracks">
            {s && s.qualityLevels.length > 0 ? (
              <label className="field"><span>Quality</span>
                <select className="input" value={s.qualitySelection} onChange={(e: { target: HTMLSelectElement }) => playerRef.current?.setQuality(e.target.value)}>
                  <option value="auto">Auto</option>
                  {s.qualityLevels.map((q) => <option key={q.id} value={q.id}>{q.label}</option>)}
                </select>
              </label>
            ) : (
              <p className="muted small">Manual quality: not exposed by the <b>{s?.engine ?? 'current'}</b> engine. The browser picks renditions automatically (now showing {s?.currentQuality?.label ?? '—'}).</p>
            )}
            <p className="small">Subtitles: {s?.textTracks.length ? s.textTracks.map((t) => `${t.label}${t.active ? ' ●' : ''}`).join(', ') : 'none'}</p>
            <p className="small">Audio tracks: {s?.audioTracks.length ? s.audioTracks.map((t) => `${t.label}${t.active ? ' ●' : ''}`).join(', ') : caps.audioTrackApi ? 'none' : 'audioTracks API not available in this browser'}</p>
          </Card>

          <Card title="Network fault simulator">
            {fixtureServer === false && <p className="muted small">Requires the local fixture server (<code>npm run serve</code>).</p>}
            {fixtureServer && (
              <>
                <div className="fault-grid">
                  {FAULTS.map((f) => <button key={f.id} type="button" className="btn sm" onClick={() => addFault(f.body)}>{f.label}</button>)}
                </div>
                <button type="button" className="btn ghost sm" onClick={clearFaults}>Clear faults</button>
                <ul className="faults">
                  {faults.length === 0 && <li className="muted small">No active faults.</li>}
                  {faults.map((f) => (
                    <li key={f.id} className="small mono">
                      “{f.match}” → {f.status ?? (f.abort ? 'abort' : `${f.delayMs} ms delay`)} · hits {f.hits} · {f.remaining < 0 ? '∞' : `${f.remaining} left`}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Card>

          <Card title="Branding & recovery">
            <div className="row">
              <label className="field"><span>Accent</span><input className="input" type="color" value={cfg.accent} onChange={(e: { target: HTMLInputElement }) => setCfg({ ...cfg, accent: e.target.value })} /></label>
              <label className="field"><span>Max retries</span><input className="input" type="number" min={0} max={10} value={cfg.maxAttempts} onChange={(e: { target: HTMLInputElement }) => setCfg({ ...cfg, maxAttempts: Number(e.target.value) })} /></label>
            </div>
            <label className="field"><span>Title</span><input className="input" value={cfg.title} onChange={(e: { target: HTMLInputElement }) => setCfg({ ...cfg, title: e.target.value })} /></label>
            <button type="button" className="btn" onClick={applyConfig}>Apply</button>
          </Card>

          <Card title="VAST / VMAP tag tester" badge="Phase 3 · not built">
            <p className="muted small">The advertising engine (IMA, house ads, VMAP scheduling) has not been implemented yet. This panel will drive it once Phase 3 passes its gate.</p>
          </Card>
          <Card title="Overlay preview" badge="Phase 4 · not built">
            <p className="muted small">The overlay engine is not implemented yet.</p>
          </Card>
        </aside>
      </main>
    </div>
  );
}

function Card(props: { title: string; children?: unknown; actions?: unknown; badge?: string }) {
  return (
    <section className="card" aria-label={props.title}>
      <header className="card-h">
        <h2>{props.title}</h2>
        {props.badge && <span className="badge warn">{props.badge}</span>}
        {props.actions ? <div className="card-actions">{props.actions}</div> : null}
      </header>
      <div className="card-b">{props.children}</div>
    </section>
  );
}

function summarize(p: unknown): string {
  if (p === undefined || p === null) return '';
  const s = JSON.stringify(p, (k, v) => (k === 'state' || k === 'config' ? '…' : typeof v === 'number' ? Math.round(v * 100) / 100 : v));
  return s === '{}' ? '' : s.length > 220 ? s.slice(0, 220) + '…' : s;
}

function shortUrl(u: string): string {
  try {
    const x = new URL(u);
    return x.origin === location.origin ? x.pathname : u;
  } catch {
    return u;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
