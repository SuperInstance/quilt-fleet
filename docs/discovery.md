# Discovery

> Discovery is the answer to: *"How does a fleet manager know which
> Quilt instances exist, where they live, and what they can do?"*
> `quilt-fleet` supports three complementary mechanisms: **mDNS/Bonjour**,
> **DNS-SD**, and **static configuration**.

## 1. The `quilt://` URI

Every cell is addressed by a URI:

```
   quilt://[instance]/[sheet]#[cell]
   │        │          │       │
   │        │          │       └─ cell name within the sheet
   │        │          └───────── logical group of cells (like a table)
   │        └──────────────────── the Quilt instance that owns the sheet
   └───────────────────────────── scheme, reserved
```

Examples:

```
   quilt://jetson-orin-1/sensors#temperature
   quilt://server-primary/vault#root
   quilt://esp32-living-1/actuator#relay-3
   quilt://cf-edge/session#user-42
```

The `instance` segment is a DNS-style name. It resolves through the
discovery layer:

1. **mDNS / Bonjour** — local network, no central server.
2. **DNS-SD** — wide-area, uses unicast DNS.
3. **Static config** — `fleet.yaml`, useful for production.

## 2. mDNS / Bonjour

Each Quilt instance advertises itself as a Bonjour service:

```
   _quilt._tcp.local.  PTR  quilt-fleet._quilt._tcp.local.
   quilt-fleet._quilt._tcp.local.  SRV  jetson-orin-1.local.:4040
   jetson-orin-1._quilt._tcp.local.  TXT  "tier=jetson" "v=0.1" "id=01J..."
```

The fleet manager subscribes to `_quilt._tcp.local.` and updates its
registry whenever a new instance appears or an old one disappears.

```ts
import { Discovery, DiscoveryMethod } from '@quilt/fleet';

const discovery = new Discovery({
  bonjour: true,
  onInstanceFound: (info) => console.log('found', info),
  onInstanceLost:  (id)    => console.log('lost',  id),
});

await discovery.start();
```

The Bonjour adapter is implemented with [`bonjour-service`][bonjour]
and works on Linux, macOS, and Windows.

[bonjour]: https://www.npmjs.com/package/bonjour-service

## 3. DNS-SD

For deployments that span subnets, mDNS does not work. The fleet
falls back to **DNS Service Discovery** (RFC 6763): the same SRV/TXT
records, but served by a real DNS server (Route 53, Cloudflare DNS,
CoreDNS, …).

```yaml
discovery:
  dnsSd:
    enabled: true
    domain:  _quilt._tcp.fleet.internal
    servers: [10.0.0.53, 10.0.0.54]
```

## 4. Static configuration

For production, you usually want a **bounded, reviewed list** of
instances. `fleet.yaml` is the canonical way:

```yaml
instances:
  - name: jetson-orin-1
    tier: jetson
    endpoint: http://jetson-orin-1.lan:4040
    transport: ws

  - name: server-primary
    tier: server
    endpoint: grpc://server.internal:7070
    transport: grpc
    region: us-east-1

  - name: cf-edge-eu
    tier: cloudflare
    endpoint: https://quilt-edge-eu.superinstance.workers.dev
    transport: http
```

The fleet merges static config with whatever discovery returns,
giving precedence to the static record (so an operator can pin an
endpoint even if mDNS is noisy).

## 5. Hybrid mode

You can mix all three:

```ts
const fleet = new FleetManager({
  discovery: {
    bonjour: true,        // discover dev ESP32s on the LAN
    dnsSd:    true,        // discover jetsons in the office VPN
    static:   './prod.yaml', // pin server-tier endpoints
  },
});
```

The registry deduplicates by instance name. The first source to
report wins; later sources are ignored unless they change
capability or tier.

## 6. Security considerations

- mDNS is **broadcast** — anyone on the LAN can see your fleet.
  Disable it in production with `bonjour: false`.
- DNS-SD records can be **tampered with** if the DNS server is
  compromised. Use DNSSEC where possible.
- Static config is **only as safe as your git repo**. Pin SHA-256
  hashes of the instance binaries if you want belt-and-braces.

## 7. Discovery events

```ts
fleet.discovery.on('up',      (info) => …);
fleet.discovery.on('down',    (id)   => …);
fleet.discovery.on('updated', (info) => …);
```
