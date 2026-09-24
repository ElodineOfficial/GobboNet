# Zero-chat restore and integration handshake

The client previously rejected every server snapshot with zero threads, including
valid character/persona/settings backups. A session restore guard could then
prevent another attempt. The server's GET endpoint itself was not rejecting them.

- Startup restores into memory before initial rendering, extensions and startup
  saves. Browser persistence is a best-effort cache, not a prerequisite.
- Zero-chat snapshots restore metadata without a page reload; any existing local
  chats are preserved. Startup restores with chats also work without storage.
- Removed the session reload guard from startup. Failed requests can be retried.
- Incoming custom code remains disabled until explicitly enabled locally.
- `window.GobboNet.ready` reports initial UI/state readiness and startup errors.
- `window.GobboNet.fetchServerState()` provides a GET-only snapshot handshake,
  independent of UI state, cache contents and previous restore attempts.
- No new dependencies, external services or server permissions. Existing manual
  full-history restores retain their storage/reload path. Previous memory and
  launcher changes are retained.

Regression coverage uses real restore/migration/boot functions with denied,
silently discarded and working storage; zero-chat metadata; existing history;
custom-code quarantine; stale session markers; failures/retries; malformed
responses; profile routing; GET-only behavior; and delayed startup readiness.

Native follow-up: use the community WebView with storage disabled; confirm two
characters and personas on a zero-chat server, then create/append a thread and
reopen it. Compare GPU memory at setup, first reply, repeated replies, idle unload
and model switching against the accepted memory-QOL build. This patch changes no
engine settings or memory-management code.
