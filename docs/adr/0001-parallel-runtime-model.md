# 1. Parallel Runtime Model for Go and PowerShell Backends

## Context
GobboNet was originally built with a Windows-focused PowerShell backend (`fileserver.ps1` and `launch.bat`). PR #2 introduces a compiled Go backend server (`cmd/gobbonet`) for cross-platform support and single-binary distribution.

## Decision
Retain `fileserver.ps1` and the existing PowerShell tooling intact while introducing the GobboNet Go Server as a strictly additive, parallel backend runtime sharing full HTTP wire compatibility.

## Consequences
Existing Windows users experience zero disruption and can continue using `launch.bat`. The Go server is independently tested against wire conformance to ensure drop-in substitutability across Linux, macOS, and Windows.
