# ════════════════════════════════════════════════════════════════════════════
# quilt-fleet
# Federation & orchestration across Quilt tiers
# ════════════════════════════════════════════════════════════════════════════

```
   ██████╗ ██╗   ██╗██╗██╗     ████████╗      ███████╗██╗     ███████╗███████╗████████╗
  ██╔═══██╗██║   ██║██║██║     ╚══██╔══╝      ██╔════╝██║     ██╔════╝██╔════╝╚══██╔══╝
  ██║   ██║██║   ██║██║██║        ██║   █████╗█████╗  ██║     █████╗  █████╗     ██║
  ██║▄▄ ██║██║   ██║██║██║        ██║   ╚════╝██╔══╝  ██║     ██╔══╝  ██╔══╝     ██║
  ╚██████╔╝╚██████╔╝██║███████╗   ██║         ██║     ███████╗███████╗███████╗   ██║
   ╚══▀▀═╝  ╚═════╝ ╚═╝╚══════╝   ╚═╝         ╚═╝     ╚══════╝╚══════╝╚══════╝   ╚═╝

   Federation · Orchestration · Discovery · Quorum · Migration · Auto-scaling
```

> **The 18th Quilt repo.** This is the **fleet** layer — the conductor that turns
> dozens of Quilt instances (ESP32, Jetson, Codespace, Cloudflare Workers, Servers)
> into a single, addressable federation.

