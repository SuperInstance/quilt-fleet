# Migration

> Migration is the answer to: *"I need to move a cell from instance
> A to instance B without ever dropping the value or breaking
> in-flight subscribers."* `quilt-fleet` implements a **two-phase
> cutover** with read-back verification.

## 1. When to migrate

The fleet proposes a migration when **any** of the following holds:

1. The source instance is **unreachable** (no heartbeat for 15 s).
2. The source instance is **persistently degraded** (EWMA latency
   above 1 s for 5 min).
3. The source's **load** is above the auto-scaler threshold and a
   peer instance has spare capacity.
4. An operator **manually** issues `quilt-fleet migrate`.
5. A **geographic** policy says a cell should live closer to its
   most-active subscriber (e.g. an EU user moved to a US cell).

## 2. The two-phase cutover

```
   Time ──────────────────────────────────────────────────────▶

   SOURCE                                  DEST
   ──────                                  ────
   ┌────────────┐
   │ Phase 1A   │  freeze writes (advisory)
   │  t=0ms     │  snapshot value v_n
   └────┬───────┘
        │  ┌────────────┐
        │  │ Phase 1B   │  write v_n to DEST
        │  │  t=0..50ms │  DEST acknowledges
        │  └────┬───────┘
        │       │ ┌────────────┐
        │       │ │ Phase 2A   │  read-back v_n from DEST
        │       │ │  t=50ms    │  value must match
        │       │ └────┬───────┘
        │       │      │ ┌────────────┐
        │       │      │ │ Phase 2B   │  flip DNS / routing
        │       │      │ │  t=100ms   │  queries now go to DEST
        │       │      │ └────┬───────┘
        │       │      │      │ ┌────────────┐
        │       │      │      │ │ Phase 2C   │  unfreeze SOURCE
        │       │      │      │ │  t=150ms   │  (writes resume, but
        │       │      │      │ │            │   go to DEST now)
        │       │      │      │ └────────────┘
   ──────                                  ────
```

Total cutover window: **~150 ms** in the happy path.

## 3. Failure handling

| Phase  | If it fails                                  | Recovery                          |
|--------|-----------------------------------------------|------------------------------------|
| 1A     | source can't freeze                          | abort; retry in 30 s              |
| 1B     | destination unreachable                      | abort; mark dest bad; try another |
| 2A     | read-back mismatches                         | retry 1B; if still bad, abort     |
| 2B     | routing flip fails                           | rollback; new attempt 5 min later |
| 2C     | source unfreeze fails                        | log warning; SOURCE will idle out |

A migration is considered **successful** only when 2C completes.
Until then, reads are served from SOURCE (it is still the
authoritative answer). A failed migration is *idempotent* — the
next attempt resumes from the same point.

## 4. Subscribers during migration

A subscriber that is mid-receive when 2B happens receives **one
final update from SOURCE** (the last value before the flip) and
**then reconnects to DEST**. The double-update is intentional: it
guarantees no subscriber silently misses the last value.

`@quilt/sdk` de-duplicates using the cell version, so the user
sees a single value.

## 5. Quorum migration

If a cell is replicated under quorum (N copies), migration is
**per-replica**:

1. Pick the replica with the most current version.
2. Migrate the others one at a time.
3. Only when all replicas are on the new tier does the quorum
   pointer flip.

The cutover is therefore **linear in N**, not exponential.

## 6. Programmatic API

```ts
const result = await fleet.migrate(
  'quilt://server-primary/session#user-42',
  'quilt://server-replica-1',
  { timeoutMs: 5_000, verify: true },
);

// result.success   — true if all phases completed
// result.durationMs — total wall time
// result.attempts  — how many attempts (1 in the happy path)
```

## 7. CLI

```bash
quilt-fleet migrate \
    quilt://server-primary/session#user-42 \
    quilt://server-replica-1
```

## 8. Audit

Every migration is logged with:

- `who` triggered it (operator id or auto-scaler)
- `why` (heartbeat timeout, load, manual, …)
- `when` (timestamps per phase)
- `result` (success / aborted / failed)

The audit log is streamed to the registry and can be exported to
`quilt-vault` for tamper-evident storage.
