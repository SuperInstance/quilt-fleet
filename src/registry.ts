/**
 * ════════════════════════════════════════════════════════════════════════════
 *  registry.ts — the instance registry
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  The registry is the **single source of truth** for which Quilt
 *  instances exist in the fleet, where they live, what they can do,
 *  and how healthy they are. Every other subsystem (discovery, health,
 *  routing, scaling) writes to the registry; everyone else reads from
 *  it.
 *
 *  Design goals
 *  ────────────
 *   • O(1) lookup by name **and** by id
 *   • O(N) iteration ordered by tier
 *   • O(log N) range queries ("all jetsons in us-east-1")
 *   • Event-driven: every mutation fires an event
 *   • Thread-safe under single-threaded Node.js semantics
 *
 *  Data structures
 *  ───────────────
 *   • `byId`     Map<id, Instance>            — primary
 *   • `byName`   Map<name, id>                — name → id
 *   • `byTier`   Map<tier, Set<id>>           — tier → ids
 *   • `byRegion` Map<region, Set<id>>         — region → ids
 *
 *  Concurrency
 *  ───────────
 *   The registry is *not* re-entrant by design. Callers should not
 *   mutate the registry from within an event handler unless they
 *   defer the mutation via `queueMicrotask`. This avoids the
 *   "registry mutation inside an iteration" footgun.
 *  ──────────────────────────────────────────────────────────────────────────
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  Capabilities,
  CellRef,
  Region,
  Tier,
  TierName,
  buildQuiltUri,
  nameToTier,
  parseQuiltUri,
  tierToName,
} from './types';

/* ─── the Instance record ──────────────────────────────────────────────── */

/**
 * A registered Quilt instance. Once registered, an instance is
 * addressable by `quilt://[name]/...` URIs.
 */
export interface Instance {
  /** ULID. Set by the registry on insert. */
  id: string;
  /** Tier number. See `types.ts` `Tier`. */
  tier: Tier;
  /** Tier name (mirrors `tier`). */
  tierName: TierName;
  /** Human-friendly name, e.g. `jetson-orin-1`. */
  name: string;
  /** Endpoint, e.g. `http://jetson.local:4040`. */
  endpoint: string;
  /** Transport hint. */
  transport: 'http' | 'ws' | 'mqtt' | 'nats' | 'grpc';
  /** Hardware / software capabilities. */
  capabilities: Capabilities;
  /** Current health status. */
  status: 'healthy' | 'degraded' | 'unreachable' | 'unknown';
  /** Epoch ms of the last received heartbeat. */
  lastHeartbeat: number;
  /** Rolling EWMA latency in ms. */
  latencyMs: number;
  /** Current load, 0.0 .. 1.0. */
  load: number;
  /** Optional region, e.g. `us-east-1`. */
  region?: Region;
  /** Optional zone within a region. */
  zone?: string;
  /** Epoch ms the instance first registered. */
  registeredAt: number;
  /** Free-form labels for filtering. */
  labels: Record<string, string>;
}

/** Patch used when re-registering or updating an instance. */
export type InstancePatch = Partial<Omit<Instance, 'id' | 'name' | 'registeredAt'>>;

/* ─── input shape for `register` ──────────────────────────────────────── */

export interface RegisterInput {
  tier: Tier | TierName;
  name: string;
  endpoint: string;
  transport?: Instance['transport'];
  capabilities?: Capabilities;
  region?: Region;
  zone?: string;
  labels?: Record<string, string>;
}

/* ─── query shape ──────────────────────────────────────────────────────── */

export interface RegistryQuery {
  tier?: Tier | TierName | Array<Tier | TierName>;
  status?: Instance['status'] | Array<Instance['status']>;
  region?: Region | Array<Region>;
  label?: Record<string, string>;
  /** Soft cap on results. */
  limit?: number;
}

/* ─── the registry itself ──────────────────────────────────────────────── */

export interface RegistryEvents {
  /** Emitted on insert. */
  add:    [Instance];
  /** Emitted on update. */
  update: [Instance, InstancePatch];
  /** Emitted on remove. */
  remove: [Instance];
  /** Emitted when an instance's status changes. */
  status: [Instance, Instance['status']];
}

