# Health

> Health is the answer to: *"Is this instance still alive, and how
> quickly can I get an answer from it?"* `quilt-fleet` tracks three
> numbers per instance: **heartbeat age**, **rolling latency**, and
> **last update age**. Together they let the fleet detect and react
> to failures within seconds.

## 1. Heartbeat

Every Quilt instance sends a small heartbeat to the fleet manager
every `5s` (configurable). The fleet marks an instance
**unreachable** after 3 missed beats.

```ts
heartbeat: {
  intervalMs: 5_000,
  missedBeforeUnreachable: 3,
}
```

The heartbeat payload is intentionally tiny:

```json
{
  "id":   "01JABCD...",
  "tier": "jetson",
  "v":    "0.1.0",
  "load": 0.42,
  "cells": 1234
}
```

## 2. Rolling latency

On every health probe the fleet records the round-trip time and
feeds it into an **exponentially weighted moving average**:

```
   ewma_new = 0.3 * sample + 0.7 * ewma_old
```

This makes the latency reactive to recent changes while staying
robust against outliers. The fleet also keeps a `p95` over the last
100 samples for the dashboard.

## 3. Last update age

For each cell the registry knows about, the fleet records when it
last received a write. Cells that have not been written in a long
time are flagged as **stale**. The threshold is per-tier:

| Tier        | Default stale threshold |
|-------------|--------------------------|
| esp32       | 60 s                     |
| jetson      | 5 min                    |
| codespace   | 30 min                   |
| cloudflare  | 10 min                   |
| server      | 1 hour                   |

A stale cell is not necessarily unhealthy — some cells are
intentionally write-rare. The fleet only fires an alert if a
cell's *configured* `expectedWriteHz` is exceeded by 5× in either
direction.

## 4. Status state machine

```
                 ┌──────────────┐
                 │  UNKNOWN     │  (just registered)
                 └──────┬───────┘
                        │ first heartbeat
                        ▼
                 ┌──────────────┐
       ┌────────▶│   HEALTHY    │◀────────┐
       │         └──────┬───────┘         │
       │                │ heartbeat       │ heartbeat
       │                │ times out       │ received
       │                ▼                 │
       │         ┌──────────────┐         │
       │         │  DEGRADED    │─────────┘
       │         └──────┬───────┘
       │                │ N consecutive failures
       │                ▼
       │         ┌──────────────┐
       └─────────│ UNREACHABLE  │
                 └──────┬───────┘
                        │ recovery + ack
                        ▼
                 ┌──────────────┐
                 │   HEALTHY    │
                 └──────────────┘
```

## 5. Health API

```http
GET /api/health
200 OK
{
  "fleet":   "healthy",
  "instances": {
    "jetson-orin-1":  "healthy",
    "esp32-living-1": "degraded",
    "server-primary": "healthy"
  },
  "totals":   { "healthy": 4, "degraded": 1, "unreachable": 0 }
}
```

## 6. Programmatic access

```ts
const h = await fleet.health.get('jetson-orin-1');
// h.status, h.latencyMs, h.lastHeartbeat, h.lastUpdate
```

## 7. Reactive hooks

```ts
fleet.health.on('degraded',     (id) => …);
fleet.health.on('unreachable',  (id) => …);
fleet.health.on('recovered',    (id) => …);
fleet.health.on('latencySpike', (id, ms) => …);
```

These events are the inputs to the auto-scaler and to the
incident-response playbook.

## 8. Health-driven routing

The router consults health on every query:

- A query to a `degraded` instance is **retried** once on a
  healthy replica before the user sees an error.
- A query to an `unreachable` instance is **immediately** rerouted.
- A *write* to an `unreachable` instance triggers a **migration
  proposal** (see `migration.md`).
