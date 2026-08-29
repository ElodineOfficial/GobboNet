# 6. Visual Ergonomics, Accessibility Palettes, and Visual Documentation

## Context
1. **Visual Fatigue & Contrast (PR #25)**: The default `GOBLIN_BIOS` palette operates at 18.8:1 chroma contrast on near-black backgrounds, causing blooming and eye strain during multi-hour sessions, while secondary cyan text was below WCAG AA thresholds (2.8:1). Users requested an opt-in subdued theme without losing the cyberpunk identity.
2. **Documentation Ergonomics (PRs #16, #26, #31, #32)**: User-facing documentation lacked architecture diagrams, error flowcharts, memory pipeline visuals, and community mod discovery. Furthermore, port numbers (8080 vs 9066) and privacy statements contained historical contradictions.

## Decision
1. **Opt-in Reduced Theme**: Introduce `[data-theme="reduced"]` in `css/01-tokens.css` with mathematically solved WCAG 2.1 AA compliant color tokens (7–10:1 body text, ≥4.5:1 secondary text), paired with `@media (prefers-reduced-motion)` and `@media (prefers-contrast: more)` support. The default `GOBLIN_BIOS` palette remains unchanged.
2. **Visual Documentation Suite**: Integrate Mermaid architecture graphs, network trust boundary flowcharts, memory budget matrices, and error triage trees into `README.md`, `SECURITY.md`, `TROUBLESHOOTING.md`, and `RAG_INFO.md`. Fix all historical port/privacy errata.
3. **Mod & Backup Ecosystem**: Document community extensions and provide client-side AES-GCM encrypted backup architecture in `EXTENSIONS.md`.

## Review & Reversal Points
- *Theme Token Hoisting*: Currently 253 hardcoded inline colors in specific subviews exist outside CSS tokens. Maintainers may decide whether to keep these or conduct a broader token hoist.
- *Default Palette*: `GOBLIN_BIOS` remains the default to preserve brand identity; operators can switch themes via Settings.
