# 4. Lead Architect Diad and Tactical Agent Dispatch Model

## Context
Unsupervised agent swarms and "vibe coding" produce sprawling, multi-file code diffs that are difficult to audit, regression-prone, and fragile. Running local inference on an RTX 3090 Ti provides fast, cost-free compute that enables a structured, hands-on engineering workflow.

## Decision
Establish a **Lead Architect Diad** between the human engineer and the resident Driver model. The Diad holds high-altitude multi-file context, models system architecture, and performs code review on every change. All implementation work is decomposed into strictly bounded, single-file tasks dispatched to tactical worker agents with predefined output schemas.

## Consequences
Multi-file code modifications are eliminated in favor of surgical single-file commits. System-wide coherence is maintained by the Diad, while low-level execution remains fast, auditable, and verifiable by automated tests.
