/**
 * ════════════════════════════════════════════════════════════════════════════
 *  transports/http.ts — HTTP / REST transport
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  The default transport for server, codespace, and cloudflare tiers.
 *  Uses long-polling because it works through every HTTP proxy on
 *  the planet.
 *
 *  URL contract (proposed)
 *  ───────────────────────
 *   GET  /cell/<sheet>#<cell>            read
 *   PUT  /cell/<sheet>#<cell>            write   {value, version}
 *   GET  /cell/<sheet>#<cell>?wait=1     long-poll for new version
 *
 *  The adapter polls every 1 s and returns the first newer version.
 *  A real implementation would use Server-Sent Events, but SSE is
 *  often blocked by middleboxes.
 *  ──────────────────────────────────────────────────────────────────────────
 */

import type { TransportAdapter } from './index';
import type { Instance } from '../registry';

export const httpTransport: TransportAdapter = {
  subscribe(instance, sheet, cell) {
    const url = `${instance.endpoint.replace(/\/$/, '')}/cell/${encodeURIComponent(sheet)}#${encodeURIComponent(cell)}`;
    let lastVersion = 0;
    let cancelled = false;

    const it: AsyncIterable<{ value: unknown; version: number }> & { close(): void } = {
      [Symbol.asyncIterator]() { return this; },
      async next() {
        if (cancelled) return { value: undefined as any, done: true };
        while (!cancelled) {
          try {
            const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
            if (res.ok) {
              const body = await res.json();
              if (typeof body.version === 'number' && body.version > lastVersion) {
                lastVersion = body.version;
                return { value: { value: body.value, version: body.version }, done: false };
              }
            }
          } catch { /* ignore */ }
          await new Promise(r => setTimeout(r, 1_000).unref?.());
        }
        return { value: undefined as any, done: true };
      },
      close() { cancelled = true; },
    };
    return it;
  },

  async read(instance, sheet, cell) {
    const url = `${instance.endpoint.replace(/\/$/, '')}/cell/${encodeURIComponent(sheet)}#${encodeURIComponent(cell)}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1_500) });
      if (!res.ok) return null;
      const body = await res.json();
      return typeof body.version === 'number'
        ? { value: body.value, version: body.version }
        : null;
    } catch {
      return null;
    }
  },

  async write(instance, sheet, cell, value, version) {
    const url = `${instance.endpoint.replace(/\/$/, '')}/cell/${encodeURIComponent(sheet)}#${encodeURIComponent(cell)}`;
    try {
      const res = await fetch(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value, version }),
        signal: AbortSignal.timeout(1_500),
      });
      return res.ok;
    } catch {
      return false;
    }
  },
};
