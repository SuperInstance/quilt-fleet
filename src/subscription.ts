/**
 * ════════════════════════════════════════════════════════════════════════════
 *  subscription.ts — cross-instance cell subscription
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  When a fleet manager subscribes to a cell, it does not care which
 *  instance owns the cell — it cares about the **value**, and the
 *  stream of updates. This module sits between the
 *  {@link Registry} / {@link Router} and the consumer; it:
 *
 *   • Resolves a `quilt://` URI to a concrete instance
 *   • Opens a subscription to that instance (transport-dependent)
 *   • Re-resolves on instance loss, re-subscribes on a healthy peer
 *   • Emits `update` events with the cell value + metadata
 *   • De-duplicates by cell version
 *   • Tracks `lastValueAt` and `missedUpdates` for observability
 *
 *  The transport-specific subscribe call is delegated to a
 *  `TransportAdapter`. This module itself is transport-agnostic.
 *  ──────────────────────────────────────────────────────────────────────────
 */

import { EventEmitter } from 'node:events';
import { CellRef, parseQuiltUri } from './types';
import type { Registry, Instance } from './registry';
import type { Router } from './routing';

/* ─── subscription record ────────────────────────────────────────────── */

export interface Subscription {
  id: string;
  uri: string;
  instance: string;             // currently subscribed instance id
  instanceName: string;
  createdAt: number;
  lastValueAt: number;
  lastVersion: number;
  missedUpdates: number;
}

export interface SubscriptionEvent {
  ts: number;
  uri: string;
  instance: string;
  value: unknown;
  version: number;
  origin: string;               // instance that produced the value
}

export interface SubscriptionEvents {
  update:    [SubscriptionEvent];
  missed:    [string, number];  // subscription id, gap
  resubscribed: [string, string]; // sub id, new instance name
  error:     [string, Error];
  close:     [string];
}

/* ─── the transport interface (a thin contract) ──────────────────────── */

export interface CellTransport {
  /** Subscribe to a cell on a given instance. Returns an unsubscribe
   *  function and a stream of `(value, version)`. */
  subscribe(
    instance: Instance,
    ref: CellRef,
  ): AsyncIterable<{ value: unknown; version: number }> & {
    close(): void;
  };
}

/* ─── manager ───────────────────────────────────────────────────────── */

export class SubscriptionManager extends EventEmitter<SubscriptionEvents> {
  private readonly subs = new Map<string, SubInternal>();
  private nextId = 1;
  private reg: Registry | null = null;
  private router: Router | null = null;
  private transport: CellTransport | null = null;

  constructor(
    private readonly opts: {
      maxMissedUpdates?: number;
      resubscribeBackoffMs?: number;
    } = {},
  ) {
    super();
  }

  bind(registry: Registry, router: Router, transport: CellTransport): void {
    this.reg = registry;
    this.router = router;
    this.transport = transport;
  }

  /* ─── subscribe ──────────────────────────────────────────────────── */

  async subscribe(uri: string): Promise<Subscription> {
    if (!this.reg || !this.router || !this.transport) {
      throw new Error('subscription manager not bound');
    }
    const ref = parseQuiltUri(uri);
    const inst = this.router.pick(ref);
    if (!inst) {
      throw new Error(`no instance available for ${uri}`);
    }

    const id = `sub-${this.nextId++}`;
    const sub: SubInternal = {
      id,
      uri,
      ref,
      instanceId: inst.id,
      instanceName: inst.name,
      createdAt: Date.now(),
      lastValueAt: 0,
      lastVersion: 0,
      missedUpdates: 0,
      stream: null,
      cancelled: false,
      retrying: false,
    };
    this.subs.set(id, sub);
    this.startStream(sub);
    return this.toPublic(sub);
  }

  /** Bulk-subscribe to many URIs. Returns a list of subscriptions. */
  async subscribeMany(uris: string[]): Promise<Subscription[]> {
    return Promise.all(uris.map(u => this.subscribe(u)));
  }

