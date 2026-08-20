/**
 * ════════════════════════════════════════════════════════════════════════════
 *  routing.ts — pick the best instance for a query
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  The router is the **decision point** between "the cell says
 *  `quilt://jetson-orin-1/sensors#temp`" and "we will actually
 *  contact `http://10.0.0.42:4040`". It considers:
 *
 *   1. **Tier preference** — the cell's `tierPreference` list
 *      orders tiers from most-preferred to least-preferred.
 *   2. **Locality** — if a query has a region/zone hint, prefer an
 *      instance in the same region/zone.
 *   3. **Latency** — prefer the lowest EWMA latency.
 *   4. **Health** — never route to an `unreachable` instance unless
 *      there is no alternative.
 *   5. **Load** — prefer instances with spare capacity.
 *
 *  The router is **stateless** apart from the references it holds
 *  to the registry and the policy. Every call to `pick()` is a pure
 *  function of the current registry contents + the policy.
 *  ──────────────────────────────────────────────────────────────────────────
 */

import { CellRef } from './types';
import type { Registry, Instance } from './registry';

/* ─── policy ────────────────────────────────────────────────────────── */

export interface RoutePolicy {
  /** Strict tier preference — return the first instance matching
   *  one of these tiers. If `undefined`, any tier is allowed. */
  tierPreference?: number[];
  /** Prefer instances in the same region as the caller. */
  preferLocality?: boolean;
  /** Region hint for the caller. */
  localityHint?: string;
  /** Hard cap on how many unhealthy picks are allowed before
   *  giving up. Default 1. */
  maxUnhealthy?: number;
  /** Whether to balance load across replicas or pick the fastest. */
  loadBalance?: 'fastest' | 'round_robin' | 'least_loaded';
  /** Per-cell overrides keyed by full URI. */
  perCell?: Record<string, RoutePolicy>;
}

export interface RouteDecision {
  instance: Instance;
  reason: string;
  rank: number;
  considered: Instance[];
}

/* ─── the router ────────────────────────────────────────────────────── */

export class Router {
  private rr = new Map<string, number>(); // tier → counter for round-robin

  constructor(
    private readonly reg: Registry,
    private readonly policy: RoutePolicy = {},
  ) {}

  /** Update the policy at runtime. */
  setPolicy(p: RoutePolicy): void {
    Object.assign(this.policy, p);
  }

  /** Pick a single instance for a cell. */
  pick(ref: CellRef | string, callerPolicy: RoutePolicy = {}): Instance | null {
    const merged = this.mergePolicy(ref, callerPolicy);
    const candidates = this.candidates(ref, merged);
    if (candidates.length === 0) return null;
    const ranked = this.rank(candidates, merged);
    if (ranked.length === 0) return null;
    return ranked[0]!.instance;
  }

  /** Pick N instances (replica set). Returns at most `n`. */
  pickN(ref: CellRef | string, n: number, callerPolicy: RoutePolicy = {}): Instance[] {
    const merged = this.mergePolicy(ref, callerPolicy);
    const candidates = this.candidates(ref, merged);
    if (candidates.length === 0) return [];
    const ranked = this.rank(candidates, merged);
    return ranked.slice(0, n).map(r => r.instance);
  }

  /** Like `pick` but returns the full ranked list with reasons. */
  decide(ref: CellRef | string, callerPolicy: RoutePolicy = {}): RouteDecision | null {
    const merged = this.mergePolicy(ref, callerPolicy);
    const candidates = this.candidates(ref, merged);
    if (candidates.length === 0) return null;
    const ranked = this.rank(candidates, merged);
    if (ranked.length === 0) return null;
    return {
      instance: ranked[0]!.instance,
      reason:   ranked[0]!.reason,
      rank:     0,
      considered: ranked.map(r => r.instance),
    };
  }

  /* ─── internals ──────────────────────────────────────────────────── */

  private mergePolicy(ref: CellRef | string, caller: RoutePolicy): RoutePolicy {
    const key = typeof ref === 'string' ? ref : ref.uri;
    const perCell = this.policy.perCell?.[key] ?? {};
    return {
      ...this.policy,
      ...perCell,
      ...caller,
    };
  }

  private candidates(ref: CellRef | string, policy: RoutePolicy): Instance[] {
    const all = this.reg.list({
      status: ['healthy', 'degraded'],
    });
    if (all.length === 0) return [];
    // tier preference
    if (policy.tierPreference && policy.tierPreference.length > 0) {
      const filtered = all.filter(i => policy.tierPreference!.includes(i.tier));
      if (filtered.length > 0) return filtered;
    }
    return all;
  }

  private rank(candidates: Instance[], policy: RoutePolicy): RouteDecision[] {
    const mode = policy.loadBalance ?? 'fastest';
    const score = (i: Instance): number => {
      let s = 0;
      // tier preference
      if (policy.tierPreference && policy.tierPreference.length > 0) {
        const idx = policy.tierPreference.indexOf(i.tier);
        s += (idx < 0 ? 100 : idx) * 1_000;
      }
      // locality
      if (policy.preferLocality && policy.localityHint) {
        s += i.region === policy.localityHint ? 0 : 500;
      }
      // latency
      s += i.latencyMs;
      // load
      if (mode === 'least_loaded') {
        s += i.load * 1_000;
      }
      return s;
    };

    const decisions: RouteDecision[] = candidates.map(i => ({
      instance: i,
      reason: `tier=${i.tierName} latency=${Math.round(i.latencyMs)}ms load=${i.load.toFixed(2)}`,
      rank: 0,
      considered: [],
    }));

    if (mode === 'round_robin') {
      const key = policy.tierPreference?.join(',') ?? 'all';
      const idx = this.rr.get(key) ?? 0;
      // sort by tier first, then cycle within the tier
      decisions.sort((a, b) => a.instance.tier - b.instance.tier);
      const reordered = [...decisions.slice(idx), ...decisions.slice(0, idx)];
      this.rr.set(key, (idx + 1) % reordered.length);
      return reordered;
    }

    decisions.sort((a, b) => score(a.instance) - score(b.instance));
    decisions.forEach((d, idx) => { d.rank = idx; });
    return decisions;
  }
}