/**
 * The instance registry. Use `new Registry()` to create one; pass it
 * to {@link FleetManager} for production wiring.
 *
 * @example
 * ```ts
 * const reg = new Registry();
 * const i = reg.register({ tier: 2, name: 'jetson-1', endpoint: 'http://...:4040' });
 * reg.list({ tier: 2, status: 'healthy' });
 * reg.unregister(i.id);
 * ```
 */
export class Registry extends EventEmitter<RegistryEvents> {
  /** id → Instance */
  private readonly byId = new Map<string, Instance>();
  /** name → id (case-insensitive) */
  private readonly byName = new Map<string, string>();
  /** tier → id set */
  private readonly byTier = new Map<Tier, Set<string>>();
  /** region → id set */
  private readonly byRegion = new Map<string, Set<string>>();

  /** Generate a stable ULID-shaped id. We don't depend on a ULID lib
   *  to keep the registry zero-dep. The format is `01H...` (10 chars
   *  time + 16 chars random) and is monotonic-ish. */
  private newId(): string {
    // Crockford base32 alphabet without I, L, O, U
    const A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    let t = Date.now();
    let ts = '';
    for (let i = 0; i < 10; i++) {
      ts = A[t % 32]! + ts;
      t = Math.floor(t / 32);
    }
    let r = '';
    for (let i = 0; i < 16; i++) {
      r += A[Math.floor(Math.random() * 32)];
    }
    return (ts + r).slice(0, 26);
  }

  /* ─── mutation ─────────────────────────────────────────────────────── */

  /**
   * Register a new instance, or update an existing one with the same
   * name. Returns the resulting {@link Instance} record.
   *
   * Throws on invalid input (bad name, missing endpoint, bad tier).
   */
  register(input: RegisterInput): Instance {
    if (!input.name || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.name)) {
      throw new Error(
        `invalid instance name: ${JSON.stringify(input.name)} ` +
        `(must match ^[a-z0-9][a-z0-9-]{0,62}$)`,
      );
    }
    if (!input.endpoint || !/^[a-z]+:\/\//.test(input.endpoint)) {
      throw new Error(
        `invalid endpoint: ${JSON.stringify(input.endpoint)} ` +
        `(must be a URL with a scheme)`,
      );
    }

    const tier: Tier = typeof input.tier === 'number'
      ? input.tier
      : nameToTier(input.tier);

    if (tier < 1 || tier > 5) {
      throw new Error(`tier out of range: ${input.tier}`);
    }

    const nameKey = input.name.toLowerCase();
    const existingId = this.byName.get(nameKey);
    if (existingId) {
      return this.update(existingId, {
        tier,
        tierName: tierToName(tier),
        endpoint: input.endpoint,
        transport: input.transport,
        capabilities: input.capabilities,
        region: input.region,
        zone: input.zone,
        labels: input.labels,
      });
    }

    const inst: Instance = {
      id:           this.newId(),
      tier,
      tierName:     tierToName(tier),
      name:         input.name,
      endpoint:     input.endpoint,
      transport:    input.transport ?? 'http',
      capabilities: input.capabilities ?? {},
      status:       'unknown',
      lastHeartbeat: 0,
      latencyMs:    0,
      load:         0,
      region:       input.region,
      zone:         input.zone,
      registeredAt: Date.now(),
      labels:       input.labels ?? {},
    };

    this.byId.set(inst.id, inst);
    this.byName.set(nameKey, inst.id);
    this.bucket(this.byTier, inst.tier).add(inst.id);
    if (inst.region) {
      this.bucket(this.byRegion, inst.region).add(inst.id);
    }

