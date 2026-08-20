/**
 * ════════════════════════════════════════════════════════════════════════════
 *  discovery.ts — find Quilt instances on the network
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  Discovery is the answer to *"how does the fleet learn that a new
 *  Quilt instance exists?"*. This module supports three mechanisms:
 *
 *   1. **mDNS / Bonjour** — local network, no central server. Default
 *      for dev and home deployments.
 *   2. **DNS-SD**       — wide-area, uses unicast DNS. Default for
 *      production across subnets.
 *   3. **Static config** — a `fleet.yaml` of pinned endpoints. Default
 *      for production with strict ops review.
 *
 *  All three feed the same `onInstanceFound` / `onInstanceLost`
 *  callbacks, so the consumer (the {@link Registry}) does not care
 *  which method found an instance.
 *
 *  Bonjour caveat
 *  ──────────────
 *  The `bonjour-service` package is dynamically imported so the
 *  fleet still starts on platforms where mDNS is not available
 *  (Windows Server Core, certain Alpine images, …).
 *  ──────────────────────────────────────────────────────────────────────────
 */

import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { Capabilities, Region, Tier, TierName, nameToTier, tierToName } from './types';
import type { RegisterInput } from './registry';

/* ─── config ──────────────────────────────────────────────────────────── */

export interface DiscoveryConfig {
  /** mDNS / Bonjour adapter. Default `false` in production. */
  bonjour?: boolean;
  /** DNS-SD adapter. */
  dnsSd?: DnsSdConfig;
  /** Static config — path to a YAML file or an in-memory list. */
  static?: string | StaticConfig;
  /** Service type for mDNS / DNS-SD. */
  serviceType?: string;
  /** Domain for mDNS / DNS-SD. */
  domain?: string;
  /** Polling interval for static config reload (ms). */
  staticReloadMs?: number;
}

export interface DnsSdConfig {
  enabled: boolean;
  /** DNS server to query. */
  servers?: string[];
  /** Domain to query. */
  domain?: string;
}

export interface StaticConfig {
  /** File path (YAML or JSON). */
  file?: string;
  /** In-memory list. */
  instances?: RegisterInput[];
  /** Polling interval. */
  reloadMs?: number;
}

/* ─── events ──────────────────────────────────────────────────────────── */

export interface DiscoveryEvent {
  ts: number;
  type: 'up' | 'down' | 'updated';
  instance: RegisterInput | string;
  source: 'bonjour' | 'dns-sd' | 'static';
}

export interface DiscoveryEvents {
  up:      [RegisterInput & { source: string }];
  down:    [string, string];                  // name, source
  updated: [RegisterInput & { source: string }];
  error:   [Error, string];                   // err, source
}

/* ─── the discovery orchestrator ──────────────────────────────────────── */

/**
 * Wraps one or more discovery backends. Each backend implements
 * `start()` and `stop()` and emits `up` / `down` events. The
 * `Discovery` orchestrator deduplicates and forwards.
 */
export class Discovery extends EventEmitter<DiscoveryEvents> {
  private readonly cfg: DiscoveryConfig;
  private bonjourHandle: BonjourBackend | null = null;
  private staticHandle: StaticBackend | null = null;
  private dnsSdHandle: DnsSdBackend | null = null;
  private running = false;

  constructor(cfg: DiscoveryConfig = {}) {
    super();
    this.cfg = {
      serviceType: cfg.serviceType ?? 'quilt',
      domain:      cfg.domain      ?? 'local',
      ...cfg,
    };
  }

  /* ─── lifecycle ───────────────────────────────────────────────────── */

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    if (this.cfg.bonjour) {
      try {
        this.bonjourHandle = new BonjourBackend(this.cfg);
        this.bonjourHandle.on('up',      (i) => this.emit('up',      { ...i, source: 'bonjour' }));
        this.bonjourHandle.on('down',    (n) => this.emit('down',    n, 'bonjour'));
        this.bonjourHandle.on('updated', (i) => this.emit('updated', { ...i, source: 'bonjour' }));
        this.bonjourHandle.on('error',   (e) => this.emit('error',   e, 'bonjour'));
        await this.bonjourHandle.start();
      } catch (e) {
        this.emit('error', e as Error, 'bonjour');
      }
    }

