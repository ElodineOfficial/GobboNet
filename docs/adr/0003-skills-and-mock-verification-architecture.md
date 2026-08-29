# 3. Substrate-Agnostic Filesystem Skills System and Automated Story Verification Engine

## Context
GobboNet's extensibility was previously confined to inline card codes (`js/23-card-code.js`) and global JS/CSS mods (`js/19-extensions.js`). Developers and operators needed a composable, substrate-agnostic, filesystem-based skill format that synthesizes standard YAML frontmatter, structured markdown prompt engineering, and native GobboNet template expansion (`{{char}}`, `{{user}}`, `{{current_DAT}}`) without introducing external build dependencies or vendor lock-in. Furthermore, automated regression testing required a reproducible user-story replay mechanism (`.story.md`) to verify prompt behavior and deterministic inference offline across any model family without manual UI clicking.

## Decision
1. Implement a **Substrate-Agnostic Filesystem Skills Engine** (`internal/skills/` and `js/25-skills.js`) that discovers markdown-formatted skills (`skills/<name>/SKILL.md`) across local and user-config directories via `GET/PUT /skills/*` API endpoints with an in-browser markdown editor.
2. Unify the skill schema around universal conventions: standard YAML frontmatter for metadata, structured markdown sections for layered system prompts, RAG storybook integration, and GobboNet macro expansion.
3. Implement an **Automated Story Verification and Replay Engine** (`internal/mock/` and `gobbonet mock [list|run]`) supporting `.story.md` execution, assertion testing, dataset logging, and reproducible markdown reports.
4. Enforce a **Strict Zero-Telemetry Invariant**: All experimental operator profiling and heuristic mirroring remain strictly isolated within local development environments and private forks, never exported to public upstream code.

## Consequences
Skills are fully portable, model-agnostic, and editable as plain text files with zero build steps. Any developer can author or inspect skills without requiring proprietary tooling or specific agent frameworks. Offline sovereignty and local execution invariants are preserved.
