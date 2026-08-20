/**
 * ════════════════════════════════════════════════════════════════════════════
 *  tiers/cloudflare.ts — Tier 4: Cloudflare Workers + Durable Objects
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  Tier 4 is the global edge. Cloudflare Workers run in anycast
 *  POPs around the world with a 30 s CPU budget per request and
 *  128 MB of memory. Durable Objects provide a single-writer
 *  abstraction for stateful cells.
 *
 *  Default transport: HTTP (Workers) and WebSocket (Durable Objects).
 *  Workers are typically fronted by an HTTPS endpoint; the adapter
 *  uses fetch() under the hood.
 *  ──────────────────────────────────────────────────────────────────────────
 */

import { Tier, TierName } from '../types';
import type { TierAdapter, TierProfile } from './index';

export const cloudflareProfile: TierProfile = {
  tier: Tier.Cloudflare,
  name: 'cloudflare' as TierName,
  defaultTransport: 'http',
  defaultCapabilities: {
    ram_mb: 128,
    cpu_cores: 1,
    storage_bytes: 0,
  },
  defaultHeartbeatMs: 10_000,
  recommendedCells: [
    'edge.session',
    'edge.geo',
    'cdn.cacheKey',
    'vector.embedding',
    'prompt.cache',
  ],
  description: 'Tier 4 edge: 30 s CPU, 128 MB mem, anycast POPs.',
};

export const cloudflareAdapter: TierAdapter = {
  async probe(endpoint) {
    const t0 = Date.now();
    try {
      // Cloudflare Workers do not need a /health endpoint; we just
      // GET the root and see if the Worker is alive.
      const res = await fetch(endpoint, {
        method: 'GET',
        signal: AbortSignal.timeout(1_500),
      });
      return { ok: res.status < 500, latencyMs: Date.now() - t0 };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - t0, details: (e as Error).message };
    }
  },

  async *subscribe(endpoint, sheet, cell) {
    // Cloudflare does not support long-lived WebSockets from Workers
    // without Durable Objects. We poll the `/sse` endpoint (Server-
    // Sent Events) for updates.
    const url = endpoint.replace(/\/$/, '') + `/sse?sheet=${encodeURIComponent(sheet)}&cell=${encodeURIComponent(cell)}`;
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    } catch {
      return;
    }
    if (!res.ok || !res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let version = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = chunk.split('\n').find(l => l.startsWith('data: '));
          if (line) {
            try {
              const m = JSON.parse(line.slice(6));
              version = m.version ?? version + 1;
              yield { value: m.value, version };
            } catch { /* ignore parse */ }
          }
        }
      }
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
  },

  buildRegistration(name, endpoint, overrides = {}) {
    return {
      tier:       Tier.Cloudflare,
      name,
      endpoint,
      transport:  'http',
      capabilities: { ...cloudflareProfile.defaultCapabilities, ...overrides },
    };
  },
};
