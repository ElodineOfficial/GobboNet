# 4. Defense-in-Depth Security Architecture

## Context
Multiple independent security reviews and bug reports (PRs #4, #5, #6, #7, #24, #30) identified critical trust boundary issues across the web interface, state synchronization pipeline, authentication system, and Windows process lifecycle:
1. **XSS & Injection**: Rendering sinks in `chat.html` / `js/` lacked multi-context escaping (`escapeJsString`, `escapeJsAttr`, `safeCssColor`, `safeDataUrl`), allowing untrusted character card names or synced state to execute script.
2. **Untrusted Code Execution via State Sync**: `/state` sync and full-data backups imported `customCode` with `customCodeEnabled = true` or injected extensions, executing script on peer devices without user confirmation.
3. **Authentication & KDF**: Single-round SHA-256 password hashing was vulnerable to offline cracking, while `/login` lacked rate-limiting, allowing rapid brute-force attacks.
4. **URLACL & Firewall Over-Reach**: `setup-lan.bat` reserved URL ACLs for `Everyone` and opened firewall rules for loopback-only services.
5. **Orphaned Process & Stale Salt**: Launchers could adopt orphaned server processes holding obsolete password salts.

## Decision
Synthesize a unified, defense-in-depth security model across both Go and PowerShell runtimes:
1. **Multi-Context Sanitization**: Implement strict multi-context escaping (`escapeJsString`, `escapeJsAttr`, `safeCssColor`, `safeDataUrl`, `CSS.escape`) across all rendering paths.
2. **Untrusted Code Neutralization**: Enforce `neutralizeUntrustedCode()` on all state restore and data import paths, preserving script text for review while strictly defaulting execution flags to `false`.
3. **Hardened Password Authentication**: Upgrade password hashing to PBKDF2-SHA256 (210k iterations) / Argon2id with 10-character minimums, while maintaining transparent backward compatibility for legacy `<salt>:<hash>` secrets. Implement per-IP rate-limiting (5 failures / 15-minute lockout with `429 Retry-After`) checked before body reads.
4. **Least-Privilege Scoping**: Scope `urlacl` grants to the executing user account and restrict firewall rules strictly to the public web port (9066).
5. **Lifecycle & Salt Guards**: Add `SECRET_JUST_SET` launcher guards and process-tree supervision to prevent stale salt adoption.

## Review & Reversal Points
- *Password KDF Upgrade*: If 210k iterations cause noticeable delay on lower-power single-board computers (e.g. Raspberry Pi), iteration counts can be tuned via configuration.
- *Strict Code Neutralization*: If operators prefer an explicit prompt to auto-enable known identical code on synced devices, an optional hash-matching whitelist can be introduced.
