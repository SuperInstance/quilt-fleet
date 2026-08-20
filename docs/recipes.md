# Recipes

> Real-world deployment configurations. Each recipe is a single
> `fleet.yaml` you can run with `quilt-fleet serve --config ./X.yaml`.
> The full files live in [`../examples/`](../examples).

## Recipe 1 — Home IoT

**Use case**: 5 ESP32 sensors, 1 Jetson aggregator, 1 server for
archival. Sensor fan-out to a Cloudflare Worker dashboard.

```yaml
# examples/home-iot.yaml
fleet:
  id: home-main
  region: us-east-1

discovery:
  bonjour: true
  static: []

instances:
  - { name: esp32-living-1,   tier: esp32,      endpoint: mqtt://10.0.0.21:1883 }
  - { name: esp32-living-2,   tier: esp32,      endpoint: mqtt://10.0.0.22:1883 }
  - { name: esp32-kitchen,    tier: esp32,      endpoint: mqtt://10.0.0.23:1883 }
  - { name: esp32-bedroom,    tier: esp32,      endpoint: mqtt://10.0.0.24:1883 }
  - { name: esp32-garage,     tier: esp32,      endpoint: mqtt://10.0.0.25:1883 }
  - { name: jetson-orin-1,    tier: jetson,     endpoint: http://jetson.lan:4040 }
  - { name: server-primary,   tier: server,     endpoint: grpc://nas.lan:7070 }
  - { name: cf-edge,          tier: cloudflare, endpoint: https://quilt-home.workers.dev }

scaling:
  policy: load
  threshold: 50
  min: 1
  max: 3

quorum:
  default: 1
  critical:
    - sensors.smoke
    - safety.eStop
    - vault.lock
```

## Recipe 2 — Factory floor

**Use case**: 10 Jetsons on the line, 1 server for analytics, quorum
on safety-critical cells. Strict latency budget.

```yaml
# examples/factory.yaml
fleet:
  id: factory-line-3
  region: us-central-2

instances:
  - { name: line3-jetson-1,  tier: jetson, endpoint: grpc://line3-1.factory:4040, region: us-central-2 }
  - { name: line3-jetson-2,  tier: jetson, endpoint: grpc://line3-2.factory:4040, region: us-central-2 }
  - { name: line3-jetson-3,  tier: jetson, endpoint: grpc://line3-3.factory:4040, region: us-central-2 }
  - { name: line3-jetson-4,  tier: jetson, endpoint: grpc://line3-4.factory:4040, region: us-central-2 }
  - { name: line3-jetson-5,  tier: jetson, endpoint: grpc://line3-5.factory:4040, region: us-central-2 }
  - { name: line3-jetson-6,  tier: jetson, endpoint: grpc://line3-6.factory:4040, region: us-central-2 }
  - { name: line3-jetson-7,  tier: jetson, endpoint: grpc://line3-7.factory:4040, region: us-central-2 }
  - { name: line3-jetson-8,  tier: jetson, endpoint: grpc://line3-8.factory:4040, region: us-central-2 }
  - { name: line3-jetson-9,  tier: jetson, endpoint: grpc://line3-9.factory:4040, region: us-central-2 }
  - { name: line3-jetson-10, tier: jetson, endpoint: grpc://line3-10.factory:4040, region: us-central-2 }
  - { name: server-analytics, tier: server, endpoint: grpc://analytics.factory:7070, region: us-central-2 }

quorum:
  default: 3
  critical:
    - safety.eStop
    - safety.lightCurtain
    - plc.emergency
    - quality.rejectedCount

scaling:
  policy: load
  threshold: 200
  min: 10
  max: 14
```

## Recipe 3 — Research cluster

**Use case**: 3 Cloudflare Workers for global read latency, 1 server
holds the canonical embeddings index, vectorize as the shared store.

```yaml
# examples/research-cluster.yaml
fleet:
  id: research-cluster
  region: global

instances:
  - { name: cf-edge-eu,   tier: cloudflare, endpoint: https://quilt-eu.workers.dev,   region: eu-west-1 }
  - { name: cf-edge-us,   tier: cloudflare, endpoint: https://quilt-us.workers.dev,   region: us-east-1 }
  - { name: cf-edge-apac, tier: cloudflare, endpoint: https://quilt-apac.workers.dev, region: ap-south-1 }
  - { name: server-canon, tier: server,     endpoint: grpc://canon.research.internal:7070 }

routing:
  preferLocality: true
  localityKey: region

cells:
  vector.embedding: { tierPreference: [server, cloudflare], quorum: 3 }
  prompt.template:  { tierPreference: [cloudflare, server] }
  agent.run:        { tierPreference: [server] }
```

## Recipe 4 — Multi-region

**Use case**: 3 regions, each with a Cloudflare + server pair.
Reads stay regional; writes are replicated globally with quorum.

```yaml
# examples/multi-region.yaml
fleet:
  id: multi-region
  region: global

instances:
  # US
  - { name: cf-us,   tier: cloudflare, endpoint: https://quilt-us.workers.dev,   region: us-east-1 }
  - { name: srv-us,  tier: server,     endpoint: grpc://srv-us.internal:7070,    region: us-east-1 }
  # EU
  - { name: cf-eu,   tier: cloudflare, endpoint: https://quilt-eu.workers.dev,   region: eu-west-1 }
  - { name: srv-eu,  tier: server,     endpoint: grpc://srv-eu.internal:7070,    region: eu-west-1 }
  # APAC
  - { name: cf-apac, tier: cloudflare, endpoint: https://quilt-apac.workers.dev, region: ap-south-1 }
  - { name: srv-apac, tier: server,     endpoint: grpc://srv-apac.internal:7070,  region: ap-south-1 }

routing:
  preferLocality: true
  localityKey: region
  fallback: any

quorum:
  default: 2
  critical: [vault.lock, auth.token, billing.invoice]
```

## Recipe 5 — Disaster recovery

**Use case**: hot standby in a second region. Auto-migrate the
moment the primary goes dark.

```yaml
# examples/disaster-recovery.yaml
fleet:
  id: dr-pair
  region: us-east-1

instances:
  - name: srv-primary
    tier: server
    endpoint: grpc://srv-primary.us-east-1.internal:7070
    region: us-east-1
    role: primary
  - name: srv-standby
    tier: server
    endpoint: grpc://srv-standby.us-west-2.internal:7070
    region: us-west-2
    role: standby

migration:
  triggerOnUnreachable: true
  unreachableAfterMs: 15_000
  verify: true
  rollbackOnFailure: true

quorum:
  default: 2
  critical: '*'   # all cells are critical in DR

scaling:
  policy: passive
```

## Tips

- Start with the **home-iot** recipe if you are new. It is small
  enough to read end-to-end.
- Add `region:` to every instance once you have more than one
  physical site — locality is the single biggest latency win.
- Use `quorum: '*'` only in DR; otherwise you pay the read cost
  on every cell.
