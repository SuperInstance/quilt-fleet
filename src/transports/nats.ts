/**
 * ════════════════════════════════════════════════════════════════════════════
 *  transports/nats.ts — NATS transport
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  Used for server-tier instances that want at-most-once delivery
 *  and JetStream for replay. The Quilt NATS contract is:
 *
 *    subject:   quilt.<instance>.<sheet>.<cell>
 *    publish:   JSON { value, version }
 *  ──────────────────────────────────────────────────────────────────────────
 */

import type { TransportAdapter } from './index';
import type { Instance } from '../registry';

export const natsTransport: TransportAdapter = {
  subscribe(instance, sheet, cell) {
    const subj = `quilt.${instance.name}.${sheet}.${cell}`;
    let nc: any = null;
    let sub: any = null;
    const queue: Array<{ value: unknown; version: number }> = [];
    const waiters: Array<(r: IteratorResult<{ value: unknown; version: number }>) => void> = [];
    let closed = false;

    function cleanup() {
      closed = true;
      try { sub?.unsubscribe?.(); } catch { /* ignore */ }
      try { nc?.close?.();    } catch { /* ignore */ }
      while (waiters.length) waiters.shift()!({ value: undefined as any, done: true });
    }

    (async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const nats = require('nats') as typeof import('nats');
        nc = await nats.connect({ servers: instance.endpoint, timeout: 1_500 });
        sub = nc.subscribe(subj);
        for await (const msg of sub) {
          if (closed) break;
          try {
            const m = JSON.parse(nats.decode(msg.data));
            const ev = { value: m.value, version: m.version ?? 0 };
            const w = waiters.shift();
            if (w) w({ value: ev, done: false });
            else queue.push(ev);
          } catch { /* ignore */ }
        }
      } catch {
        cleanup();
      }
    })();

    const it: AsyncIterable<{ value: unknown; version: number }> & { close(): void } = {
      [Symbol.asyncIterator]() { return this; },
      async next() {
        if (closed && queue.length === 0) return { value: undefined as any, done: true };
        if (queue.length) return { value: queue.shift()!, done: false };
        return new Promise(r => waiters.push(r));
      },
      close() { cleanup(); },
    };
    return it;
  },

  async read(instance, sheet, cell) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const nats = require('nats') as typeof import('nats');
      const nc = await nats.connect({ servers: instance.endpoint, timeout: 1_000 });
      try {
        const m = await nc.request(`quilt.${instance.name}.${sheet}.${cell}.get`, undefined, { timeout: 1_000 });
        const body = JSON.parse(nats.decode(m.data));
        return { value: body.value, version: body.version ?? 0 };
      } finally {
        try { await nc.close(); } catch { /* ignore */ }
      }
    } catch {
      return null;
    }
  },

  async write(instance, sheet, cell, value, version) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const nats = require('nats') as typeof import('nats');
      const nc = await nats.connect({ servers: instance.endpoint, timeout: 1_000 });
      try {
        nc.publish(
          `quilt.${instance.name}.${sheet}.${cell}.set`,
          nats.encode(JSON.stringify({ value, version })),
        );
        await nc.flush();
        return true;
      } finally {
        try { await nc.close(); } catch { /* ignore */ }
      }
    } catch {
      return false;
    }
  },
};
