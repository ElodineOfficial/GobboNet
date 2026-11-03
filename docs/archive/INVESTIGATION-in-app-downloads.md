# Investigation — why in-app model downloads failed

Roadmap 1.7.7 item #8b. **Status: live for testing, not confirmed working.**
This batch makes the path testable and its failures explain themselves. Whether
it works on real installs is for the maintainer's testing to settle. The
maintainer asked for exactly that split: "work on this but don't list it as
working yet. I'll test what you can't and we can work on errors from there."

## Background

The maintainer's account:

- **The failures were "mostly a permissions issue."**
- **After a lot of attempts**, the "download more models here" approach wasn't
  viable.
- **No error text or logs** from those attempts survive.

**The button was held off from 1.7 until 1.7.7.** `MODEL_CATALOG_ENABLED = false` in
`js/02-model.js`:

- The button read NOT WORKING YET, disabled.
- A note explains the manual route instead (put the `.gguf` in the models
  folder).

**Everything behind the hold was left intact**, so lifting it restores the
whole path. `tests/test-model-catalog.mjs` proves that.

## The path, step by step

| # | Step | Where | Can fail on permissions? |
|---|---|---|---|
| 1 | The page asks for the list | `GET /catalog.json` → `internal/server/models.go` `handleCatalog` | No. It reads the bundled `models.ini` or the cached remote list. |
| 2 | The page asks for one model **by index** | `POST /model-download` → `modelDownloadPost` | Only the app's own auth. It sits behind the password like every route, so a phone needs to be logged in. |
| 3 | Free-space check | `modelfetch.FreeBytes` | No. A failed check never blocks. |
| 4 | **New:** the models folder is tried | `modelfetch.checkFolder` | **Yes.** Creating the folder, a file, a write, a rename, a delete. |
| 5 | The published checksum is read | `pointerSum`, `/raw/` on Hugging Face | No. Unreachable means the size check is used instead. |
| 6 | Hugging Face is asked for the file | `client.Do`, `/resolve/` (redirects to its CDN) | Network rather than disk: a firewall, proxy, antivirus HTTPS scanning, or a gated model (401/403). |
| 7 | Bytes are written to `<model>.part` | `io.Copy` into the models folder | **Yes.** A blocked folder, antivirus quarantining the growing file, a full disk. |
| 8 | Checksum and size are checked | `Run` | No. |
| 9 | `.part` is renamed to `.gguf` | `moveIntoPlace` | **Yes, on Windows especially.** Antivirus opens a file to scan it the moment it is closed, and a rename during that scan fails. |
| 10 | The list refreshes | the server's directory scan | No. |
| 11 | *Switch to it now* | `POST /swap-model` → the supervisor restarts llama-server on the new file | A process launch. Same binary, same folder as at startup. |

**Steps 4, 7 and 9 are where a permissions problem can live.** Before this
batch, a folder that refused step 9 was found out only after the whole
multi-gigabyte download — steps 6 to 8 — had finished.

## What the code rules out

**The standard Windows install is per-user.** It goes into
`%LOCALAPPDATA%\GobboNet` with `RequestExecutionLevel user`, and creates the
models folder itself. `launch.bat` points `model_dir` there. That folder is
writable by the user GobboNet runs as.

**On Linux the default is `~/.local/share/gobbonet/models`**, or the folder
chosen in the setup wizard. The wizard tests it with a write before accepting
it.

So on a standard install the models folder *should* be writable. The failure
needs something narrower than "permissions" in general.

## Hypotheses, most likely first — and how each will now show itself

| # | Hypothesis | What a test will now show |
|---|---|---|
| 1 | **A protected or redirected folder.** A portable copy unpacked into Documents, Desktop or a OneDrive folder, where Windows *Controlled Folder Access* blocks unrecognised programs from writing. Or Program Files, or a drive the account can't write. | Fails at once, *while checking the models folder*, with "Windows would not let GobboNet …" and the Controlled Folder Access steps. Windows Security also shows "Unauthorized changes blocked". |
| 2 | **Antivirus.** A new executable writing a multi-GB file from an outbound download gets blocked, quarantined, or held at the rename. | A hold at the rename is now waited out: `[download] … is held by another program; retrying`, then success. A block mid-write fails *while downloading* with a write error. A quarantine fails at *moving it into place*, or leaves the file missing afterwards. |
| 3 | **Hugging Face refusing.** A gated repo answers 401/403 without a login. | Fails *while contacting Hugging Face*, naming the refusal and the licence. |
| 4 | **Network interference.** A firewall that blocks unknown programs, a proxy, or antivirus HTTPS scanning. | Fails *while contacting Hugging Face* — "refused or cut off", "failed its security check", or "did not answer in time". A connection that goes quiet mid-download now fails after 2 minutes instead of sitting at the same percentage forever. |
| 5 | **The app's own access checks.** From a phone, the session or the Host check. | A 401 or 421 on `POST /model-download`, before any `[download]` line. |
| 6 | **The swap after the download.** Not the download itself. | The download says *Downloaded*, and *Switch to it now* fails with the supervisor's own message. |

## What changed for 1.7.7

**Nothing is listed as working.**

### The button is live, and says it is being tested

`MODEL_CATALOG_ENABLED` is `true` again, so *Add a Model → BROWSE CATALOGUE*
works from the PC and from a phone. A new `MODEL_CATALOG_CONFIRMED = false`
keeps a note under the button: *Being tested — not confirmed working yet*, and
where to look when a download fails. Setting it `true` once the matrix passes
removes the note. Setting `MODEL_CATALOG_ENABLED` back to `false` puts the hold
back.

