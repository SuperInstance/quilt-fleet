# Architecture

> `quilt-fleet` is the **orchestration plane** that sits above the Quilt
> data plane (one or more [`@quilt/core`](../quilt) instances). It does
> not store cells itself — it routes, federates, and orchestrates the
> Quilt instances that do.

## 1. Layering

```
   ┌──────────────────────────────────────────────────────────────────┐
   │  Applications (CLI · REST · GraphQL · gRPC · dashboard)         │
   └──────────────────────────────────────────────────────────────────┘
                                  │  consumes
                                  ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │  quilt-fleet  (this repo)                                       │
   │  ────────────────────────                                       │
   │   • FleetManager        top-level lifecycle, dependencies        │
   │   • Registry            instance bookkeeping                    │
   │   • Discovery           bonjour / dns-sd / static config         │
   │   • Health              heartbeat, latency, last-update          │
   │   • Subscription        cross-instance cell subscription        │
   │   • Routing             pick best instance for a query          │
   │   • Quorum              majority vote across N replicas          │
   │   • Migration           two-phase cell move                     │
   │   • Scaling             policy-driven instance spawn / destroy  │
   └──────────────────────────────────────────────────────────────────┘
            │              │              │              │
            ▼              ▼              ▼              ▼
        transports/    tiers/         discovery/      api/
        http, ws,      esp32,         bonjour,        rest,
        mqtt, nats     jetson,        dns-sd,         graphql,
                       codespace,     static          grpc
                       cloudflare,
                       server
                                  │
                                  ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │  Quilt instances (per-tier)                                     │
   │   • quilt-esp32, quilt-jetson, quilt-codespace,                 │
   │     quilt-cloudflare, quilt-server                              │
   │  They speak the cell protocol over the transport of choice.     │
   └──────────────────────────────────────────────────────────────────┘
```

## 2. Core types

```ts
// An addressable Quilt instance.
interface Instance {
  id: string;                    // ULID
  tier: Tier;                    // esp32 | jetson | codespace | cloudflare | server
  name: string;                  // human label, e.g. "jetson-orin-1"
  endpoint: string;              // http://jetson.local:4040
  transport: 'http' | 'ws' | 'mqtt' | 'nats';
  capabilities: Record<string, unknown>;
  status: 'healthy' | 'degraded' | 'unreachable';
  lastHeartbeat: number;         // epoch ms
  latencyMs: number;             // rolling EWMA
  load: number;                  // 0.0 .. 1.0
  region?: string;               // us-east, eu-west, apac, ...
  zone?: string;
}

// A cell in the federation, identified by URI.
interface CellRef {
  uri: string;                   // quilt://instance/sheet#cell
  instance: string;              // owning instance
  sheet: string;                 // logical group
  cell: string;                  // cell name
  version: number;               // monotonic
  updatedAt: number;
}
```

## 3. Lifecycle

```
   ┌────────┐  init   ┌──────────┐  start  ┌──────────┐  serve  ┌────────┐
   │  new   │ ──────▶ │  load    │ ──────▶ │  discover│ ──────▶ │  run   │
   └────────┘         │  config  │         │  & bind  │         └────────┘
                      └──────────┘         └──────────┘
                                                │  stop / signal
                                                ▼
                                          ┌────────────┐
                                          │  shutdown  │
                                          │  drain,    │
                                          │  persist   │
                                          └────────────┘
```

## 4. Failure modes

| Failure | Detection | Recovery |
|---------|-----------|----------|
| Instance crash      | missed heartbeat                | mark unreachable, redistribute load |
| Slow instance       | EWMA latency > 250 ms           | route to faster replica, log warning |
| Quorum split        | majority not reached in 2 s     | return `NO_QUORUM`, surface alert |
| Migration failure   | destination does not ack        | rollback to source, retry with backoff |
| Discovery storm     | > 100 bonjour packets/s         | rate-limit, switch to static config |

## 5. Why a separate repo?

- The Quilt **core** is small and pure — it must run on an ESP32 with
  320 KB of RAM. An orchestrator is too heavy.
- Federation is **a concern of the operator**, not the cell. It belongs
  in its own package with its own test suite, its own CLI, its own
  release cadence.
- Most Quilt instances never need to know the fleet exists. They
  speak the cell protocol to whatever Quilt instance is in front of
  them. `quilt-fleet` is what those front-facing instances talk to.

## 6. Future work

- Raft-backed control plane for the registry itself.
- CRDT-backed routing table so two fleet managers can merge.
- WASM tier plugin so users can run their own tier adapter.
- gRPC streaming for sub-millisecond migration handoff.
