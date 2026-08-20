/**
 * ════════════════════════════════════════════════════════════════════════════
 *  test/registry.test.ts — unit tests for the instance registry
 * ════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Registry, RegisterInput } from '../src/registry';
import { Tier } from '../src/types';

function makeReg(): Registry {
  return new Registry();
}

function populate(reg: Registry): void {
  reg.register({ tier: Tier.Esp32,      name: 'esp32-a',     endpoint: 'mqtt://10.0.0.1:1883',  region: 'us-east-1' });
  reg.register({ tier: Tier.Jetson,     name: 'jetson-1',    endpoint: 'http://10.0.0.2:4040',  region: 'us-east-1' });
  reg.register({ tier: Tier.Jetson,     name: 'jetson-2',    endpoint: 'http://10.0.0.3:4040',  region: 'eu-west-1' });
  reg.register({ tier: Tier.Cloudflare, name: 'cf-edge',     endpoint: 'https://quilt.workers.dev' });
  reg.register({ tier: Tier.Server,     name: 'srv-primary', endpoint: 'grpc://srv.internal:7070', region: 'us-east-1' });
}

describe('Registry', () => {
  let reg: Registry;
  beforeEach(() => { reg = makeReg(); });

  it('registers an instance and assigns a 26-char id', () => {
    const i = reg.register({ tier: Tier.Jetson, name: 'j-1', endpoint: 'http://x:4040' });
    expect(i.id).toHaveLength(26);
    expect(i.tierName).toBe('jetson');
    expect(i.status).toBe('unknown');
  });

  it('rejects invalid names', () => {
    expect(() => reg.register({ tier: 1, name: '',         endpoint: 'http://x' })).toThrow();
    expect(() => reg.register({ tier: 1, name: 'Bad_Name', endpoint: 'http://x' })).toThrow();
    expect(() => reg.register({ tier: 1, name: '-leading',  endpoint: 'http://x' })).toThrow();
  });

  it('rejects invalid endpoints', () => {
    expect(() => reg.register({ tier: 1, name: 'ok', endpoint: ''        })).toThrow();
    expect(() => reg.register({ tier: 1, name: 'ok', endpoint: 'no-scheme' })).toThrow();
  });

  it('rejects out-of-range tiers', () => {
    expect(() => reg.register({ tier: 0 as Tier, name: 'a', endpoint: 'http://x' })).toThrow();
    expect(() => reg.register({ tier: 9 as Tier, name: 'b', endpoint: 'http://x' })).toThrow();
  });

  it('accepts tier as a name', () => {
    const i = reg.register({ tier: 'esp32', name: 'esp-a', endpoint: 'mqtt://x' });
    expect(i.tier).toBe(1);
    expect(i.tierName).toBe('esp32');
  });

  it('updates on duplicate name registration', () => {
    reg.register({ tier: Tier.Jetson, name: 'j-1', endpoint: 'http://a:1' });
    const i = reg.register({ tier: Tier.Jetson, name: 'j-1', endpoint: 'http://b:2' });
    expect(reg.size()).toBe(1);
    expect(i.endpoint).toBe('http://b:2');
  });

  it('looks up by id and by name', () => {
    const i = reg.register({ tier: Tier.Jetson, name: 'j-1', endpoint: 'http://a:1' });
    expect(reg.get(i.id)).toBe(i);
    expect(reg.byInstanceName('j-1')).toBe(i);
    expect(reg.byInstanceName('J-1')).toBe(i); // case-insensitive
  });

  it('emits add and update events', () => {
    const events: string[] = [];
    reg.on('add',    () => events.push('add'));
    reg.on('update', () => events.push('update'));
    const i = reg.register({ tier: Tier.Jetson, name: 'j-1', endpoint: 'http://a:1' });
    reg.update(i.id, { latencyMs: 12 });
    expect(events).toEqual(['add', 'update']);
  });

  it('emits status on status change only', () => {
    const events: string[] = [];
    reg.on('status', () => events.push('status'));
    const i = reg.register({ tier: Tier.Jetson, name: 'j-1', endpoint: 'http://a:1' });
    reg.update(i.id, { status: 'healthy' });
    reg.update(i.id, { status: 'healthy' });
    reg.update(i.id, { status: 'degraded' });
    expect(events).toHaveLength(2);
  });

  it('re-buckets when tier changes', () => {
    const i = reg.register({ tier: Tier.Esp32, name: 'a', endpoint: 'http://a' });
    expect(reg.list({ tier: Tier.Esp32 })).toHaveLength(1);
    reg.update(i.id, { tier: Tier.Server });
    expect(reg.list({ tier: Tier.Esp32 })).toHaveLength(0);
    expect(reg.list({ tier: Tier.Server })).toHaveLength(1);
  });

  it('re-buckets when region changes', () => {
    const i = reg.register({ tier: Tier.Server, name: 'a', endpoint: 'http://a', region: 'us-east-1' });
    expect(reg.list({ region: 'us-east-1' })).toHaveLength(1);
    reg.update(i.id, { region: 'eu-west-1' });
    expect(reg.list({ region: 'us-east-1' })).toHaveLength(0);
    expect(reg.list({ region: 'eu-west-1' })).toHaveLength(1);
  });

  it('removes an instance', () => {
    const i = reg.register({ tier: Tier.Jetson, name: 'j-1', endpoint: 'http://a' });
    reg.unregister(i.id);
    expect(reg.get(i.id)).toBeUndefined();
    expect(reg.size()).toBe(0);
  });

  it('filters by status, region, label, tier, and limit', () => {
    populate(reg);
    reg.update(reg.byInstanceName('srv-primary')!.id, { status: 'healthy' });
    reg.update(reg.byInstanceName('jetson-1')!.id,    { status: 'degraded' });
    expect(reg.list({ status: 'healthy' })).toHaveLength(1);
    expect(reg.list({ status: ['healthy', 'degraded'] })).toHaveLength(2);
    expect(reg.list({ region: 'us-east-1' })).toHaveLength(3);
    expect(reg.list({ tier: Tier.Jetson })).toHaveLength(2);
    expect(reg.list({ tier: ['jetson', 'server'] as any })).toHaveLength(3);
    expect(reg.list({ limit: 2 })).toHaveLength(2);
  });

  it('sorts owners of a cell by tier then latency', () => {
    populate(reg);
    const owners = reg.ownersOfCell({ uri: 'quilt://x/y#z' } as any);
    expect(owners[0]!.tier).toBeLessThanOrEqual(owners[owners.length - 1]!.tier);
  });

  it('toJSON includes all instances', () => {
    populate(reg);
    const j = reg.toJSON();
    expect(j.instances).toHaveLength(5);
  });
});
