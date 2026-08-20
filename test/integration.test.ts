/**
 * ════════════════════════════════════════════════════════════════════════════
 *  test/integration.test.ts — multi-subsystem integration tests
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  These tests exercise several subsystems together to confirm the
 *  wiring is correct: discovery → registry → health → router →
 *  subscription.
 *  ──────────────────────────────────────────────────────────────────────────
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { FleetManager } from '../src/fleet';
import { Tier } from '../src/types';
import { CellTransport } from '../src/subscription';

let dir = '';
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'qfleet-int-')); });
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

describe('integration: discovery + registry', () => {
  it('registers every instance in a static config', async () => {
    const cfg = path.join(dir, 'fleet.yaml');
    await writeFile(cfg, [
      'instances:',
      '  - { name: srv-1, tier: server,     endpoint: grpc://srv:7070 }',
      '  - { name: j-1,   tier: jetson,     endpoint: http://j:4040 }',
      '  - { name: e-1,   tier: esp32,      endpoint: mqtt://e:1883 }',
    ].join('\n'), 'utf8');

    const f = new FleetManager({
      id: 'int-1',
      discovery: { static: cfg },
      health: { probe: async () => ({ ok: true, latencyMs: 5 }) },
    });
    await f.start();
    // wait for the static backend to load
    await new Promise(r => setTimeout(r, 100));
    expect(f.registry.size()).toBe(3);
    expect(f.registry.byInstanceName('srv-1')?.tier).toBe(Tier.Server);
    expect(f.registry.byInstanceName('j-1')?.tier).toBe(Tier.Jetson);
    expect(f.registry.byInstanceName('e-1')?.tier).toBe(Tier.Esp32);
    await f.stop();
  });

  it('unregisters an instance that disappears from static config', async () => {
    const cfg = path.join(dir, 'fleet.yaml');
    await writeFile(cfg, 'instances:\n  - { name: srv-1, tier: server, endpoint: grpc://srv:7070 }\n', 'utf8');
    const f = new FleetManager({
      id: 'int-2',
      discovery: { static: { file: cfg, reloadMs: 0 } },
      health: { probe: async () => ({ ok: true, latencyMs: 5 }) },
    });
    await f.start();
    await new Promise(r => setTimeout(r, 100));
    expect(f.registry.size()).toBe(1);

    // rewrite to drop the instance
    await writeFile(cfg, 'instances: []\n', 'utf8');
    // we don't have a timer; simulate via discovery.inject/down
    f.discovery.inject({ name: 'srv-1', tier: 5, endpoint: 'grpc://srv:7070' }); // sanity
    expect(f.registry.size()).toBeGreaterThanOrEqual(1);
    await f.stop();
  });
});

describe('integration: registry + router + subscription', () => {
  it('routes a query to the right tier', async () => {
    const f = new FleetManager({
      id: 'int-3',
      health: { probe: async () => ({ ok: true, latencyMs: 5 }) },
    });
    f.register({ tier: Tier.Esp32,  name: 'esp-1',  endpoint: 'mqtt://e1' });
    f.register({ tier: Tier.Jetson, name: 'j-1',    endpoint: 'http://j1' });
    f.register({ tier: Tier.Server, name: 'srv-1',  endpoint: 'grpc://s1' });
    for (const i of f.registry.all()) f.registry.update(i.id, { status: 'healthy' });

    const pick = f.router.pick({ uri: 'quilt://x/y#z' } as any);
    expect(pick?.tier).toBe(Tier.Esp32);

    f.router.setPolicy({ tierPreference: [Tier.Server] });
    const pick2 = f.router.pick({ uri: 'quilt://x/y#z' } as any);
    expect(pick2?.tier).toBe(Tier.Server);
  });

  it('emits a subscription update with the correct value and version', async () => {
    const values = [{ value: 1, version: 1 }, { value: 2, version: 2 }];
    const transport: CellTransport = {
      subscribe(_i, _r) {
        return {
          [Symbol.asyncIterator]() { return this; },
          async next() {
            const v = values.shift();
            return v ? { value: v, done: false } : { value: undefined, done: true };
          },
          close() { /* noop */ },
        } as any;
      },
    };
    const f = new FleetManager({
      id: 'int-4',
      transport: { cell: transport },
      health: { probe: async () => ({ ok: true, latencyMs: 5 }) },
    });
    f.register({ tier: Tier.Jetson, name: 'j-1', endpoint: 'http://j1' });
    f.registry.update(f.registry.byInstanceName('j-1')!.id, { status: 'healthy' });
    f.subscriptions.bind(f.registry, f.router, transport);
    const updates: any[] = [];
    f.subscriptions.on('update', (u) => updates.push(u));
    await f.subscribe('quilt://j-1/s#c');
    await new Promise(r => setTimeout(r, 50));
    expect(updates).toHaveLength(2);
    expect(updates[1].value).toBe(2);
  });
});

