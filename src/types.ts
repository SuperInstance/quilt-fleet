/**
 * ════════════════════════════════════════════════════════════════════════════
 *  types.ts — shared type definitions for the Quilt fleet layer
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  This module collects every shared interface, enum, and branded type
 *  used across the fleet. It deliberately has **zero runtime cost** —
 *  every export is erased by the TypeScript compiler.
 *
 *  Design rules
 *  ────────────
 *   • All identifiers that flow on the wire are ULID strings (26 chars).
 *   • All timestamps are epoch milliseconds (number).
 *   • All sizes are explicit (`*_ms`, `*_mb`, `*_bytes`).
 *   • All enums are frozen `as const` objects so they survive `isolatedModules`.
 *   • All interfaces are structural; no classes with hidden state.
 *  ──────────────────────────────────────────────────────────────────────────
 */

/* ─── identifier brands ─────────────────────────────────────────────────── */

/** A 26-character ULID, e.g. `01JABCD...`. Branded so it can't be mixed
 *  with a plain string by accident. */
export type Ulid = string & { readonly __brand: 'Ulid' };

/** A region label (e.g. `us-east-1`). */
export type Region = string & { readonly __brand: 'Region' };

/** A zone within a region. */
export type Zone = string & { readonly __brand: 'Zone' };

/* ─── tiers ─────────────────────────────────────────────────────────────── */

/**
 * The five Quilt tiers, ordered from weakest (Tier 1 = ESP32) to
 * strongest (Tier 5 = Server). The numeric value is used for routing
 * preferences: the router prefers the *lowest* tier that satisfies the
 * cell's `tierPreference` (so reads stay at the edge).
 */
export const Tier = {
  /** Tier 1 — ESP32: 320 KB RAM, WiFi only, battery-powered. */
  Esp32:      1,
  /** Tier 2 — Jetson: 8-32 GB RAM, CUDA, edge inference. */
  Jetson:     2,
  /** Tier 3 — Codespace: 2-32 vCPU burst, ephemeral. */
  Codespace:  3,
  /** Tier 4 — Cloudflare: 30 s CPU, 128 MB, global anycast. */
  Cloudflare: 4,
  /** Tier 5 — Server: 64-512 GB RAM, NVMe, datacenter. */
  Server:     5,
} as const;

/** A tier value. */
export type Tier = (typeof Tier)[keyof typeof Tier];

/** String label for a tier (used in URIs and config). */
export type TierName = 'esp32' | 'jetson' | 'codespace' | 'cloudflare' | 'server';

export const TIER_NAMES: readonly TierName[] = [
  'esp32',
  'jetson',
  'codespace',
  'cloudflare',
  'server',
] as const;

export function tierToName(t: Tier): TierName {
  return TIER_NAMES[t - 1] ?? 'server';
}

export function nameToTier(n: TierName): Tier {
  return (TIER_NAMES.indexOf(n) + 1) as Tier;
}

/* ─── cell URIs ─────────────────────────────────────────────────────────── */

/**
 * A `quilt://` URI. We do not parse with a regex at runtime; the
 * shape is documented here for the implementer.
 *
 *   quilt://[instance]/[sheet]#[cell]
 *                  ─┬─  ──┬── ─┬─
 *                    │     │    └─ cell name
 *                    │     └────── sheet name
 *                    └──────────── instance name
 */
export interface CellRef {
  /** The full URI as a string. */
  uri: string;
  /** Owning instance, e.g. `jetson-orin-1`. */
  instance: string;
  /** Sheet name, e.g. `sensors`. */
  sheet: string;
  /** Cell name, e.g. `temperature`. */
  cell: string;
}

/** Parse a `quilt://` URI into a {@link CellRef}. */
export function parseQuiltUri(uri: string): CellRef {
  // quilt://[instance]/[sheet]#[cell]
  const m = /^quilt:\/\/([^\/]+)\/([^#]+)#(.+)$/.exec(uri);
  if (!m) {
    throw new Error(`invalid quilt URI: ${uri}`);
  }
  return { uri, instance: m[1]!, sheet: m[2]!, cell: m[3]! };
}

/** Build a `quilt://` URI from its parts. */
export function buildQuiltUri(
  instance: string,
  sheet: string,
  cell: string,
): string {
  return `quilt://${instance}/${sheet}#${cell}`;
}

/* ─── capability flags ──────────────────────────────────────────────────── */

/** Hardware capabilities an instance may advertise. */
export interface Capabilities {
  /** RAM in megabytes. */
  ram_mb?: number;
  /** Number of CPU cores. */
  cpu_cores?: number;
  /** CUDA / GPU present. */
  cuda?: boolean;
  /** Metal (Apple Silicon) present. */
  metal?: boolean;
  /** WebGPU present. */
  webgpu?: boolean;
  /** Persistent storage bytes available for cells. */
  storage_bytes?: number;
  /** Whether the instance is on battery (and may go to sleep). */
  battery?: boolean;
  /** Whether the instance has a Trusted Platform Module. */
  tpm?: boolean;
  /** Free-form extras, e.g. `inference: 'cuda'`. */
  [k: string]: unknown;
}

/* ─── generic event envelope ───────────────────────────────────────────── */

export interface FleetEventBase {
  /** When the event happened (epoch ms). */
  ts: number;
  /** Fleet id. */
  fleet: string;
}
