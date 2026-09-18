# 1.7.4 — `[ui]`: the config file reaches the chat page

Roadmap item 10, *"Config toml file"* — with a correction up front, because it
changes what the item turned out to be.

## The config file already existed

`gobbonet.toml` has been there the whole time: 25 keys covering URLs, ports,
paths, GPU layers, context size, auth, the model catalog and job limits, plus
`config get` / `config set` / `config keys`, discovery, and a written template.
`github.com/BurntSushi/toml` was already a dependency and already used by
`internal/config`.

So the server half of this item was done. **No new dependency was added for
this work, and none was needed.**

What had no file representation at all was the *other* config — the ~20
settings in the CONFIG panel, which live in the browser and nowhere else.
Setting a machine up for someone meant walking them through that panel on every
device they own. That is the half this adds.

## `[ui]` — a seed, not a lock

This is the decision everything else follows from, so it is worth being
explicit about what was rejected.

**An override** would mean the file wins on every boot, so a setting changed in
CONFIG silently reverts on reload. A UI that argues with the user is worse than
no file.

**Write-back** — the panel saving changes into the file — has the mirror
problem: a phone would be rewriting a file on the server, and two devices with
different preferences would fight over it.

So the file answers a narrower question, and answers it honestly: *what does a
device start with before anyone has chosen.*

- A device with **no settings of its own** takes the presets on its first
  visit.
- A device that **already has settings** keeps them, and is offered the presets
  under **DATA → SERVER PRESETS**, which shows exactly which values differ and
  applies them in one click.

Nothing is overwritten without being asked, and the file never claims to
describe a state it isn't maintaining.

```toml
[ui]
stream_replies = false
auto_scroll = "off"       # "smart" | "always" | "off"
sticky_cards = false
token_limit = 8192
```

## Where validation lives, and why

Go carries the table without interpreting it. The browser validates it.

The keys are the frontend's own settings, defined in `DEFAULT_SETTINGS` in
`js/04-state.js`, and they grow every release. Mirroring them into a Go struct
would mean two lists that drift — and the drift would be **silent**: a setting
added to the UI would simply stop being presettable, with nothing to notice it.

Checking against `DEFAULT_SETTINGS` instead means a setting added next release
is presettable the day it lands, with nothing to update anywhere. There's a
test that adds a setting at runtime and asserts it's immediately presettable
and immediately listed.

Three consequences worth stating:

- **Both spellings work.** `stream_replies` and `streamReplies` both resolve.
  A config file written by hand will be snake_case and the JS names are
  camelCase; rejecting one would be technically correct and useless, since the
  user has no way to know which this one wanted.
- **Unknown keys and wrong types are reported, never merged.** Merging a typo
  would put it into `state.settings`, which then syncs to every other device
  via item 4. The DATA panel names what was ignored and why. An ignored typo in
  a config file costs someone an evening.
- **The key list in the panel is generated** from `DEFAULT_SETTINGS`, with the
  TOML spelling derived rather than written down. The config file's comment
  points at that list instead of listing keys itself, because a hand-written
  list in a comment is one that goes stale.

## The bug the live test caught

`config set` appends a key when it isn't already in the file. That was correct
for as long as the file had no tables in it. `[ui]` changed that:

```
$ gobbonet config set listen_port 9999     # reports success
$ gobbonet config get listen_port
9066                                        # ...unchanged
```

The line landed *after* `[ui]`, so TOML read it back as `ui.listen_port`, the
real `listen_port` kept its old value, and the command reported success. The
launcher scripts drive `config set`, so a silently ineffective write is a
machine that comes up on the wrong port with nothing in any log.

`Set` is table-aware now: it only matches root-level keys, and inserts above
the first table header — above the comment block introducing it, so the
explanation stays attached to the section it explains. A file with no tables
behaves exactly as it did, and there's a test for that too.

`Keys()` also skips table-valued fields, detected by kind rather than by name,
so `config keys` doesn't advertise `ui` as something `config set` can write.

## Changes

**Go** — `UI map[string]any` on `Config`; `GET /ui-defaults.json`; `Keys()`
skips maps; `Set` writes above tables; the `[ui]` section documented in
`DefaultTOML`.

**Browser** — the preset logic in `js/21-data.js` (no new file: the JS load
order is a contract and the DATA panel it serves already lives there);
`hadOwnSettings` recorded by the loader; the seed awaited in boot before the
first render; the DATA panel section.

## What pins it

`tests/test-server-presets.mjs` (53), `internal/server/ui_defaults_test.go` (3)
and `internal/config/ui_table_test.go` (6).

Three guarantees verified to fail without their fix: making it a lock instead
of a seed loses 3 assertions, dropping validation loses 4, dropping the
snake_case spelling loses 4.

The Go tests assert values pass through **unchanged**, including a key Go has
never heard of — asserting on a schema there would be asserting on the second
list this design exists to avoid.

One test bug worth recording: the wiring check used
`boot.indexOf('render()')`, which matched a mention of `render()` in boot's
header comment rather than the call. It looks for the call now.

## Not changed

Version strings still say 1.7.3 — items 8 and 12, which are next, in that
order so the About section can be tested against a version it is actually
reporting.

The existing 25 server keys, their behaviour, and the `config get`/`set`/`keys`
interface are untouched apart from the table-awareness fix, which only affects
files that have a table in them.
