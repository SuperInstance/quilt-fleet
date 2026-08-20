/**
 * ════════════════════════════════════════════════════════════════════════════
 *  tiers/esp32.ts — Tier 1: ESP32 (microcontroller)
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  The smallest Quilt instance. 320 KB of RAM, 4 MB of flash, WiFi only.
 *  ESP32 instances are *sources* of sensor data and *sinks* of actuator
 *  commands; they are never authoritative for critical state.
 *
 *  Default transport: MQTT (because it is what the ESP32 Arduino and
 *  ESP-IDF cores handle cheaply).
 *
 *  Recommended cells: `sensors.temperature`, `sensors.motion`,
 *  `actuator.relay`, `actuator.pwm`.
 *
 *  STUB: the actual MQTT probe / subscribe call is left to a
 *  concrete transport adapter; this module documents the contract.
 *  ──────────────────────────────────────────────────────────────────────────
 */

import { Tier, TierName } from '../types';
import type { TierAdapter, TierProfile } from './index';

export const esp32Profile: TierProfile = {
  tier: Tier.Esp32,
  name: 'esp32' as TierName,
  defaultTransport: 'mqtt',
  defaultCapabilities: {
    ram_mb: 0.3,
    cpu_cores: 2,
    storage_bytes: 4 * 1024 * 1024,
    battery: true,
  },
  defaultHeartbeatMs: 15_000,
  recommendedCells: [
    'sensors.temperature',
    'sensors.humidity',
    'sensors.motion',
    'sensors.lux',
    'sensors.voc',
    'actuator.relay',
    'actuator.pwm',
    'actuator.servo',
  ],
  description: 'Tier 1 microcontroller: 320 KB RAM, WiFi, battery-friendly.',
};

export const esp32Adapter: TierAdapter = {
  async probe(endpoint) {
    // An ESP32 instance is usually reachable only via MQTT broker; we
    // ping the broker to see if the device is online.
    const t0 = Date.now();
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mqtt = require('mqtt') as typeof import('mqtt');
      const client = mqtt.connect(endpoint, { connectTimeout: 1_500 });
      const ok = await new Promise<boolean>((resolve) => {
        client.once('connect', () => { client.end(true); resolve(true); });
        client.once('error',   () => { client.end(true); resolve(false); });
        setTimeout(() => { try { client.end(true); } catch {} resolve(false); }, 1_500).unref?.();
      });
      return { ok, latencyMs: Date.now() - t0 };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - t0, details: (e as Error).message };
    }
  },

  async *subscribe(endpoint, sheet, cell) {
    // The real implementation would `mqtt.subscribe(...)` and yield
    // messages. STUB yields nothing — production should provide a
    // concrete transport.
    void endpoint; void sheet; void cell;
    return;
  },

  buildRegistration(name, endpoint, overrides = {}) {
    return {
      tier:       Tier.Esp32,
      name,
      endpoint,
      transport:  'mqtt',
      capabilities: { ...esp32Profile.defaultCapabilities, ...overrides },
    };
  },
};
