/**
 * ════════════════════════════════════════════════════════════════════════════
 *  test/health.test.ts — unit tests for the HealthMonitor
 * ════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HealthMonitor, ProbeResult } from '../src/health';
import { Registry } from '../src/registry';
import { Tier } from '../src/types';

function makeReg(): Registry {
  const r = new Registry();
  r.register({ tier: Tier.Jetson, name: 'a', endpoint: 'http://a' });
  r.register({ tier: Tier.Jetson, name: 'b', endpoint: 'http://b' });
  return r;
}

describe('HealthMonitor', () => {
  let reg: Registry;
  beforeEach(() => { reg = makeReg(); });

  it('initializes state for every registered instance on bind', () => {
    const m = new HealthMonitor({});
    m.bind(reg);
    expect(m.all()).toHaveLength(2);
    for (const s of m.all()) {
      expect(s.state).toBe('unknown');
      expect(s.probes).toBe(0);
    }
  });

  it('marks instance healthy after a successful probe', async () => {
    const m = new HealthMonitor({
      intervalMs: 10_000,             // we don't want the timer to fire
      probe: async (): Promise<ProbeResult> => ({ ok: true, latencyMs: 5 }),
    });
    m.bind(reg);
    const a = reg.byInstanceName('a')!;
    await (m as any).probeOne(a);
    const s = m.get(a.id);
    expect(s!.state).toBe('healthy');
    expect(s!.probes).toBe(1);
    expect(s!.latencyMs).toBeGreaterThan(0);
  });

  it('marks instance degraded after a failed probe', async () => {
    const m = new HealthMonitor({
      probe: async (): Promise<ProbeResult> => ({ ok: false, latencyMs: 100, message: 'down' }),
    });
    m.bind(reg);
    const a = reg.byInstanceName('a')!;
    await (m as any).probeOne(a);
    expect(m.get(a.id)!.state).toBe('degraded');
  });

  it('marks instance unreachable after N consecutive failures', async () => {
    const m = new HealthMonitor({
      missedBeforeUnreachable: 2,
      probe: async (): Promise<ProbeResult> => ({ ok: false, latencyMs: 100 }),
    });
    m.bind(reg);
    const a = reg.byInstanceName('a')!;
    await (m as any).probeOne(a);
    await (m as any).probeOne(a);
    expect(m.get(a.id)!.state).toBe('unreachable');
  });

  it('recovers when a probe succeeds again', async () => {
    let ok = false;
    const m = new HealthMonitor({
      missedBeforeUnreachable: 1,
      probe: async (): Promise<ProbeResult> => ok
        ? { ok: true,  latencyMs: 5 }
        : { ok: false, latencyMs: 5 },
    });
    m.bind(reg);
    const a = reg.byInstanceName('a')!;
    await (m as any).probeOne(a);
    expect(m.get(a.id)!.state).toBe('unreachable');
    ok = true;
    await (m as any).probeOne(a);
    expect(m.get(a.id)!.state).toBe('healthy');
  });

  it('degrades on high latency', async () => {
    const m = new HealthMonitor({
      degradedLatencyMs: 50,
      probe: async (): Promise<ProbeResult> => ({ ok: true, latencyMs: 100 }),
    });
    m.bind(reg);
    const a = reg.byInstanceName('a')!;
    // first probe initializes EWMA
    await (m as any).probeOne(a);
    // second probe nudges EWMA past threshold
    await (m as any).probeOne(a);
    await (m as any).probeOne(a);
    expect(m.get(a.id)!.state).toBe('degraded');
  });

  it('totals counts instances by state', async () => {
    const m = new HealthMonitor({
      probe: async (i): Promise<ProbeResult> => ({
        ok: i.name !== 'a',
        latencyMs: 5,
      }),
    });
    m.bind(reg);
    for (const i of reg.all()) await (m as any).probeOne(i);
    const t = m.totals();
    expect(t.healthy).toBe(1);
    expect(t.degraded).toBe(1);
  });

  it('removes state when an instance is removed from the registry', async () => {
    const m = new HealthMonitor({});
    m.bind(reg);
    const a = reg.byInstanceName('a')!;
    expect(m.get(a.id)).toBeDefined();
    reg.unregister(a.id);
    expect(m.get(a.id)).toBeUndefined();
  });

  it('fires the recovered event on a bounce back to healthy', async () => {
    let ok = false;
    const m = new HealthMonitor({
      missedBeforeUnreachable: 1,
      probe: async (): Promise<ProbeResult> => ok
        ? { ok: true,  latencyMs: 5 }
        : { ok: false, latencyMs: 5 },
    });
    const events: string[] = [];
    m.on('unreachable', () => events.push('unreachable'));
    m.on('recovered',   () => events.push('recovered'));
    m.bind(reg);
    const a = reg.byInstanceName('a')!;
    await (m as any).probeOne(a);
    ok = true;
    await (m as any).probeOne(a);
    expect(events).toEqual(['unreachable', 'recovered']);
  });

  it('exposes a p95 latency', async () => {
    const m = new HealthMonitor({
      probe: async (): Promise<ProbeResult> => ({ ok: true, latencyMs: 10 }),
    });
    m.bind(reg);
    const a = reg.byInstanceName('a')!;
    for (let i = 0; i < 20; i++) await (m as any).probeOne(a);
    const s = m.get(a.id)!;
    expect(s.p95Ms).toBeGreaterThanOrEqual(0);
  });
});
