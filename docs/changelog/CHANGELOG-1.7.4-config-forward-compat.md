# 1.7.4 — A config file is no longer a one-way door

Raised as: *"Why does the binary have to match and disables this feature? This
means people can't download the zip and just replace the folder/necessary
files."*

Chasing that turned up something considerably worse than a greyed-out panel.

## The old binary would not start at all

Every config key this release added — `idle_standdown_minutes` and the `[ui]`
table — is unknown to 1.7.3. `Load()` treated any unrecognised key as fatal, so
a config written by this build stopped the previous binary dead:

```
$ gobbonet-1.7.3 serve --config gobbonet.toml
 [ERROR] gobbonet.toml: unknown setting(s): idle_standdown_minutes, ui, ui.auto_scroll
```

Reproduced with the actual 1.7.3 binary against a 1.7.4 config.

That is not a disabled feature, it is a server that will not boot, and the
message reads as *"your config is broken"* when the truth is *"your binary is
old"*. It springs as soon as anyone touches the new stand-down setting once —
the APPLY button writes `idle_standdown_minutes` through `config set` — and
then rolls back, or updates the web files and the binary in either order.

Rolling back to check whether something is a regression is a completely normal
thing to do, and it was booby-trapped.

## What changed

Unknown keys are now sorted into two kinds, because they are two different
problems that need opposite treatment.

**A typo stays fatal.** Silently ignoring `listen_prot` means the setting the
user thought they changed never took effect, and they find out by wondering why
the port is wrong. It now also names what it was probably meant to be:

```
gobbonet.toml: unknown setting(s): listen_prot (did you mean listen_port?)
```

**A key from a newer version is a warning.** It is reported on stderr, ignored,
and the server starts:

```
WARNING: gobbonet.toml has setting(s) this version does not know: a_setting_from_1_8
         They are being ignored. This usually means the config was written by a
         newer GobboNet than the binary now running it — update the binary to use them.
```

The classifier is `nearestKey()`: Levenshtein against the known key list, with
a deliberately tight threshold — two edits, and no more than a quarter of the
name's length. `listen_prot` is caught. A whole table from a later release
arrives as `ui` and `ui.auto_scroll`, neither of which resembles anything, and
is let through. Names of three characters or fewer are never matched, because
at that length two edits reaches most of the alphabet and the guess would be
noise.

A typo **beside** a future key is still fatal. Letting it through because
something else in the file was forward-looking would be the worst of both
rules, and there is a test for exactly that.

## The honest limit

This fixes 1.7.4 onward. It cannot fix 1.7.3, whose strictness is already
compiled in — a 1.7.3 binary meeting a 1.7.4 config still refuses. The trap is
closed going forward, not backward.

And the part that genuinely cannot be engineered away: **idle stand-down needs
the server binary.** The timer runs in the Go process because the case it
exists for is the browser being *closed*, and a shut tab cannot run a timer. No
amount of frontend work makes an old binary unload a model.

What that deserved was a better explanation than "update the GobboNet binary",
which is not obviously about a file sitting next to the `web/` folder somebody
just replaced. The panel now says:

> This server is older than these web files and does not have the idle
> stand-down setting. The gobbonet program file ships in the same download as
> web/ — replace both together. The timer runs in the server, not the browser:
> nothing here can unload a model while the page is closed, which is the case
> it exists for.

## What pins it

`internal/config/config_test.go` gains 5 tests: a key from a newer version
loads, a whole table from a newer version loads, four spellings of a real typo
are still refused *and* suggest the right key, a typo beside a future key is
still fatal, and the classifier itself is checked in both directions.

`TestLoadRejectsUnknownKeys` — the original strictness test — is unchanged and
still passes, which is the point: nothing about typo handling got looser.

One note on writing those tests. `idle_standdown_minutes` is the key that
caused all this, and it is the wrong thing to assert on here: from 1.7.4's own
point of view it is a *known* key and never reaches the classifier. The test
asserted it should look unknown and failed, correctly. The cases are keys this
version genuinely does not have, which is what 1.7.3 saw.
