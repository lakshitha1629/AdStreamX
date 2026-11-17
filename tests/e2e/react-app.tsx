// Test app for the React wrapper (built into tests/e2e/pages/build/react-app.js).
// Runs under <StrictMode> in a development build so the mount→unmount→mount cycle is real.
import { StrictMode, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { MediaSourceConfig } from '@adstreamx/shared-types';
import { AdStreamXPlayer, type AdStreamXPlayerHandle, type AdStreamXPlayerProps } from '@adstreamx/react-player';
import { activeCount } from '@adstreamx/player-sdk';

interface TestApi {
  set(p: Partial<AdStreamXPlayerProps> & { mounted?: boolean; handlerTag?: string }): void;
  log: string[];
  handle(): AdStreamXPlayerHandle | null;
}
const w = window as unknown as { __react: TestApi; AdStreamXActive?: () => number };
const log: string[] = [];
w.AdStreamXActive = activeCount; // live player instances in this bundle (leak checks)

function App() {
  const ref = useRef<AdStreamXPlayerHandle | null>(null);
  const [mounted, setMounted] = useState(true);
  const [source, setSource] = useState<MediaSourceConfig | undefined>({ src: '/media/mp4/short.mp4' });
  const [config, setConfig] = useState<AdStreamXPlayerProps['config']>({ muted: true, branding: { accentColor: '#22d3ee' } });
  const [tag, setTag] = useState('A');
  w.__react = {
    log,
    handle: () => ref.current,
    set(p) {
      if (p.mounted !== undefined) setMounted(p.mounted);
      if ('source' in p) setSource(p.source);
      if (p.config) setConfig(p.config);
      if (p.handlerTag) setTag(p.handlerTag);
    },
  };
  return mounted ? (
    <AdStreamXPlayer
      ref={ref}
      source={source}
      config={config}
      style={{ width: '640px' }}
      onReady={() => log.push(`ready:${tag}`)}
      onError={(e) => log.push(`error:${e.code}`)}
      events={{ ended: () => log.push(`ended:${tag}`), playing: () => log.push(`playing:${tag}`), loadstart: () => log.push(`loadstart:${tag}`) }}
    />
  ) : (
    <p id="unmounted">unmounted</p>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
