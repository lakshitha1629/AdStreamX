import { forwardRef, useEffect, useImperativeHandle, useRef, type CSSProperties, type ForwardedRef } from 'react';
import type { MediaSourceConfig, PlayerConfigInput, PlayerErrorInfo, PlayerEventMap, PlayerState } from '@adstreamx/shared-types';
import { AdStreamX, type AdStreamXPlayer as Player, type CreateOptions, type PlayerPlugin } from '@adstreamx/player-sdk';

type Handlers = { [K in keyof PlayerEventMap]?: (payload: PlayerEventMap[K]) => void };

export interface AdStreamXPlayerProps {
  /** Media source. Changing it (by value) calls setSource on the existing player. */
  source?: MediaSourceConfig;
  fallbackSources?: MediaSourceConfig[];
  /** Player config. Changing it (by value) calls updateConfig; source fields are taken from `source`. */
  config?: Omit<PlayerConfigInput, 'source' | 'fallbackSources'>;
  /** Creation-only options (engines, command verifier, analytics transport). */
  options?: Omit<CreateOptions, 'plugins'>;
  /** Plugins registered once at creation. */
  plugins?: PlayerPlugin[];
  className?: string;
  style?: CSSProperties;
  onReady?: (player: Player) => void;
  onError?: (error: PlayerErrorInfo) => void;
  onStateChange?: (state: PlayerState) => void;
  /** Any player event by name, e.g. { ended: () => …, qualitychange: (e) => … }. */
  events?: Handlers;
}

export interface AdStreamXPlayerHandle {
  /** The live player instance (null before mount / after unmount). */
  readonly player: Player | null;
}

/**
 * React wrapper. One player per mounted component (StrictMode's mount→unmount→mount
 * creates and fully destroys the first instance). Handler props are read through a ref, so
 * changing callbacks never recreates the player.
 */
export const AdStreamXPlayer = forwardRef<AdStreamXPlayerHandle, AdStreamXPlayerProps>(function AdStreamXPlayer(
  props: AdStreamXPlayerProps,
  ref: ForwardedRef<AdStreamXPlayerHandle>,
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<Player | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const appliedSource = useRef<string>('');
  const appliedConfig = useRef<string>('');

  useImperativeHandle(ref, () => ({
    get player() {
      return playerRef.current;
    },
  }), []);

  // create / destroy
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const p0 = propsRef.current;
    const player = AdStreamX.create(
      host,
      { ...(p0.config ?? {}), source: p0.source, fallbackSources: p0.fallbackSources ?? [] },
      { ...(p0.options ?? {}), plugins: p0.plugins },
    );
    playerRef.current = player;
    appliedSource.current = key(p0.source, p0.fallbackSources);
    appliedConfig.current = key(p0.config);

    const offs: (() => void)[] = [];
    offs.push(player.on('error', (e) => propsRef.current.onError?.(e)));
    offs.push(player.on('statechange', ({ state }) => propsRef.current.onStateChange?.(state)));
    // Subscribe to every event once; dispatch to whatever handler is current.
    for (const name of EVENT_NAMES) {
      offs.push(
        player.on(name, (payload: unknown) => {
          const fn = propsRef.current.events?.[name] as ((p: unknown) => void) | undefined;
          fn?.(payload);
        }),
      );
    }
    let cancelled = false;
    player
      .ready()
      .then(() => {
        if (!cancelled) propsRef.current.onReady?.(player);
      })
      .catch(() => undefined); // surfaced through onError
    return () => {
      cancelled = true;
      offs.forEach((off) => off());
      player.destroy();
      if (playerRef.current === player) playerRef.current = null;
    };
  }, []);

  // source changes (compared by value, so inline object literals are fine)
  const sourceKey = key(props.source, props.fallbackSources);
  useEffect(() => {
    const player = playerRef.current;
    if (!player || sourceKey === appliedSource.current) return;
    appliedSource.current = sourceKey;
    if (props.source) void player.setSource(props.source, props.fallbackSources ?? []).catch(() => undefined);
    else player.unload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey]);

  // config changes
  const configKey = key(props.config);
  useEffect(() => {
    const player = playerRef.current;
    if (!player || configKey === appliedConfig.current) return;
    appliedConfig.current = configKey;
    try {
      player.updateConfig(props.config ?? {});
    } catch (e) {
      console.error('[AdStreamX] invalid config update', e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configKey]);

  return <div ref={hostRef} className={props.className} style={props.style} data-adstreamx-react="" />;
});

function key(...v: unknown[]): string {
  return JSON.stringify(v);
}

const EVENT_NAMES: (keyof PlayerEventMap)[] = [
  'ready', 'loadstart', 'loadedmetadata', 'play', 'playing', 'pause', 'ended', 'seeking', 'seeked', 'timeupdate',
  'bufferingstart', 'bufferingend', 'volumechange', 'ratechange', 'qualitychange', 'qualitylevels', 'texttrackchange',
  'audiotrackchange', 'liveedgereached', 'livelatencychange', 'fullscreenchange', 'pictureinpicturechange', 'theaterchange',
  'autoplayblocked', 'retry', 'fallback', 'sourcechange', 'configupdated',
  'adbreakstart', 'adbreakend', 'adrequest', 'adloaded', 'adstarted', 'adquartile', 'adcompleted', 'adskipped', 'aderror',
  'overlayshown', 'overlayclosed', 'overlayclicked', 'polldisplayed', 'voteaccepted', 'pollresultsupdated',
  'commandreceived', 'commandapplied', 'commandrejected', 'announcement', 'analyticsflush', 'pluginregistered',
];
