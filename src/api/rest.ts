/**
 * ════════════════════════════════════════════════════════════════════════════
 *  api/rest.ts — REST API for the fleet manager
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  Endpoints
 *  ─────────
 *   GET  /api/fleet                  list instances
 *   GET  /api/fleet/:id              instance details
 *   GET  /api/cells                  list known cells
 *   GET  /api/cells/:uri             cell value
 *   POST /api/cells/:uri/subscribe   subscribe (returns subscription id)
 *   POST /api/cells/:uri/migrate     migrate cell
 *   GET  /api/health                 fleet health
 *   GET  /api/quorum/:cell           quorum status
 *
 *  Built on Express; the router is also exported for embedding in a
 *  larger app.
 *  ──────────────────────────────────────────────────────────────────────────
 */

import express, { Request, Response, Router } from 'express';
import type { FleetManager } from '../fleet';
import { parseQuiltUri, buildQuiltUri } from '../types';
import { CellRef } from '../types';

export interface RestOptions {
  /** Path prefix. Default `/api`. */
  prefix?: string;
  /** Whether to also start an HTTP listener. Default `false`
   *  (you mount the router yourself). */
  listen?: boolean;
  port?: number;
}

/** Build the REST router. */
export function createRestRouter(fleet: FleetManager): Router {
  const r = Router();

  r.get('/fleet', (_req, res) => {
    const instances = fleet.registry.all().map(i => ({
      id: i.id,
      name: i.name,
      tier: i.tierName,
      endpoint: i.endpoint,
      status: i.status,
      region: i.region,
      load: i.load,
      latencyMs: i.latencyMs,
      capabilities: i.capabilities,
      registeredAt: i.registeredAt,
    }));
    res.json({ instances, count: instances.length });
  });

  r.get('/fleet/:id', (req, res) => {
    const i = fleet.registry.get(req.params.id!) ?? fleet.registry.byInstanceName(req.params.id!);
    if (!i) return res.status(404).json({ error: 'not found' });
    res.json(i);
  });

  r.get('/cells', (_req, res) => {
    const subs = fleet.subscriptions.list();
    res.json({ cells: subs, count: subs.length });
  });

  r.get('/cells/*uri', async (req, res) => {
    const uri = `quilt://${req.params.uri}`;
    try {
      const v = await fleet.query(uri);
      res.json({ uri, value: v });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  r.post('/cells/*uri/subscribe', async (req: Request, res: Response) => {
    const uri = `quilt://${req.params.uri}`;
    try {
      const sub = await fleet.subscribe(uri);
      res.status(201).json({ subscriptionId: sub.id, uri });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  r.post('/cells/*uri/migrate', async (req, res) => {
    const uri = `quilt://${req.params.uri}`;
    const target = String(req.body?.target ?? '');
    if (!target) return res.status(400).json({ error: 'target required' });
    try {
      const result = await fleet.migrate(uri, target);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  r.get('/health', (_req, res) => {
    const totals = fleet.health.totals();
    res.json({ fleet: fleet.fleetId, totals });
  });

  r.get('/quorum/:cell', (req, res) => {
    const cell = req.params.cell!;
    res.json({
      cell,
      replicaCount: fleet.quorum.replicaCount(cell),
      isCritical:   fleet.quorum.isCritical(cell),
    });
  });

  return r;
}

/** Create the full Express app. */
export function createRestApp(fleet: FleetManager, opts: RestOptions = {}): express.Express {
  const app = express();
  app.use(express.json());
  const prefix = opts.prefix ?? '/api';
  app.use(prefix, createRestRouter(fleet));
  if (opts.listen) {
    const port = opts.port ?? 8080;
    app.listen(port, () => {
      // eslint-disable-next-line no-console
      console.log(`quilt-fleet REST listening on :${port}${prefix}`);
    });
  }
  return app;
}
