import { expect, type Page } from 'playwright/test';
import type { PlayerConfigInput, PlayerState } from '@adstreamx/shared-types';

type Win = Window & {
  mk(slot: string, config: PlayerConfigInput, name?: string): unknown;
  __players: Record<string, { getState(): PlayerState } & Record<string, (...a: unknown[]) => unknown>>;
  __events: { p: string; t: string; e: Record<string, unknown>; at: number }[];
  AdStreamX: { activeCount(): number };
};

export async function openHarness(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/e2e/harness.html');
  await page.waitForFunction(() => !!(window as unknown as Win).AdStreamX);
  return errors;
}

export async function create(page: Page, config: PlayerConfigInput, name = 'a', slot = 'slot-a') {
  await page.evaluate(([c, n, s]) => void (window as unknown as Win).mk(s as string, c as PlayerConfigInput, n as string), [config, name, slot] as const);
}

export async function call<T = unknown>(page: Page, name: string, method: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    async ([n, m, a]) => {
      const p = (window as unknown as Win).__players[n as string]!;
      try {
        return { ok: true, v: await (p[m as string] as (...x: unknown[]) => unknown)(...(a as unknown[])) };
      } catch (e) {
        return { ok: false, v: { name: (e as Error).name, code: (e as { code?: string }).code, message: (e as Error).message } };
      }
    },
    [name, method, args] as const,
  ).then((r) => {
    if (!r.ok) throw Object.assign(new Error(`${method} failed: ${JSON.stringify(r.v)}`), r.v);
    return r.v as T;
  });
}

export async function tryCall(page: Page, name: string, method: string, ...args: unknown[]) {
  try {
    return { ok: true as const, value: await call(page, name, method, ...args) };
  } catch (e) {
    return { ok: false as const, error: e as { code?: string; name?: string } };
  }
}

export const state = (page: Page, name = 'a') => page.evaluate((n) => (window as unknown as Win).__players[n]!.getState(), name);

export const events = (page: Page, name?: string, type?: string) =>
  page.evaluate(([n, t]) => (window as unknown as Win).__events.filter((x) => (!n || x.p === n) && (!t || x.t === t)), [name, type] as const);

export async function waitState(page: Page, pred: string, name = 'a', timeout = 20_000) {
  // pred is a JS expression over `s` (the PlayerState), evaluated in the page.
  await page.waitForFunction(
    ([n, p]) => {
      const s = (window as unknown as Win).__players[n as string]?.getState();
      // eslint-disable-next-line no-new-func
      return !!s && new Function('s', `return (${p});`)(s);
    },
    [name, pred] as const,
    { timeout, polling: 100 },
  );
  return state(page, name);
}

/** Wait until playback time advances by `seconds` (proves frames are actually being played). */
export async function expectProgress(page: Page, seconds: number, name = 'a', timeout = 20_000) {
  const t0 = (await state(page, name)).currentTime;
  const s = await waitState(page, `s.currentTime >= ${t0 + seconds} && !s.paused`, name, timeout);
  expect(s.currentTime).toBeGreaterThanOrEqual(t0 + seconds);
  return s;
}

export async function addFault(page: Page, body: Record<string, unknown>) {
  const r = await page.request.post('/__faults', { data: body, headers: { 'x-adstreamx-test': '1' } });
  expect(r.status()).toBe(201);
}
export async function clearFaults(page: Page) {
  await page.request.delete('/__faults', { headers: { 'x-adstreamx-test': '1' } });
}

export async function playMuted(page: Page, name = 'a') {
  await call(page, name, 'setMuted', true);
  await call(page, name, 'play');
}
