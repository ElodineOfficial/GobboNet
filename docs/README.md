# Documentation

Reference material and the per-change record. None of this is needed to *run*
GobboNet — see the [README](../README.md) at the repo root for that.

## Reference

| File | What it covers |
|---|---|
| [INDEX.md](INDEX.md) | Frontend module map. Translates a pre-v1.5 `chat.html` line number into the `js/` module that now holds it. |
| [GO_SERVER.md](GO_SERVER.md) | The Go server: what it does, how it supervises llama.cpp, what replaced the PowerShell file server. Also shipped as the README inside release bundles. |
| [GO_CONFIG_SPLIT.md](GO_CONFIG_SPLIT.md) | How configuration is divided between `config.toml`, `perf.toml` and runtime state. |
| [GO_MIGRATION_INVENTORY.md](GO_MIGRATION_INVENTORY.md) | What moved from PowerShell to Go, and what deliberately did not. |
| [RAG_INFO.md](RAG_INFO.md) | The retrieval pipeline — embedding server, chunking, how lore is selected. |
| [PURGE.md](PURGE.md) | What deleting data actually deletes, and where copies can survive. |

Kept at the repo root instead, because something points at them by name:

- **[README.md](../README.md)** — installed into the `.deb` as package documentation.
- **[TROUBLESHOOTING.md](../TROUBLESHOOTING.md)** and **[SECURITY.md](../SECURITY.md)** — `launch.bat` tells users to read these, so they need to be where a user looking for them will be.
- **[AGENTS.md](../AGENTS.md)** — conventionally found at the root.

## Patches

[`patches/`](patches/) holds `git format-patch` output from earlier work — four
files covering the LaTeX rendering change. Nothing reads them; the code they
describe is already merged and the reasoning is in the changelog. They are kept
as a record of how those changes were assembled, and moved here from the repo
root because they are history rather than something you run.

## Changelog

[`changelog/`](changelog/) holds one file per change, each covering the symptom,
the cause, what was actually done, and what was deliberately left alone.

They are notes on individual fixes rather than a release history, so the useful
way in is to search for a symptom — `grep -ril "drive specified" docs/changelog/`
— rather than to read them in order.
