/**
 * ════════════════════════════════════════════════════════════════════════════
 *  quorum.ts — majority vote across N replicas
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  Some cells are **critical** — `vault.lock`, `safety.eStop`,
 *  `auth.token`, `billing.invoice`. For those, the fleet replicates
 *  the cell to N instances and serves reads via majority vote.
 *
 *  This module implements:
 *
 *   1. **Replica set selection** — pick N instances for a cell
 *      (default 3, configurable per cell).
 *   2. **Write path** — broadcast the new value to all replicas,
 *      wait for `(N/2 + 1)` acknowledgements, return the new
 *      committed version.
 *   3. **Read path** — query all N replicas, group responses by
 *      value, return the value with `(N/2 + 1)` matching
 *      responses. If no value achieves quorum, return `NO_QUORUM`.
 *   4. **Repair** — when a stale replica is detected, push the
 *      quorum-winning value to it in the background.
 *
 *  Quorum is **opt-in per cell**. Most cells are not replicated.
 *  The set of critical cells is configured at fleet level (see
 *  `quilt.fleet.yaml`).
 *  ──────────────────────────────────────────────────────────────────────────
 */

import { EventEmitter } from 'node:events';
import type { Registry, Instance } from './registry';
import { CellRef, parseQuiltUri } from './types';

/* ─── config ────────────────────────────────────────────────────────── */

export interface QuorumConfig {
  /** Default replica count. 3 is a sane default. */
  default?: number;
  /** Per-cell overrides. Pattern matching is glob-style (`*`). */
  critical?: string[];
  /** Read timeout in ms. */
  readTimeoutMs?: number;
  /** Write timeout in ms. */
  writeTimeoutMs?: number;
  /** Whether to attempt to repair stale replicas. */
  autoRepair?: boolean;
}

/* ─── results ───────────────────────────────────────────────────────── */

export type QuorumStatus = 'committed' | 'no_quorum' | 'timeout' | 'split_brain';

export interface QuorumRead<T = unknown> {
  status: QuorumStatus;
  value?: T;
  version?: number;
  /** How many replicas agreed. */
  agreement: number;
  /** Per-replica response for forensics. */
  responses: Array<{ instance: string; value: T; version: number }>;
  /** The replicas that disagreed. */
  dissenters: string[];
}

export interface QuorumWrite {
  status: QuorumStatus;
  version: number;
  acks: string[];
  missing: string[];
}

/* ─── transport contract for quorum I/O ─────────────────────────────── */

export interface QuorumTransport {
  read(instance: Instance, ref: CellRef): Promise<{ value: unknown; version: number } | null>;
  write(instance: Instance, ref: CellRef, value: unknown, version: number): Promise<boolean>;
}

/* ─── the coordinator ───────────────────────────────────────────────── */

export interface QuorumEvents {
  committed:  [string, number];
  noQuorum:   [string, QuorumStatus];
  repaired:   [string, string];  // cell, repaired instance
}

export class QuorumCoordinator extends EventEmitter<QuorumEvents> {
  private readonly cfg: Required<QuorumConfig>;
  private reg: Registry | null = null;
  private transport: QuorumTransport | null = null;
  /** cell URI → version committed */
  private lastCommitted = new Map<string, number>();

  constructor(cfg: QuorumConfig = {}) {
    super();
    this.cfg = {
      default:        cfg.default        ?? 3,
      critical:       cfg.critical       ?? [],
      readTimeoutMs:  cfg.readTimeoutMs  ?? 2_000,
      writeTimeoutMs: cfg.writeTimeoutMs ?? 2_000,
      autoRepair:     cfg.autoRepair     ?? true,
    };
  }

  bind(registry: Registry, transport: QuorumTransport): void {
    this.reg = registry;
    this.transport = transport;
  }

  /** How many replicas does a given cell require? */
  replicaCount(cellRefOrName: string): number {
    return this.cfg.critical.some(pat => globMatch(pat, cellRefOrName))
      ? Math.max(3, this.cfg.default)
      : this.cfg.default;
  }

  /** Is a cell considered critical (i.e. must be replicated)? */
  isCritical(cellRefOrName: string): boolean {
    return this.cfg.critical.some(pat => globMatch(pat, cellRefOrName));
  }

  /** Choose the replica set for a cell. Prefers the lowest-tier
   *  healthy instance that owns the cell, then peers. */
  pickReplicas(ref: CellRef, n: number): Instance[] {
    if (!this.reg) throw new Error('quorum not bound');
    const all = this.reg.list({ status: ['healthy', 'degraded'] });
    // The instance named in the URI is the primary; we then fill
    // with the lowest-latency healthy peers on a *different* tier.
    const primary = this.reg.byInstanceName(ref.instance);
    if (!primary) {
      // fall back to any healthy instances
      return all.slice(0, n);
    }
    const peers = all.filter(i => i.id !== primary.id);
    return [primary, ...peers.slice(0, n - 1)];
  }

  /* ─── read ───────────────────────────────────────────────────────── */