    if (this.cfg.dnsSd?.enabled) {
      try {
        this.dnsSdHandle = new DnsSdBackend(this.cfg.dnsSd);
        this.dnsSdHandle.on('up',      (i) => this.emit('up',      { ...i, source: 'dns-sd' }));
        this.dnsSdHandle.on('down',    (n) => this.emit('down',    n, 'dns-sd'));
        this.dnsSdHandle.on('updated', (i) => this.emit('updated', { ...i, source: 'dns-sd' }));
        this.dnsSdHandle.on('error',   (e) => this.emit('error',   e, 'dns-sd'));
        await this.dnsSdHandle.start();
      } catch (e) {
        this.emit('error', e as Error, 'dns-sd');
      }
    }

    if (this.cfg.static) {
      try {
        this.staticHandle = new StaticBackend(this.cfg.static);
        this.staticHandle.on('up',      (i) => this.emit('up',      { ...i, source: 'static' }));
        this.staticHandle.on('down',    (n) => this.emit('down',    n, 'static'));
        this.staticHandle.on('updated', (i) => this.emit('updated', { ...i, source: 'static' }));
        this.staticHandle.on('error',   (e) => this.emit('error',   e, 'static'));
        await this.staticHandle.start();
      } catch (e) {
        this.emit('error', e as Error, 'static');
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    await this.bonjourHandle?.stop();
    await this.staticHandle?.stop();
    await this.dnsSdHandle?.stop();
    this.bonjourHandle = null;
    this.staticHandle = null;
    this.dnsSdHandle = null;
  }

  /* ─── tests-only helpers ──────────────────────────────────────────── */

  /** Manually inject an instance (used by tests and by the CLI). */
  inject(input: RegisterInput, source = 'manual'): void {
    this.emit('up', { ...input, source } as RegisterInput & { source: string });
  }
}

/* ─── Bonjour backend ─────────────────────────────────────────────────── */

/**
 * mDNS / Bonjour discovery.
 *
 * Service type: `_quilt._tcp.local.` by default.
 * TXT records: `tier`, `v`, `id`, `region`.
 */
class BonjourBackend extends EventEmitter<{
  up:      [RegisterInput];
  down:    [string];
  updated: [RegisterInput];
  error:   [Error];
}> {
  private readonly cfg: DiscoveryConfig;
  private browser: any = null;
  private known = new Map<string, RegisterInput>();

  constructor(cfg: DiscoveryConfig) {
    super();
    this.cfg = cfg;
  }

  async start(): Promise<void> {
    // The real bonjour-service package is optional. We attempt to
    // import it; if it isn't installed (e.g. in CI), we emit an
    // error and the backend stays inert.
    let Bonjour: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('bonjour-service') as any;
      Bonjour = mod.Bonjour ?? mod.default ?? mod;
    } catch (e) {
      this.emit('error', new Error(
        'bonjour-service not installed; install it to enable mDNS discovery',
      ));
      return;
    }
    const bonjour = new Bonjour();
    this.browser = bonjour.find({
      type: this.cfg.serviceType,
      domain: this.cfg.domain,
    });
    this.browser.on('up',   (svc: any) => this.handleBonjourUp(svc));
    this.browser.on('down', (svc: any) => this.handleBonjourDown(svc));
  }

  async stop(): Promise<void> {
    this.browser?.stop?.();
    this.browser = null;
    this.known.clear();
  }

  private handleBonjourUp(svc: any): void {
    const name = (svc.name ?? svc.host ?? '').toString();
    if (!name) return;
    const txt = svc.txt ?? svc.txtRecord ?? {};
    const tierRaw = (txt.tier ?? 'server').toString().toLowerCase();
    const tierName: TierName =
      ['esp32', 'jetson', 'codespace', 'cloudflare', 'server'].includes(tierRaw)
        ? (tierRaw as TierName)
        : 'server';
    const reg: RegisterInput = {
      tier:       nameToTier(tierName),
      name,
      endpoint:   `http://${svc.host ?? svc.referer?.address ?? name}:${svc.port ?? 4040}`,
      transport:  'http',
      capabilities: parseCapabilities(txt),
      region:     txt.region ? (txt.region as Region) : undefined,
    };
    this.known.set(name, reg);
    if (this.known.size === 1) {
      this.emit('up', reg);
    } else {
      this.emit('updated', reg);
    }
  }

  private handleBonjourDown(svc: any): void {
    const name = (svc.name ?? '').toString();
    if (!name) return;
    if (this.known.delete(name)) {
      this.emit('down', name);
    }
  }
}

function parseCapabilities(txt: Record<string, unknown>): Capabilities {
  const out: Capabilities = {};
  if (txt.ram)      out.ram_mb       = Number(txt.ram);
  if (txt.cpu)      out.cpu_cores    = Number(txt.cpu);
  if (txt.cuda)     out.cuda         = txt.cuda === 'true' || txt.cuda === true;
  if (txt.metal)    out.metal        = txt.metal === 'true' || txt.metal === true;
  if (txt.battery)  out.battery      = txt.battery === 'true' || txt.battery === true;
  if (txt.storage)  out.storage_bytes = Number(txt.storage);
  return out;
}