**The first attempt hid it behind `?test-downloads`** in the page address. The
maintainer clicked the button, nothing happened, and there was nothing to test.
That switch also could not survive signing in, since the login page always
returns to the plain address. It is gone; the maintainer chose the live button
instead.

### Every failure says which step it stopped at

- **The download window's title** reads "Download failed while *checking the
  models folder* / *contacting Hugging Face* / *downloading* / *moving it into
  place*".
- **The message underneath says what usually causes that error on that
  platform.** See `internal/modelfetch/diagnose.go`. The error numbers are
  Windows' own; on Linux the same numbers mean other things, and are not
  misread.

### Every step is logged with a `[download]` prefix

- **Windows:** the lines appear in GobboNet's window (the one `launch.bat`
  opens).
- **Linux:** they go to `~/.local/share/gobbonet/launch.log`.
- **The Linux setup wizard** uses the same downloader, so its downloads log and
  explain themselves the same way.

### Three changes that head off failures

**1. The models folder is tried before downloading.** A few bytes go through
every file operation the download will need: create the folder, create, write,
close, rename, delete. A folder that refuses any of them fails in a second,
before any download.

**2. A file held by another program is waited for.** On Windows, a rename that
fails with a sharing violation, a lock violation or "access denied" — what
antivirus produces while scanning a just-closed file — is retried for up to 20
seconds before it counts as a failure. Elsewhere rename errors are not
transient and fail at once.

**3. Downloads can no longer hang forever.** The old code used Go's default HTTP
client, which has no timeouts. Now:

| What | Limit |
|---|---|
| Connecting | 30 s |
| The TLS handshake | 30 s |
| Waiting for Hugging Face to start answering | 60 s |
| The checksum pointer | 30 s |
| The download itself | No total limit, but no data for 2 minutes stops it |

None of the three changes the outcome of a download that already worked.

## The matrix, for the maintainer

Use a small model, *Llama 3.2 3B Instruct* (3.4 GB). For each row:

1. Open GobboNet.
2. Go to CONFIG → Add a Model → BROWSE CATALOGUE → DOWNLOAD.
3. When it finishes, press *Switch to it now*.

| # | Setup | Tests hypothesis | Report back |
|---|---|---|---|
| 1 | Windows installer, default folder, from the PC | baseline | Did it finish? Did the switch work? |
| 2 | Portable ZIP in **Documents**, Controlled Folder Access **on** | 1 | The failure title and message, and whether Windows Security showed a block |
| 3 | Portable ZIP on a **OneDrive** Desktop | 1 | as above |
| 4 | Portable ZIP in **Program Files** | 1 | as above |
| 5 | Row 1 again with a third-party antivirus active, if there is one to hand | 2 | Any "held by another program; retrying" line, and the result |
| 6 | Linux `.deb` and `.rpm` | baseline | as row 1 |
| 7 | Row 1 from a **phone**, logged in | 5 | whether the list loads and the download starts |
| 8 | Any row that downloaded: *Switch to it now* | 6 | the message if it fails |

**For any failure, send three things:**

- the download window's title;
- its message;
- every line starting `[download]` from GobboNet's window or `launch.log`.

Those name the step, the operating system's own error, and the folder.

## What was tested here

**On Linux, with a real server:**

- **The list:** the catalogue loaded (the bundled list; this machine is
  offline).
- **A models folder that could not be created:**
  - The download failed in under a second.
  - The title read "Download failed while checking the models folder", with
    the operating system's error.
  - No request was made to Hugging Face.
- **A writable folder with no internet:**
  - The folder check passed.
  - It failed "while contacting Hugging Face" with "Could not look up
    huggingface.co … Is this PC online?".
  - Nothing was left in the folder.
- **The button** read BROWSE CATALOGUE, enabled, with the *Being tested* note
  under it.
- **At 390 wide:** the same.

**`internal/modelfetch/diagnose_test.go`** (new):

- **Each explanation** for Windows and Linux, including a Windows number that
  must not be read as one on Linux.
- **The folder check:** it leaves nothing behind, and reports a refused rename.
- **Waiting out a held file on Windows:** it succeeds on the third try, doesn't
  retry a real failure, gives up in time, and doesn't retry at all on Linux.
- **A run:**
  - stops at the folder before any request;
  - explains a 403;
  - gives up on a stalled connection and removes the `.part`;
  - ends with only the model in the folder.

**`tests/test-download-testing.mjs`** (new, 27 assertions):

- **Without the switch:** the hold is unchanged.
- **With it:** the catalogue works, and the box still says "not working yet".
- **Only the exact switch counts**, and it can't conjure a server for a page
  opened from a file.
- **Each failed step is named in the title.** An older server that reports no
  step reads as before.

**Not testable here:**

- Windows of any kind;
- Controlled Folder Access, OneDrive and antivirus;
- a real download from Hugging Face (this machine can't reach it);
- the swap onto a real model.

That is the matrix above.

## Decision point, unchanged from the roadmap

After the matrix:

- **If it comes down to one cause:** fix it, and lift the hold.
- **Otherwise:** retire the in-app path deliberately. That removes a visible
  button, so it is asked about first.

Until then the installer, `launch.bat`, the Linux wizard and "put the `.gguf`
in the models folder" cover adding models.