    this.emit('add', inst);
    return inst;
  }

  /** Update an existing instance. */
  update(id: string, patch: InstancePatch): Instance {
    const inst = this.byId.get(id);
    if (!inst) {
      throw new Error(`unknown instance id: ${id}`);
    }
    const before: Instance = { ...inst };
    const merged: Instance = {
      ...inst,
      ...patch,
      // never let these be overwritten via update
      id:           inst.id,
      name:         inst.name,
      registeredAt: inst.registeredAt,
    };
    this.byId.set(id, merged);

    // re-bucket if tier or region changed
    if (patch.tier !== undefined && patch.tier !== before.tier) {
      this.byTier.get(before.tier)?.delete(id);
      this.bucket(this.byTier, merged.tier).add(id);
    }
    if (patch.region !== undefined && patch.region !== before.region) {
      if (before.region) this.byRegion.get(before.region)?.delete(id);
      if (merged.region) this.bucket(this.byRegion, merged.region).add(id);
    }

    if (patch.status && patch.status !== before.status) {
      this.emit('status', merged, patch.status);
    }
    this.emit('update', merged, patch);
    return merged;
  }

  /** Remove an instance. Returns the removed record, or null. */
  unregister(id: string): Instance | null {
    const inst = this.byId.get(id);
    if (!inst) return null;
    this.byId.delete(id);
    this.byName.delete(inst.name.toLowerCase());
    this.byTier.get(inst.tier)?.delete(id);
    if (inst.region) this.byRegion.get(inst.region)?.delete(id);
    this.emit('remove', inst);
    return inst;
  }

  /* ─── reads ────────────────────────────────────────────────────────── */

  /** Look up by id. */
  get(id: string): Instance | undefined {
    return this.byId.get(id);
  }

  /** Look up by name (case-insensitive). */
  byInstanceName(name: string): Instance | undefined {
    return this.byName.get(name.toLowerCase())
      ? this.byId.get(this.byName.get(name.toLowerCase())!)
      : undefined;
  }

  /** Total registered instances. */
  size(): number {
    return this.byId.size;
  }

  /** All instances, no filter. */
  all(): Instance[] {
    return Array.from(this.byId.values());
  }

  /** Filter instances by a query. */
  list(q: RegistryQuery = {}): Instance[] {
    let out: Instance[] = [];
    if (q.tier !== undefined) {
      const tiers = Array.isArray(q.tier)
        ? q.tier.map(t => typeof t === 'number' ? t : nameToTier(t))
        : [typeof q.tier === 'number' ? q.tier : nameToTier(q.tier)];
      for (const t of tiers) {
        const set = this.byTier.get(t);
        if (!set) continue;
        for (const id of set) {
          const i = this.byId.get(id);
          if (i) out.push(i);
        }
      }
    } else {
      out = this.all();
    }

    if (q.status !== undefined) {
      const allowed = Array.isArray(q.status) ? q.status : [q.status];
      out = out.filter(i => allowed.includes(i.status));
    }
    if (q.region !== undefined) {
      const allowed = Array.isArray(q.region) ? q.region : [q.region];
      out = out.filter(i => i.region && allowed.includes(i.region));
    }
    if (q.label) {
      out = out.filter(i => {
        for (const [k, v] of Object.entries(q.label!)) {
          if (i.labels[k] !== v) return false;
        }
        return true;
      });
    }
    if (q.limit !== undefined && q.limit >= 0) {
      out = out.slice(0, q.limit);
    }
    return out;
  }

  /** All instances that own the given cell URI, in tier-preference
   *  order (lowest tier first, then by latency). */
  ownersOfCell(ref: CellRef): Instance[] {
    const parsed: CellRef = ref.uri ? ref : parseQuiltUri(ref.uri);
    // We don't track per-cell ownership at the registry level (that's
    // the routing layer's job). We instead return all healthy
    // instances in tier order. The router will narrow it down.
    return this.list({ status: ['healthy', 'degraded'] })
      .sort((a, b) => a.tier - b.tier || a.latencyMs - b.latencyMs);
  }

  /* ─── helpers ──────────────────────────────────────────────────────── */

  private bucket<K>(map: Map<K, Set<string>>, key: K): Set<string> {
    let s = map.get(key);
    if (!s) {
      s = new Set();
      map.set(key, s);
    }
    return s;
  }

  /** Return a plain object representation (handy for JSON). */
  toJSON(): { instances: Instance[] } {
    return { instances: this.all() };
  }
}

/* ─── utility: the reverse of parseQuiltUri ───────────────────────────── */

/** Build a registry-relative URI fragment for diagnostics. */
export function describeCellAt(instance: Instance, sheet: string, cell: string): string {
  return buildQuiltUri(instance.name, sheet, cell);
}
