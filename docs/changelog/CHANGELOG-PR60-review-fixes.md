# PR #60 integration and review fixes

John McCardle's **Session storage upgrades** contribution is retained as the
base of this update:

- PR: https://github.com/ElodineOfficial/GobboNet/pull/60
- Author: John McCardle (`jmccardle`)
- PR commit: `b2d5ab43e18acc0664b2dd113e6767be4322a303`
- Original main: `28fe0b249a65f391fc16beef5249fd6d9b46fd35`

The PR was fast-forwarded locally, with its author metadata unchanged. No
GitHub branches, PRs, reviews, issues or tags were changed. The corrections are
an additional, uncommitted patch on top of that commit.

## Corrections

### Sync initialization and lost histories

A failed startup/index request no longer authorizes a whole-document upload.
An existing backup with no local ledger is reconciled using individual thread
contents; message counts alone are not treated as evidence of equality.
Creating a backup uses `If-None-Match: *`. Explicitly replacing an existing
backup uses its document ETag. The server checks those conditions under the
same file mutex as per-thread updates; whole-document deletion uses that mutex
too. A 412 replacement conflict clears the overwrite request so a retry cannot
silently overwrite the intervening change.

Only explicit overwrite choices authorize full replacement. An older server
without the conditional-sync protocol is reported rather than trusted with a
blind write. An imported thread ID that cannot be addressed individually is
reported as a sync error, retaining local content instead of falling back to
unconditional replacement. Normal generated IDs are unaffected.

### Encryption maintenance

The server holds an OS file lock on the data directory's `.state.lock` for its
lifetime. Encryption/decryption, recovery, recovery-phrase replacement and
password changes acquire the same exclusive lock before reading credentials or
changing files. While the server is running those commands explain that it
must be stopped first. The OS releases the lock on exit or crash; the lock file
is intentionally retained to avoid locking different inodes under one name.
Linux/macOS use flock and Windows uses LockFileEx, through the existing
`golang.org/x/sys` dependency. No new dependencies or outbound services.

Stop older GobboNet versions before installing this update: they do not
participate in this new process lock. As with other advisory locks, this
coordinates GobboNet processes, not arbitrary programs editing its files.

`keyring init` now unlocks and resumes an existing keyring instead of refusing
its own recovery instruction. It validates already-sealed files and preserves
the same data key and recovery phrase. A fresh initialization displays and
confirms the recovery phrase before encrypting history. If interrupted before
saving that phrase, resume with the password and use `keyring set-recovery` to
obtain a new one.

Malformed keyring KDF parameters and nonce lengths are rejected before crypto
calls, avoiding panic/unbounded allocation from malformed files.

### Credential artifacts and test fixtures

Removed the two committed curl cookie jars, `j3.txt` and `jar2.txt`. Added
ignore entries for these and local keyring/profile/lock artifacts. Cookie
values are not included in the delivery patch (forward-only binary deletion
records remove the files without redistributing their contents).

Updated the existing export test to load the real schema version and the sync
target fixture to implement the new index response and await asynchronous
writes. Assertions remain in place.

## Validation

- All 22 Node frontend suites pass, including seven new initialization
  regression scenarios.
- Targeted Go tests pass for keyring, state, process locking and CLI commands.
- Race-detector tests pass for state, keyring and process locking.
- `go vet` passes for the changed backend packages and CLI.
- Full `go test ./...`: all packages pass except the pre-existing
  `TestVersionFileMatchesUpstreamRelease` check. The same failure was reproduced
  on untouched main: VERSION is 1.7.5, while the nearest release tag is v1.7.3.
  Neither VERSION nor release tags were changed to hide the failure.
- Live Linux process/HTTP smoke checks passed: interactive encryption and
  recovery confirmation; repeat/resume preserving the key; refusal of all
  encryption/password maintenance commands while serving; login, encrypted
  reads/writes and stale snapshot rejection; decryption after shutdown with
  both conversations preserved.
- Windows amd64 and Linux amd64 binaries rebuilt with the patched UI embedded.
  Windows is cross-compiled, not runtime-tested on Windows in this environment.

Build toolchain: official Go 1.26.1 Linux amd64 download, verified against the
SHA-256 in Go's official release metadata. Module verification remains enabled.
Binary stamp: `1.7.5-go-b2d5ab4-pr60-fixes` (the PR commit plus this patch).
