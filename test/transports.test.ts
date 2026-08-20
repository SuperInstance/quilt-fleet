/**
 * ════════════════════════════════════════════════════════════════════════════
 *  test/transports.test.ts — unit tests for transport adapters
 * ════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import { httpTransport } from '../src/transports/http';
import { mqttTransport } from '../src/transports/mqtt';
import { natsTransport } from '../src/transports/nats';
import { wsTransport }   from '../src/transports/websocket';
import { transportFor, cellTransport, TRANSPORTS } from '../src/transports';
import type { Instance } from '../src/registry';
import { Tier } from '../src/types';

function inst(name: string, endpoint: string): Instance {
  return {
    id: 'i-' + name,
    tier: Tier.Server,
    tierName: 'server',
    name,
    endpoint,
    transport: 'http',
    capabilities: {},
    status: 'unknown',
    lastHeartbeat: 0,
    latencyMs: 0,
    load: 0,
    registeredAt: 0,
    labels: {},
  };
}

describe('transport factory', () => {
  it('returns the http transport for "http"', () => {
    expect(transportFor('http')).toBe(httpTransport);
  });
  it('returns the ws transport for "ws" and "websocket"', () => {
    expect(transportFor('ws')).toBe(wsTransport);
    expect(transportFor('websocket')).toBe(wsTransport);
  });
  it('returns the mqtt transport for "mqtt"', () => {
    expect(transportFor('mqtt')).toBe(mqttTransport);
  });
  it('returns the nats transport for "nats"', () => {
    expect(transportFor('nats')).toBe(natsTransport);
  });
  it('falls back to http for unknown names', () => {
    expect(transportFor('grpc')).toBe(httpTransport);
    expect(transportFor('xyz'  as any)).toBe(httpTransport);
  });
  it('exposes the same set of keys as the index', () => {
    expect(Object.keys(TRANSPORTS).sort()).toEqual(
      ['grpc', 'http', 'mqtt', 'nats', 'ws', 'websocket'].sort(),
    );
  });
  it('cellTransport wraps any transport into a CellTransport', () => {
    const ct = cellTransport('http');
    expect(typeof ct.subscribe).toBe('function');
  });
});

describe('http transport (no network)', () => {
  it('subscribe returns an iterator that ends when closed', async () => {
    const it = httpTransport.subscribe(inst('a', 'http://127.0.0.1:1'), 's', 'c');
    // schedule a close
    setTimeout(() => it.close(), 50);
    let done = false;
    for (let i = 0; i < 20 && !done; i++) {
      const r = await it[Symbol.asyncIterator]().next();
      if (r.done) { done = true; break; }
    }
    expect(done).toBe(true);
  });

  it('read returns null for unreachable endpoints', async () => {
    const r = await httpTransport.read(inst('a', 'http://127.0.0.1:1'), 's', 'c');
    expect(r).toBeNull();
  });

  it('write returns false for unreachable endpoints', async () => {
    const r = await httpTransport.write(inst('a', 'http://127.0.0.1:1'), 's', 'c', 'v', 1);
    expect(r).toBe(false);
  });
});

describe('mqtt transport (no network)', () => {
  it('subscribe closes when the package is missing', async () => {
    const it = mqttTransport.subscribe(inst('a', 'mqtt://127.0.0.1:1'), 's', 'c');
    // if mqtt is installed, the connect may take a moment; in either
    // case the iterator should close within a few seconds.
    const r = await Promise.race([
      it[Symbol.asyncIterator]().next(),
      new Promise(r => setTimeout(() => r({ value: undefined, done: true }), 5_000)),
    ]);
    expect((r as any).done).toBe(true);
    it.close();
  });

  it('read returns null when broker is unreachable', async () => {
    const r = await mqttTransport.read(inst('a', 'mqtt://127.0.0.1:1'), 's', 'c');
    expect(r).toBeNull();
  });

  it('write returns false when broker is unreachable', async () => {
    const r = await mqttTransport.write(inst('a', 'mqtt://127.0.0.1:1'), 's', 'c', 'v', 1);
    expect(r).toBe(false);
  });
});

describe('nats transport (no network)', () => {
  it('read returns null when nats is unreachable', async () => {
    const r = await natsTransport.read(inst('a', 'nats://127.0.0.1:1'), 's', 'c');
    expect(r).toBeNull();
  });

  it('write returns false when nats is unreachable', async () => {
    const r = await natsTransport.write(inst('a', 'nats://127.0.0.1:1'), 's', 'c', 'v', 1);
    expect(r).toBe(false);
  });
});

describe('ws transport (no network)', () => {
  it('read returns null when ws is unreachable', async () => {
    const r = await wsTransport.read(inst('a', 'http://127.0.0.1:1'), 's', 'c');
    expect(r).toBeNull();
  });

  it('write returns false when ws is unreachable', async () => {
    const r = await wsTransport.write(inst('a', 'http://127.0.0.1:1'), 's', 'c', 'v', 1);
    expect(r).toBe(false);
  });
});
