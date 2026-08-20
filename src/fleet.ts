/**
 * ════════════════════════════════════════════════════════════════════════════
 *  fleet.ts — the FleetManager
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  This is the top-level orchestrator. It owns a {@link Registry},
 *  a {@link Discovery}, a {@link HealthMonitor}, a
 *  {@link SubscriptionManager}, a {@link QuorumCoordinator},
 *  a {@link MigrationCoordinator}, a {@link Router}, and a
 *  {@link Scaler}, and wires them together.
 *
 *  Wiring diagram
 *  ──────────────
 *        ┌──────────┐
 *        │  start() │
 *        └────┬─────┘
 *             ▼
 *      ┌────────────┐
 *      │ Discovery  │──up──▶ Registry
 *      └────────────┘         │
 *                             ▼
 *      ┌────────────┐    ┌──────────┐
 *      │   Health   │──▶ │ Registry │ (status updates)
 *      └────────────┘    └────┬─────┘
 *                            ▼
 *                    ┌──────────────┐
 *                    │   Router     │ ◀── picks instance for
 *                    └──────┬───────┘     subscribe/query/migrate
 *                           ▼
 *                    ┌────────────────┐
 *                    │ Subscriptions  │
 *                    └────────────────┘
 *
 *      ┌────────────┐    ┌────────────┐
 *      │   Quorum   │    │  Migration │
 *      └────────────┘    └────────────┘
 *
 *      ┌────────────┐
 *      │   Scaler   │──spawn/destroy──▶ user provisioner
 *      └────────────┘
 *  ──────────────────────────────────────────────────────────────────────────
 */

import { EventEmitter } from 'node:events';
import { Registry } from './registry';
import { Discovery, type DiscoveryConfig } from './discovery';
import { HealthMonitor, type HealthConfig } from './health';
import { SubscriptionManager, type CellTransport } from './subscription';
import { QuorumCoordinator, type QuorumConfig, type QuorumTransport } from './quorum';
import { MigrationCoordinator, type MigrationConfig, type MigrationTransport } from './migration';
import { Router, type RoutePolicy } from './routing';
import { Scaler, type ScalingPolicy } from './scaling';
import { CellRef, parseQuiltUri } from './types';

/* ─── config ────────────────────────────────────────────────────────── */

export interface FleetConfig {
  id: string;
  region?: string;
  discovery?: DiscoveryConfig;
  health?: HealthConfig;
  routing?: RoutePolicy;
  quorum?: QuorumConfig;
  migration?: MigrationConfig;
  scaling?: ScalingPolicy;
  transport?: {
    cell?: CellTransport;
    quorum?: QuorumTransport;
    migration?: MigrationTransport;
  };
}

/* ─── public events ─────────────────────────────────────────────────── */

export interface FleetEvent {
  ts: number;
  type: string;
  [k: string]: unknown;
}

export interface FleetEvents {
  start:     [];
  stop:      [];
  error:     [Error];
  instance:  [string, 'added' | 'removed' | 'updated'];
  health:    [string, 'healthy' | 'degraded' | 'unreachable' | 'recovered'];
  scaling:   [string, 'spawn' | 'destroy'];
}

/* ─── the manager ───────────────────────────────────────────────────── */

export class FleetManager extends EventEmitter<FleetEvents> {
  readonly registry:    Registry;
  readonly discovery:   Discovery;
  readonly health:      HealthMonitor;
  readonly subscriptions: SubscriptionManager;
  readonly quorum:      QuorumCoordinator;
  readonly migration:   MigrationCoordinator;
  readonly router:      Router;
  readonly scaler:      Scaler;
  readonly fleetId: string;
  readonly region?: string;
  private readonly cfg: FleetConfig;
  private running = false;

  constructor(cfg: FleetConfig) {
    super();
    if (!cfg.id) throw new Error('FleetManager requires a non-empty `id`');
    this.cfg = cfg;
    this.fleetId = cfg.id;
    this.region = cfg.region;

    this.registry      = new Registry();
    this.discovery     = new Discovery(cfg.discovery ?? {});
    this.health        = new HealthMonitor(cfg.health ?? {});
    this.subscriptions = new SubscriptionManager();
    this.quorum        = new QuorumCoordinator(cfg.quorum ?? {});
    this.migration     = new MigrationCoordinator(cfg.migration ?? {});
    this.router        = new Router(this.registry, cfg.routing ?? {});
    this.scaler        = new Scaler(cfg.scaling ?? { name: 'passive', threshold: 0 });

    this.wire();
  }

