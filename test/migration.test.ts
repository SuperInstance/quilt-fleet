/**
 * ════════════════════════════════════════════════════════════════════════════
 *  test/migration.test.ts — unit tests for MigrationCoordinator
 * ════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MigrationCoordinator, MigrationTransport } from '../src/migration';
import { Registry } from '../src/registry';
import { Tier } from '../src/types';

function makeReg(): Registry {
  const r = new Registry();
  r.register({ tier: Tier.Server, name: 'src',  endpoint: 'grpc://src:7070' });
  r.register({ tier: Tier.Server, name: 'dest', endpoint: 'grpc://dest:7070' });
  return r;
}

describe('MigrationCoordinator', () => {
  let reg: Registry;
  let mig: MigrationCoordinator;
  let transport: MigrationTransport;
  let frozen: Set<string>;
  let store: Map<string, { value: unknown; version: number } | null>;

  beforeEach(() => {
    reg = makeReg();
    frozen = new Set();
    store = new Map();
    store.set('src', { value: 'hello', version: 7 });
    transport = {
      async freeze(_i, ref)        { frozen.add(ref.instance); return true; },
      async unfreeze(i, ref)      { frozen.delete(i.id); return true; },
      async read(i, ref) {
        if (ref.instance !== i.name) return null;
        return store.get(ref.instance === 'src' ? 'src' : 'dest') ?? null;
      },
      async write(i, ref, value, version) {
        if (ref.instance !== i.name) return false;
        store.set(i.name, { value, version });
        return true;
      },
      async flipRouting() { return true; },
    };
    mig = new MigrationCoordinator({
      phaseTimeoutMs: 200,
      totalTimeoutMs: 2_000,
    });
    mig.bind(reg, transport);
  });

  it('completes all 5 phases in the happy path', async () => {
    const result = await mig.migrate('quilt://src/session#user-42', 'dest');
    expect(result.success).toBe(true);
    expect(result.plan.status).toBe('success');
    expect(result.plan.phases.map(p => p.status)).toEqual(['ok','ok','ok','ok','ok']);
    // the source was frozen and then unfrozen
    expect(frozen.has('src')).toBe(false);
    // the dest has the new value
    expect(store.get('dest')).toEqual({ value: 'hello', version: 7 });
  });

  it('rolls back on phase 1B failure', async () => {
    transport.write = async () => false;
    const result = await mig.migrate('quilt://src/session#user-42', 'dest');
    expect(result.success).toBe(false);
    expect(result.plan.status).toBe('rolled_back');
    expect(result.plan.phases[1]!.status).toBe('fail');
  });

  it('rolls back on phase 2A mismatch', async () => {
    // make the read-back return a different value
    let destRead = 0;
    transport.read = async (i, ref) => {
      if (i.name === 'src') return store.get('src')!;
      destRead++;
      // first read returns the wrong version
      if (destRead === 1) return { value: 'WRONG', version: 7 };
      return { value: 'hello', version: 7 };
    };
    const result = await mig.migrate('quilt://src/session#user-42', 'dest');
    expect(result.success).toBe(false);
  });

  it('rejects an unknown target instance', async () => {
    await expect(mig.migrate('quilt://src/s#c', 'nope'))
      .rejects.toThrow(/unknown target/);
  });

  it('rejects migration to the same instance', async () => {
    await expect(mig.migrate('quilt://src/s#c', 'src'))
      .rejects.toThrow(/same instance/);
  });

  it('times out a hung phase', async () => {
    transport.flipRouting = () => new Promise(() => { /* never */ }) as any;
    const result = await mig.migrate('quilt://src/session#user-42', 'dest');
    expect(result.success).toBe(false);
    expect(result.plan.phases[3]!.status).toBe('fail');
  });

  it('emits start, phaseStart, phaseEnd, and complete events', async () => {
    const events: string[] = [];
    mig.on('start',     () => events.push('start'));
    mig.on('phaseStart',(_, p) => events.push(`phaseStart:${p}`));
    mig.on('phaseEnd',  (_, p, s) => events.push(`phaseEnd:${p}:${s}`));
    mig.on('complete',  () => events.push('complete'));
    await mig.migrate('quilt://src/session#user-42', 'dest');
    expect(events[0]).toBe('start');
    expect(events[events.length - 1]).toBe('complete');
    // 5 phases × 2 events each
    expect(events.filter(e => e.startsWith('phaseStart')).length).toBe(5);
    expect(events.filter(e => e.startsWith('phaseEnd:')).length).toBe(5);
  });

  it('lists past migrations', async () => {
    await mig.migrate('quilt://src/session#user-1', 'dest');
    await mig.migrate('quilt://src/session#user-2', 'dest');
    expect(mig.list()).toHaveLength(2);
  });
});
