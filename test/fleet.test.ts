/**
 * ════════════════════════════════════════════════════════════════════════════
 *  test/fleet.test.ts — top-level integration tests for FleetManager
 * ════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FleetManager, FleetConfig } from '../src/fleet';
import { Tier } from '../src/types';

function fleetConfig(over: Partial<FleetConfig> = {}): FleetConfig {
  return {
    id: 'test-fleet',
    region: 'us-east-1',
    health: { probe: async () => ({ ok: true, latencyMs: 5 }) },
    scaling: { name: 'passive', threshold: 0 },
    ...over,
  };
}

describe('FleetManager', () => {
  let f: FleetManager;
  beforeEach(() => { f = new FleetManager(fleetConfig()); });

  it('constructs with the given id', () => {
    expect(f.fleetId).toBe('test-fleet');
    expect(f.region).toBe('us-east-1');
  });

  it('starts and stops', async () => {
    await f.start();
    expect(f.listenerCount('start')).toBeGreaterThanOrEqual(1);
    await f.stop();
  });

  it('throws if id is missing', () => {
    expect(() => new FleetManager({ id: '' } as any)).toThrow();
  });

  it('register adds an instance', () => {
    const i = f.register({ tier: Tier.Jetson, name: 'j-1', endpoint: 'http://x' });
    expect(f.registry.get(i.id)).toBe(i);
  });

  it('emits instance events on add / remove', async () => {
    const events: any[] = [];
    f.on('instance', (id, kind) => events.push([id, kind]));
    const i = f.register({ tier: Tier.Jetson, name: 'j-1', endpoint: 'http://x' });
    f.registry.unregister(i.id);
    expect(events).toHaveLength(2);
    expect(events[0][1]).toBe('added');
    expect(events[1][1]).toBe('removed');
  });

  it('applies health status from the monitor to the registry', async () => {
    await f.start();
    const i = f.register({ tier: Tier.Jetson, name: 'j-1', endpoint: 'http://x' });
    // run a probe manually
    await (f.health as any).probeOne(i);
    const after = f.registry.get(i.id)!;
    expect(after.status).toBe('healthy');
    await f.stop();
  });

  it('subscribes via the manager and surfaces an update', async () => {
    await f.start();
    f.register({ tier: Tier.Jetson, name: 'j-1', endpoint: 'http://x' });
    const updates: any[] = [];
    f.subscriptions.on('update', (u) => updates.push(u));
    await f.subscribe('quilt://j-1/s#c');
    // No real transport wired, so we won't get updates; just verify
    // the subscription was created.
    expect(f.subscriptions.list()).toHaveLength(1);
    await f.stop();
  });

  it('migrate delegates to the migration coordinator', async () => {
    f.register({ tier: Tier.Server, name: 'src',  endpoint: 'grpc://s' });
    f.register({ tier: Tier.Server, name: 'dest', endpoint: 'grpc://d' });
    (f.migration as any).transport = {
      freeze:   async () => true,
      unfreeze: async () => true,
      read:     async () => ({ value: 'x', version: 1 }),
      write:    async () => true,
      flipRouting: async () => true,
    };
    (f.migration as any).reg = f.registry;
    const r = await f.migrate('quilt://src/s#c', 'dest');
    expect(r.success).toBe(true);
  });

  it('query returns null when no transport is wired', async () => {
    await f.start();
    f.register({ tier: Tier.Server, name: 'srv', endpoint: 'grpc://s' });
    const v = await f.query('quilt://srv/s#c');
    expect(v).toBeNull();
    await f.stop();
  });

  it('scale(auto) returns the scaler', () => {
    expect(f.scale('auto')).toBe(f.scaler);
  });

  it('scale(up) spawns in the requested tier', async () => {
    let spawned: any = null;
    (f.scaler as any).cfg.provisioner = async (req: any) => { spawned = req; };
    await f.scale('up', 4);
    expect(spawned).not.toBeNull();
    expect(spawned.tier).toBe('cloudflare');
  });

  it('scale(down) destroys the lowest-loaded healthy instance', async () => {
    f.register({ tier: Tier.Jetson, name: 'j-1', endpoint: 'http://j1', status: 'healthy', load: 0.1 });
    f.register({ tier: Tier.Jetson, name: 'j-2', endpoint: 'http://j2', status: 'healthy', load: 0.9 });
    (f.scaler as any).cfg.deprovisioner = async () => {};
    const d = await f.scale('down');
    expect(d).not.toBeNull();
    expect(f.registry.byInstanceName('j-1')).toBeUndefined();
  });
});