  /* ─── lifecycle ──────────────────────────────────────────────────── */

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Bind subsystems to the registry first so discovery events flow.
    if (this.cfg.transport?.cell) {
      this.subscriptions.bind(this.registry, this.router, this.cfg.transport.cell);
    }
    if (this.cfg.transport?.quorum) {
      this.quorum.bind(this.registry, this.cfg.transport.quorum);
    }
    if (this.cfg.transport?.migration) {
      this.migration.bind(this.registry, this.cfg.transport.migration);
    }

    this.health.bind(this.registry);
    this.scaler.bind(this.registry, this.health);

    this.health.start();
    this.scaler.start();
    await this.discovery.start();

    this.emit('start');
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    await this.discovery.stop();
    this.health.stop();
    this.scaler.stop();
    this.emit('stop');
  }

  /* ─── public API ─────────────────────────────────────────────────── */

  async subscribe(uri: string) {
    return this.subscriptions.subscribe(uri);
  }

  async query<T = unknown>(uri: string): Promise<T | null> {
    const ref = parseQuiltUri(uri);
    if (this.quorum.isCritical(uri)) {
      const r = await this.quorum.read<T>(ref);
      return (r.value ?? null) as T | null;
    }
    const inst = this.router.pick(ref);
    if (!inst) return null;
    // In production this would hit the transport; here we return null
    // if no transport is wired.
    if (!this.cfg.transport?.cell) return null;
    // The cell transport implements `subscribe` which can be
    // adapted to a one-shot read by closing after the first value.
    const it = this.cfg.transport.cell.subscribe(inst, ref);
    const first = await it[Symbol.asyncIterator]().next();
    it.close();
    if (first.done) return null;
    return first.value.value as T;
  }

  async migrate(sourceUri: string, targetInstance: string) {
    return this.migration.migrate(sourceUri, targetInstance);
  }

  /** Programmatically add an instance (bypasses discovery). */
  register(input: Parameters<Registry['register']>[0]) {
    return this.registry.register(input);
  }

  /** Apply a scaling decision. */
  async scale(direction: 'up' | 'down' | 'auto', tier?: number) {
    if (direction === 'auto') {
      // run one tick by re-emitting the current policy
      return this.scaler;
    }
    if (direction === 'up') {
      const tierName = (tier ?? 2) as 1 | 2 | 3 | 4 | 5;
      return this.scaler.spawn(tierToNameLocal(tierName), 'manual-scale-up');
    }
    if (direction === 'down') {
      // pick the lowest-loaded healthy instance and destroy it
      const target = this.registry
        .all()
        .filter(i => i.status === 'healthy')
        .sort((a, b) => a.load - b.load)[0];
      if (!target) return null;
      return this.scaler.destroy(target.id, 'manual-scale-down');
    }
    return null;
  }

  /* ─── wiring ─────────────────────────────────────────────────────── */

  private wire(): void {
    // Discovery → Registry
    this.discovery.on('up',      (i) => this.registry.register(i));
    this.discovery.on('updated', (i) => {
      const existing = this.registry.byInstanceName(i.name);
      if (existing) {
        this.registry.update(existing.id, i as any);
      } else {
        this.registry.register(i);
      }
    });
    this.discovery.on('down', (name) => {
      const existing = this.registry.byInstanceName(name);
      if (existing) this.registry.unregister(existing.id);
    });
    this.discovery.on('error', (e) => this.emit('error', e));

    // Registry → FleetManager
    this.registry.on('add',    (i) => this.emit('instance', i.id, 'added'));
    this.registry.on('remove', (i) => this.emit('instance', i.id, 'removed'));
    this.registry.on('update', (i) => this.emit('instance', i.id, 'updated'));

    // Health → Registry (status updates)
    this.health.on('healthy',     (id) => this.applyHealth(id, 'healthy'));
    this.health.on('degraded',    (id) => this.applyHealth(id, 'degraded'));
    this.health.on('unreachable', (id) => this.applyHealth(id, 'unreachable'));
    this.health.on('recovered',   (id) => this.applyHealth(id, 'healthy'));

    // Scaler events
    this.scaler.on('spawn',   (req) => this.emit('scaling', req.tier, 'spawn'));
    this.scaler.on('destroy', (req) => this.emit('scaling', req.instanceId, 'destroy'));
  }

  private applyHealth(id: string, status: 'healthy' | 'degraded' | 'unreachable'): void {
    const inst = this.registry.get(id);
    if (!inst) return;
    this.registry.update(id, { status });
    this.emit('health', id, status);
  }
}

/* ─── local helper ─────────────────────────────────────────────────── */

function tierToNameLocal(t: number): 'esp32' | 'jetson' | 'codespace' | 'cloudflare' | 'server' {
  return (['esp32', 'jetson', 'codespace', 'cloudflare', 'server'][t - 1] ?? 'server') as any;
}
