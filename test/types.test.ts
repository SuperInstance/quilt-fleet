/**
 * ════════════════════════════════════════════════════════════════════════════
 *  test/types.test.ts — unit tests for the shared types
 * ════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import {
  Tier,
  TIER_NAMES,
  tierToName,
  nameToTier,
  parseQuiltUri,
  buildQuiltUri,
} from '../src/types';

describe('types', () => {
  it('exposes five tiers in ascending power order', () => {
    expect(Tier.Esp32).toBe(1);
    expect(Tier.Jetson).toBe(2);
    expect(Tier.Codespace).toBe(3);
    expect(Tier.Cloudflare).toBe(4);
    expect(Tier.Server).toBe(5);
  });

  it('round-trips tier numbers and names', () => {
    for (const n of TIER_NAMES) {
      const t = nameToTier(n);
      expect(tierToName(t)).toBe(n);
    }
  });

  it('falls back to server on unknown tier', () => {
    expect(tierToName(99 as any)).toBe('server');
  });

  it('parses quilt:// URIs', () => {
    const r = parseQuiltUri('quilt://jetson-orin-1/sensors#temperature');
    expect(r.instance).toBe('jetson-orin-1');
    expect(r.sheet).toBe('sensors');
    expect(r.cell).toBe('temperature');
    expect(r.uri).toBe('quilt://jetson-orin-1/sensors#temperature');
  });

  it('builds quilt:// URIs from parts', () => {
    expect(buildQuiltUri('srv', 'vault', 'lock')).toBe('quilt://srv/vault#lock');
  });

  it('throws on invalid URIs', () => {
    expect(() => parseQuiltUri('not-a-uri')).toThrow();
    expect(() => parseQuiltUri('http://foo/bar')).toThrow();
    expect(() => parseQuiltUri('quilt://no-sheet#cell')).toThrow();
  });

  it('handles edge-case instance and cell names', () => {
    const r = parseQuiltUri('quilt://a/b#c');
    expect(r.instance).toBe('a');
    expect(r.sheet).toBe('b');
    expect(r.cell).toBe('c');
  });

  it('handles deep cell paths with slashes inside the cell name', () => {
    // cells may contain slashes
    const r = parseQuiltUri('quilt://srv/vault#a/b/c');
    expect(r.cell).toBe('a/b/c');
  });
});
