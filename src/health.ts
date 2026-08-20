/**
 * ════════════════════════════════════════════════════════════════════════════
 *  health.ts — heartbeat, latency, status
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  The health monitor tracks the **liveness** of every instance in
 *  the registry. It does so by:
 *
 *   1. Sending periodic **probes** to each instance (HTTP GET /health
 *      by default, transport-specific overrides are possible).
 *   2. Recording **latency** in an exponentially weighted moving
 *      average (EWMA), plus a p95 over the last 100 samples.
 *   3. Tracking the **lastUpdate** timestamp for every cell we
 *      learn about.
 *   4. Classifying each instance as `healthy`, `degraded`, or
 *      `unreachable`, and firing events on transitions.
 *
 *  The status state machine is documented in `docs/health.md`. The
 *  monitor never calls into the registry directly — it only fires
 *  events that the {@link FleetManager} translates into
 *  `registry.update(...)` calls. This keeps the modules testable
 *  in isolation.
 *  ──────────────────────────────────────────────────────────────────────────
 */

import { EventEmitter } from 'node:events';
import type { Registry, Instance } from './registry';

/* ─── config ──────────────────────────────────────────────────────────── */

export interface HealthConfig {
  /** How often to probe each instance (ms). */
  intervalMs?: number;
  /** Timeout per probe (ms). */
  timeoutMs?: number;
  /** How many missed beats before marking `unreachable`. */
  missedBeforeUnreachable?: number;
  /** EWMA smoothing factor α (0..1). 0.3 by default. */
  alpha?: number;
  /** Latency above which an instance is `degraded` (ms). */
  degradedLatencyMs?: number;
  /** Latency above which an instance is `unreachable` (ms). */
  unreachableLatencyMs?: number;
  /** Optional probe function (defaults to HTTP GET /health). */
  probe?: (inst: Instance) => Promise<ProbeResult>;
}

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  load?: number;
  cells?: number;
  message?: string;
}

/* ─── per-instance state ─────────────────────────────────────────────── */

interface InstHealth {
  status: HealthState;
  lastHeartbeat: number;
  latencyMs: number;
  latencySamples: number[];   // for p95
  load: number;
  misses: number;
  lastError?: string;
  lastUpdate: number;
}

export type HealthState = 'unknown' | 'healthy' | 'degraded' | 'unreachable';

/* ─── public snapshot ────────────────────────────────────────────────── */

export interface HealthSnapshot {
  instance: string;
  state: HealthState;
  latencyMs: number;
  p95Ms: number;
  load: number;
  lastHeartbeat: number;
  lastUpdate: number;
  lastError?: string;
  probes: number;
  failures: number;
}

/* ─── events ──────────────────────────────────────────────────────────── */

export interface HealthEvents {
  probe:        [string, ProbeResult];
  healthy:      [string];
  degraded:     [string, ProbeResult];
  unreachable:  [string];
  recovered:    [string];
  latencySpike: [string, number];
}

/* ─── the monitor ─────────────────────────────────────────────────────── */

export class HealthMonitor extends EventEmitter<HealthEvents> {
  private readonly cfg: Required<Omit<HealthConfig, 'probe'>> & { probe: HealthConfig['probe'] };
  private readonly state = new Map<string, InstHealth>();
  private timer: NodeJS.Timeout | null = null;
  private reg: Registry | null = null;
  private probes = 0;
  private failures = 0;
  private probeCounts = new Map<string, number>();
  private failureCounts = new Map<string, number>();

  constructor(cfg: HealthConfig = {}) {
    super();
    this.cfg = {
      intervalMs:              cfg.intervalMs              ?? 5_000,
      timeoutMs:               cfg.timeoutMs               ?? 1_500,
      missedBeforeUnreachable: cfg.missedBeforeUnreachable ?? 3,
      alpha:                   cfg.alpha                   ?? 0.3,
      degradedLatencyMs:       cfg.degradedLatencyMs       ?? 250,
      unreachableLatencyMs:    cfg.unreachableLatencyMs    ?? 5_000,
      probe:                   cfg.probe                   ?? defaultProbe,
    };
  }

  /** Bind to a registry. The monitor will subscribe to its
   *  add/remove events and only probe registered instances. */
  bind(registry: Registry): void {
    this.reg = registry;
    registry.on('add',    (i) => this.onAdd(i));
    registry.on('remove', (i) => this.onRemove(i));
    // initialize for anything already there
    for (const inst of registry.all()) this.onAdd(inst);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.cfg.intervalMs);
    this.timer.unref?.();
    // fire a tick immediately
    queueMicrotask(() => this.tick());
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /* ─── snapshot API ────────────────────────────────────────────────── */

  get(instanceId: string): HealthSnapshot | undefined {
    const s = this.state.get(instanceId);
    if (!s) return undefined;
    return this.toSnapshot(instanceId, s);
  }

  all(): HealthSnapshot[] {
    const out: HealthSnapshot[] = [];
    for (const [id, s] of this.state) {
      out.push(this.toSnapshot(id, s));
    }
    return out;
  }

  totals(): Record<HealthState, number> {
    const t: Record<HealthState, number> = {
      unknown: 0, healthy: 0, degraded: 0, unreachable: 0,
    };
    for (const s of this.state.values()) t[s.status]++;
    return t;
  }

