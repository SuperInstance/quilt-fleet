/**
 * ════════════════════════════════════════════════════════════════════════════
 *  tiers/codespace.ts — Tier 3: dev container / codespace
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  Codespaces are *ephemeral* Quilt instances used for development,
 *  CI, and integration tests. They burst to 2-32 vCPU and 8-64 GB
 *  RAM but are torn down at the end of a session.
 *
 *  Default transport: HTTP. Codespaces usually run a small
 *  Quilt SDK server on a random port, accessible via a tunnel.
 *
 *  STUB: the actual HTTP probe is implemented; subscribe yields
 *  from a polling loop (because codespaces do not stay online long
 *  enough for a long-lived WebSocket).
 *  ──────────────────────────────────────────────────────────────────────────
 */

import { Tier, TierName } from '../types';
import type { TierAdapter, TierProfile } from './index';

export const codespaceProfile: TierProfile = {
  tier: Tier.Codespace,
  name: 'codespace' as TierName,
  defaultTransport: 'http',
  defaultCapabilities: {
    ram_mb: 16_384,
    cpu_cores: 8,
  },
  defaultHeartbeatMs: 30_000,
  recommendedCells: [
    'build.status',
    'test.runner',
    'e2e.result',
    'ci.artifact',
  ],
  description: 'Tier 3 ephemeral: 2-32 vCPU burst, 8-64 GB RAM, short-lived.',
};

export const codespaceAdapter: TierAdapter = {
  async probe(endpoint) {
    const t0 = Date.now();
    try {
      const res = await fetch(endpoint.replace(/\/$/, '') + '/health', {
        signal: AbortSignal.timeout(1_500),
      });
      return { ok: res.ok, latencyMs: Date.now() - t0 };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - t0, details: (e as Error).message };
    }
  },

  async *subscribe(endpoint, sheet, cell) {
    // Poll the HTTP endpoint every 1 s.
    const url = endpoint.replace(/\/$/, '') + `/cell/${sheet}#${cell}`;
    let lastVersion = 0;
    while (true) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(1_500) });
        if (res.ok) {
          const body = await res.json();
          if (typeof body.version === 'number' && body.version > lastVersion) {
            lastVersion = body.version;
            yield { value: body.value, version: body.version };
          }
        }
      } catch { /* ignore */ }
      await new Promise(r => setTimeout(r, 1_000).unref?.());
    }
  },

  buildRegistration(name, endpoint, overrides = {}) {
    return {
      tier:       Tier.Codespace,
      name,
      endpoint,
      transport:  'http',
      capabilities: { ...codespaceProfile.defaultCapabilities, ...overrides },
    };
  },
};
