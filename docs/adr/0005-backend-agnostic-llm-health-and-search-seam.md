# 5. Backend-Agnostic LLM Health Probing and Keyless Web Search Seam

## Context
GobboNet was originally coupled to `llama-server` on loopback and `ollama.com` for web search:
1. **LLM Health Probing (PR #18)**: When operators pointed GobboNet at alternative OpenAI-compatible inference servers (Ollama, vLLM, LM Studio, aphrodite, or gateway proxies), the UI displayed a false "OFFLINE" banner because these backends implement standard OpenAI `/v1/models` rather than llama.cpp's custom `/health` endpoint.
2. **Web Search Flexibility (PR #11)**: Web search was hardcoded to forward user requests directly to `ollama.com/api` with an Ollama API key. Users without an Ollama account or those running self-hosted search engines (e.g. SearxNG, local search microservices) experienced broken search.

## Decision
1. **Two-Stage Health Probe**: Probe `/health` first (for fast llama-server detection); if `/health` returns 404, immediately probe `/v1/models`. If either succeeds, report the backend as operational. If both fail or connection is refused, report offline.
2. **Configurable Search Provider Seam**: Introduce a provider abstraction supporting `auto`, `ollama`, and generic `http` backends via `SEARCH_PROVIDER` and `SEARCH_URL`. When configured, GobboNet forwards `{query, max_results}` to standard search endpoints (such as SearxNG) with no external account dependencies.
3. **Zero-Telemetry Invariant**: Maintain strict privacy by stripping client identifying headers and cookies before proxying, while leaving default behavior untouched when custom search is unconfigured.

## Review & Reversal Points
- *Ollama Default*: The default search provider remains `ollama` when unconfigured. Maintainers may evaluate whether `auto` detection or an out-of-the-box local dummy provider is preferable.
- *Search Normalization*: Standard JSON results normalizer accepts both `snippet`, `content`, and `description` keys across search engine engines.