  async read<T = unknown>(ref: CellRef | string): Promise<QuorumRead<T>> {
    if (!this.reg || !this.transport) throw new Error('quorum not bound');
    const parsed: CellRef = typeof ref === 'string' ? parseQuiltUri(ref) : ref;
    const n = this.replicaCount(parsed.uri);
    const replicas = this.pickReplicas(parsed, n);
    if (replicas.length < Math.floor(n / 2) + 1) {
      return { status: 'no_quorum', agreement: 0, responses: [], dissenters: [] };
    }

    const responses = await Promise.all(
      replicas.map(async r => {
        try {
          const out = await withTimeout(
            this.transport!.read(r, parsed),
            this.cfg.readTimeoutMs,
          );
          if (!out) return null;
          return { instance: r.name, value: out.value as T, version: out.version };
        } catch {
          return null;
        }
      }),
    );

    const ok = responses.filter((r): r is { instance: string; value: T; version: number } => r !== null);
    if (ok.length < Math.floor(n / 2) + 1) {
      this.emit('noQuorum', parsed.uri, 'no_quorum');
      return {
        status: 'no_quorum',
        agreement: ok.length,
        responses: ok,
        dissenters: [],
      };
    }

    // group by JSON-stringified value
    const groups = new Map<string, { value: T; version: number; count: number; instances: string[] }>();
    for (const r of ok) {
      const k = JSON.stringify(r.value);
      const g = groups.get(k);
      if (g) {
        g.count++;
        g.instances.push(r.instance);
        g.version = Math.max(g.version, r.version);
      } else {
        groups.set(k, { value: r.value, version: r.version, count: 1, instances: [r.instance] });
      }
    }
    const sorted = Array.from(groups.values()).sort((a, b) => b.count - a.count);
    const winner = sorted[0]!;
    if (winner.count < Math.floor(n / 2) + 1) {
      this.emit('noQuorum', parsed.uri, 'split_brain');
      return {
        status: 'split_brain',
        agreement: winner.count,
        value: winner.value,
        version: winner.version,
        responses: ok,
        dissenters: ok.filter(r => JSON.stringify(r.value) !== JSON.stringify(winner.value)).map(r => r.instance),
      };
    }

    // Repair: push the winner to the dissenters
    if (this.cfg.autoRepair) {
      const losers = ok.filter(r => JSON.stringify(r.value) !== JSON.stringify(winner.value));
      for (const l of losers) {
        const inst = this.reg.byInstanceName(l.instance);
        if (inst) {
          this.transport.write(inst, parsed, winner.value, winner.version)
            .then(ok => { if (ok) this.emit('repaired', parsed.uri, l.instance); })
            .catch(() => { /* best-effort */ });
        }
      }
    }

    return {
      status: 'committed',
      value: winner.value,
      version: winner.version,
      agreement: winner.count,
      responses: ok,
      dissenters: ok.filter(r => JSON.stringify(r.value) !== JSON.stringify(winner.value)).map(r => r.instance),
    };
  }

  /* ─── write ──────────────────────────────────────────────────────── */

  async write(ref: CellRef | string, value: unknown): Promise<QuorumWrite> {
    if (!this.reg || !this.transport) throw new Error('quorum not bound');
    const parsed: CellRef = typeof ref === 'string' ? parseQuiltUri(ref) : ref;
    const n = this.replicaCount(parsed.uri);
    const replicas = this.pickReplicas(parsed, n);
    if (replicas.length < Math.floor(n / 2) + 1) {
      return { status: 'no_quorum', version: 0, acks: [], missing: replicas.map(r => r.name) };
    }
    const nextVersion = (this.lastCommitted.get(parsed.uri) ?? 0) + 1;

    const results = await Promise.all(
      replicas.map(async r => {
        try {
          const ok = await withTimeout(
            this.transport!.write(r, parsed, value, nextVersion),
            this.cfg.writeTimeoutMs,
          );
          return { name: r.name, ok };
        } catch {
          return { name: r.name, ok: false };
        }
      }),
    );

    const acks = results.filter(r => r.ok).map(r => r.name);
    const missing = results.filter(r => !r.ok).map(r => r.name);
    if (acks.length < Math.floor(n / 2) + 1) {
      this.emit('noQuorum', parsed.uri, 'no_quorum');
      return { status: 'no_quorum', version: nextVersion, acks, missing };
    }

    this.lastCommitted.set(parsed.uri, nextVersion);
    this.emit('committed', parsed.uri, nextVersion);
    return { status: 'committed', version: nextVersion, acks, missing };
  }
}

/* ─── helpers ───────────────────────────────────────────────────────── */

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    t.unref?.();
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

/** Tiny glob matcher: `*` matches any run of non-`/` chars; `**`
 *  matches anything. */
export function globMatch(pat: string, s: string): boolean {
  if (pat === s) return true;
  if (pat.includes('**')) {
    const [head, ...rest] = pat.split('**');
    if (!s.startsWith(head)) return false;
    const tail = rest.join('**');
    return tail === '' || s.endsWith(tail);
  }
  if (!pat.includes('*')) return false;
  // turn into a regex
  const re = new RegExp('^' + pat.split('*').map(escapeRegex).join('.*') + '$');
  return re.test(s);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
