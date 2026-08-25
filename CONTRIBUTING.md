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
| **Zero Build Step** | `chat.html`, `js/` (24 modules), and `css/` (15 stylesheets) run as plain, unbundled web assets. No npm, no webpack, no transpilers. |
| **Parallel Runtime Parity** | The Go server (`cmd/gobbonet`) and the PowerShell server (`fileserver.ps1`) must maintain 100% identical HTTP wire contracts on port 9066. |
| **Single-File Focus** | Prefer surgical, single-concern micro-PRs (1–2 files modified) over massive, multi-file refactors. |
| **Offline-First & Private** | GobboNet runs strictly on loopback (`127.0.0.1`). No user data, telemetry, or prompt content ever leaves the local machine. |

---

## 3. Contributor Macros & Commands

GobboNet includes pre-seeded macros to streamline AI-assisted development:

- **`{{grill}}`**: Prompts the AI to interview you on requirements and edge cases before writing code.
- **`{{adr}}`**: Formats a 1-paragraph Architectural Decision Record (Context, Decision, Consequences).
- **`{{review}}`**: Audits a proposed diff against GobboNet invariants and load-order rules.
- **`{{standup}}`**: Generates a daily engineering standup check-in.

> 💡 **Daily Standup in Scheduler:** Open **`// SCHED`** in the chat and click **`➕ DAILY CONTRIBUTOR STANDUP`** to get an automated daily 09:00 check-in prompt!

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

### Git Branching (Micro-PR Model)
1. Fork the repository and clone locally.
2. Create a clean feature branch:
   ```bash
   git checkout -b feat/my-surgical-feature
   ```
3. Author your change, verify with tests and `./stage-web.sh`, and commit with a clear message:
   ```bash
   git commit -m "feat(ui): add syntax highlighting for card code blocks"
   ```
4. Open a Pull Request on GitHub.

---

## 5. Community & Support

- Open an issue for bugs or architectural proposals.
- Keep discussions respectful, focused, and pragmatic.

*GobboNet is built by and for the community. No venture capital, no telemetry, no masters.*
