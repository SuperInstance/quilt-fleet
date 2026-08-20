/**
 * ════════════════════════════════════════════════════════════════════════════
 *  tiers/jetson.ts — Tier 2: NVIDIA Jetson (edge GPU)
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  Tier 2 is the "edge brain": 8-32 GB RAM, CUDA, ROS2. Jetson instances
 *  typically run local inference (YOLO, OCR, audio), aggregate
 *  ESP32 sensor streams, and bridge protocols (BLE, Zigbee, LoRa).
 *
 *  Default transport: WebSocket. Jetsons usually serve a Quilt
 *  HTTP+WS endpoint locally and connect to a server tier for sync.
 *  ──────────────────────────────────────────────────────────────────────────
 */

import { Tier, TierName } from '../types';
import type { TierAdapter, TierProfile } from './index';

export const jetsonProfile: TierProfile = {
  tier: Tier.Jetson,
  name: 'jetson' as TierName,
  defaultTransport: 'ws',
  defaultCapabilities: {
    ram_mb: 16_384,
    cpu_cores: 8,
    cuda: true,
    metal: false,
    storage_bytes: 256 * 1024 * 1024 * 1024,
  },
  defaultHeartbeatMs: 5_000,
  recommendedCells: [
    'inference.detections',
    'inference.ocr',
    'vision.frames',
    'nav.odometry',
    'sensors.aggregated',
    'agent.thoughts',
  ],
  description: 'Tier 2 edge GPU: 8-32 GB RAM, CUDA, local inference.',
};

export const jetsonAdapter: TierAdapter = {
  async probe(endpoint) {
    const t0 = Date.now();
    try {
      const url = endpoint.replace(/\/$/, '') + '/health';
      const res = await fetch(url, { signal: AbortSignal.timeout(1_500) });
      return { ok: res.ok, latencyMs: Date.now() - t0 };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - t0, details: (e as Error).message };
    }
  },

  async *subscribe(endpoint, sheet, cell) {
    const wsUrl = endpoint.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws';
    let ws: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const WebSocket = require('ws');
      ws = new WebSocket(wsUrl);
    } catch {
      return;
    }
    const queue: Array<{ value: unknown; version: number }> = [];
    const waiters: Array<(v: IteratorResult<{ value: unknown; version: number }>) => void> = [];
    let closed = false;
    ws.on('open', () => {
      ws.send(JSON.stringify({ op: 'subscribe', sheet, cell }));
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
    ws.on('close', () => {
      closed = true;
      while (waiters.length) {
        waiters.shift()!({ value: undefined as any, done: true });
      }
    });
    try {
      while (!closed) {
        if (queue.length) {
          yield queue.shift()!;
        } else {
          const next = await new Promise<IteratorResult<{ value: unknown; version: number }>>((resolve) => {
            waiters.push(resolve);
          });
          if (next.done) return;
          yield next.value;
        }
      }
    } finally {
      try { ws.close(); } catch { /* ignore */ }
    }
  },

  buildRegistration(name, endpoint, overrides = {}) {
    return {
      tier:       Tier.Jetson,
      name,
      endpoint,
      transport:  'ws',
      capabilities: { ...jetsonProfile.defaultCapabilities, ...overrides },
    };
  },
};
