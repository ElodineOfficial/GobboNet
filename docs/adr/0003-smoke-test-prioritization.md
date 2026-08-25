# 3. Operational Smoke Test Prioritization

## Context
A full function-by-function code audit of the ~12.7k-line Go codebase is a multi-session commitment. Immediate validation requires confirming that the GobboNet Go Server actually builds, launches, and operates smoothly on the local Linux development environment.

## Decision
Prioritize the Smoke Test Track: stage web assets, compile the binary, generate configuration, set the access password, and launch the server for live browser testing before continuing deep-dive code reviews.

## Consequences
Establishes an immediate working baseline ("works on my machine") and empirical familiarity with runtime UX, proxying, and process supervision, informing subsequent code refinements with real operational context.