  /* ─── internal: per-tick probe loop ───────────────────────────────── */

  private async tick(): Promise<void> {
    if (!this.reg) return;
    const snapshot = this.reg.all();
    await Promise.all(snapshot.map(i => this.probeOne(i)));
  }

  private async probeOne(inst: Instance): Promise<void> {
    const state = this.state.get(inst.id) ?? this.newState();
    this.probeCounts.set(inst.id, (this.probeCounts.get(inst.id) ?? 0) + 1);
    this.probes++;

    let result: ProbeResult;
    const start = Date.now();
    try {
      const probePromise = this.cfg.probe!(inst);
      const timeout = new Promise<ProbeResult>((_, reject) => {
        setTimeout(() => reject(new Error('probe timeout')), this.cfg.timeoutMs).unref?.();
      });
      result = await Promise.race([probePromise, timeout]);
    } catch (e) {
      const msg = (e as Error).message;
      result = { ok: false, latencyMs: Date.now() - start, message: msg };
    }

    this.emit('probe', inst.id, result);
    this.updateState(inst, state, result);
  }

  private updateState(inst: Instance, s: InstHealth, r: ProbeResult): void {
    const prev = s.status;
    if (r.ok) {
      s.lastHeartbeat = Date.now();
      s.misses = 0;
      s.latencyMs = this.cfg.alpha * r.latencyMs + (1 - this.cfg.alpha) * s.latencyMs;
      s.latencySamples.push(r.latencyMs);
      if (s.latencySamples.length > 100) s.latencySamples.shift();
      if (typeof r.load === 'number') s.load = r.load;
      s.lastError = undefined;
    } else {
      s.misses++;
      s.lastError = r.message ?? 'probe failed';
      this.failureCounts.set(inst.id, (this.failureCounts.get(inst.id) ?? 0) + 1);
      this.failures++;
    }
    s.lastUpdate = Date.now();

    let next: HealthState;
    if (!r.ok && s.misses >= this.cfg.missedBeforeUnreachable) {
      next = 'unreachable';
    } else if (!r.ok) {
      next = 'degraded';
    } else if (s.latencyMs >= this.cfg.unreachableLatencyMs) {
      next = 'unreachable';
    } else if (s.latencyMs >= this.cfg.degradedLatencyMs) {
      next = 'degraded';
    } else {
      next = 'healthy';
    }

    if (next === prev) {
      // still fire latencySpike for visibility
      if (next === 'degraded' && r.latencyMs > s.latencyMs * 1.5) {
        this.emit('latencySpike', inst.id, r.latencyMs);
      }
      return;
    }
    s.status = next;
    switch (next) {
      case 'healthy':     this.emit('healthy',     inst.id); break;
      case 'degraded':    this.emit('degraded',    inst.id, r); break;
      case 'unreachable': this.emit('unreachable', inst.id); break;
    }
    if (prev === 'unreachable' && next !== 'unreachable') {
      this.emit('recovered', inst.id);
    }
  }

  /* ─── lifecycle hooks ─────────────────────────────────────────────── */

  private onAdd(inst: Instance): void {
    this.state.set(inst.id, this.newState());
  }

  private onRemove(inst: Instance): void {
    this.state.delete(inst.id);
    this.probeCounts.delete(inst.id);
    this.failureCounts.delete(inst.id);
  }

  private newState(): InstHealth {
    return {
      status: 'unknown',
      lastHeartbeat: 0,
      latencyMs: 0,
      latencySamples: [],
      load: 0,
      misses: 0,
      lastUpdate: 0,
    };
  }

  private toSnapshot(id: string, s: InstHealth): HealthSnapshot {
    const sorted = [...s.latencySamples].sort((a, b) => a - b);
    const p95 = sorted.length === 0
      ? 0
      : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!;
    return {
      instance: id,
      state: s.status,
      latencyMs: Math.round(s.latencyMs),
      p95Ms: p95,
      load: s.load,
      lastHeartbeat: s.lastHeartbeat,
      lastUpdate: s.lastUpdate,
      lastError: s.lastError,
      probes: this.probeCounts.get(id) ?? 0,
      failures: this.failureCounts.get(id) ?? 0,
    };
  }
}

/* ─── default probe (HTTP GET /health) ───────────────────────────────── */

/**
 * Default probe implementation. Uses fetch() (Node 18+) with a
 * per-call timeout. Returns load / cells if the body parses.
 *
 * For transports that are not HTTP (mqtt, nats, grpc), the caller
 * should pass a custom `probe` function via the `HealthConfig`.
 */
export async function defaultProbe(inst: Instance): Promise<ProbeResult> {
  const start = Date.now();
  const url = inst.endpoint.replace(/\/$/, '') + '/health';
  const res = await fetch(url, { method: 'GET' }).catch((e) => {
    throw new Error(`fetch failed: ${(e as Error).message}`);
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const latencyMs = Date.now() - start;
  let body: any = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  return {
    ok: true,
    latencyMs,
    load: typeof body?.load === 'number' ? body.load : undefined,
    cells: typeof body?.cells === 'number' ? body.cells : undefined,
  };
}
