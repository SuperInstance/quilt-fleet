/**
 * ════════════════════════════════════════════════════════════════════════════
 *  test/tiers.test.ts — unit tests for the tier adapters and profiles
 * ════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import {
  TIER_PROFILES,
  TIER_ADAPTERS,
  adapterFor,
  TierAdapter,
  TierProfile,
} from '../src/tiers';
import { Tier } from '../src/types';

describe('tier profiles', () => {
  const TIERS = ['esp32', 'jetson', 'codespace', 'cloudflare', 'server'] as const;

  for (const t of TIERS) {
    it(`defines a profile for ${t}`, () => {
      const p: TierProfile = TIER_PROFILES[t];
      expect(p).toBeDefined();
      expect(p.name).toBe(t);
      expect(p.tier).toBeGreaterThanOrEqual(1);
      expect(p.tier).toBeLessThanOrEqual(5);
      expect(p.defaultHeartbeatMs).toBeGreaterThan(0);
      expect(p.recommendedCells.length).toBeGreaterThan(0);
    });

    it(`defines an adapter for ${t}`, () => {
      const a: TierAdapter = TIER_ADAPTERS[t];
      expect(a).toBeDefined();
      expect(typeof a.probe).toBe('function');
      expect(typeof a.subscribe).toBe('function');
      expect(typeof a.buildRegistration).toBe('function');
    });
  }

  it('adapterFor returns a known adapter', () => {
    expect(adapterFor('jetson')).toBe(TIER_ADAPTERS.jetson);
    expect(adapterFor('nope' as any)).toBe(TIER_ADAPTERS.server);
  });
});

describe('tier adapter buildRegistration', () => {
  for (const t of ['esp32', 'jetson', 'codespace', 'cloudflare', 'server'] as const) {
    it(`produces a registration for ${t}`, () => {
      const a = TIER_ADAPTERS[t];
      const r = a.buildRegistration('test', 'http://test:4040');
      expect(r.name).toBe('test');
      expect(r.endpoint).toBe('http://test:4040');
      expect(typeof r.tier).toBe('number');
      expect(r.tier).toBeGreaterThanOrEqual(1);
    });

    it(`merges capability overrides for ${t}`, () => {
      const a = TIER_ADAPTERS[t];
      const r = a.buildRegistration('test', 'http://x', { custom: true });
      expect((r.capabilities as any).custom).toBe(true);
    });
  }
});

describe('tier adapter probe (no network)', () => {
  it('reports failure for an unreachable endpoint', async () => {
    const a = TIER_ADAPTERS.jetson;
    const r = await a.probe('http://127.0.0.1:1/');  // nothing listens on :1
    expect(r.ok).toBe(false);
    expect(r.latencyMs).toBeGreaterThan(0);
  });

  it('reports failure for an unreachable MQTT broker', async () => {
    const a = TIER_ADAPTERS.esp32;
    const r = await a.probe('mqtt://127.0.0.1:1');
    expect(r.ok).toBe(false);
  });
});

describe('tier adapter subscribe (no network)', () => {
  it('returns a no-op iterator for esp32 (no broker)', async () => {
    const a = TIER_ADAPTERS.esp32;
    const it = a.subscribe('mqtt://127.0.0.1:1', 's', 'c');
    const first = await it[Symbol.asyncIterator]().next();
    // either it yields nothing, or it closes immediately
    expect(first.done).toBe(true);
    it.close();
  });

  it('returns a no-op iterator for cloudflare (no endpoint)', async () => {
    const a = TIER_ADAPTERS.cloudflare;
    const it = a.subscribe('http://127.0.0.1:1', 's', 'c');
    const first = await it[Symbol.asyncIterator]().next();
    expect(first.done).toBe(true);
    it.close();
  });
});
