# 5. OpenAPI 3.1 Canonical Contract and Automated Conformance Testing

## Context
GobboNet provides a rich HTTP API spanning session authentication, proxied LLM completions, detached job execution, cross-device state synchronization, and runtime performance tuning. Maintaining strict wire parity between the parallel Go and PowerShell runtimes requires an explicit, machine-readable contract. Developers need rapid, interactive API observability and pulse-checking (via Yaak), while CI requires automated, headless contract validation across all supported operating systems.

## Decision
Adopt **OpenAPI 3.1** (`gobbonet_openapi.yaml`) as the single canonical source of truth for GobboNet's API contracts. Serve the specification statically at `GET /openapi.yaml` on both the Go server and PowerShell `fileserver.ps1`. Implement automated Go conformance testing (`internal/server/conformance_test.go`) within the multi-OS GitHub Actions CI pipeline to validate registered route contracts against the OpenAPI specification without external runtime dependencies.

## Consequences
Documentation, interactive developer pulse-checking in Yaak, and automated CI tests are tightly coupled to a single specification. Any API drift or regression is caught immediately at test time, while developers gain one-click import into Yaak for interactive debugging.
