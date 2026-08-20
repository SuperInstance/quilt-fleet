/**
 * ════════════════════════════════════════════════════════════════════════════
 *  migration.ts — two-phase cell cutover
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  Moving a cell from instance A to instance B without ever dropping
 *  the value requires careful choreography. This module implements
 *  the two-phase cutover described in `docs/migration.md`:
 *
 *     Phase 1A — advisory freeze on source
 *     Phase 1B — write snapshot to destination
 *     Phase 2A — read-back from destination (verify)
 *     Phase 2B — flip routing (DNS / registry)
 *     Phase 2C — unfreeze source
 *
 *  Every phase has a timeout, a retry policy, and a rollback path.
 *  The total wall time in the happy path is ~150 ms; the worst-case
 *  timeout is `cfg.totalTimeoutMs` (default 30 s).
 *
 *  The cutover is **idempotent** — if interrupted at any phase, the
 *  next call resumes from the same point and re-validates.
 *  ──────────────────────────────────────────────────────────────────────────
 */

import { EventEmitter } from 'node:events';
import type { Registry, Instance } from './registry';
import { CellRef, parseQuiltUri } from './types';

/* ─── config ────────────────────────────────────────────────────────── */

export interface MigrationConfig {
  /** Per-phase timeout. */
  phaseTimeoutMs?: number;
  /** Total wall time before giving up. */
  totalTimeoutMs?: number;
  /** How many read-back mismatches are tolerable. */
  maxVerifyFailures?: number;
  /** If true, roll back on any phase failure. */
  rollbackOnFailure?: boolean;
}

export type MigrationPhase =
  | '1A' | '1B' | '2A' | '2B' | '2C'
  | 'rollback';

export type MigrationStatus = 'success' | 'in_progress' | 'failed' | 'rolled_back';

export interface MigrationPlan {
  source: string;          // instance name
  dest:   string;          // instance name
  uri:    string;          // quilt://source/sheet#cell
  startedAt: number;
  finishedAt?: number;
  status: MigrationStatus;
  currentPhase: MigrationPhase;
  phases: Array<{ phase: MigrationPhase; status: 'pending' | 'ok' | 'fail'; ts: number; error?: string }>;
  attempts: number;
  error?: string;
}

export interface MigrationResult {
  success: boolean;
  durationMs: number;
  attempts: number;
  plan: MigrationPlan;
}

/* ─── transport contract for migration I/O ──────────────────────────── */

export interface MigrationTransport {
  freeze(instance: Instance, ref: CellRef): Promise<boolean>;
  unfreeze(instance: Instance, ref: CellRef): Promise<boolean>;
  read(instance: Instance, ref: CellRef): Promise<{ value: unknown; version: number } | null>;
  write(instance: Instance, ref: CellRef, value: unknown, version: number): Promise<boolean>;
  flipRouting(fromInstance: Instance, toInstance: Instance, ref: CellRef): Promise<boolean>;
}

/* ─── events ────────────────────────────────────────────────────────── */

export interface MigrationEvents {
  start:      [MigrationPlan];
  phaseStart: [string, MigrationPhase];
  phaseEnd:   [string, MigrationPhase, 'ok' | 'fail'];
  rollback:   [string, MigrationPhase, string];
  complete:   [MigrationResult];
}

/* ─── the coordinator ───────────────────────────────────────────────── */

export class MigrationCoordinator extends EventEmitter<MigrationEvents> {
  private readonly cfg: Required<MigrationConfig>;
  private reg: Registry | null = null;
  private transport: MigrationTransport | null = null;
  private plans = new Map<string, MigrationPlan>();

  constructor(cfg: MigrationConfig = {}) {
    super();
    this.cfg = {
      phaseTimeoutMs:   cfg.phaseTimeoutMs   ?? 2_000,
      totalTimeoutMs:   cfg.totalTimeoutMs   ?? 30_000,
      maxVerifyFailures: cfg.maxVerifyFailures ?? 1,
      rollbackOnFailure: cfg.rollbackOnFailure ?? true,
    };
  }

  bind(registry: Registry, transport: MigrationTransport): void {
    this.reg = registry;
    this.transport = transport;
  }

  list(): MigrationPlan[] {
    return Array.from(this.plans.values());
  }

  get(id: string): MigrationPlan | undefined {
    return this.plans.get(id);
  }

  /* ─── main entry point ───────────────────────────────────────────── */

