# Documentation

Reference material and the per-change record. None of this is needed to *run*
GobboNet — see the [README](../README.md) at the repo root for that.

## Reference

| File | What it covers |
|---|---|
| [INDEX.md](INDEX.md) | Frontend module map. Translates a pre-v1.5 `chat.html` line number into the `js/` module that now holds it. |
| [GO_SERVER.md](GO_SERVER.md) | The Go server: what it does, how it supervises llama.cpp, what replaced the PowerShell file server (removed in 1.8.0). Also shipped as the README inside release bundles. |
| [archive/GO_CONFIG_SPLIT.md](archive/GO_CONFIG_SPLIT.md) | How configuration is divided between `config.toml`, `perf.toml` and runtime state. |
| [archive/GO_MIGRATION_INVENTORY.md](archive/GO_MIGRATION_INVENTORY.md) | What moved from PowerShell to Go, and what deliberately did not. |
| [RAG_INFO.md](RAG_INFO.md) | The retrieval pipeline — embedding server, chunking, how lore is selected. |
| [PURGE.md](PURGE.md) | What deleting data actually deletes, and where copies can survive. |
| [UPDATES.md](UPDATES.md) | The update button in ABOUT (1.8.0): what it checks and trusts, and how the maintainer signs a release so it can be installed from there. |

Kept at the repo root instead, because something points at them by name:

- **[README.md](../README.md)** — installed into the `.deb` as package documentation.
- **[TROUBLESHOOTING.md](../TROUBLESHOOTING.md)** and **[SECURITY.md](../SECURITY.md)** — `launch.bat` tells users to read these, so they need to be where a user looking for them will be.
- **[AGENTS.md](../AGENTS.md)** — conventionally found at the root.

## Archive

[`archive/`](archive/) holds the investigations, roadmaps and design notes of
past releases: `INVESTIGATION-*.md`, `ROADMAP-*.md`, and the two Go migration
notes above. They describe the tree as it was when they were written, and the
code wins where they disagree. Moved out of `docs/` in 1.7.9.

The `git format-patch` files that used to sit in `patches/` were removed in
1.7.9. The changes they describe are merged, and the reasoning is in the
changelog.

## Changelog

[`changelog/`](changelog/) holds one file per change, each covering the symptom,
the cause, what was actually done, and what was deliberately left alone.

They are notes on individual fixes rather than a release history, so the useful
way in is to search for a symptom — `grep -ril "drive specified" docs/changelog/`
— rather than to read them in order.
