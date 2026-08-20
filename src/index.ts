/**
 * ════════════════════════════════════════════════════════════════════════════
 *  @quilt/fleet — federation across Quilt tiers
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  This is the public entry point of `quilt-fleet`, the 18th Quilt
 *  repository. It is responsible for orchestrating *multiple* Quilt
 *  instances — across tiers (ESP32, Jetson, Codespace, Cloudflare,
 *  Server) — as a single, addressable federation.
 *
 *  While `@quilt/core` defines the cell model and `@quilt/sdk` lets a
 *  single process read and write cells, real deployments need dozens
 *  of Quilt instances running on vastly different hardware. This
 *  package is the conductor that keeps them in sync.
 *
 *  ─── Public surface ───────────────────────────────────────────────────────
 *
 *  - {@link FleetManager}       top-level orchestrator, lifecycle, wiring
 *  - {@link Registry}           instance bookkeeping
 *  - {@link Discovery}          Bonjour / DNS-SD / static config
 *  - {@link Health}             heartbeat, latency, status
 *  - {@link Subscription}       cross-instance cell subscription
 *  - {@link Quorum}             majority vote across N replicas
 *  - {@link Migration}          two-phase cell move
 *  - {@link Router}             pick best instance for a query
 *  - {@link Scaler}             policy-driven instance spawn / destroy
 *  - tier adapters:             esp32, jetson, codespace, cloudflare, server
 *  - transport adapters:        http, websocket, mqtt, nats
 *  - API surfaces:              REST, GraphQL, gRPC
 *
 *  ─── Example ──────────────────────────────────────────────────────────────
 *
 *  ```ts
 *  import { FleetManager, Tier } from '@quilt/fleet';
 *
 *  const fleet = new FleetManager({
 *    id: 'main',
 *    discovery: { bonjour: true, static: './fleet.yaml' },
 *  });
 *
 *  await fleet.start();
 *  await fleet.registry.register({
 *    tier: Tier.Jetson,
 *    name: 'jetson-orin-1',
 *    endpoint: 'http://jetson.local:4040',
 *  });
 *
 *  const sub = await fleet.subscribe(
 *    'quilt://jetson-orin-1/sensors#temperature'
 *  );
 *  sub.on('update', (v) => console.log('cell updated', v));
 *
 *  await fleet.shutdown();
 *  ```
 *
 *  See `docs/architecture.md` for the full layered view.
 *  ──────────────────────────────────────────────────────────────────────────
 */

// ─── core types ────────────────────────────────────────────────────────────
export * from './types';

// ─── top-level orchestrator ────────────────────────────────────────────────
export { FleetManager } from './fleet';
export type { FleetConfig, FleetEvent } from './fleet';

// ─── subsystems ────────────────────────────────────────────────────────────
export { Registry } from './registry';
export type { Instance, InstancePatch, Tier as InstanceTier } from './registry';

export { Discovery } from './discovery';
export type { DiscoveryConfig, DiscoveryEvent } from './discovery';

export { HealthMonitor } from './health';
export type { HealthSnapshot, HealthState } from './health';

export { SubscriptionManager } from './subscription';
export type { Subscription, SubscriptionEvent } from './subscription';

export { QuorumCoordinator } from './quorum';
export type { QuorumResult, QuorumConfig } from './quorum';

export { MigrationCoordinator } from './migration';
export type { MigrationPlan, MigrationResult } from './migration';

export { Router } from './routing';
export type { RouteDecision, RoutePolicy } from './routing';

export { Scaler } from './scaling';
export type { ScalingPolicy, ScalingDecision } from './scaling';

// ─── tier adapters ─────────────────────────────────────────────────────────
export * as Tiers from './tiers';

// ─── transport adapters ────────────────────────────────────────────────────
export * as Transports from './transports';

// ─── API surfaces ──────────────────────────────────────────────────────────
export { createRestApp } from './api/rest';
export { createGraphQLSchema } from './api/graphql';
export { createGrpcServer } from './api/grpc';

// ─── CLI ───────────────────────────────────────────────────────────────────
export { runCli } from './cli';

// ─── version ───────────────────────────────────────────────────────────────
export const VERSION = '0.1.0';
export const NAME = '@quilt/fleet';
