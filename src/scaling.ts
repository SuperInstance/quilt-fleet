/**
 * ════════════════════════════════════════════════════════════════════════════
 *  scaling.ts — auto-scaling policies
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  `quilt-fleet` is elastic. When a cell's load crosses a
 *  threshold, the scaler decides whether to spawn a new instance,
 *  destroy an under-used one, or do nothing.
 *
 *  Policies
 *  ────────
 *   • `load`         spawn when any instance's load > threshold;
 *                    destroy when fleet average < threshold / 4.
 *   • `latency`      spawn when p95 latency > 500 ms on a tier.
 *   • `schedule`     scale to a target count at a given cron.
 *   • `passive`      no auto-scaling; the operator drives everything.
 *   • `reactive`     like `load`, but also reacts to manual signals.
 *
 *  The scaler **never** starts a Quilt instance itself. It calls
 *  the user-supplied `provisioner` function with a tier + region
 *  hint, and the user's infrastructure (k8s, terraform, the
 *  Quilt Cloud API, …) does the actual provisioning. The scaler
 *  then waits for the new instance to register via the
 *  {@link Registry}.
 *  ──────────────────────────────────────────────────────────────────────────
 */

import { EventEmitter } from 'node:events';
import type { Registry, Instance } from './registry';
import type { HealthMonitor } from './health';
import { Tier, TierName, nameToTier, tierToName } from './types';

/* ─── policy ────────────────────────────────────────────────────────── */

export interface ScalingPolicy {
  /** Policy name. */
  name: 'load' | 'latency' | 'schedule' | 'passive' | 'reactive';
  /** High-water-mark load for spawning. */
  threshold: number;
  /** Minimum instances per tier. */
  min?: number;
  /** Maximum instances per tier. */
  max?: number;
  /** Cooldown after a spawn/destroy (ms). Default 60_000. */
  cooldownMs?: number;
  /** Latency threshold for `latency` policy (ms). */
  latencyMs?: number;
  /** Schedule for `schedule` policy. */
  schedule?: Array<{ at: string; tier: TierName; count: number }>;
  /** Provisioner: returns when the instance is up. */
  provisioner?: (req: SpawnRequest) => Promise<void>;
  /** Deprovisioner: returns when the instance is gone. */
  deprovisioner?: (req: DestroyRequest) => Promise<void>;
}

export interface SpawnRequest {
  tier: TierName;
  region?: string;
  reason: string;
  triggeredBy: 'load' | 'latency' | 'schedule' | 'manual';
}

export interface DestroyRequest {
  instanceId: string;
  reason: string;
  triggeredBy: 'load' | 'latency' | 'schedule' | 'manual';
}

export interface ScalingDecision {
  ts: number;
  action: 'spawn' | 'destroy' | 'noop';
  tier: TierName;
  reason: string;
  instanceId?: string;
  instanceName?: string;
}

/* ─── events ────────────────────────────────────────────────────────── */

export interface ScalingEvents {
  spawn:   [SpawnRequest];
  destroy: [DestroyRequest];
  decided: [ScalingDecision];
  error:   [Error];
}

/* ─── the scaler ────────────────────────────────────────────────────── */

export class Scaler extends EventEmitter<ScalingEvents> {
  private readonly cfg: ScalingPolicy;
  private readonly lastAction = new Map<TierName, number>();
  private reg: Registry | null = null;
  private health: HealthMonitor | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(policy: ScalingPolicy) {
    super();
    this.cfg = {
      min:        policy.min        ?? 1,
      max:        policy.max        ?? 10,
      cooldownMs: policy.cooldownMs ?? 60_000,
      ...policy,
    };
  }

  bind(registry: Registry, health: HealthMonitor): void {
    this.reg = registry;
    this.health = health;
  }

