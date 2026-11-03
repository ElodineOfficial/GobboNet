# 1.7.9 — The password minimum is a setting

*Closes the last open part of PR #6 (neoliminal), "Rate-limit login and hash
the access password with PBKDF2". First landed in step 3 as a fixed
10-character minimum. Revised during step 7 at Elodine's request: 10 was too
high, and it should never be hard-coded with no way to change it.*

## What was happening

The rest of PR #6 was already in place, and stronger than asked:

- passwords are stored as Argon2id (the PR asked for PBKDF2);
- legacy SHA-256 secrets upgrade on the next sign-in;
- the login rate limiter returns a "too many attempts" page.

The minimum length for a new password was a constant: 6 in 1.7.8. GobboNet
once allowed 4, a PIN. PR #6 asked for 10, but neither number fits everyone.

## The change

**`min_password_length` in `config.toml`, 8 by default, never below 4.** It
applies wherever a password is chosen. **A password that is already set is
never checked**, whatever its length. Sign-in does not look at length, so a
4- or 6-character password from an earlier version keeps working after the
update.

- An unset or zero value means 8. A value below 4 is lifted to 4 rather than
  refused, so a typo cannot stop GobboNet from starting.
- It is an ordinary key: `gobbonet config get/set min_password_length`, the
  CONFIG > Config File editor, and the default config documents it.
- To use a shorter password:
  1. `gobbonet config set min_password_length 4`
  2. `gobbonet set-password`

| Where a password is chosen | How it gets the minimum |
| --- | --- |
| `gobbonet set-password`, the console prompt, `--stdin`, and changing the keyring password | `cmd/gobbonet/main.go`, `minPasswordLength(cfg)` |
| Setup wizards (Go, Linux, Linux ZIP copy) | the server enforces `s.minPasswordLength()` and sends it as `min_password` in `/api/state`; the page checks it and shows it in the note under the field |
| Windows first run, `launch.bat` | the generated PowerShell runs `gobbonet.exe config get min_password_length` itself, so no install path passes through cmd quoting; 8 with no config or no `gobbonet.exe`; never below 4 |
| Windows installer page (NSIS) | 8, the default. No config exists at install time. To choose shorter: tick the skip box, set the key, then run `set-password`. |

## Tests

- `internal/config`: `TestMinPasswordLength` covers the default, a PIN, a value
  below the floor, a high value, and that it is a listed key.
- `internal/setup`: `TestPasswordMinimumFollowsConfig` checks both sides of the
  boundary at 8, 4 and 12, and that `/api/state` reports the same number.
- `internal/auth`: `TestShortExistingPasswordsStillVerify`. A 6-character
  password verifies in both stored formats.
- `tests/test-password-minimum.py`, new. It pins the wizards, `launch.bat` and
  the NSIS page, and checks no fixed number is left.
- Run here:
  - **Go setup wizard in a browser:** "8 characters minimum", 7 refused, 8
    accepted; with the key set to 4, "4 characters minimum", 3 refused, 4
    accepted.
  - **`gobbonet set-password`:** the same boundaries.
  - **`launch.bat`'s PowerShell:** its three lines, unescaped as cmd would,
    run in PowerShell 7 against the real binary. No config gives 8, 4 gives
    4, 2 gives 4, 12 gives 12, no `gobbonet.exe` gives 8, and an install path
    with a space and an apostrophe works.

**Not run:** `launch.bat` and the NSIS page in a Windows console.
