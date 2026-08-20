/**
 * ════════════════════════════════════════════════════════════════════════════
 *  tiers/server.ts — Tier 5: Server (datacenter)
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  Tier 5 is the canonical system of record. Server-tier Quilt
 *  instances run in a datacenter with 64-512 GB RAM, NVMe RAID,
 *  and a fat network pipe. They host:
 *
 *   • The authoritative copy of every critical cell
 *   • Postgres / Kafka / Vault integrations
 *   • Quorum coordination
 *   • Long-term archival
 *
 *  Default transport: gRPC (because it has the best semantics for
 *  streaming cells and strong typing for cell values).
 *  ──────────────────────────────────────────────────────────────────────────
 */

import { Tier, TierName } from '../types';
import type { TierAdapter, TierProfile } from './index';

export const serverProfile: TierProfile = {
  tier: Tier.Server,
  name: 'server' as TierName,
  defaultTransport: 'grpc',
  defaultCapabilities: {
    ram_mb: 65_536,
    cpu_cores: 32,
    storage_bytes: 1024 * 1024 * 1024 * 1024,
    tpm: true,
  },
  defaultHeartbeatMs: 5_000,
  recommendedCells: [
    'vault.lock',
    'vault.token',
    'auth.session',
    'auth.user',
    'safety.eStop',
    'billing.invoice',
    'ledger.*',
  ],
  description: 'Tier 5 server: 64-512 GB RAM, NVMe, datacenter fabric.',
};

export const serverAdapter: TierAdapter = {
  async probe(endpoint) {
    const t0 = Date.now();
    try {
      // gRPC health-check is on `/grpc.health.v1.Health/Check`. We
      // try the standard HTTP/1.1 `/health` first because it is
      // what most reverse proxies expose.
      const url = endpoint.replace(/\/$/, '') + '/health';
      const res = await fetch(url, { signal: AbortSignal.timeout(1_500) });
      return { ok: res.ok, latencyMs: Date.now() - t0 };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - t0, details: (e as Error).message };
    }
  },

  async *subscribe(endpoint, sheet, cell) {
    // A real implementation would open a gRPC client-streaming RPC
    // `Subscribe(sheet, cell)`. We STUB with an HTTP poll.
    const url = endpoint.replace(/\/$/, '') + `/grpc-bridge/cell/${encodeURIComponent(sheet)}#${encodeURIComponent(cell)}`;
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
      await new Promise(r => setTimeout(r, 500).unref?.());
    }
  },

  buildRegistration(name, endpoint, overrides = {}) {
    return {
      tier:       Tier.Server,
      name,
      endpoint,
      transport:  'grpc',
      capabilities: { ...serverProfile.defaultCapabilities, ...overrides },
    };
  },
};
