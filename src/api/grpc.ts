/**
 * ════════════════════════════════════════════════════════════════════════════
 *  api/grpc.ts — gRPC server for the fleet
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  gRPC is the canonical transport between `quilt-fleet` and the
 *  server tier. The proto contract is defined in
 *  `proto/quilt_fleet.proto` (out of band of the TypeScript
 *  distribution). This module uses `@grpc/grpc-js` and the dynamic
 *  proto loader, so no code generation is required at install time.
 *
 *  Services
 *  ────────
 *   FleetService
 *     ListInstances  () returns (stream Instance)
 *     GetInstance    (InstanceRequest) returns (Instance)
 *     Subscribe      (CellRequest)     returns (stream CellUpdate)
 *     Migrate        (MigrateRequest)  returns (MigrationResult)
 *  ──────────────────────────────────────────────────────────────────────────
 */

import type { FleetManager } from '../fleet';
import { parseQuiltUri } from '../types';

/* The proto is loaded at runtime from a path the user supplies, or
 * from the package's own copy if available. */
export const DEFAULT_PROTO = `
syntax = "proto3";
package quilt.fleet.v1;

service FleetService {
  rpc ListInstances(Empty)          returns (stream Instance);
  rpc GetInstance(InstanceRequest)  returns (Instance);
  rpc Subscribe(CellRequest)        returns (stream CellUpdate);
  rpc Migrate(MigrateRequest)       returns (MigrationResult);
}
syntax = "proto3";
package quilt.fleet.v1;

service FleetService {
  rpc ListInstances(Empty)          returns (stream Instance);
  rpc GetInstance(InstanceRequest)  returns (Instance);
  rpc Subscribe(CellRequest)        returns (stream CellUpdate);
  rpc Migrate(MigrateRequest)       returns (MigrationResult);
}

message Empty {}

message InstanceRequest { string id = 1; string name = 2; }
message CellRequest     { string uri = 1; }
message MigrateRequest  { string uri = 1; string target = 2; }

message Instance {
  string id        = 1;
  string name      = 2;
  int32  tier      = 3;
  string endpoint  = 4;
  string status    = 5;
  double load      = 6;
  double latency_ms = 7;
  string region    = 8;
}

message CellUpdate {
  string uri        = 1;
  string value_json = 2;
  int32  version    = 3;
  int64  ts_ms      = 4;
}

message MigrationResult {
  bool   success    = 1;
  int32  duration_ms = 2;
  int32  attempts   = 3;
}
`.trim();

/** Default proto path, used if the caller does not supply one. */
const DEFAULT_PROTO_PATH = './proto/quilt_fleet.proto';

/** Public factory. Returns a {@link GrpcServer} handle. */
export function createGrpcServer(fleet: FleetManager, opts: { protoPath?: string; bindAddr?: string } = {}) {
  const handle: GrpcServer = {
    fleet,
    protoPath: opts.protoPath,
    bindAddr:  opts.bindAddr ?? '0.0.0.0:7070',
    /** Start the server. Lazy-loads @grpc/grpc-js and
     *  @grpc/proto-loader to keep optional-deps clean. */
    async start() {
      let grpc: any;
      let protoLoader: any;
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        grpc = require('@grpc/grpc-js');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        protoLoader = require('@grpc/proto-loader');
      } catch (e) {
        throw new Error(
          'gRPC server requires @grpc/grpc-js and @grpc/proto-loader. ' +
          'Install them to enable gRPC.',
        );
      }
      const def = protoLoader.loadSync(this.protoPath ?? DEFAULT_PROTO_PATH, {
        keepCase: true,
        longs:    String,
        enums:    String,
        defaults: true,
        oneofs:   true,
      });
      const proto = grpc.loadPackageDefinition(def);
      const pkg = proto.quilt?.fleet?.v1;
      if (!pkg) throw new Error('proto did not contain package quilt.fleet.v1');

      const server = new grpc.Server();
      server.addService(pkg.FleetService.service, {
        ListInstances: this.listInstances.bind(this),
        GetInstance:   this.getInstance.bind(this),
        Subscribe:     this.subscribe.bind(this),
        Migrate:       this.migrate.bind(this),
      });
      await new Promise<void>((resolve, reject) => {
        server.bindAsync(this.bindAddr, grpc.ServerCredentials.createInsecure(), (err: Error | null) => {
          if (err) reject(err); else resolve();
        });
      });
      this._server = server;
    },
    async stop() {
      if (!this._server) return;
      await new Promise<void>(resolve => this._server!.tryShutdown(() => resolve()));
    },
    /* ─── handlers ────────────────────────────────────────────── */
    listInstances(call: any) {
      for (const i of this.fleet.registry.all()) {
        call.write({
          id:        i.id,
          name:      i.name,
          tier:      i.tier,
          endpoint:  i.endpoint,
          status:    i.status,
          load:      i.load,
          latency_ms: i.latencyMs,
          region:    i.region ?? '',
        });
      }
      call.end();
    },
    getInstance(call: any, callback: any) {
      const req = call.request;
      const i = req.name
        ? this.fleet.registry.byInstanceName(req.name)
        : this.fleet.registry.get(req.id);
      if (!i) return callback({ code: 5, message: 'not found' }); // NOT_FOUND
      callback(null, {
        id:        i.id,
        name:      i.name,
        tier:      i.tier,
        endpoint:  i.endpoint,
        status:    i.status,
        load:      i.load,
        latency_ms: i.latencyMs,
        region:    i.region ?? '',
      });
    },
    subscribe(call: any) {
      const req = call.request;
      parseQuiltUri(req.uri); // validate
      this.fleet.subscribe(req.uri).then(sub => {
        sub.on('update', (u) => {
          call.write({
            uri:        u.uri,
            value_json: JSON.stringify(u.value),
            version:    u.version,
            ts_ms:      u.ts,
          });
        });
        call.on('cancelled', () => this.fleet.subscriptions.unsubscribe(sub.id));
      }).catch((e) => {
        call.emit('error', { code: 13, message: (e as Error).message }); // INTERNAL
      });
    },
    async migrate(call: any, callback: any) {
      const req = call.request;
      const r = await this.fleet.migrate(req.uri, req.target);
      callback(null, { success: r.success, duration_ms: r.durationMs, attempts: r.attempts });
    },
    _server: null as any,
  };
  return handle;
}

export interface GrpcServer {
  fleet: FleetManager;
  protoPath?: string;
  bindAddr: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  listInstances(call: any): void;
  getInstance(call: any, callback: any): void;
  subscribe(call: any): void;
  migrate(call: any, callback: any): Promise<void>;
  _server: any;
}