[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![typescript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](./tsconfig.json)
[![tests](https://img.shields.io/badge/tests-75%2B-brightgreen.svg)](./test)
[![node](https://img.shields.io/badge/node-%3E%3D18-green.svg)](./package.json)
[![version](https://img.shields.io/badge/version-0.1.0-orange.svg)](./package.json)

---

## ✦ What is `quilt-fleet`?

`quilt-fleet` is the **orchestration plane** for the Quilt ecosystem. While
[`@quilt/core`](../quilt) defines the cell model and
[`@quilt/sdk`](../quilt-live) lets a single process read and write cells, real
deployments need **dozens of Quilt instances** running on vastly different
hardware — and they must agree on what cells exist, where they live, and how
to route requests to the closest, freshest copy.

`quilt-fleet` answers that need. It:

- **Registers** Quilt instances by **tier** (esp32, jetson, codespace, cloudflare, server)
- **Discovers** cells via URI: `quilt://[instance]/[sheet]#[cell]`
- **Subscribes** to cells across instances — propagation flows through the fleet
- **Monitors health** via heartbeat, latency, last-update tracking
- **Auto-scales** by spawning instances when a cell's load crosses a threshold
- **Quorums** critical cells across N instances and uses majority vote
- **Migrates** cells between instances without dropping the value
- **Routes** queries to the best instance by tier, latency, locality

---

## ✦ Tier model

```
   ┌──────────────────────────────────────────────────────────────────┐
   │                          QUILT FLEET                              │
   └──────────────────────────────────────────────────────────────────┘

        ◀────  ESP32 (Tier 1)  ────▶  edge sensor / actuator
        ┌───────────────────────────────────────────────────────┐
        │  ◯ esp32-living-1   ◯ esp32-living-2   ◯ esp32-garage │
        │  sensors: temp, motion, lux                          │
        │  constraints: 320KB RAM, 4MB flash, WiFi only         │
        └───────────────────────────────────────────────────────┘
                                  │
                                  ▼ mqtt / ws
        ◀────  Jetson (Tier 2)  ────▶  edge inference / aggregator
        ┌───────────────────────────────────────────────────────┐
        │  ◯ jetson-orin-1    ◯ jetson-orin-2                   │
        │  runs: yolo, ocr, blender, vector index              │
        │  constraints: 8-32GB RAM, CUDA, ROS2                  │
        └───────────────────────────────────────────────────────┘
                                  │
                                  ▼ quic / ws
        ◀────  Codespace (Tier 3)  ────▶  dev / staging fleet
        ┌───────────────────────────────────────────────────────┐
        │  ◯ codespace-dev-1   ◯ codespace-staging-1            │
        │  runs: build agents, test runners, e2e               │
        │  constraints: 2-32 vCPU burst, ephemeral             │
        └───────────────────────────────────────────────────────┘
                                  │
                                  ▼ https
        ◀────  Cloudflare (Tier 4)  ────▶  global edge / KV
        ┌───────────────────────────────────────────────────────┐
        │  ◯ cf-worker-eu   ◯ cf-worker-us   ◯ cf-worker-apac   │
        │  runs: vectorize, durable objects, kv, d1            │
        │  constraints: 30s CPU, 128MB mem, anycast            │
        └───────────────────────────────────────────────────────┘
                                  │
                                  ▼ nats / grpc
        ◀────  Server (Tier 5)  ────▶  authoritative cluster
        ┌───────────────────────────────────────────────────────┐
        │  ◯ server-primary  ◯ server-replica-1  ◯ server-replica-2 │
        │  runs: postgres, kafka, vault, consensus, archival   │
        │  constraints: 64-512GB RAM, nvme, raid, datacenter   │
        └───────────────────────────────────────────────────────┘
```

---

## ✦ Quick start

```bash
# 1. Install
npm install @quilt/fleet

# 2. Initialize a fleet config
quilt-fleet init --config fleet.yaml

# 3. Register three instances
quilt-fleet add quilt://living-room@esp32.local
quilt-fleet add quilt://kitchen@jetson.local:4040
quilt-fleet add quilt://primary@server.internal:7070

# 4. Subscribe a cloudflare worker to a sensor cell
quilt-fleet subscribe quilt://living-room/temperature#ambient --to cf-edge

# 5. Watch propagation
quilt-fleet watch quilt://living-room/temperature#ambient
```

Programmatic API:

```typescript
import { FleetManager, Tier, Discovery } from '@quilt/fleet';

// Construct a fleet with discovery enabled
const fleet = new FleetManager({
  id: 'main',
  discovery: { bonjour: true, dnsSd: true, static: './fleet.yaml' },
  scaling: { policy: 'load', threshold: 100, min: 1, max: 10 },
  quorum:   { default: 3, critical: ['safety', 'vault.lock'] },
});

await fleet.start();

// Register an instance manually
const instance = await fleet.registry.register({
  tier: Tier.Jetson,
  name: 'jetson-orin-1',
  endpoint: 'http://jetson-orin-1.local:4040',
  capabilities: { cuda: true, ram_mb: 32768 },
});

// Subscribe a remote cell — propagation flows through the fleet
const sub = await fleet.subscribe('quilt://jetson-orin-1/sensors#temperature');
sub.on('update', (value, meta) => {
  console.log('cell updated', value, 'at', meta.origin);
});

// Query a cell from the best instance (by tier, latency, locality)
const cell = await fleet.query('quilt://server-primary/vault#root');

// Migrate without dropping the value
await fleet.migrate(
  'quilt://server-primary/session#user-42',
  'quilt://server-replica-1'
);

await fleet.shutdown();
```

---

## ✦ Cross-references

| Repo | Role |
|------|------|
| [`quilt`](../quilt)              | Core cell model, propagation, lattice algebra |
| [`quilt-live`](../quilt-live)    | Reactive SDK with observables |
| [`quilt-mesh`](../quilt-mesh)    | P2P transport for a single mesh |
| [`quilt-flow`](../quilt-flow)    | Dataflow / pipelines |
| `quilt-fleet` (**this**)         | Multi-tier federation across instances |
| `quilt-cloudflare`               | CF Workers / Durable Objects adapter |
| `quilt-esp32`                    | Embedded client |
| `quilt-vault`                    | Encrypted secrets |

`quilt-fleet` sits **above** `quilt-mesh` — a mesh is a single Quilt
instance; a fleet is a federation of meshes that share a URI namespace.

---

## ✦ CLI

```text
quilt-fleet init        # create a fleet config
quilt-fleet add <uri>   # register an instance
quilt-fleet list        # show all instances
quilt-fleet status <i>  # show instance health
quilt-fleet subscribe <uri>  # subscribe to a cell
quilt-fleet migrate <uri> <target>  # move a cell
quilt-fleet scale <policy>      # apply scaling policy
quilt-fleet serve              # run as the central orchestrator
```

---

## ✦ Engineering bar compliance

- [x] **Apache-2.0** license
- [x] All files have **header comments** describing their role
- [x] **ASCII art**, badges, and a tier model diagram
- [x] **TypeScript strict mode** (`strict: true`)
- [x] **75+ tests** across 6 test suites
- [x] **CLI** with 8 subcommands
- [x] **REST API** with 8 endpoints
- [x] **5 tier-specific configs** (esp32, jetson, codespace, cloudflare, server)
- [x] **5 example YAML configs** for real-world deployments
- [x] **CI** workflow (typecheck + test + build)
- [x] **Cross-references** to sibling Quilt repos

See [`QUILT_ENGINEERING_BAR.md`](../QUILT_ENGINEERING_BAR.md) for the full bar.

---

## ✦ License

Apache-2.0 — see [`LICENSE`](./LICENSE).

`quilt-fleet` is part of the Quilt federation. Maintained by
[SuperInstance](https://github.com/SuperInstance).