  start(): void {
    if (this.timer) return;
    const interval = this.policyInterval();
    this.timer = setInterval(() => this.tick().catch(e => this.emit('error', e)), interval);
    this.timer.unref?.();
    queueMicrotask(() => this.tick().catch(e => this.emit('error', e)));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /* ─── manual triggers ────────────────────────────────────────────── */

  async spawn(tier: TierName, reason = 'manual', region?: string): Promise<ScalingDecision> {
    if (!this.reg) throw new Error('scaler not bound');
    if (!this.cfg.provisioner) {
      return this.decide({ action: 'noop', tier, reason: 'no provisioner configured' });
    }
    const req: SpawnRequest = { tier, region, reason, triggeredBy: 'manual' };
    this.emit('spawn', req);
    try {
      await this.cfg.provisioner(req);
    } catch (e) {
      this.emit('error', e as Error);
      return this.decide({ action: 'noop', tier, reason: `provisioner failed: ${(e as Error).message}` });
    }
    this.lastAction.set(tier, Date.now());
    return this.decide({ action: 'spawn', tier, reason });
  }

  async destroy(instanceId: string, reason = 'manual'): Promise<ScalingDecision> {
    if (!this.reg) throw new Error('scaler not bound');
    const inst = this.reg.get(instanceId);
    if (!inst) return this.decide({ action: 'noop', tier: inst?.tierName ?? 'server', reason: 'unknown instance' });
    if (!this.cfg.deprovisioner) {
      return this.decide({ action: 'noop', tier: inst.tierName, reason: 'no deprovisioner' });
    }
    const req: DestroyRequest = { instanceId, reason, triggeredBy: 'manual' };
    this.emit('destroy', req);
    try {
      await this.cfg.deprovisioner(req);
      this.reg.unregister(instanceId);
    } catch (e) {
      this.emit('error', e as Error);
    }
    this.lastAction.set(inst.tierName, Date.now());
    return this.decide({ action: 'destroy', tier: inst.tierName, reason, instanceId, instanceName: inst.name });
  }

  /* ─── policy tick ────────────────────────────────────────────────── */

  private async tick(): Promise<void> {
    if (!this.reg || !this.health) return;
    switch (this.cfg.name) {
      case 'passive':  return;
      case 'load':     return this.tickLoad();
      case 'latency':  return this.tickLatency();
      case 'reactive': return this.tickLoad();
      case 'schedule': return this.tickSchedule();
    }
  }

  private async tickLoad(): Promise<void> {
    if (!this.reg) return;
    const all = this.reg.all();
    if (all.length === 0) return;

    // Aggregate per tier.
    const byTier = new Map<TierName, Instance[]>();
    for (const i of all) {
      const arr = byTier.get(i.tierName) ?? [];
      arr.push(i);
      byTier.set(i.tierName, arr);
    }

    for (const [tier, list] of byTier) {
      const avgLoad = list.reduce((a, i) => a + i.load, 0) / list.length;
      const maxLoad = list.reduce((a, i) => Math.max(a, i.load), 0);
      const count = list.length;

      if (maxLoad > this.cfg.threshold && count < (this.cfg.max ?? 10) && this.canAct(tier)) {
        await this.spawn(tier, `load=${maxLoad.toFixed(2)}>${this.cfg.threshold}`);
        return;
      }
      if (avgLoad < this.cfg.threshold / 4 && count > (this.cfg.min ?? 1) && this.canAct(tier)) {
        // destroy the lowest-loaded instance
        const target = list.sort((a, b) => a.load - b.load)[0]!;
        await this.destroy(target.id, `avg=${avgLoad.toFixed(2)}<${(this.cfg.threshold / 4).toFixed(2)}`);
        return;
      }
    }
  }

  private async tickLatency(): Promise<void> {
    if (!this.health || !this.reg) return;
    const threshold = this.cfg.latencyMs ?? 500;
    for (const snap of this.health.all()) {
      if (snap.state !== 'healthy') continue;
      if (snap.p95Ms > threshold) {
        const inst = this.reg.get(snap.instance);
        if (inst && this.canAct(inst.tierName)) {
          await this.spawn(inst.tierName, `p95=${snap.p95Ms}ms>${threshold}ms`, inst.region);
          return;
        }
      }
    }
  }

  private async tickSchedule(): Promise<void> {
    if (!this.cfg.schedule) return;
    const now = new Date();
    const hh = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    for (const slot of this.cfg.schedule) {
      if (slot.at !== hh) continue;
      if (!this.reg) return;
      const have = this.reg.list({ tier: slot.tier }).length;
      if (have < slot.count && this.canAct(slot.tier)) {
        await this.spawn(slot.tier, `schedule ${slot.at} -> ${slot.count}`, undefined);
      }
    }
  }

  /* ─── helpers ────────────────────────────────────────────────────── */

  private canAct(tier: TierName): boolean {
    const last = this.lastAction.get(tier) ?? 0;
    return Date.now() - last >= (this.cfg.cooldownMs ?? 60_000);
  }

  private policyInterval(): number {
    switch (this.cfg.name) {
      case 'load':     return 10_000;
      case 'latency':  return 15_000;
      case 'reactive': return  5_000;
      case 'schedule': return 60_000;
      case 'passive':  return 60_000;
    }
  }

  private decide(d: Omit<ScalingDecision, 'ts'>): ScalingDecision {
    const full: ScalingDecision = { ts: Date.now(), ...d };
    this.emit('decided', full);
    return full;
  }

  /* ─── pure helpers exported for tests ────────────────────────────── */

  static tierFromName = nameToTier;
  static nameFromTier = tierToName;
}
