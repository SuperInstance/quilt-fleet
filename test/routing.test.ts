/**
 * ════════════════════════════════════════════════════════════════════════════
 *  test/routing.test.ts — unit tests for the Router
 * ════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Router } from '../src/routing';
import { Registry } from '../src/registry';
import { Tier } from '../src/types';

function makeReg(): Registry {
  const r = new Registry();
  r.register({ tier: Tier.Esp32,      name: 'esp-1',  endpoint: 'mqtt://e1',  region: 'us-east-1' });
  r.register({ tier: Tier.Jetson,     name: 'j-east', endpoint: 'http://je',  region: 'us-east-1' });
  r.register({ tier: Tier.Jetson,     name: 'j-eu',   endpoint: 'http://ju',  region: 'eu-west-1' });
  r.register({ tier: Tier.Server,     name: 'srv',    endpoint: 'grpc://s',   region: 'us-east-1' });
  return r;
}

describe('Router', () => {
  let reg: Registry;
  beforeEach(() => { reg = makeReg(); });

  it('picks the lowest tier when no policy is set', () => {
    const r = new Router(reg);
    expect(r.pick({ uri: 'quilt://x/y#z' } as any)?.tier).toBe(Tier.Esp32);
  });

  it('honors tierPreference', () => {
    const r = new Router(reg, { tierPreference: [Tier.Jetson, Tier.Server] });
    const i = r.pick({ uri: 'quilt://x/y#z' } as any);
    expect(i?.tier).toBe(Tier.Jetson);
  });

  it('falls back to all tiers if tierPreference excludes all', () => {
    // Use a tierPreference that has no healthy instance
    // All instances default to status=unknown which is excluded.
    // Mark one as healthy.
    const j = reg.byInstanceName('j-east')!;
    reg.update(j.id, { status: 'healthy' });
    const r = new Router(reg, { tierPreference: [Tier.Server] });
    const i = r.pick({ uri: 'quilt://x/y#z' } as any);
    expect(i).not.toBeNull();
  });

  it('prefers instances in the same region', () => {
    const r = new Router(reg, { preferLocality: true, localityHint: 'eu-west-1' });
    // mark both jetsons as healthy with equal latency
    for (const name of ['j-east', 'j-eu']) {
      const i = reg.byInstanceName(name)!;
      reg.update(i.id, { status: 'healthy', latencyMs: 10 });
    }
    const i = r.pick({ uri: 'quilt://x/y#z' } as any);
    expect(i?.name).toBe('j-eu');
  });

  it('prefers lower latency when locality and tier tie', () => {
    const r = new Router(reg, { tierPreference: [Tier.Jetson] });
    reg.update(reg.byInstanceName('j-east')!.id, { status: 'healthy', latencyMs: 200 });
    reg.update(reg.byInstanceName('j-eu')!.id,   { status: 'healthy', latencyMs: 50  });
    const i = r.pick({ uri: 'quilt://x/y#z' } as any);
    expect(i?.name).toBe('j-eu');
  });

  it('respects loadBalance = least_loaded', () => {
    const r = new Router(reg, { tierPreference: [Tier.Jetson], loadBalance: 'least_loaded' });
    reg.update(reg.byInstanceName('j-east')!.id, { status: 'healthy', load: 0.9, latencyMs: 10 });
    reg.update(reg.byInstanceName('j-eu')!.id,   { status: 'healthy', load: 0.1, latencyMs: 10 });
    const i = r.pick({ uri: 'quilt://x/y#z' } as any);
    expect(i?.name).toBe('j-eu');
  });

  it('cycles round-robin across candidates', () => {
    const r = new Router(reg, { tierPreference: [Tier.Jetson], loadBalance: 'round_robin' });
    reg.update(reg.byInstanceName('j-east')!.id, { status: 'healthy' });
    reg.update(reg.byInstanceName('j-eu')!.id,   { status: 'healthy' });
    const a = r.pick({ uri: 'quilt://x/y#z' } as any)?.name;
    const b = r.pick({ uri: 'quilt://x/y#z' } as any)?.name;
    const c = r.pick({ uri: 'quilt://x/y#z' } as any)?.name;
    expect(a).not.toBe(b);
    expect(c).toBe(a);   // 2 candidates → cycle of 2
  });

  it('pickN returns up to N distinct instances', () => {
    const r = new Router(reg);
    for (const i of reg.all()) reg.update(i.id, { status: 'healthy' });
    const ns = r.pickN({ uri: 'quilt://x/y#z' } as any, 3);
    expect(ns).toHaveLength(3);
    expect(new Set(ns.map(n => n.id)).size).toBe(3);
  });

  it('decide returns rank and considered list', () => {
    const r = new Router(reg, { tierPreference: [Tier.Jetson, Tier.Server] });
    for (const i of reg.all()) reg.update(i.id, { status: 'healthy' });
    const d = r.decide({ uri: 'quilt://x/y#z' } as any);
    expect(d).not.toBeNull();
    expect(d!.rank).toBe(0);
    expect(d!.considered).toHaveLength(3);
  });

  it('returns null when nothing is healthy', () => {
    const r = new Router(reg);
    expect(r.pick({ uri: 'quilt://x/y#z' } as any)).toBeNull();
  });

  it('setPolicy updates policy at runtime', () => {
    const r = new Router(reg);
    r.setPolicy({ tierPreference: [Tier.Server] });
    const i = r.pick({ uri: 'quilt://x/y#z' } as any);
    expect(i?.tier).toBe(Tier.Server);
  });
});
