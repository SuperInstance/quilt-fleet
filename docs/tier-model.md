# Tier Model

> `quilt-fleet` recognizes **five tiers** of Quilt instance, each with
> its own hardware constraints, transport preferences, and default
> roles. The tier is the single most important property of an
> instance — it shapes how the fleet talks to it, what cells it
> typically owns, and how it is allowed to fail.

## The five tiers

```
   tier 1  ─ ESP32          320 KB RAM, WiFi only,    battery-powered
   tier 2  ─ Jetson         8-32 GB RAM, CUDA,        plugged in
   tier 3  ─ Codespace      2-32 vCPU burst,          ephemeral
   tier 4  ─ Cloudflare     30 s CPU, 128 MB mem,      global edge
   tier 5  ─ Server         64-512 GB RAM, NVMe,      datacenter
```

## 1. ESP32 — Tier 1

**Role**: sensor fan-in, actuator fan-out, the *edge of the edge*.

| Property            | Value                                         |
|---------------------|-----------------------------------------------|
| RAM                 | 320 KB                                        |
| Flash               | 4 MB                                          |
| Network             | WiFi 2.4 GHz                                  |
| Transport           | MQTT (preferred), WebSocket                   |
| Typical cells       | `sensors.temperature`, `sensors.motion`, `actuator.relay` |
| Failure mode        | power loss, WiFi drop                         |
| Backup              | keep last value, replay on reconnect          |
| Quorum eligible?    | **No** — too small                            |

A single ESP32 is not authoritative. Cells it produces are typically
replicated to a Jetson or server. The fleet treats ESP32 instances
as **sources of truth for local state** that the higher tiers
aggregate.

## 2. Jetson — Tier 2

**Role**: edge inference, local aggregation, protocol bridge.

| Property            | Value                                         |
|---------------------|-----------------------------------------------|
| RAM                 | 8-32 GB                                       |
| GPU                 | NVIDIA CUDA, Tensor cores                     |
| Network             | gigabit Ethernet + WiFi                       |
| Transport           | WebSocket, MQTT, gRPC                         |
| Typical cells       | `inference.detections`, `vision.frames`, `nav.odometry` |
| Failure mode        | kernel panic, OOM, CUDA error                 |
| Backup              | ESP32 fallback, peer Jetson failover         |
| Quorum eligible?    | **Yes** for non-critical cells                |

A Jetson can run real models. It is the natural place for local
inference (YOLO, OCR, audio) and for bridging protocols (BLE, Zigbee,
LoRa, ROS2). The fleet uses Jetsons as the **default aggregator**
for ESP32 cells.

## 3. Codespace — Tier 3

**Role**: development, CI, ephemeral workloads.

| Property            | Value                                         |
|---------------------|-----------------------------------------------|
| vCPU                | 2-32 burst                                    |
| RAM                 | 8-64 GB                                       |
| Network             | gigabit                                       |
| Transport           | HTTP, WebSocket                               |
| Typical cells       | `build.status`, `test.runner`, `e2e.result`   |
| Failure mode        | teardown, sleep, network policy               |
| Backup              | none — ephemeral by design                   |
| Quorum eligible?    | **No** — too volatile                         |

Codespaces are *throwaway* Quilt instances. The fleet treats them
as **read-mostly mirrors** used for development and CI; they never
hold authoritative state.

## 4. Cloudflare — Tier 4

**Role**: global edge, low-latency reads, write coalescing.

| Property            | Value                                         |
|---------------------|-----------------------------------------------|
| CPU                 | 30 s per request                              |
| Memory              | 128 MB                                        |
| Storage             | KV, D1, Durable Objects, Vectorize, R2        |
| Network             | anycast — closest POP                         |
| Transport           | HTTP (Workers), WebSocket (Durable Objects)   |
| Typical cells       | `edge.session`, `cdn.cacheKey`, `vector.embedding` |
| Failure mode        | regional outage, throttling                   |
| Backup              | regional failover via Workers                 |
| Quorum eligible?    | **Yes** for cached cells                      |

A Cloudflare Worker is **the front door** of a Quilt deployment. The
fleet uses Cloudflare instances to **answer reads close to the user**
and to **coalesce writes** before they hit a server-tier instance.

## 5. Server — Tier 5

**Role**: authoritative state, consensus, archival.

| Property            | Value                                         |
|---------------------|-----------------------------------------------|
| RAM                 | 64-512 GB                                     |
| Storage             | NVMe RAID, often petabyte-scale                |
| Network             | datacenter fabric                             |
| Transport           | gRPC, NATS, Postgres protocol                 |
| Typical cells       | `vault.*`, `auth.*`, `safety.*`, `ledger.*`   |
| Failure mode        | hardware fault, partition                     |
| Backup              | replica + WAL + offsite                       |
| Quorum eligible?    | **Yes** — the canonical quorum tier           |

A server-tier Quilt instance is the **system of record**. Every
critical cell lives here. The fleet treats server instances as
**the source of truth** and replicates to lower tiers for
performance and locality.

## Tier interaction matrix

| From \ To | ESP32 | Jetson | Codespace | Cloudflare | Server |
|-----------|-------|--------|-----------|------------|--------|
| **ESP32**      | —     | mqtt→ws  | ws        | https      | https  |
| **Jetson**     | mqtt  | ws      | ws        | https      | grpc   |
| **Codespace**  | —     | ws      | ws        | https      | https  |
| **Cloudflare** | —     | ws      | ws        | https      | https  |
| **Server**     | —     | grpc    | https     | https      | grpc   |

(`—` = rare / not recommended)

## Tier selection policy

When the fleet must place a new cell, it picks a tier from the cell's
`tierPreference` field (default: `server`). For each cell, you can
specify a list of allowed tiers:

```yaml
cells:
  sensors.temperature:  { tierPreference: [esp32, jetson] }
  inference.detections: { tierPreference: [jetson] }
  vault.lock:           { tierPreference: [server], quorum: 3 }
  edge.session:         { tierPreference: [cloudflare, server] }
```

The fleet then chooses the lowest tier that satisfies the preference
**and** has spare capacity.
