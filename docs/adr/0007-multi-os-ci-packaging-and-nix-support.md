# 7. Multi-OS CI Packaging, Hermetic Builds, and Nix Ecosystem Support

## Context
GobboNet's release pipeline relied on manual zip archives, and test coverage was limited to local developer machines (PRs #21, #22, #28). With the introduction of the cross-platform Go server, reproducible packaging across Linux, macOS, Windows, and container environments became essential. Furthermore, declarative home-server deployments (e.g. NixOS, systemd) required deterministic service declarations and sandbox isolation.

## Decision
1. **Multi-OS GitHub Actions CI Matrix**: Implement automated CI validating syntax (`node --check`, JSON parsing), Go unit & conformance tests, static asset serving, and cross-platform compilation on Ubuntu, macOS, and Windows.
2. **Automated Tag-Driven Release Packaging**: Automate multi-platform zip creation, SHA-256 checksum generation, and GitHub Release drafting on git tag push.
3. **Nix Flake & NixOS Module**: Provide `flake.nix`, `default.nix`, and `nix/module.nix` for declarative deployment, automated systemd service management, and sandboxed state directories on Linux/NixOS environments.
4. **Browser Demo Publishing**: Support GitHub Pages automated deployment for zero-install WebGPU/WASM in-browser demo without modifying core desktop distribution artifacts.

## Review & Reversal Points
- *Engine Bundling vs External Engine*: The Go installer and Nix packages deliberately do not bundle heavy engine binaries (llama.cpp) directly into source repositories, preferring dynamic downloading or system packages. Maintainers can review whether pre-packaged engine bundles are desired for specific release channels.