/* ─── DNS-SD backend ──────────────────────────────────────────────────── */

/**
 * DNS-SD discovery. In v0.1 this is **stubbed** — the production
 * implementation will use a `dnsSd` library that supports the
 * PTR/SRV/TXT record lookup loop. The stub returns whatever the
 * in-memory list holds, which is sufficient for tests and for
 * developers who want to wire DNS-SD later.
 */
class DnsSdBackend extends EventEmitter<{
  up:      [RegisterInput];
  down:    [string];
  updated: [RegisterInput];
  error:   [Error];
}> {
  private readonly cfg: DnsSdConfig;

  constructor(cfg: DnsSdConfig) {
    super();
    this.cfg = cfg;
  }

  async start(): Promise<void> {
    // STUB: a real implementation would resolve `_quilt._tcp.<domain>`
    // PTR records, follow each SRV, fetch TXT, and emit.
    // For v0.1 we log and return.
    if (!this.cfg.enabled) return;
    if (!this.cfg.servers || this.cfg.servers.length === 0) {
      this.emit('error', new Error('dns-sd enabled but no servers configured'));
    }
  }

  async stop(): Promise<void> { /* noop */ }
}

/* ─── Static backend ──────────────────────────────────────────────────── */

/**
 * Static discovery from a YAML or JSON file. The file is read at
 * `start()` and optionally re-read on an interval to pick up
 * edits without a fleet restart.
 */
class StaticBackend extends EventEmitter<{
  up:      [RegisterInput];
  down:    [string];
  updated: [RegisterInput];
  error:   [Error];
}> {
  private readonly cfg: string | StaticConfig;
  private known = new Map<string, RegisterInput>();
  private timer: NodeJS.Timeout | null = null;
  private staticConfig: StaticConfig;

  constructor(cfg: string | StaticConfig) {
    super();
    this.cfg = cfg;
    this.staticConfig = typeof cfg === 'string'
      ? { file: cfg, reloadMs: 30_000 }
      : cfg;
  }

  async start(): Promise<void> {
    await this.loadOnce();
    if (this.staticConfig.reloadMs && this.staticConfig.reloadMs > 0) {
      this.timer = setInterval(() => {
        this.loadOnce().catch(e => this.emit('error', e as Error));
      }, this.staticConfig.reloadMs);
      // Don't keep the event loop alive just for this timer
      this.timer.unref?.();
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.known.clear();
  }

  private async loadOnce(): Promise<void> {
    let entries: RegisterInput[] = [];
    if (this.staticConfig.instances) {
      entries = this.staticConfig.instances;
    } else if (this.staticConfig.file) {
      const raw = await readFile(path.resolve(this.staticConfig.file), 'utf8');
      if (this.staticConfig.file.endsWith('.json')) {
        const parsed = JSON.parse(raw);
        entries = parsed.instances ?? [];
      } else {
        const parsed = parseYaml(raw) as { instances?: RegisterInput[] } | null;
        entries = parsed?.instances ?? [];
      }
    } else {
      return;
    }

    const seen = new Set<string>();
    for (const raw of entries) {
      const reg = normalizeStaticEntry(raw);
      seen.add(reg.name);
      const prev = this.known.get(reg.name);
      if (!prev) {
        this.known.set(reg.name, reg);
        this.emit('up', reg);
      } else if (!shallowEqualRegister(prev, reg)) {
        this.known.set(reg.name, reg);
        this.emit('updated', reg);
      }
    }
    for (const name of Array.from(this.known.keys())) {
      if (!seen.has(name)) {
        this.known.delete(name);
        this.emit('down', name);
      }
    }
  }
}

/* ─── helpers ────────────────────────────────────────────────────────── */

function normalizeStaticEntry(raw: RegisterInput): RegisterInput {
  const tier: Tier = typeof raw.tier === 'number'
    ? raw.tier
    : nameToTier(raw.tier as TierName);
  return {
    ...raw,
    tier,
    transport: raw.transport ?? 'http',
  };
}

function shallowEqualRegister(a: RegisterInput, b: RegisterInput): boolean {
  return a.name === b.name
      && a.tier === b.tier
      && a.endpoint === b.endpoint
      && a.transport === b.transport
      && a.region === b.region
      && a.zone === b.zone;
}

/** Re-export the tier helpers for tests. */
export { tierToName, nameToTier };
