# Domain Glossary (CONTEXT.md)

### GobboNet Go Server
The standalone, compiled Go backend binary (`gobbonet`) that serves the chat UI, proxies requests to llama.cpp, manages in-memory generation jobs, and supervises local llama-server processes across Linux, macOS, and Windows.
_Avoid_: `Go Backend Runtime`, `gobbonet-server`, `Next-Gen Engine`

### Parallel Runtime Model
The operational architecture where the GobboNet Go Server and the PowerShell server (`fileserver.ps1`) coexist with strict API wire compatibility, allowing users to run either backend without mutual interference or configuration conflicts.
_Avoid_: `Replacement Backend`, `Unified Rewrite`, `Legacy Fallback`

### HITL Function-by-Function Review
The disciplined co-authoring review process of auditing every subsystem's anatomy, establishing clear regression tests, and refining code for pragmatism and clarity.
_Avoid_: `Vibe Coding`, `Black-box Acceptance`, `Bulk Porting`

### Smoke Test Track
The practical workflow of building, launching, and actively using the GobboNet Go Server locally against real upstreams and browsers to prove end-to-end viability ("works on my machine") ahead of deeper code audits.
_Avoid_: `Speculative Audit`, `Dry-run Verification`

### Driver (Lead Architect Model)
The primary resident technical reasoning model in VRAM that forms a Diad with the human engineer, focusing exclusively on high-altitude system architecture, multi-file continuity, design review, and tactical task scoping rather than low-level code churn.
_Avoid_: `Junior Dev Bot`, `Vibe Driver`, `Roleplay Default`

### Lead Architect Diad (The Diad)
The tightly-coupled Human-in-the-Loop partnership between the human engineer and the resident Driver model that maintains whole-system context, verifies design invariants, and reviews every proposed code modification.
_Avoid_: `Autonomous Solo Agent`, `Unsupervised Swarm`

### Tactical Worker Agent
A lightweight, specialized subagent dispatched by the Diad to execute a strictly bounded, single-file implementation or test task against a predefined, verifiable output schema.
_Avoid_: `Mega-Agent`, `Multi-File Sweeper`

### Single-File Change Invariant
The strict development discipline where all code modifications are authored, reviewed, and tested one file at a time, preventing sprawling opaque diffs while preserving system-wide cohesion at the Diad level.
_Avoid_: `Mass Refactor Diffs`, `Batch Patching`

### Swiss Army Knife (Pocket Tool)
The flexible conversational and persona model (e.g., Llama 3.1 8B) kept in reserve for nuanced multi-turn dialogue, character roleplay, and human-facing customer empathy rather than primary code architecture.
_Avoid_: `Primary Coding Engine`


