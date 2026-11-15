# 1.8.1 — Linux setup: the Install location step names this install

AppImage and ZIP. Present since 1.7.9.

## What was happening

The Install location step of the Linux setup page opens with "The Debian
package manages program files in /usr/lib/gobbonet." That is true of the
`.deb`. The `.rpm`'s build rewrites the line for its own path
(`installer-fedora/gobbonet.spec`, checked by `check-rpm.sh`). The AppImage
is built from the `.deb` and the ZIP carries the same `wizard.html`, so both
showed the Debian sentence to people who had no Debian package.

## The change

`gobbonet-setup.py` (both copies) works out how it was installed,
`install_kind()`:

| Install | How it knows | The sentence |
| --- | --- | --- |
| AppImage | `APPIMAGE` and `APPDIR` set, with this file inside `APPDIR` (the test `login_program()` already used, now `appimage_file()`) | GobboNet's program files stay inside the AppImage, *the AppImage file*; nothing is installed. |
| ZIP | anything else, not under a package path | GobboNet's program files stay in the folder you unpacked, *the folder*. |
| `.deb`, `.rpm` | this file in `/usr/lib/gobbonet` or `/usr/lib64/gobbonet` | the page's own, unchanged |

It puts the sentence in when it serves the page (`wizard_page()`), escaped,
in place of the Debian one; a package's page is served byte for byte as
before. `wizard.html` itself is unchanged, so the `.rpm`'s `sed` and
`check-rpm.sh`'s "differs from installer-linux/ in exactly its two Fedora
lines" still hold. `/api/state` also says `install_kind` and `program_files`.

## Tests

- `tests/test-setup-program-files.py` (new): the module itself for every
  layout (AppImage; ZIP; ZIP started from another AppImage, whose variables
  are not GobboNet's; `.deb`; `.rpm`), a folder name that looks like markup,
  and that only the one sentence changes. That the sentence it replaces is in
  both `wizard.html` copies once and is the one the `.rpm`'s `sed` rewrites.
  Then the real setup server laid out as an AppImage's mount and as an
  unpacked ZIP: `GET /` and `/api/state`. 19 checks; against 1.8.0's setup
  it stops at the first, the sentence it replaces not being defined.
- In headless Chrome, the setup page from the ZIP's layout, clicked through
  to Install location.

Not run: the AppImage and `.rpm` builds themselves (their own steps, with the
installers).