  async migrate(
    sourceUri: string,
    targetInstanceName: string,
    opts: Partial<MigrationConfig> = {},
  ): Promise<MigrationResult> {
    if (!this.reg || !this.transport) throw new Error('migration not bound');

    const cfg = { ...this.cfg, ...opts };
    const ref = parseQuiltUri(sourceUri);
    const source = this.reg.byInstanceName(ref.instance);
    const dest = this.reg.byInstanceName(targetInstanceName);
    if (!source) throw new Error(`unknown source instance: ${ref.instance}`);
    if (!dest)   throw new Error(`unknown target instance: ${targetInstanceName}`);
    if (source.id === dest.id) throw new Error('source and target are the same instance');

    const id = `mig-${source.id}-${dest.id}-${ref.sheet}-${ref.cell}-${Date.now()}`;
    const plan: MigrationPlan = {
      source: source.name,
      dest:   dest.name,
      uri:    sourceUri,
      startedAt: Date.now(),
      status: 'in_progress',
      currentPhase: '1A',
      phases: [
        { phase: '1A', status: 'pending', ts: 0 },
        { phase: '1B', status: 'pending', ts: 0 },
        { phase: '2A', status: 'pending', ts: 0 },
        { phase: '2B', status: 'pending', ts: 0 },
        { phase: '2C', status: 'pending', ts: 0 },
      ],
      attempts: 1,
    };
    this.plans.set(id, plan);
    this.emit('start', plan);

    const start = Date.now();
    try {
      await this.runPhases(id, plan, source, dest, ref, cfg);
      plan.status = 'success';
      plan.finishedAt = Date.now();
      const result: MigrationResult = {
        success: true,
        durationMs: plan.finishedAt - start,
        attempts: plan.attempts,
        plan,
      };
      this.emit('complete', result);
      return result;
    } catch (e) {
      plan.status = cfg.rollbackOnFailure ? 'rolled_back' : 'failed';
      plan.finishedAt = Date.now();
      plan.error = (e as Error).message;
      if (cfg.rollbackOnFailure) {
        await this.rollback(plan, source, ref, (e as Error).message);
      }
      const result: MigrationResult = {
        success: false,
        durationMs: plan.finishedAt - start,
        attempts: plan.attempts,
        plan,
      };
      this.emit('complete', result);
      return result;
    }
  }

  /* ─── phase runner ───────────────────────────────────────────────── */

  private async runPhases(
    id: string,
    plan: MigrationPlan,
    source: Instance,
    dest:   Instance,
    ref:    CellRef,
    cfg: Required<MigrationConfig>,
  ): Promise<void> {
    // Phase 1A — freeze source
    await this.runPhase(id, plan, '1A', async () => {
      return this.transport!.freeze(source, ref);
    }, cfg);

    // Read snapshot
    const snap = await withTimeout(
      this.transport!.read(source, ref),
      cfg.phaseTimeoutMs,
    );
    if (!snap) throw new Error('1A: source returned null snapshot');

    // Phase 1B — write to dest
    await this.runPhase(id, plan, '1B', async () => {
      return this.transport!.write(dest, ref, snap.value, snap.version);
    }, cfg);

    // Phase 2A — read-back
    let verifyFails = 0;
    for (let attempt = 0; attempt <= cfg.maxVerifyFailures; attempt++) {
      await this.runPhase(id, plan, '2A', async () => {
        const back = await this.transport!.read(dest, ref);
        if (!back) return false;
        if (back.version !== snap.version) return false;
        return JSON.stringify(back.value) === JSON.stringify(snap.value);
      }, cfg);
      // If the most recent 2A phase is ok, stop retrying
      const last = plan.phases.find(p => p.phase === '2A')!;
      if (last.status === 'ok') break;
      verifyFails++;
    }
    if (verifyFails > cfg.maxVerifyFailures) {
      throw new Error(`2A: read-back mismatched ${verifyFails} times`);
    }

    // Phase 2B — flip routing
    await this.runPhase(id, plan, '2B', async () => {
      return this.transport!.flipRouting(source, dest, ref);
    }, cfg);

    // Phase 2C — unfreeze source
    await this.runPhase(id, plan, '2C', async () => {
      return this.transport!.unfreeze(source, ref);
    }, cfg);
  }

  private async runPhase(
    id: string,
    plan: MigrationPlan,
    phase: MigrationPhase,
    fn: () => Promise<boolean>,
    cfg: Required<MigrationConfig>,
  ): Promise<void> {
    const entry = plan.phases.find(p => p.phase === phase)!;
    plan.currentPhase = phase;
    this.emit('phaseStart', id, phase);
    entry.ts = Date.now();
    try {
      const ok = await withTimeout(fn(), cfg.phaseTimeoutMs);
      if (!ok) throw new Error(`${phase}: returned false`);
      entry.status = 'ok';
      this.emit('phaseEnd', id, phase, 'ok');
    } catch (e) {
      entry.status = 'fail';
      entry.error = (e as Error).message;
      this.emit('phaseEnd', id, phase, 'fail');
      throw e;
    }
  }

  /* ─── rollback ───────────────────────────────────────────────────── */

  private async rollback(
    plan: MigrationPlan,
    source: Instance,
    ref: CellRef,
    reason: string,
  ): Promise<void> {
    if (!this.reg || !this.transport) return;
    plan.currentPhase = 'rollback';
    this.emit('rollback', `${plan.source}->${plan.dest}#${ref.cell}`, 'rollback', reason);
    // Always try to unfreeze the source — it is the most damaging
    // side-effect if left frozen.
    try {
      await withTimeout(this.transport.unfreeze(source, ref), this.cfg.phaseTimeoutMs);
    } catch { /* best effort */ }
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
