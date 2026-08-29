# Contributing to GobboNet 🔨

Welcome to **GobboNet**! We are a non-profit, self-hosted, offline AI chat workbench designed for local hardware sovereignty. 

We love community contributions! Whether you're fixing a bug, adding a character preset, improving test coverage, or designing a new UI extension, this guide will help you craft clean, surgical pull requests that get reviewed and merged quickly.

---

## 1. Quick Start: Meet `ForgeGoblin` 🧙‍♂️

GobboNet includes a built-in AI pair programmer and architectural guide: **`ForgeGoblin`**.

1. Start GobboNet (`./gobbonet serve --config ./config.toml` or `launch.bat`).
2. Open `http://localhost:9066` in your browser.
3. Open **`// CHARS`** and activate **`ForgeGoblin`**.
4. Pitch your idea or type `{{grill}}` to let ForgeGoblin interview you down the design tree frontier, check system invariants, and help format your code!

---

## 2. Core Architectural Invariants

All contributions must respect GobboNet's fundamental design principles:

| Invariant | Principle |
| :--- | :--- |
| **Zero Build Step** | `chat.html`, `js/` (25 modules), and `css/` (15 stylesheets) run as plain, unbundled web assets. No npm, no webpack, no transpilers. |
| **Parallel Runtime Parity** | The Go server (`cmd/gobbonet`) and the PowerShell server (`fileserver.ps1`) maintain HTTP wire compatibility across core endpoints on port 9066 (with minor lifecycle differences documented in `docs/archived/GO_MIGRATION_INVENTORY.md`). |
| **Single-File Focus** | Prefer surgical, single-concern micro-PRs (1–2 files modified) over massive, multi-file refactors. |
| **Offline-First & Zero Telemetry** | GobboNet runs by default strictly on loopback (`127.0.0.1`). No telemetry, analytics, or user prompt tracking is EVER allowed into the public project. Features involving local profiling (e.g. private Echo mirroring) must remain strictly in private workspaces. |

---

## 3. Contributor Macros & Fast Shortcuts

GobboNet includes developer macros to accelerate pair-programming:

- **`{{grill}}`**: Prompts the AI to interview you on requirements and edge cases before writing code.
- **`{{adr}}`**: Formats a 1-paragraph Architectural Decision Record (Context, Decision, Consequences).
- **`{{review}}`**: Audits a proposed diff against GobboNet invariants and load-order rules.
- **`{{standup}}`**: *(Optional)* Generates a quick status and task check-in for regular builders.

---

## 4. Development & Testing Workflow

### Staging Web Assets
If you modify `chat.html`, `default-characters.json`, `js/`, or `css/`, re-stage the static root:
```bash
./stage-web.sh
```

### Running Backend Tests
Run the Go test suite with the race detector enabled across all packages:
```bash
go test -v -race ./...
```

### Running Automated User Stories
Verify deterministic story execution using the CLI test runner:
```bash
./gobbonet mock list
./gobbonet mock run story-01-character-swap
```

### Git Branching & Upstream PR Bundling Strategy
To make your contributions effortless for the upstream maintainers to review, split large architectural improvements into cohesive, surgical pull request bundles:

1. **Bundle 1: Composable Skills System** (`feat/skills-engine`)
   - Backend: `internal/skills/` (`GET/PUT /skills/*` discovery & parser)
   - Frontend: `js/25-skills.js`, `// SKILLS` modal editor in `chat.html`
   - Zero telemetry, pure filesystem discovery.

2. **Bundle 2: Automated Story Verification Engine** (`feat/mock-story-verifier`)
   - Backend: `internal/mock/` (`/mock/*` routes and `gobbonet mock [list|run]` CLI)
   - Sample stories in `stories/*.story.md`
   - Deterministic test replay and regression defense.

3. **Bundle 3: CI/CD & Cross-Platform Conformance Hardening** (`feat/ci-conformance-hardening`)
   - `.github/workflows/ci.yml` multi-OS matrix testing (Linux/macOS/Windows) with `-race` detection
   - Conformance contract tests in `internal/server/conformance_test.go`.

> [!CAUTION]
> **Private Workspace Isolation:**
> Experimental user profiling, tone telemetry counters, and personal prompt experiments are for **local private use only**. Keep them in your private fork and do **not** export them to public upstream branches.

---

## 5. Community & Support

- Open an issue for bugs or architectural proposals.
- Keep discussions respectful, focused, and pragmatic.

*GobboNet is built by and for the community. No venture capital, no telemetry, no masters.*

---

## 6. Dual-Mode Contributor Experience

### A. Sovereign Offline Contributor Mode (Zero Cloud)
- Run a full local install of GobboNet on your machine.
- Chat with `ForgeGoblin` to ideate, explore, and "vibe-code" community contributions completely offline.
- Run tests (`nix develop`, `./stage-web.sh`, `go test -race ./...`, `./gobbonet mock list`) with zero internet connection until you are ready to `git push`.

### B. Hybrid Agent Delegation
- If you use external AI coding assistants, they can query GobboNet on `127.0.0.1:9066` as a high-speed, 0-token local inference subagent for offline code drafting, AST checks, and prompt experiments.
