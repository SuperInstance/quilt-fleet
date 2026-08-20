/**
 * ════════════════════════════════════════════════════════════════════════════
 *  transports/index.ts — the transport adapter registry
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  A `TransportAdapter` knows how to send a single cell query or
 *  subscription to an instance. The four supported transports are:
 *
 *   • `http`      — REST: GET /cell/<sheet>#<cell>
 *   • `websocket` — streaming WS subscription
 *   • `mqtt`      — pub/sub via an MQTT broker
 *   • `nats`      — JetStream / NATS subjects
 *
 *  Each adapter is constructed with the instance's endpoint and
 *  returns a `subscribe` iterator that yields `(value, version)`
 *  pairs. Close cancels the subscription.
 *  ──────────────────────────────────────────────────────────────────────────
 */

import type { CellTransport } from '../subscription';
import type { Instance } from '../registry';
import { httpTransport } from './http';
import { wsTransport }   from './websocket';
import { mqttTransport } from './mqtt';
import { natsTransport } from './nats';

export interface TransportAdapter {
  /** Subscribe to a cell on the given instance. */
  subscribe(instance: Instance, sheet: string, cell: string): AsyncIterable<{ value: unknown; version: number }> & { close(): void };
  /** Send a one-shot write. Returns true on success. */
  write(instance: Instance, sheet: string, cell: string, value: unknown, version: number): Promise<boolean>;
  /** Send a one-shot read. Returns null if not found. */
  read(instance: Instance, sheet: string, cell: string): Promise<{ value: unknown; version: number } | null>;
}

export const TRANSPORTS: Record<string, TransportAdapter> = {
  http:      httpTransport,
  ws:        wsTransport,
  websocket: wsTransport,
  mqtt:      mqttTransport,
  nats:      natsTransport,
  grpc:      httpTransport,   // gRPC bridges via HTTP for v0.1
};

export function transportFor(name: string): TransportAdapter {
  return TRANSPORTS[name] ?? httpTransport;
}

/** Build a {@link CellTransport} (the lighter interface used by
 *  SubscriptionManager) from a transport name. */
export function cellTransport(name: string): CellTransport {
  const t = transportFor(name);
  return {
    subscribe(instance, ref) {
      return t.subscribe(instance, ref.sheet, ref.cell);
    },
  };
}
