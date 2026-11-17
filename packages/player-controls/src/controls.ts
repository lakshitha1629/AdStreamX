import type { PlayerConfig, PlayerState } from '@adstreamx/shared-types';
import { formatTime, type PlayerCore } from '@adstreamx/player-core';
import { icon, type IconName } from './icons.ts';
import { mapKey, type KeyAction } from './keyboard.ts';
import { injectStyles } from './styles.ts';

export interface ControlsHandle {
  readonly element: HTMLElement;
  /** Show the controls and restart the auto-hide timer. */
  poke(): void;
  update(config: PlayerConfig): void;
  destroy(): void;
}

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const DOUBLE_TAP_MS = 300;

/**
 * Custom player chrome. Talks to the player only through the PlayerCore public API,
 * so any engine behind the core gets identical controls.
 */
export function createControls(root: HTMLElement, core: PlayerCore, initialConfig: PlayerConfig): ControlsHandle {
  const doc = root.ownerDocument;
  injectStyles(doc);
  let config = initialConfig;
  const caps = core.getCapabilities();
  const disposers: (() => void)[] = [];
  const listen = <K extends keyof HTMLElementEventMap>(el: EventTarget, type: K | string, fn: (e: never) => void, opts?: AddEventListenerOptions) => {
    el.addEventListener(type, fn as EventListener, opts);
    disposers.push(() => el.removeEventListener(type, fn as EventListener, opts));
  };
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (fn: () => void, ms: number) => {
    const id = setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
    return id;
  };

  // ---------------------------------------------------------------- DOM
  const ui = el('div', 'asx-ui');
  const gesture = el('div', 'asx-gesture');
  gesture.setAttribute('aria-hidden', 'true');
  const top = el('div', 'asx-top');
  const title = el('div', 'asx-title');
  const logo = doc.createElement('img');
  logo.className = 'asx-logo';
  top.append(title, logo);

  const center = el('div', 'asx-center');
  const spinner = el('div', 'asx-spinner asx-hidden');
  spinner.setAttribute('role', 'status');
  spinner.setAttribute('aria-label', 'Loading');
  const bigPlay = btn('asx-bigplay', 'Play', 'play');
  const errorBox = el('div', 'asx-error asx-hidden');
  errorBox.setAttribute('role', 'alert');
  const errTitle = el('div', 'asx-error-title');
  const errCode = el('div', 'asx-error-code');
  const errRetry = doc.createElement('button');
  errRetry.type = 'button';
  errRetry.className = 'asx-error-retry';
  errRetry.textContent = 'Try again';
  errorBox.append(errTitle, errCode, errRetry);
  center.append(spinner, bigPlay, errorBox);

  const flashL = el('div', 'asx-flash asx-flash-left');
  const flashR = el('div', 'asx-flash asx-flash-right');

  const controls = el('div', 'asx-controls');
  const seekWrap = el('div', 'asx-seek-wrap');
  const seek = range('asx-range asx-seek', 'Seek', 0, 1000, 1);
  const seekTip = el('div', 'asx-seek-tip');
  seekWrap.append(seek, seekTip);

  const bar = el('div', 'asx-bar');
  const playBtn = btn('asx-btn', 'Play', 'play');
  const muteBtn = btn('asx-btn', 'Mute', 'volume');
  const volume = range('asx-range asx-volume', 'Volume', 0, 100, 1);
  const time = el('span', 'asx-time');
  const liveBtn = doc.createElement('button');
  liveBtn.type = 'button';
  liveBtn.className = 'asx-live asx-hidden';
  liveBtn.textContent = 'LIVE';
  const latency = el('span', 'asx-latency asx-hidden');
  const spacer = el('div', 'asx-spacer');
  const ccBtn = btn('asx-btn', 'Subtitles', 'cc');
  const audioBtn = btn('asx-btn asx-hide-narrow', 'Audio track', 'audio');
  const qualityBtn = btn('asx-btn', 'Quality', 'quality');
  const rateBtn = btn('asx-btn asx-text-btn asx-hide-narrow', 'Playback speed');
  rateBtn.textContent = '1×';
  const pipBtn = btn('asx-btn asx-hide-narrow', 'Picture-in-Picture', 'pip');
  const theaterBtn = btn('asx-btn asx-hide-narrow', 'Theater mode', 'theater');
  const fsBtn = btn('asx-btn', 'Fullscreen', 'fullscreen');
  for (const b of [ccBtn, audioBtn, qualityBtn, rateBtn]) b.setAttribute('aria-haspopup', 'menu');
  theaterBtn.setAttribute('aria-pressed', 'false');
  bar.append(playBtn, muteBtn, volume, time, liveBtn, latency, spacer, ccBtn, audioBtn, qualityBtn, rateBtn, pipBtn, theaterBtn, fsBtn);
  controls.append(seekWrap, bar);

  const menu = el('div', 'asx-menu asx-hidden');
  menu.setAttribute('role', 'menu');
  const sr = el('div', 'asx-sr');
  sr.setAttribute('aria-live', 'polite');
  // Operator announcements: plain text only (textContent), never HTML.
  const announceBox = el('div', 'asx-announce asx-hidden');
  announceBox.setAttribute('role', 'status');
  announceBox.setAttribute('aria-live', 'polite');

  ui.append(gesture, top, announceBox, center, flashL, flashR, controls, menu, sr);
  root.appendChild(ui);
  root.classList.add('asx-player');
  if (!root.hasAttribute('tabindex')) root.tabIndex = 0;
  root.setAttribute('role', 'region');
  root.setAttribute('aria-roledescription', 'video player');

  // ---------------------------------------------------------------- behaviour
  let dragging = false;
  let menuFor: HTMLButtonElement | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const announce = (msg: string) => {
    sr.textContent = '';
    later(() => (sr.textContent = msg), 30);
  };

  const poke = () => {
    root.classList.remove('asx-idle');
    if (idleTimer) clearTimeout(idleTimer);
    const s = core.getState();
    if (config.controls.autoHideMs > 0 && s.status === 'playing' && !menuFor && !dragging) {
      idleTimer = later(() => {
        const st = core.getState();
        const focusInControls = controls.contains(doc.activeElement);
        if (st.status === 'playing' && !menuFor && !dragging && !focusInControls) root.classList.add('asx-idle');
      }, config.controls.autoHideMs);
    }
  };

  const safe = (fn: () => unknown) => {
    try {
      const r = fn();
      if (r instanceof Promise) r.catch(() => undefined);
    } catch {
      /* player destroyed or action unsupported */
    }
  };

  const togglePlay = () => {
    const s = core.getState();
    if (s.status === 'error') return safe(() => core.retry());
    if (s.paused || s.ended) safe(() => core.play());
    else core.pause();
  };

  const seekBy = (delta: number) => {
    const s = core.getState();
    if (s.streamType === 'live' && s.live?.dvr) core.seekTo(s.currentTime + delta);
    else if (s.streamType === 'vod') core.seekTo(s.currentTime + delta);
    else return;
    flash(delta < 0 ? flashL : flashR, `${delta > 0 ? '+' : '−'}${Math.abs(delta)}s`);
  };

  const flash = (node: HTMLElement, text: string) => {
    node.textContent = text;
    node.classList.add('asx-show');
    later(() => node.classList.remove('asx-show'), 500);
  };

  const toggleFullscreen = () => {
    if (core.getState().fullscreen) safe(() => core.exitFullscreen());
    else safe(() => core.enterFullscreen());
  };

  const toggleCaptions = () => {
    const s = core.getState();
    const active = s.textTracks.find((t) => t.active);
    if (active) core.setTextTrack(null);
    else if (s.textTracks[0]) core.setTextTrack(s.textTracks[0].id);
    announce(active ? 'Subtitles off' : 'Subtitles on');
  };

  const perform = (a: KeyAction) => {
    const s = core.getState();
    switch (a.type) {
      case 'togglePlay':
        return togglePlay();
      case 'seekBy':
        return seekBy(a.seconds);
      case 'seekPercent':
        if (s.streamType === 'vod' && Number.isFinite(s.duration)) core.seekTo((s.duration * a.percent) / 100);
        else if (s.live?.dvr) core.seekTo(s.live.seekableStart + (s.live.dvrWindow * a.percent) / 100);
        return;
      case 'seekStart':
        if (s.streamType === 'vod') core.seekTo(0);
        else if (s.live?.dvr) core.seekTo(s.live.seekableStart);
        return;
      case 'seekEnd':
        if (s.streamType === 'live') core.goLive();
        return;
      case 'volumeBy': {
        const v = Math.round(Math.min(1, Math.max(0, s.volume + a.delta)) * 100) / 100;
        core.setVolume(v);
        if (v > 0) core.setMuted(false);
        return announce(`Volume ${Math.round(v * 100)}%`);
      }
      case 'toggleMute':
        core.setMuted(!s.muted);
        return announce(s.muted ? 'Unmuted' : 'Muted');
      case 'toggleFullscreen':
        return toggleFullscreen();
      case 'toggleTheater':
        return core.setTheater(!s.theater);
      case 'toggleCaptions':
        return toggleCaptions();
      case 'togglePip':
        return safe(() => core.togglePictureInPicture());
      case 'rateBy': {
        if (s.streamType !== 'vod') return;
        const r = Math.min(2, Math.max(0.25, s.playbackRate + a.delta));
        core.setPlaybackRate(r);
        return announce(`Speed ${r}×`);
      }
    }
  };

  // keyboard (only when focus is inside the player, never global)
  listen(root, 'keydown', (e: KeyboardEvent) => {
    if (!config.controls.keyboard) return;
    const target = e.target as HTMLElement;
    if (menuFor && menu.contains(target)) return; // menu handles its own keys
    if (e.key === 'Escape' && menuFor) return closeMenu(true);
    const isRange = target instanceof HTMLInputElement && target.type === 'range';
    const isButton = target instanceof HTMLButtonElement;
    if (isRange && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) return;
    if (isButton && (e.key === ' ' || e.key === 'Enter')) return;
    const action = mapKey(e);
    if (!action) return;
    e.preventDefault();
    poke();
    perform(action);
  });

  // pointer: mouse click toggles play; touch tap toggles controls; double-tap sides seek
  let lastTap = 0;
  let tapTimer: ReturnType<typeof setTimeout> | null = null;
  listen(gesture, 'pointerup', (e: PointerEvent) => {
    if (e.button !== 0) return;
    if (menuFor) return closeMenu(false);
    if (e.pointerType === 'mouse') {
      togglePlay();
      return poke();
    }
    if (!config.controls.gestures) return poke();
    const nowT = performance.now();
    const rect = gesture.getBoundingClientRect();
    const x = (e.clientX - rect.left) / Math.max(1, rect.width);
    if (nowT - lastTap < DOUBLE_TAP_MS) {
      if (tapTimer) clearTimeout(tapTimer);
      tapTimer = null;
      lastTap = 0;
      if (x < 0.35) seekBy(-10);
      else if (x > 0.65) seekBy(10);
      else togglePlay();
      return poke();
    }
    lastTap = nowT;
    tapTimer = later(() => {
      tapTimer = null;
      if (root.classList.contains('asx-idle')) poke();
      else if (core.getState().status === 'playing') root.classList.add('asx-idle');
      else poke();
    }, DOUBLE_TAP_MS);
  });
  listen(gesture, 'dblclick', (e: MouseEvent) => {
    if ((e as PointerEvent).pointerType === 'touch') return;
    toggleFullscreen();
  });
  listen(root, 'pointermove', (e: PointerEvent) => {
    if (e.pointerType === 'mouse') poke();
  });
  listen(root, 'focusin', () => poke());
  listen(root, 'mouseleave', () => {
    if (core.getState().status === 'playing' && !menuFor) root.classList.add('asx-idle');
  });

  listen(bigPlay, 'click', () => togglePlay());
  listen(playBtn, 'click', () => togglePlay());
  listen(errRetry, 'click', () => safe(() => core.retry()));
  listen(muteBtn, 'click', () => perform({ type: 'toggleMute' }));
  listen(volume, 'input', () => {
    const v = Number(volume.value) / 100;
    core.setVolume(v);
    core.setMuted(v === 0);
  });
  listen(liveBtn, 'click', () => {
    core.goLive();
    announce('Jumped to live');
  });
  listen(pipBtn, 'click', () => safe(() => core.togglePictureInPicture()));
  listen(theaterBtn, 'click', () => perform({ type: 'toggleTheater' }));
  listen(fsBtn, 'click', () => toggleFullscreen());

  // seek bar
  const seekRange = (s: PlayerState): [number, number] | null => {
    if (s.streamType === 'live') return s.live && s.live.dvr && s.live.dvrWindow > 1 ? [s.live.seekableStart, s.live.seekableEnd] : null;
    if (s.streamType === 'vod' && Number.isFinite(s.duration) && s.duration > 0) return [0, s.duration];
    return null;
  };
  const valueToTime = (val: number, s: PlayerState) => {
    const r = seekRange(s);
    return r ? r[0] + ((r[1] - r[0]) * val) / 1000 : 0;
  };
  const seekLabel = (t: number, s: PlayerState) =>
    s.streamType === 'live' && s.live ? `${formatTime(Math.max(0, s.live.seekableEnd - t))} behind live` : `${formatTime(t)} of ${formatTime(s.duration)}`;
  listen(seek, 'input', () => {
    dragging = true;
    seekWrap.classList.add('asx-dragging');
    const s = core.getState();
    const t = valueToTime(Number(seek.value), s);
    seekTip.textContent = s.streamType === 'live' && s.live ? `−${formatTime(s.live.seekableEnd - t)}` : formatTime(t);
    seekTip.style.left = `${Number(seek.value) / 10}%`;
    seek.style.setProperty('--asx-pct', `${Number(seek.value) / 10}%`);
  });
  listen(seek, 'change', () => {
    const s = core.getState();
    const t = valueToTime(Number(seek.value), s);
    core.seekTo(t);
    dragging = false;
    seekWrap.classList.remove('asx-dragging');
    seek.setAttribute('aria-valuetext', seekLabel(t, s));
    poke();
  });
  listen(seek, 'pointerup', () => {
    dragging = false;
    seekWrap.classList.remove('asx-dragging');
  });
  listen(seekWrap, 'pointermove', (e: PointerEvent) => {
    if (dragging) return;
    const s = core.getState();
    const r = seekRange(s);
    if (!r) return;
    const rect = seek.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / Math.max(1, rect.width)));
    const t = r[0] + (r[1] - r[0]) * frac;
    seekTip.textContent = s.streamType === 'live' ? `−${formatTime(r[1] - t)}` : formatTime(t);
    seekTip.style.left = `${frac * 100}%`;
  });

  // menus
  type Item = { label: string; checked: boolean; onSelect: () => void };
  const openMenu = (owner: HTMLButtonElement, heading: string, items: Item[], note?: string) => {
    if (menuFor === owner) return closeMenu(true);
    menu.replaceChildren();
    const h = el('div', 'asx-menu-title');
    h.textContent = heading;
    h.id = `asx-menu-h-${Math.random().toString(36).slice(2, 8)}`;
    menu.setAttribute('aria-labelledby', h.id);
    menu.append(h);
    for (const it of items) {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'asx-menu-item';
      b.setAttribute('role', 'menuitemradio');
      b.setAttribute('aria-checked', String(it.checked));
      b.textContent = it.label;
      b.addEventListener('click', () => {
        it.onSelect();
        closeMenu(true);
        announce(`${heading}: ${it.label}`);
      });
      menu.append(b);
    }
    if (note) {
      const n = el('div', 'asx-menu-note');
      n.textContent = note;
      menu.append(n);
    }
    menu.classList.remove('asx-hidden');
    owner.setAttribute('aria-expanded', 'true');
    menuFor = owner;
    poke();
    const first = (menu.querySelector('[aria-checked="true"]') ?? menu.querySelector('.asx-menu-item')) as HTMLElement | null;
    first?.focus();
  };
  const closeMenu = (restoreFocus: boolean) => {
    if (!menuFor) return;
    const owner = menuFor;
    menuFor = null;
    menu.classList.add('asx-hidden');
    owner.setAttribute('aria-expanded', 'false');
    if (restoreFocus) owner.focus();
    poke();
  };
  listen(menu, 'keydown', (e: KeyboardEvent) => {
    const items = [...menu.querySelectorAll<HTMLElement>('.asx-menu-item')];
    const i = items.indexOf(doc.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu(true);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'Tab') {
      closeMenu(false);
    }
  });
  listen(doc, 'pointerdown', (e: PointerEvent) => {
    if (menuFor && !menu.contains(e.target as Node) && e.target !== menuFor && !menuFor.contains(e.target as Node)) closeMenu(false);
  });

  listen(ccBtn, 'click', () => {
    const s = core.getState();
    openMenu(ccBtn, 'Subtitles', [
      { label: 'Off', checked: !s.textTracks.some((t) => t.active), onSelect: () => core.setTextTrack(null) },
      ...s.textTracks.map((t) => ({ label: t.label, checked: t.active, onSelect: () => core.setTextTrack(t.id) })),
    ]);
  });
  listen(audioBtn, 'click', () => {
    const s = core.getState();
    openMenu(audioBtn, 'Audio', s.audioTracks.map((t) => ({ label: t.label, checked: t.active, onSelect: () => core.setAudioTrack(t.id) })));
  });
  listen(qualityBtn, 'click', () => {
    const s = core.getState();
    openMenu(
      qualityBtn,
      'Quality',
      [
        { label: 'Auto', checked: s.qualitySelection === 'auto', onSelect: () => core.setQuality('auto') },
        ...s.qualityLevels.map((q) => ({ label: q.label, checked: s.qualitySelection === q.id, onSelect: () => core.setQuality(q.id) })),
      ],
      s.qualityLevels.length === 0 ? 'This engine lets the browser choose the quality automatically.' : undefined,
    );
  });
  listen(rateBtn, 'click', () => {
    const s = core.getState();
    openMenu(rateBtn, 'Speed', RATES.map((r) => ({ label: r === 1 ? 'Normal' : `${r}×`, checked: s.playbackRate === r, onSelect: () => core.setPlaybackRate(r) })));
  });

  // ---------------------------------------------------------------- render
  const render = (s: PlayerState) => {
    const isLive = s.streamType === 'live';
    const playing = !s.paused && !s.ended;
    setIcon(playBtn, playing ? 'pause' : s.ended ? 'replay' : 'play');
    playBtn.setAttribute('aria-label', playing ? 'Pause' : s.ended ? 'Replay' : 'Play');
    setIcon(muteBtn, s.muted || s.volume === 0 ? 'muted' : 'volume');
    muteBtn.setAttribute('aria-label', s.muted ? 'Unmute' : 'Mute');
    const volPct = s.muted ? 0 : Math.round(s.volume * 100);
    if (Number(volume.value) !== volPct) volume.value = String(volPct);
    volume.style.setProperty('--asx-pct', `${volPct}%`);
    volume.style.setProperty('--asx-buf', `${volPct}%`);
    volume.setAttribute('aria-valuetext', `${volPct}%`);
    volume.hidden = !config.controls.show.volume;
    muteBtn.hidden = !config.controls.show.volume;

    const showSpinner = s.status === 'loading' || s.status === 'buffering' || s.status === 'recovering';
    spinner.classList.toggle('asx-hidden', !showSpinner || s.status === 'error');
    spinner.setAttribute('aria-label', s.status === 'recovering' ? `Reconnecting (attempt ${s.retryAttempt})` : 'Loading');
    const showBig = !playing && !showSpinner && s.status !== 'error' && s.status !== 'idle' && !!s.source;
    bigPlay.classList.toggle('asx-hidden', !showBig);
    setIcon(bigPlay, s.ended ? 'replay' : 'play');
    bigPlay.setAttribute('aria-label', s.ended ? 'Replay' : 'Play');

    if (s.status === 'error' && s.error) {
      errorBox.classList.remove('asx-hidden');
      errTitle.textContent = s.error.message;
      errCode.textContent = s.error.code + (s.error.httpStatus ? ` · HTTP ${s.error.httpStatus}` : '');
      // Retrying cannot fix these; the host page has to supply a different/fresh URL.
      errRetry.hidden = ['SOURCE_NOT_ALLOWED', 'INVALID_SOURCE', 'EXPIRED_URL'].includes(s.error.code);
    } else {
      errorBox.classList.add('asx-hidden');
    }

    // seek bar
    const r = seekRange(s);
    seekWrap.classList.toggle('asx-hidden', !r);
    if (r && !dragging) {
      const span = Math.max(0.001, r[1] - r[0]);
      const pct = Math.min(100, Math.max(0, ((s.currentTime - r[0]) / span) * 100));
      const buf = Math.min(100, Math.max(pct, ((s.bufferedEnd - r[0]) / span) * 100));
      seek.value = String(Math.round(pct * 10));
      seek.style.setProperty('--asx-pct', `${pct}%`);
      seek.style.setProperty('--asx-buf', `${buf}%`);
      seek.setAttribute('aria-valuetext', seekLabel(s.currentTime, s));
    }

    // time / live
    time.classList.toggle('asx-hidden', isLive || !s.source);
    if (!isLive) time.textContent = `${formatTime(s.currentTime)} / ${formatTime(s.duration)}`;
    liveBtn.classList.toggle('asx-hidden', !isLive);
    latency.classList.toggle('asx-hidden', !isLive || !s.live || s.live.atLiveEdge);
    if (isLive && s.live) {
      liveBtn.classList.toggle('asx-at-edge', s.live.atLiveEdge);
      liveBtn.setAttribute('aria-label', s.live.atLiveEdge ? 'Live, at live edge' : 'Go to live edge');
      latency.textContent = `${s.live.estimated ? '≈' : ''}−${formatTime(s.live.latency)}`;
    }

    const show = config.controls.show;
    ccBtn.hidden = !show.captions || s.textTracks.length === 0;
    ccBtn.setAttribute('aria-pressed', String(s.textTracks.some((t) => t.active)));
    audioBtn.hidden = !show.audioTracks || s.audioTracks.length < 2;
    qualityBtn.hidden = !show.quality || !s.source;
    rateBtn.hidden = !show.playbackRate || s.streamType !== 'vod';
    rateBtn.textContent = `${s.playbackRate}×`;
    pipBtn.hidden = !show.pip || !caps.pictureInPicture;
    pipBtn.setAttribute('aria-pressed', String(s.pictureInPicture));
    theaterBtn.hidden = !show.theater;
    theaterBtn.setAttribute('aria-pressed', String(s.theater));
    fsBtn.hidden = !show.fullscreen || !(caps.fullscreen || caps.videoElementFullscreen);
    setIcon(fsBtn, s.fullscreen ? 'exitFullscreen' : 'fullscreen');
    fsBtn.setAttribute('aria-label', s.fullscreen ? 'Exit fullscreen' : 'Fullscreen');
    root.classList.toggle('asx-theater', s.theater);
    controls.classList.toggle('asx-hidden', !s.source || s.status === 'error');
    if (s.status !== 'playing') {
      root.classList.remove('asx-idle');
    }
  };

  const applyConfig = (c: PlayerConfig) => {
    config = c;
    root.style.setProperty('--asx-accent', c.branding.accentColor);
    title.textContent = c.branding.title ?? '';
    top.classList.toggle('asx-hidden', !c.branding.title && !c.branding.logoUrl);
    if (c.branding.logoUrl) {
      logo.src = c.branding.logoUrl;
      logo.alt = c.branding.logoAlt ?? '';
      logo.hidden = false;
    } else {
      logo.removeAttribute('src');
      logo.hidden = true;
    }
    ui.classList.toggle('asx-hidden', !c.controls.enabled);
    render(core.getState());
  };

  let lastStatus = core.getState().status;
  const offState = core.on('statechange', ({ state }) => {
    render(state);
    if (state.status !== lastStatus) {
      if (state.status === 'playing' || lastStatus === 'playing') poke();
      if (state.status === 'error' && state.error) announce(state.error.message);
      if (state.status === 'recovering') announce('Reconnecting');
      lastStatus = state.status;
    }
  });
  disposers.push(offState);

  let announceTimer: ReturnType<typeof setTimeout> | null = null;
  disposers.push(
    core.on('announcement', ({ text, level, durationMs }) => {
      announceBox.textContent = text;
      announceBox.classList.toggle('asx-warning', level === 'warning');
      announceBox.classList.remove('asx-hidden');
      if (announceTimer) clearTimeout(announceTimer);
      announceTimer = later(() => announceBox.classList.add('asx-hidden'), durationMs);
    }),
  );

  applyConfig(config);

  return {
    element: ui,
    poke,
    update: applyConfig,
    destroy() {
      for (const d of disposers.splice(0)) d();
      for (const t of timers) clearTimeout(t);
      timers.clear();
      if (idleTimer) clearTimeout(idleTimer);
      ui.remove();
      root.classList.remove('asx-player', 'asx-idle', 'asx-theater');
    },
  };

  // ---------------------------------------------------------------- helpers
  function el(tag: string, cls: string): HTMLElement {
    const n = doc.createElement(tag);
    n.className = cls;
    return n;
  }
  function btn(cls: string, label: string, ic?: IconName): HTMLButtonElement {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.setAttribute('aria-label', label);
    b.title = label;
    if (ic) setIcon(b, ic);
    return b;
  }
  function setIcon(b: HTMLElement, name: IconName) {
    if (b.dataset.icon === name) return;
    b.dataset.icon = name;
    b.innerHTML = icon(name);
  }
  function range(cls: string, label: string, min: number, max: number, step: number): HTMLInputElement {
    const r = doc.createElement('input');
    r.type = 'range';
    r.className = cls;
    r.min = String(min);
    r.max = String(max);
    r.step = String(step);
    r.value = '0';
    r.setAttribute('aria-label', label);
    return r;
  }
}
