/**
 * ════════════════════════════════════════════════════════════════════════════
 *  test/quorum.test.ts — unit tests for the QuorumCoordinator
 * ════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { QuorumCoordinator, QuorumTransport, globMatch } from '../src/quorum';
import { Registry } from '../src/registry';
import { Tier } from '../src/types';

function makeReg(): Registry {
  const r = new Registry();
  for (let i = 0; i < 5; i++) {
    r.register({ tier: Tier.Jetson, name: `j-${i}`, endpoint: `http://j${i}:4040` });
  }
  return r;
}

describe('globMatch', () => {
  it('matches exact strings', () => {
    expect(globMatch('foo', 'foo')).toBe(true);
    expect(globMatch('foo', 'bar')).toBe(false);
  });
  it('matches single-star patterns', () => {
    expect(globMatch('safety.*', 'safety.eStop')).toBe(true);
    expect(globMatch('safety.*', 'vault.lock')).toBe(false);
    expect(globMatch('*',        'anything')).toBe(true);
  });
  it('matches double-star patterns', () => {
    expect(globMatch('a.**.c',  'a.b.c')).toBe(true);
    expect(globMatch('a.**.c',  'a.x.y.z.c')).toBe(true);
  });
});

describe('QuorumCoordinator', () => {
  let reg: Registry;
  let q: QuorumCoordinator;
  let transport: QuorumTransport;
  let stores: Map<string, Map<string, { value: unknown; version: number }>>;

  beforeEach(() => {
    reg = makeReg();
    stores = new Map();
    for (const inst of reg.all()) {
      stores.set(inst.id, new Map());
    }
    transport = {
      async read(instance, ref) {
        return stores.get(instance.id)?.get(`${ref.sheet}#${ref.cell}`) ?? null;
      },
      async write(instance, ref, value, version) {
        const m = stores.get(instance.id)!;
        const cur = m.get(`${ref.sheet}#${ref.cell}`);
        if (cur && cur.version >= version) return false;
        m.set(`${ref.sheet}#${ref.cell}`, { value, version });
        return true;
      },
    };
    q = new QuorumCoordinator({
      default: 3,
      critical: ['safety.*', 'vault.*'],
      readTimeoutMs:  200,
      writeTimeoutMs: 200,
    });
    q.bind(reg, transport);
  });

  it('reads with majority when 2 of 3 agree', async () => {
    const r = await q.read<{ ok: true }>('quilt://j-0/safety#eStop');
    // no data yet → no_quorum
    expect(r.status).toBe('no_quorum');
    // write 3 copies with the same value
    await q.write('quilt://j-0/safety#eStop', { ok: true });
    const r2 = await q.read<{ ok: true }>('quilt://j-0/safety#eStop');
    expect(r2.status).toBe('committed');
    expect(r2.value).toEqual({ ok: true });
  });

  it('detects split brain', async () => {
    // write 3 copies of A
    await q.write('quilt://j-0/safety#eStop', 'A');
    // overwrite 2 of 3 with B (version 1 still wins in the third)
    const j1 = reg.byInstanceName('j-1')!;
    const j2 = reg.byInstanceName('j-2')!;
    await transport.write(j1, { sheet: 'safety', cell: 'eStop', uri: 'x', instance: 'j-1' } as any, 'B', 999);
    await transport.write(j2, { sheet: 'safety', cell: 'eStop', uri: 'x', instance: 'j-2' } as any, 'B', 999);
    const r = await q.read('quilt://j-0/safety#eStop');
    // we have 2 'B' and 1 'A' → split_brain
    expect(r.status).toBe('split_brain');
    expect(r.agreement).toBe(2);
    expect(r.dissenters).toHaveLength(1);
  });

  it('replicates a write to all replicas and reports the version', async () => {
    const w = await q.write('quilt://j-0/vault#lock', { token: 'abc' });
    expect(w.status).toBe('committed');
    expect(w.acks).toHaveLength(3);
    expect(w.missing).toHaveLength(0);
  });

  it('reports no_quorum when too many replicas fail', async () => {
    // break the transport
    q.bind(reg, {
      read: async () => null,
      write: async () => false,
    });
    const w = await q.write('quilt://j-0/vault#lock', { token: 'abc' });
    expect(w.status).toBe('no_quorum');
  });

  it('isCritical respects the patterns', () => {
    expect(q.isCritical('safety.eStop')).toBe(true);
    expect(q.isCritical('vault.lock')).toBe(true);
    expect(q.isCritical('sensors.temp')).toBe(false);
  });

  it('replicaCount is at least 3 for critical cells', () => {
    expect(q.replicaCount('safety.eStop')).toBe(3);
    expect(q.replicaCount('sensors.temp')).toBe(3);
  });

  it('emits committed and repaired events', async () => {
    const committed: any[] = [];
    const repaired: any[] = [];
    q.on('committed', (uri, v) => committed.push([uri, v]));
    q.on('repaired',  (uri, i)  => repaired.push([uri, i]));
    await q.write('quilt://j-0/vault#lock', 'x');
    expect(committed).toHaveLength(1);
    // for repair, corrupt one replica and read
    const j0 = reg.byInstanceName('j-0')!;
    await transport.write(j0, { sheet: 'vault', cell: 'lock', uri: 'x', instance: 'j-0' } as any, 'CORRUPT', 999);
    await q.read('quilt://j-0/vault#lock');
    expect(repaired.length).toBeGreaterThanOrEqual(1);
  });
});
