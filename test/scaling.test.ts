/**
 * ════════════════════════════════════════════════════════════════════════════
 *  test/scaling.test.ts — unit tests for the Scaler
 * ════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Scaler, ScalingPolicy } from '../src/scaling';
import { Registry } from '../src/registry';
import { HealthMonitor } from '../src/health';
import { Tier } from '../src/types';

function makeReg(): Registry {
  const r = new Registry();
  r.register({ tier: Tier.Jetson, name: 'j-1', endpoint: 'http://j1' });
  r.register({ tier: Tier.Jetson, name: 'j-2', endpoint: 'http://j2' });
  return r;
}

describe('Scaler', () => {
  let reg: Registry;
  let health: HealthMonitor;
  let policy: ScalingPolicy;

  beforeEach(() => {
    reg = makeReg();
    health = new HealthMonitor({ probe: async () => ({ ok: true, latencyMs: 5 }) });
    health.bind(reg);
    policy = {
      name: 'load',
      threshold: 0.8,
      min: 1,
      max: 5,
      cooldownMs: 0,
    };
  });

  it('spawns a new instance when load crosses threshold', async () => {
    const calls: any[] = [];
    policy.provisioner = async (req) => { calls.push(req); };
    const s = new Scaler(policy);
    s.bind(reg, health);
    reg.update(reg.byInstanceName('j-1')!.id, { status: 'healthy', load: 0.95 });
    reg.update(reg.byInstanceName('j-2')!.id, { status: 'healthy', load: 0.10 });
    await (s as any).tickLoad();
    expect(calls).toHaveLength(1);
    expect(calls[0].tier).toBe('jetson');
    expect(calls[0].triggeredBy).toBe('load');
  });

  it('destroys an under-used instance', async () => {
    const destroys: any[] = [];
    policy.deprovisioner = async (req) => { destroys.push(req); };
    const s = new Scaler(policy);
    s.bind(reg, health);
    reg.update(reg.byInstanceName('j-1')!.id, { status: 'healthy', load: 0.01 });
    reg.update(reg.byInstanceName('j-2')!.id, { status: 'healthy', load: 0.01 });
    await (s as any).tickLoad();
    expect(destroys).toHaveLength(1);
  });

  it('does nothing when policy is passive', async () => {
    const s = new Scaler({ name: 'passive', threshold: 0 });
    s.bind(reg, health);
    await (s as any).tick();
    expect(reg.size()).toBe(2);
  });

  it('respects max when spawning', async () => {
    policy.max = 2;
    policy.provisioner = async () => {};
    const s = new Scaler(policy);
    s.bind(reg, health);
    reg.update(reg.byInstanceName('j-1')!.id, { status: 'healthy', load: 0.95 });
    reg.update(reg.byInstanceName('j-2')!.id, { status: 'healthy', load: 0.95 });
    await (s as any).tickLoad();
    // no spawn because we're at max
    expect(reg.size()).toBe(2);
  });

  it('respects cooldown between actions', async () => {
    policy.cooldownMs = 60_000;
    const calls: any[] = [];
    policy.provisioner = async (req) => { calls.push(req); };
    const s = new Scaler(policy);
    s.bind(reg, health);
    reg.update(reg.byInstanceName('j-1')!.id, { status: 'healthy', load: 0.95 });
    reg.update(reg.byInstanceName('j-2')!.id, { status: 'healthy', load: 0.10 });
    await (s as any).tickLoad();
    await (s as any).tickLoad();
    expect(calls).toHaveLength(1);   // cooldown blocked the second
  });

  it('manual spawn emits a decision', async () => {
    policy.provisioner = async () => {};
    const s = new Scaler(policy);
    s.bind(reg, health);
    const d = await s.spawn('jetson', 'test', 'us-east-1');
    expect(d.action).toBe('spawn');
    expect(d.tier).toBe('jetson');
  });

  it('manual destroy unregisters the instance', async () => {
    policy.deprovisioner = async () => {};
    const s = new Scaler(policy);
    s.bind(reg, health);
    const id = reg.byInstanceName('j-1')!.id;
    const d = await s.destroy(id, 'test');
    expect(d.action).toBe('destroy');
    expect(reg.get(id)).toBeUndefined();
  });

  it('latency policy spawns when p95 > threshold', async () => {
    const s = new Scaler({ name: 'latency', threshold: 1, latencyMs: 100 });
    s.bind(reg, health);
    // inject a fake p95
    const h = s as any;
    h.health.all = () => [{ instance: reg.byInstanceName('j-1')!.id, state: 'healthy', p95Ms: 200, latencyMs: 5, load: 0, lastHeartbeat: 0, lastUpdate: 0, probes: 0, failures: 0 }];
    const calls: any[] = [];
    (s as any).cfg.provisioner = async (r: any) => { calls.push(r); };
    await h.tickLatency();
    expect(calls).toHaveLength(1);
  });

  it('schedule policy spawns at the configured time', async () => {
    const s = new Scaler({
      name: 'schedule',
      threshold: 0,
      schedule: [{ at: '00:00', tier: 'jetson', count: 5 }],
    });
    s.bind(reg, health);
    const calls: any[] = [];
    (s as any).cfg.provisioner = async (r: any) => { calls.push(r); };
    // fake now
    const realNow = Date.now;
    Date.now = () => new Date('2026-01-01T00:00:30Z').getTime();
    try {
      await (s as any).tickSchedule();
      expect(calls).toHaveLength(1);
    } finally {
      Date.now = realNow;
    }
  });
});
