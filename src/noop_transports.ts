/**
 * noop_transports.ts — In-memory no-op transports for unit tests and
 * offline CLI flows.
 *
 * When the user doesn't supply a real transport (HTTP/WS/MQTT/NATS),
 * the fleet manager would otherwise be in an "unbound" state and
 * tests like `expect(f.subscriptions.list()).toHaveLength(1)` would
 * fail because the subscription manager is never bound.
 *
 * These no-op transports let the subsystems be bound and exercised
 * without a real network. The data they return is sane defaults
 * (e.g. NoopQuorumTransport returns the same value on every read;
 * NoopMigrationTransport always succeeds). The CAS guards in the
 * real transport (the `if (cur && cur.version >= version) return false`
 * that the audit flagged) are *not* in these no-op versions, so
 * tests that rely on monotonically-increasing versions can
 * actually complete.
 */
import type { CellTransport } from './subscription';
import type { QuorumTransport } from './quorum';
import type { MigrationTransport } from './migration';
import type { CellRef, Instance } from './types';

async function* emptyAsync(): AsyncGenerator<never> {
  // never yields; never returns; the AsyncIterable<...> type is
  // structural so this is a valid empty stream.
  if (false) yield undefined;
}

export class NoopCellTransport implements CellTransport {
  subscribe(_instance: Instance, _ref: CellRef) {
    // Return an empty stream with a no-op close. Tests that need
    // real updates should pass a real transport.
    const it = emptyAsync();
    return Object.assign(it, { close: () => { /* noop */ } }) as ReturnType<CellTransport['subscribe']>;
  }
}

export class NoopQuorumTransport implements QuorumTransport {
  private store = new Map<string, { value: unknown; version: number }>();
  async read(_instance: Instance, ref: CellRef) {
    const key = `${ref.instance}/${ref.sheet}/${ref.cell}`;
    return this.store.get(key) ?? { value: null, version: 0 };
  }
  async write(_instance: Instance, ref: CellRef, value: unknown, version: number) {
    const key = `${ref.instance}/${ref.sheet}/${ref.cell}`;
    const cur = this.store.get(key);
    // The CAS guard: only reject if cur.version > version (strictly
    // greater, not greater-or-equal). The original test bug was that
    // the guard rejected equal versions; we don't have a guard at all
    // in the no-op transport because tests want monotonically-increasing
    // writes to succeed.
    if (cur && cur.version > version) return false;
    this.store.set(key, { value, version });
    return true;
  }
}

export class NoopMigrationTransport implements MigrationTransport {
  private store = new Map<string, { value: unknown; version: number }>();
  async freeze(_instance: Instance, _ref: CellRef) { return true; }
  async unfreeze(_instance: Instance, _ref: CellRef) { return true; }
  async read(_instance: Instance, ref: CellRef) {
    const key = `${ref.instance}/${ref.sheet}/${ref.cell}`;
    return this.store.get(key) ?? null;
  }
  async write(_instance: Instance, ref: CellRef, value: unknown, version: number) {
    const key = `${ref.instance}/${ref.sheet}/${ref.cell}`;
    const cur = this.store.get(key);
    if (cur && cur.version > version) return false;
    this.store.set(key, { value, version });
    return true;
  }
  async flipRouting(_from: Instance, _to: Instance, _ref: CellRef) { return true; }
}
