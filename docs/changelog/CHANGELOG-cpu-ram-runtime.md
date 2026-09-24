# CPU/RAM runtime round — evaluate before GPU work

Build: 1.7.5-go-b2d5ab4-cpu-ram-runtime.
Includes the previous memory-QOL and state-handshake fixes.

## Changes

- IndexedDB streaming checkpoints select and clean only the generating thread,
  before any full-library snapshot is built. This also saves the correct thread
  if the user switches to another conversation during generation. The
  localStorage fallback still saves the complete document.
- Unchanged streamed reasoning/answer markup is not repeatedly parsed or replaced.
  Hidden tabs continue receiving and checkpointing replies without live painting.
- Repeated markdown rendering uses a bounded LRU cache: at most 128 entries and
  approximately 1 MiB of string payload, plus bounded bookkeeping. Oversized text
  renders uncached. File blocks with generated DOM IDs are not shared. Colours
  and exact text are part of the key, so edits and colour changes invalidate it.
- Large sync scans yield between conversations after an 8 ms work budget. They
  retain full content checks so direct extension edits are still detected. After
  yielding they check for changed targets/restores and newly started generation.
  This improves responsiveness; it does not eliminate the total fingerprint work.
- Server serialization writes canonical JSON one value at a time. Chat-index
  version hashing uses the same writer directly, without constructing another
  complete encoded history. Existing bytes, version tokens, unknown fields,
  conditional writes, encryption and the on-disk format are preserved.
- A once-per-minute cleanup loop releases expired completed job records even
  without a subsequent request. It stops on shutdown. Running jobs and completed
  jobs within the configured recovery window are retained as before.

No new dependencies. No GPU/engine settings, context/precision, model, lore,
visual theme, or generation limits changed.

## Validation

24 frontend suites pass, including new active/background checkpoint, fallback,
cache bounds/invalidation, unique file IDs, hidden-tab reception, sync-yield
safety and DOM replacement tests. Go state/jobs/server race checks pass. The
full Go suite passes except the existing release-tag test: VERSION 1.7.5 versus
nearest upstream tag v1.7.3. Release metadata is unchanged.

The server regression compares output byte-for-byte and ETags against the former
encoder, including unknown fields, large integers, Unicode, escaping, empty and
legacy states. Existing conditional-write/concurrency/encryption tests also run.

Reproduce the synthetic allocation comparison:

    go test ./internal/state -run '^$' -bench BenchmarkRuntimeIndex -benchtime=1x -benchmem

One Linux run, same inputs/old and new algorithms in the same process:

| Synthetic state | Former allocated bytes/op | New allocated bytes/op | Reduction |
| --- | ---: | ---: | ---: |
| 10 MiB | 85,393,800 | 32,697,368 | 61.7% |
| 100 MiB | 795,506,448 | 317,353,800 | 60.1% |

These are cumulative allocations during parse/index/hash work, not peak RSS,
steady-state RAM, GPU memory, or an end-to-end application benchmark. Disk and
encryption are excluded. One timing sample is insufficient for a speed claim.

## Evaluation before round two

Compare with the state-handshake build using the same model/settings/history:

1. Generate a long answer in a large library; watch browser and GobboNet CPU/RAM
   separately, responsiveness, and growth across repeated replies.
2. Open a long chat with reasoning/code/file blocks; edit, reroll, switch variants,
   change characters, copy/download blocks and check scroll position.
3. Switch chats and hide/return to the tab while generating. Confirm the correct
   reply survives reload/reconnect and remains intact on a second device.
4. Sync edits/appends from two devices and recheck the zero-chat character restore.

Native Windows/WebView behavior and application-level RAM improvements still need
that evaluation. The synthetic tests do not substitute for it.

Full-history DOM reconstruction, full sync fingerprint scans and whole-document
atomic writes still exist. This round reduces their avoidable costs without a
storage redesign or unreliable dirty-only tracking. Unexpired unacknowledged
job buffers still consume memory; this patch does not shorten recovery retention.
