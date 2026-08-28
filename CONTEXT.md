# Domain Glossary (CONTEXT.md)

## GobboNet Go Server
The standalone, compiled Go backend binary (`gobbonet`) that serves the chat UI, proxies requests to llama.cpp, manages in-memory generation jobs, and supervises local llama-server processes across Linux, macOS, and Windows.
_Avoid_: `Go Backend Runtime`, `gobbonet-server`, `Next-Gen Engine`

## Parallel Runtime Model
The operational architecture where the GobboNet Go Server and the PowerShell server (`fileserver.ps1`) coexist with strict API wire compatibility, allowing users to run either backend without mutual interference or configuration conflicts.
_Avoid_: `Replacement Backend`, `Unified Rewrite`, `Legacy Fallback`

## Two-Stage Health Probe
The probing seam that tests llama.cpp `/health` first, falling back to `/v1/models` to support alternative backends (Ollama, LM Studio, vLLM) without false "OFFLINE" UI banners.
_Avoid_: `Single-Endpoint Probe`, `Hardcoded Health Check`

## Multi-Context Sanitization
The defensive rendering contract in `js/` ensuring all dynamic values pass through context-appropriate escaping (`safeCssColor`, `safeDataUrl`, `escapeJsString`, `CSS.escape`) before DOM insertion.
_Avoid_: `Unescaped InnerHTML`, `Partial String Sanitization`

## OpenAPI Contract
The single canonical source of truth specification (`gobbonet_openapi.yaml`) defining all REST endpoints, authentication flows, error payloads, and SSE streaming schemas for GobboNet across both Go and PowerShell implementations.
_Avoid_: `Ad-hoc API Spec`, `Informal Endpoint Map`

## Conformance Test Suite
The automated Go test suite (`internal/server/conformance_test.go`) executed in multi-OS CI to assert route behavior, HTTP status codes, and header contracts against the OpenAPI specification with zero GUI dependencies.
_Avoid_: `Manual Smoke Testing`, `Speculative Verification`
