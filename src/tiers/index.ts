/**
 * ════════════════════════════════════════════════════════════════════════════
 *  tiers/index.ts — the tier adapter registry
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  Every tier in the Quilt fleet has different hardware constraints,
 *  default transports, and recommended cells. The `tiers/` directory
 *  holds one file per tier with a `TierAdapter` factory and a
 *  default {@link TierProfile}.
 *
 *  This index just re-exports them.
 *  ──────────────────────────────────────────────────────────────────────────
 */

export * from './esp32';
export * from './jetson';
export * from './codespace';
export * from './cloudflare';
export * from './server';

import type { Tier, TierName } from '../types';
import { esp32Adapter, esp32Profile }    from './esp32';
import { jetsonAdapter, jetsonProfile }  from './jetson';
import { codespaceAdapter, codespaceProfile } from './codespace';
import { cloudflareAdapter, cloudflareProfile } from './cloudflare';
import { serverAdapter, serverProfile }  from './server';

/** Default capabilities per tier. */
export interface TierProfile {
  /** Tier number. */
  tier: Tier;
  /** Tier name. */
  name: TierName;
  /** Default transport. */
  defaultTransport: 'http' | 'ws' | 'mqtt' | 'nats' | 'grpc';
  /** Default capabilities. */
  defaultCapabilities: Record<string, unknown>;
  /** Default polling / heartbeat interval (ms). */
  defaultHeartbeatMs: number;
  /** Default cells this tier is expected to own. */
  recommendedCells: string[];
  /** Human-readable description. */
  description: string;
}

export const TIER_PROFILES: Record<TierName, TierProfile> = {
  esp32:      esp32Profile,
  jetson:     jetsonProfile,
  codespace:  codespaceProfile,
  cloudflare: cloudflareProfile,
  server:     serverProfile,
};

/** Adapter interface — factories that know how to talk to a tier. */
export interface TierAdapter {
  /** Probe the instance. */
  probe(endpoint: string): Promise<{ ok: boolean; latencyMs: number; details?: unknown }>;
  /** Subscribe to a cell on this tier. */
  subscribe(endpoint: string, sheet: string, cell: string): AsyncIterable<{ value: unknown; version: number }>;
  /** Build a default registration record for an instance. */
  buildRegistration(name: string, endpoint: string, overrides?: Record<string, unknown>): {
    tier: Tier;
    name: string;
    endpoint: string;
    transport: TierProfile['defaultTransport'];
    capabilities: Record<string, unknown>;
  };
}

export const TIER_ADAPTERS: Record<TierName, TierAdapter> = {
  esp32:      esp32Adapter,
  jetson:     jetsonAdapter,
  codespace:  codespaceAdapter,
  cloudflare: cloudflareAdapter,
  server:     serverAdapter,
};

export function adapterFor(tier: TierName): TierAdapter {
  return TIER_ADAPTERS[tier] ?? serverAdapter;
}