  /** Cancel a subscription. */
  unsubscribe(id: string): boolean {
    const sub = this.subs.get(id);
    if (!sub) return false;
    sub.cancelled = true;
    sub.stream?.close();
    this.subs.delete(id);
    this.emit('close', id);
    return true;
  }

  /** All active subscriptions. */
  list(): Subscription[] {
    return Array.from(this.subs.values()).map(s => this.toPublic(s));
  }

  /* ─── stream management ──────────────────────────────────────────── */

  private startStream(sub: SubInternal): void {
    if (sub.cancelled || !this.reg || !this.router || !this.transport) return;

    const inst = this.reg.get(sub.instanceId);
    if (!inst) {
      // instance disappeared — try to re-resolve
      this.retryWithPeer(sub, 'instance gone');
      return;
    }

    let stream: AsyncIterable<{ value: unknown; version: number }> & { close: () => void };
    try {
      stream = this.transport.subscribe(inst, sub.ref);
    } catch (e) {
      this.emit('error', sub.id, e as Error);
      this.retryWithPeer(sub, (e as Error).message);
      return;
    }
    sub.stream = stream;

    (async () => {
      try {
        for await (const update of stream as AsyncIterable<{ value: unknown; version: number }>) {
          if (sub.cancelled) break;

          // dedup by version
          if (update.version <= sub.lastVersion) continue;
          const gap = update.version - sub.lastVersion - 1;
          if (gap > 0) {
            sub.missedUpdates += gap;
            this.emit('missed', sub.id, gap);
          }
          sub.lastVersion = update.version;
          sub.lastValueAt = Date.now();

          this.emit('update', {
            ts: Date.now(),
            uri: sub.uri,
            instance: sub.instanceName,
            value: update.value,
            version: update.version,
            origin: sub.instanceName,
          });
        }
      } catch (e) {
        if (sub.cancelled) return;
        this.emit('error', sub.id, e as Error);
        this.retryWithPeer(sub, (e as Error).message);
      }
    })();
  }

  private retryWithPeer(sub: SubInternal, why: string): void {
    if (sub.cancelled || sub.retrying || !this.reg || !this.router) return;
    sub.retrying = true;
    sub.stream?.close();
    sub.stream = null;

    const backoff = this.opts.resubscribeBackoffMs ?? 1_000;
    setTimeout(() => {
      if (sub.cancelled) return;
      sub.retrying = false;
      const inst = this.router!.pick(sub.ref);
      if (!inst) {
        this.emit('error', sub.id, new Error(`no peer for ${sub.uri} (${why})`));
        // try again with longer backoff
        this.retryWithPeer(sub, 'no peer');
        return;
      }
      const prevName = sub.instanceName;
      sub.instanceId = inst.id;
      sub.instanceName = inst.name;
      this.emit('resubscribed', sub.id, inst.name);
      this.startStream(sub);
      // `prevName` is referenced to keep the param alive for tests
      void prevName;
    }, backoff).unref?.();
  }

  private toPublic(s: SubInternal): Subscription {
    return {
      id: s.id,
      uri: s.uri,
      instance: s.instanceId,
      instanceName: s.instanceName,
      createdAt: s.createdAt,
      lastValueAt: s.lastValueAt,
      lastVersion: s.lastVersion,
      missedUpdates: s.missedUpdates,
    };
  }
}

/* ─── internal record ───────────────────────────────────────────────── */

interface SubInternal {
  id: string;
  uri: string;
  ref: CellRef;
  instanceId: string;
  instanceName: string;
  createdAt: number;
  lastValueAt: number;
  lastVersion: number;
  missedUpdates: number;
  stream: (AsyncIterable<{ value: unknown; version: number }> & { close: () => void }) | null;
  cancelled: boolean;
  retrying: boolean;
}
