# Security Policy

## Supported Versions

`quilt-fleet` follows semantic versioning. The following versions are
currently supported with security updates:

| Version | Supported          | Notes                          |
|---------|--------------------|---------------------------------|
| 0.1.x   | :white_check_mark: | Initial federation release      |
| < 0.1   | :x:                | Pre-alpha, do not deploy        |

## Reporting a Vulnerability

If you discover a security issue in `quilt-fleet`, please report it
privately. **Do not** open a public GitHub issue for security bugs.

- **Email**: security@superinstance.ai
- **Subject prefix**: `[quilt-fleet] `
- **GPG fingerprint**: posted on https://superinstance.ai/.well-known/security.txt

We aim to acknowledge new reports within **2 business days** and to
ship a fix or mitigation within **30 days** for critical issues.

## Threat Model

`quilt-fleet` is an orchestration plane. The most security-sensitive
operations are:

1. **Instance registration** — a malicious instance could publish false
   health or proxy requests to attacker-controlled endpoints.
2. **Cell migration** — a malicious instance could redirect a cell
   write to itself, allowing tampered values to be propagated.
3. **Quorum** — a compromised instance could bias a quorum vote.
4. **Quilt URIs** — a `quilt://` URI can embed an instance name that
   resolves to an arbitrary address. Validate inputs.

To mitigate:

- All transport adapters use TLS by default (or `wss://` / `mqtts://`).
- The registry refuses to register an instance with a name that does
  not match `^[a-z0-9][a-z0-9-]{0,62}$`.
- Quorum reads use a configurable majority threshold; the default
  requires `(N/2 + 1)` matching values.
- Migration uses a two-phase commit with a verification step that
  reads the value from the destination before declaring success.
- mDNS / Bonjour advertisement is opt-in and never enabled by
  default in `serve` mode.

## Best Practices for Operators

- Run `quilt-fleet serve` behind a reverse proxy with TLS termination.
- Use the bundled `quilt-vault` integration to encrypt sensitive
  cells (`vault.lock`, `safety.eStop`, `auth.token`).
- Enable audit logging via `--log-level=info` to capture every
  migration, scaling event, and quorum vote.
- Set a `--max-instances` cap to prevent runaway auto-scaling.
- Pin transport endpoints in your `fleet.yaml` rather than relying
  on `bonjour:` discovery for production deployments.

## Disclosure

We follow **coordinated disclosure**. Please give us a reasonable
window to patch before publishing details.

Thanks for keeping the Quilt federation safe.
