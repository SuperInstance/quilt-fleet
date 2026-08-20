/**
 * ════════════════════════════════════════════════════════════════════════════
 *  transports/websocket.ts — WebSocket transport
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  Used for Jetson and other long-lived instances that benefit from
 *  push-based updates instead of polling. The adapter opens a single
 *  WebSocket per cell subscription; the server pushes updates as
 *  JSON messages.
 *
 *  Wire format
 *  ───────────
 *   client → server:   { op: "subscribe", sheet, cell, since?: version }
 *   server → client:   { op: "update",   sheet, cell, value, version }
 *                       { op: "error",   message }
 *  ──────────────────────────────────────────────────────────────────────────
 */

import type { TransportAdapter } from './index';
import type { Instance } from '../registry';

export const wsTransport: TransportAdapter = {
  subscribe(instance, sheet, cell) {
    const base = instance.endpoint.replace(/^http/, 'ws').replace(/\/$/, '');
    const url = `${base}/ws/cell?sheet=${encodeURIComponent(sheet)}&cell=${encodeURIComponent(cell)}`;

    let ws: any = null;
    const queue: Array<{ value: unknown; version: number }> = [];
    const waiters: Array<(r: IteratorResult<{ value: unknown; version: number }>) => void> = [];
    let closed = false;

    function cleanup() {
      closed = true;
      try { ws?.close(); } catch { /* ignore */ }
      while (waiters.length) waiters.shift()!({ value: undefined as any, done: true });
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const WebSocket = require('ws');
      ws = new WebSocket(url);
      ws.on('open', () => {
        try { ws.send(JSON.stringify({ op: 'subscribe', sheet, cell })); } catch { /* ignore */ }
      });
      ws.on('message', (raw: any) => {
        try {
          const m = JSON.parse(raw.toString());
          if (m.op === 'update' && m.sheet === sheet && m.cell === cell) {
            const ev = { value: m.value, version: m.version ?? 0 };
            const w = waiters.shift();
            if (w) w({ value: ev, done: false });
            else queue.push(ev);
          }
        } catch { /* ignore */ }
      });
      ws.on('error', () => { /* ignore, cleanup happens via close */ });
      ws.on('close', cleanup);
    } catch {
      cleanup();
    }

    const it: AsyncIterable<{ value: unknown; version: number }> & { close(): void } = {
      [Symbol.asyncIterator]() { return this; },
      async next() {
        if (closed && queue.length === 0) {
          return { value: undefined as any, done: true };
        }
        if (queue.length) {
          return { value: queue.shift()!, done: false };
        }
        return new Promise(r => waiters.push(r));
      },
      close() { cleanup(); },
    };
    return it;
  },

  async read(instance, sheet, cell) {
    // The WS adapter delegates to a short-lived socket for reads.
    return new Promise(resolve => {
      try {
        const base = instance.endpoint.replace(/^http/, 'ws').replace(/\/$/, '');
        const url = `${base}/ws/cell?sheet=${encodeURIComponent(sheet)}&cell=${encodeURIComponent(cell)}`;
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const WebSocket = require('ws');
        const ws = new WebSocket(url);
        const t = setTimeout(() => { try { ws.close(); } catch {} resolve(null); }, 1_500);
        t.unref?.();
        ws.on('open', () => {
          try { ws.send(JSON.stringify({ op: 'read', sheet, cell })); } catch { /* ignore */ }
        });
        ws.on('message', (raw: any) => {
          try {
            const m = JSON.parse(raw.toString());
            if (m.op === 'value' && m.sheet === sheet && m.cell === cell) {
              clearTimeout(t);
              try { ws.close(); } catch { /* ignore */ }
              resolve({ value: m.value, version: m.version ?? 0 });
            }
          } catch { /* ignore */ }
        });
        ws.on('error', () => { clearTimeout(t); resolve(null); });
        ws.on('close', () => { clearTimeout(t); if (!ws.listenerCount('message')) resolve(null); });
      } catch {
        resolve(null);
      }
    });
  },

  async write(instance, sheet, cell, value, version) {
    return new Promise(resolve => {
      try {
        const base = instance.endpoint.replace(/^http/, 'ws').replace(/\/$/, '');
        const url = `${base}/ws/cell?sheet=${encodeURIComponent(sheet)}&cell=${encodeURIComponent(cell)}`;
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const WebSocket = require('ws');
        const ws = new WebSocket(url);
        const t = setTimeout(() => { try { ws.close(); } catch {} resolve(false); }, 1_500);
        t.unref?.();
        ws.on('open', () => {
          try { ws.send(JSON.stringify({ op: 'write', sheet, cell, value, version })); } catch { /* ignore */ }
        });
        ws.on('message', (raw: any) => {
          try {
            const m = JSON.parse(raw.toString());
            if (m.op === 'ack' && m.sheet === sheet && m.cell === cell) {
              clearTimeout(t);
              try { ws.close(); } catch { /* ignore */ }
              resolve(true);
            }
          } catch { /* ignore */ }
        });
        ws.on('error', () => { clearTimeout(t); resolve(false); });
        ws.on('close', () => { clearTimeout(t); if (!ws.listenerCount('message')) resolve(false); });
      } catch {
        resolve(false);
      }
    });
  },
};