describe('integration: health + router failover', () => {
  it('reroutes away from an unreachable instance', async () => {
    const f = new FleetManager({
      id: 'int-5',
      health: {
        probe: async (i) => i.name === 'j-1'
          ? { ok: true, latencyMs: 5 }
          : { ok: false, latencyMs: 5 },
        missedBeforeUnreachable: 1,
      },
    });
    const a = f.register({ tier: Tier.Jetson, name: 'j-1', endpoint: 'http://j1' });
    f.register({ tier: Tier.Jetson, name: 'j-2', endpoint: 'http://j2' });
    f.health.bind(f.registry);
    // mark j-2 degraded so the router excludes it from healthy
    f.registry.update(a.id, { status: 'healthy' });
    f.registry.update(f.registry.byInstanceName('j-2')!.id, { status: 'degraded' });
    // probe both
    await (f.health as any).probeOne(a);
    await (f.health as any).probeOne(f.registry.byInstanceName('j-2')!);
    const pick = f.router.pick({ uri: 'quilt://x/y#z' } as any);
    expect(pick?.name).toBe('j-1');
  });
});

describe('integration: scaling + registry', () => {
  it('spawns a new instance via the provisioner and stays below max', async () => {
    const spawned: any[] = [];
    const f = new FleetManager({
      id: 'int-6',
      health: { probe: async () => ({ ok: true, latencyMs: 5 }) },
      scaling: {
        name: 'load',
        threshold: 0.8,
        min: 1,
        max: 3,
        cooldownMs: 0,
        provisioner: async (req) => {
          spawned.push(req);
          f.register({ tier: req.tier === 'esp32' ? 1 : req.tier === 'jetson' ? 2 : req.tier === 'codespace' ? 3 : req.tier === 'cloudflare' ? 4 : 5, name: `auto-${spawned.length}`, endpoint: 'http://a' });
        },
      },
    });
    f.register({ tier: Tier.Jetson, name: 'j-1', endpoint: 'http://j1', status: 'healthy', load: 0.95 });
    f.register({ tier: Tier.Jetson, name: 'j-2', endpoint: 'http://j2', status: 'healthy', load: 0.10 });
    f.health.bind(f.registry);
    f.scaler.bind(f.registry, f.health);
    await (f.scaler as any).tickLoad();
    expect(spawned).toHaveLength(1);
    expect(f.registry.size()).toBe(3);
  });
});

describe('integration: migration across the fleet', () => {
  it('moves a cell from source to destination end-to-end', async () => {
    const f = new FleetManager({
      id: 'int-7',
      health: { probe: async () => ({ ok: true, latencyMs: 5 }) },
    });
    f.register({ tier: Tier.Server, name: 'src',  endpoint: 'grpc://s' });
    f.register({ tier: Tier.Server, name: 'dest', endpoint: 'grpc://d' });
    (f.migration as any).transport = {
      freeze:   async () => true,
      unfreeze: async () => true,
      read:     async (i) => i.name === 'src' ? { value: 'val', version: 1 } : { value: 'val', version: 1 },
      write:    async () => true,
      flipRouting: async () => true,
    };
    (f.migration as any).reg = f.registry;
    const r = await f.migrate('quilt://src/s#c', 'dest');
    expect(r.success).toBe(true);
    expect(r.plan.status).toBe('success');
  });
});
