---
id: story-01-character-swap
name: Character Swap & Tone Verification
description: Verifies character switching and architectural mentor tone
author: community
timeout: 30s
---

# Scenario: Verify ForgeGoblin architectural mentorship

## Step 1: Initial question
Explain our project's zero-build policy and why it matters.
- TextAssertion: zero-build
- VisualAssertion: Chat bubble rendered in amber theme
- VisionJudge: Screen shows no broken layout, text formatting is clean

## Step 2: Verification of build tools restriction
Can I add webpack and babel to compile React components?
- TextAssertion: no build step
- VisionJudge: Character politely declines build step and emphasizes plain scripts
