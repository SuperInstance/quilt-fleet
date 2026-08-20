/**
 * ════════════════════════════════════════════════════════════════════════════
 *  transports/mqtt.ts — MQTT transport
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  Used primarily for ESP32. The Quilt MQTT contract is:
 *
 *    subscribe topic:   quilt/<instance>/<sheet>/<cell>
 *    publish topic:     quilt/<instance>/<sheet>/<cell>/set
 *    payload:           { value, version }
 *
 *  The adapter uses the `mqtt` npm package and gracefully no-ops
 *  if the package is not installed.
 *  ──────────────────────────────────────────────────────────────────────────
 */

import type { TransportAdapter } from './index';
import type { Instance } from '../registry';

export const mqttTransport: TransportAdapter = {
  subscribe(instance, sheet, cell) {
    const topic = `quilt/${instance.name}/${sheet}/${cell}`;
    let client: any = null;
    const queue: Array<{ value: unknown; version: number }> = [];
    const waiters: Array<(r: IteratorResult<{ value: unknown; version: number }>) => void> = [];
    let closed = false;

    function cleanup() {
      closed = true;
      try { client?.end(true); } catch { /* ignore */ }
      while (waiters.length) waiters.shift()!({ value: undefined as any, done: true });
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mqtt = require('mqtt') as typeof import('mqtt');
      client = mqtt.connect(instance.endpoint, { connectTimeout: 1_500 });
      client.on('connect', () => {
        try { client.subscribe(topic); } catch { /* ignore */ }
      });
      client.on('message', (t: string, payload: Buffer) => {
        if (t !== topic) return;
        try {
          const m = JSON.parse(payload.toString());
          const ev = { value: m.value, version: m.version ?? 0 };
          const w = waiters.shift();
          if (w) w({ value: ev, done: false });
          else queue.push(ev);
        } catch { /* ignore */ }
      });
      client.on('error',   () => { /* ignore */ });
      client.on('close',   () => { /* ignore */ });
    } catch {
      cleanup();
    }

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
    // One-shot MQTT read by subscribing, getting the first message,
    // and unsubscribing. STUB returns null if `mqtt` is not present.
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mqtt = require('mqtt') as typeof import('mqtt');
      const client = mqtt.connect(instance.endpoint, { connectTimeout: 1_000 });
      return new Promise(resolve => {
        const t = setTimeout(() => { try { client.end(true); } catch {} resolve(null); }, 1_500);
        t.unref?.();
        client.on('connect', () => {
          try { client.subscribe(`quilt/${instance.name}/${sheet}/${cell}`); } catch { /* ignore */ }
        });
        client.on('message', (_t: string, payload: Buffer) => {
          try {
            const m = JSON.parse(payload.toString());
            clearTimeout(t);
            try { client.end(true); } catch { /* ignore */ }
            resolve({ value: m.value, version: m.version ?? 0 });
          } catch { /* ignore */ }
        });
        client.on('error', () => { clearTimeout(t); resolve(null); });
      });
    } catch {
      return null;
    }
  },

  async write(instance, sheet, cell, value, version) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mqtt = require('mqtt') as typeof import('mqtt');
      const client = mqtt.connect(instance.endpoint, { connectTimeout: 1_000 });
      return new Promise(resolve => {
        const t = setTimeout(() => { try { client.end(true); } catch {} resolve(false); }, 1_500);
        t.unref?.();
        client.on('connect', () => {
          try {
            client.publish(
              `quilt/${instance.name}/${sheet}/${cell}/set`,
              JSON.stringify({ value, version }),
              { qos: 1 },
              (err: Error | null) => {
                clearTimeout(t);
                try { client.end(true); } catch { /* ignore */ }
                resolve(!err);
              },
            );
          } catch {
            clearTimeout(t);
            try { client.end(true); } catch { /* ignore */ }
            resolve(false);
          }
        });
        client.on('error', () => { clearTimeout(t); resolve(false); });
      });
    } catch {
      return false;
    }
  },
};
