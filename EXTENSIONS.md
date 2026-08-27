# Extensions

GobboNet lets you inject custom CSS and JavaScript into the chat page. Extensions
are **entirely local** — they are stored in your browser's localStorage and
re-applied on every boot; nothing is uploaded anywhere.

> ⚠️ Extensions run with full access to the GobboNet interface — the same access
> the page itself has. Only install extensions you trust, the same way you would
> only install an app you trust.

## Adding an extension

1. Open the chat page → **Settings → Extensions** (the "MODS" button).
2. Add a **stylesheet** (URL or raw CSS) and/or a **script** (URL or raw JS).
3. **SAVE & APPLY** — the extension is injected immediately and again on every boot.
4. The **Extension Status** toggle switches all extensions off/on without clearing them;
   **CLEAR ALL** removes every extension.

Injected elements carry the class `gobbonet-ext` so they can be cleanly removed and
re-applied without leaving residue.

## Reference extension: encrypted model backup

[`extensions/gobbonet-backup.js`](extensions/gobbonet-backup.js) is a self-contained
extension that backs up your models (or any files) to a GitHub repository,
**encrypted in your browser before anything leaves your machine**:

- **The passphrase is the key.** Files are encrypted with AES-GCM, key derived from
  your passphrase (PBKDF2-SHA256, 600,000 iterations). The repo can be public or
  private — the bytes are ciphertext either way.
- **No server, no CLI, no GitHub Actions.** It uses the GitHub API directly from the
  browser. Your token is stored in localStorage; the passphrase is never stored.
- **Resumable by design.** Files are split into `.partN` chunks under GitHub's 2 GiB
  asset cap, each chunk and the whole file verified by sha256 on restore.
- **Shares with a link + passphrase.** A backup in a public repo can be shared via
  [`backup-gate.html`](extensions/backup-gate.html) — paste
  `backup-gate.html?repo=owner/name&tag=backup-…`, anyone with the passphrase can
  download and decrypt; anyone without it sees only ciphertext.

### Install

Host `gobbonet-backup.js` anywhere static (your own fork's GitHub Pages, any file
host) and paste the URL as a **script** extension. Or paste the raw file contents as
inline JS.

### What it does NOT do

Nothing phones home except the GitHub API endpoints the token authorizes (the
`api.github.com` / `uploads.github.com` calls it needs to list, upload and download
release assets). There is no telemetry, no analytics, no external fonts or scripts.

### Proven

[`gobbonet-backup.roundtrip.mjs`](extensions/gobbonet-backup.roundtrip.mjs) is a
dependency-free Node harness that loads the shipped file and drives its real
`backupFiles` / `restoreBackup` code through a full encrypt → chunk → upload →
download → verify → decrypt → stitch round-trip. Run it with
`node gobbonet-backup.roundtrip.mjs` (stubbed GitHub API, works offline), or
`REAL_API=1 REAL_TOKEN=<token> REAL_REPO=<owner/name> node gobbonet-backup.roundtrip.mjs`
against the real GitHub API — it creates a release, uploads, restores, and verifies
byte-exactness. A test that reimplements the thing it tests proves nothing; this one
loads the shipped file and drives its own code.
