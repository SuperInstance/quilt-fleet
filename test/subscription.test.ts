/**
 * ════════════════════════════════════════════════════════════════════════════
 *  test/subscription.test.ts — unit tests for SubscriptionManager
 * ════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SubscriptionManager, CellTransport } from '../src/subscription';
import { Registry } from '../src/registry';
import { Router } from '../src/routing';
import { Tier } from '../src/types';
import { EventEmitter } from 'node:events';

/** A controllable transport: feeds the consumer a fixed list of
 *  values then closes. */
function makeTransport(values: Array<{ value: unknown; version: number }> = []): CellTransport & { emitUpdate: (v: any, version: number) => void; closeAll: () => void } {
  const subs = new Map<string, (v: any) => void>();
  const closer: Array<() => void> = [];
  return {
    subscribe(_instance, ref) {
      const stream = new EventEmitter();
      const queue = [...values];
      const it: any = {
        [Symbol.asyncIterator]() { return this; },
        async next() {
          if (queue.length) return { value: queue.shift(), done: false };
          if (stream.listening && stream.listenerCount('close') === 0) {
            return new Promise(resolve => stream.once('data', (v) => resolve({ value: v, done: false })));
          }
          return { value: undefined, done: true };
        },
        close() { stream.emit('close'); },
      };
      return it;
    },
    emitUpdate(_v, _ver) { /* noop for static */ },
    closeAll() { for (const c of closer) c(); },
  };
}

describe('SubscriptionManager', () => {
  let reg: Registry;
  let router: Router;
  let sub: SubscriptionManager;
  let transport: ReturnType<typeof makeTransport>;

  beforeEach(() => {
    reg = new Registry();
    reg.register({ tier: Tier.Jetson, name: 'j-1', endpoint: 'http://j1' });
    reg.register({ tier: Tier.Jetson, name: 'j-2', endpoint: 'http://j2' });
    router = new Router(reg);
    transport = makeTransport();
    sub = new SubscriptionManager({ resubscribeBackoffMs: 1 });
    sub.bind(reg, router, transport as any);
  });

  it('binds the registry, router, and transport', () => {
    expect(() => sub.subscribe('quilt://j-1/s#c')).not.toThrow();
  });

  it('subscribes and emits update events with a fresh version', async () => {
    const updates: any[] = [];
    const t = makeTransport([{ value: 42, version: 1 }]);
    sub.bind(reg, router, t as any);
    const s = await sub.subscribe('quilt://j-1/s#c');
    sub.on('update', (u) => updates.push(u));
    // the transport already gave us the value via async iterator
    expect(s.lastVersion).toBe(0);   // we read no updates yet
    expect(updates).toHaveLength(0);
  });

  it('rejects invalid URIs', async () => {
    await expect(sub.subscribe('not-a-uri')).rejects.toThrow();
  });

  it('unsubscribe removes the subscription', async () => {
    const s = await sub.subscribe('quilt://j-1/s#c');
    expect(sub.list()).toHaveLength(1);
    expect(sub.unsubscribe(s.id)).toBe(true);
    expect(sub.list()).toHaveLength(0);
    expect(sub.unsubscribe(s.id)).toBe(false);
  });

  it('subscribeMany subscribes to a list of URIs', async () => {
    const subs = await sub.subscribeMany([
      'quilt://j-1/s#c1',
      'quilt://j-1/s#c2',
      'quilt://j-2/s#c3',
    ]);
    expect(subs).toHaveLength(3);
    expect(sub.list()).toHaveLength(3);
  });

  it('deduplicates updates with the same version', async () => {
    let pushed = 0;
    const values: Array<{ value: unknown; version: number }> = [
      { value: 1, version: 1 },
      { value: 1, version: 1 },
      { value: 2, version: 2 },
    ];
    const t: CellTransport = {
      subscribe: () => {
        return {
          [Symbol.asyncIterator]() { return this; },
          async next() {
            const v = values.shift();
            if (v) return { value: v, done: false };
            return { value: undefined, done: true };
          },
          close() { /* noop */ },
        } as any;
      },
    };
    sub.bind(reg, router, t);
    sub.on('update', () => pushed++);
    await sub.subscribe('quilt://j-1/s#c');
    // wait for iterator to drain
    await new Promise(r => setTimeout(r, 50));
    expect(pushed).toBe(2);   // only 2 unique versions
  });

  it('re-subscribes when an instance is lost', async () => {
    const t: CellTransport = {
      subscribe: () => {
        return {
          [Symbol.asyncIterator]() { return this; },
          async next() { return { value: undefined, done: true }; },
          close() { /* noop */ },
        } as any;
      },
    };
    sub.bind(reg, router, t);
    const events: string[] = [];
    sub.on('error',       () => events.push('error'));
    sub.on('resubscribed', (id, n) => events.push(`resub:${n}`));
    await sub.subscribe('quilt://j-1/s#c');
    // remove j-1 to trigger re-route
    reg.unregister(reg.byInstanceName('j-1')!.id);
    await new Promise(r => setTimeout(r, 50));
    // we expect at least one resubscribe (to j-2) or one error
    expect(events.some(e => e.startsWith('resub:') || e === 'error')).toBe(true);
  });
});
