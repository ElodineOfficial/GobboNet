## 🥞 Layer in Stack
> Part of a linear stack. Please review bottom-up:
- [ ] Layer 1: `#XX` Contract & OpenAPI 3.1 Spec
- [ ] Layer 2: `#YY` Core Engine / Backend Logic
- [ ] Layer 3: `#ZZ` Multi-OS Conformance Tests & CI
- [ ] Layer 4: `#WW` UI / Consumer Surface

---

## 🎯 Summary & Context
<!-- 1-2 sentences: What problem does this specific layer solve, and why now? -->


---

## 🛠️ What Changed in this Layer
<!-- Terse, exact bullet points of surgical changes -->
- 

---

## 🛡️ Invariants Verified
- [ ] **Zero-Build Plain Assets**: Ran `./stage-web.sh` without errors (no bundler/transpiler introduced).
- [ ] **Parallel Runtime Parity**: Verified wire compatibility across Go and PowerShell backends.
- [ ] **Single-Concern Focus**: Diff is strictly bounded to this logical layer.
- [ ] **Privacy & Zero-PII**: No cloud egress, no tokens, and anonymous git author attribution.

---

## 🧪 Verification & Pulse-Check
<!-- Exact commands for the maintainer to verify in 30 seconds -->
```bash
# 1. Stage assets & run Go tests with race detection
./stage-web.sh && go test -v -race ./...
```
