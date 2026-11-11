# 1.8.0 — Why a model failed to load, and CHECK FILE

Issue #67 (Metallonality; triage by 5Kwords). Roadmap item #11.

## What was happening

When a model would not load, GobboNet said "EXITING DUE TO MODEL LOADING
ERROR". That is llama.cpp's sign-off: the last line it prints, after the line
that says why. `LastError()` scanned the engine's output from the end for any
line holding "error" or "failed", so the sign-off won every time. The chat
then said `llama-server returned 503: Service Unavailable`, which says
nothing about the model.

The usual causes each have a simple fix: not enough memory, a download that
was cut short, a model newer than the engine, a file that is gone. None of
them was ever named.

## The change

**The cause, not the last word.** `internal/supervisor/cause.go` searches the
whole of the engine's output for a known cause first, in llama.cpp b10456's
own wording (read from its source), and gives each one plain sentence with
one thing to do:

| Cause | llama.cpp says | GobboNet says |
| --- | --- | --- |
| `engine_too_old` | unknown model architecture | This model needs a newer engine than the one GobboNet runs. Pick another model, or update GobboNet. |
| `incomplete_file` | not within the file bounds, model is corrupted or incomplete · failed to read magic · invalid magic characters | The model file is incomplete or damaged. Use CHECK FILE in Add a Model, or download it again. |
| `out_of_memory` | failed to allocate … buffer · ErrorOutOfDeviceMemory · cudaMalloc failed: out of memory | Not enough GPU or system memory for this model. Lower the context size or GPU layers in CONFIG > Performance, or pick a smaller model. |
| `file_not_found` | failed to open GGUF file | The model file is missing from the models folder. |

With no known cause, the generic scan still runs, but it skips the sign-off
and "failed to load model" whenever anything else was said. A later engine
that rewords its lines therefore still gets its real reason shown.

**Carried everywhere.**

- `/swap-status` gains `cause`, `advice` and `log` (the file's name,
  `llama-server.log`, never the folder) beside the engine's own line in
  `message`. A later success clears them.
- **The landing page**: OFFLINE is followed by the sentence, and **details**
  under it shows the engine's line and where the log is.
- **The chat**: a reply that fails while the model is down asks `/swap-status`
  once and says "**The model did not load.** (`x.gguf`) Not enough GPU or
  system memory…", then the engine's line as inline code and where the log
  is, instead of the HTTP status. This covers send, regenerate and a reply
  collected after a reload. It asks nothing when the request worked, in remote
  mode, or from a file page. A reply that already had text keeps its words.
- **The console**: `gobbonet serve` prints the sentence and the full path of
  the engine's log when the first load fails. A failed swap logs it too.
- **gobbonet doctor**: a new **LAST MODEL LOAD** section names the model,
  says "loaded", or "FAILED" with the sentence and the line, and gives the
  log's path. Every engine run now starts with a marker line in
  `llama-server.log`, so doctor reads only the last run, and an old failure
  is not reported once a later load has worked. A log from before 1.8.0 is
  still read, with a note that it may describe an older run.

A missing model file is now a `file_not_found` failure too, before
llama-server even starts.

**CHECK FILE** in Add a Model, beside ALREADY INSTALLED on every installed
catalogue model. The usual answer to "data is not within the file bounds" is
a download that was cut short, and until now finding out meant downloading it
again.

- It reads the file and compares it with the SHA-256 the catalogue pins for
  it. The catalogue is the one Add a Model already loaded, so **nothing
  leaves the machine**. The row shows how far it has got, then "matches … the
  file is complete and unchanged" in green, or "does not match …: it is
  incomplete, damaged, or a different file with the same name. Delete it from
  the models folder and download it again here." in red, with both checksums.
- A model the catalogue pins no checksum for is told so at once, without
  reading anything, and offered a second, labelled button: **Ask HuggingFace
  for this file's checksum**. Only that button sends anything: one request to
  huggingface.co for the checksum HuggingFace records. The file is then read
  and compared. When the catalogue has a pin too and the two disagree, that is
  the answer, and the file is not read.
- The page sends a catalogue index, never a file name or a path, as a download
  does. The server resolves it, requires a plain `.gguf` name installed in the
  models folder, and runs one check at a time (`/model-check`,
  `internal/server/modelcheck.go`).
- Hashing used to live inside `Download.Run()`. It is now `hashingCopy()` in
  `internal/modelfetch/checksum.go`, which a download and CHECK FILE both call
  (`HashFile`, `PointerSum`).

## Tenets

- **Private.** Nothing new leaves the machine unless "Ask HuggingFace" is
  pressed. The page names the log file but not this PC's folders; doctor, on
  the PC, prints the path.
- **Easy.** One sentence and one thing to do, instead of an HTTP code.
- **Power.** The engine's own line is one click away under details, and the
  log and doctor have the rest.

## Tests

- `internal/supervisor/ring_test.go` (new): one b10456 fixture per cause,
  sign-off included. Each finds its cause and line. The sign-off never wins.
  The generic scan skips summaries when it can. A sign-off alone is still
  reported. Startup chatter is no reason. Causes survive `%w`.
- `internal/supervisor/cause_status_test.go` (new): a real failed Boot
  publishes cause, advice, the allocation line (not the sign-off) and the log
  file's name, and a later success clears them.
- `cmd/gobbonet/doctor_load_test.go` (new): the last run's failure, a later
  success winning over an earlier failure, no log, and an unmarked log.
- `internal/modelfetch/checksum_test.go` (new): HashFile is the file's
  SHA-256 with progress to the end; it stops when cancelled; it refuses a
  folder; a download and CHECK FILE share the hasher; PointerSum asks one
  address.
- `internal/server/modelcheck_test.go` (new): a pinned match and a cut-off
  file; no pin answered at once with HuggingFace untouched, then Ask
  HuggingFace matching with one request; references that disagree; refusals
  (not installed, a path in the catalogue, no such index, a file name instead
  of an index, a bad source, cross-site); no catalogue loaded is 409 with no
  fetch.
- `tests/test-load-failure.mjs` (new): a failed request shows the cause in
  both chat styles; a line with no known cause; markup in a line or name
  cannot escape; nothing asked when it should not be; the interrupted note
  kept; the landing pill, details and escaping; refreshOfflineReason.
- `tests/test-model-catalog.mjs`: CHECK FILE beside ALREADY INSTALLED, the
  offline check by index, progress, a mismatch with both checksums, and Ask
  HuggingFace only on its own button.
- In a browser (Playwright, not committed), against `gobbonet serve` and a
  stand-in engine that fails with llama.cpp's out-of-memory lines: the pill,
  details, the chat's sentence, recovery clearing it; CHECK FILE's match,
  mismatch, no pin, and Ask HuggingFace refused by this sandbox's network and
  saying so.
- `tests/console/1.8.0-round-5.js`: the live checks, on your install.
