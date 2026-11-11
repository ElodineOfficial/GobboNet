# 1.8.0 — open_browser: start GobboNet without a new browser tab

PR #58 (orcmaul). Roadmap item #7.

## What was happening

Every way of starting GobboNet opened a browser tab, every time.
`gobbonet launch` (the Start menu and desktop shortcuts) always passed
`--open`; `launch.bat`'s hand-over to `gobbonet.exe` did too; the Linux
launcher only stopped with a `--no-browser` flag, which a menu entry cannot pass.
Someone who keeps a tab open, or uses GobboNet from a phone, got a new tab on
every start.

PR #58 added a `--nopageload` flag to the legacy branch of `launch.bat`. That
branch goes in 1.8.0 (roadmap #13), and the shortcuts never reach it, so the
need is met here instead, for every launcher. The PR closes with credit.

## The change

**One key, `open_browser`, default `true`**, in `Default()` and the generated
`config.toml` (a new "Starting GobboNet" block after the listener). A
`--no-browser` flag beats it wherever there is one.

| Launcher | Reads the key | Flag |
| --- | --- | --- |
| `gobbonet launch` (shortcuts) | yes; passes `--open` to serve only when true (`launchServeArgs`) | new `--no-browser` |
| `gobbonet launch --setup`, "Setup or add a model" | `launch.bat` reads it at its hand-over to `gobbonet.exe` | `--no-browser` reaches `launch.bat` as `GOBBONET_OPEN_BROWSER=false`, which wins |
| `launch.bat` | `gobbonet.exe config get open_browser` into a temp file and back with `set /p`, never through `for /f`, so the install path never meets cmd's quote handling | `GOBBONET_OPEN_BROWSER=false` |
| `gobbonet-launch` (.deb, .rpm, AppImage, ZIP; both copies) | yes, but only once a config exists: `config get` on a first run would write a default `config.toml` before setup asked anything. A first run always opens the wizard. | `--no-browser` |
| `gobbonet setup` | yes, when the config was not just created | `--no-browser` |

It covers setup too. A setup that the key keeps out of the browser still
shows its address: in the console on Windows, and on Linux in a
desktop dialog (`tell_url`), because a setup started from the menu has no
terminal. `--no-browser` (autostart, scripts) stays quiet.

When a launcher does not open the browser it says so, and where the chat is:
"browser not opened (open_browser = false in config.toml); the chat is at
http://127.0.0.1:9066/".

**CONFIG > Basics > When GobboNet Starts**: a checkbox, "Open the browser when
GobboNet starts". It reads and writes `config.toml` through a new
`/launch-settings` route (GET `{open_browser}`, POST `{open_browser: bool}`).

- **Any signed-in device can change it** (the maintainer's call). It decides nothing
  but whether a tab opens on the PC, and cannot make anything run. A page on
  another site cannot flip it (`sameOriginOrNone`, as for LAN access).
- The file is the truth, because the launchers read the file: GET reads it
  (so a Config File editor change shows at once), and a POST that cannot write
  it fails with the reason and the box goes back.
- Like Idle Stand-Down, it saves the moment the box changes, never on SAVE,
  and it takes effect at the next start.

Docs: README, LINUX-START-HERE.md and FEDORA.md point at the setting.

Not changed: the legacy PowerShell server's own browser opening in
`launch.bat`, which goes with that branch in round 6.

## Tests

- `cmd/gobbonet/launch_test.go`: the default opens; `open_browser = false`
  does not; `--no-browser` beats a true key; an unreadable config keeps the old
  behaviour; `--setup --no-browser` hands `launch.bat` exactly
  `GOBBONET_OPEN_BROWSER=false` and never an inherited value; the key defaults
  on and is in the generated file.
- `internal/server/launchsettings_test.go`: the default is true; a device that
  is not this PC saves false into `config.toml` and reads it back; GET follows
  the file when it changes underneath; bad bodies get 400, a cross-site POST
  403, PUT 405.
- `tests/test-launch-open-browser.py` (new): the real `gobbonet-launch`, run
  with a stand-in `gobbonet` and `xdg-open`: the default opens the chat, false
  does not and the log says why and where, `--no-browser` beats true; the key
  is never read before a first run; a re-run setup follows it and still shows
  its address. `launch.bat` statically: CRLF throughout, the hand-over uses
  `!GN_OPEN!`, no unconditional `--open` left on the `gobbonet.exe` path, the
  key read through a file and not `for /f`, `GOBBONET_OPEN_BROWSER` honoured,
  the temp file removed, the message's parentheses escaped.
- `tests/test-open-browser-panel.mjs` (new): the box shows the file's value;
  an older server, a file:// page or an unreachable server disable it with a
  reason; a change POSTs JSON and keeps the server's answer; a refused or
  failed save puts the box back.
- `tests/test-config-sections.mjs`: the box's four ids and two labels join the
  inventory, in Basics.
- `tests/test-windows-installer.py` and `tests/test-launch-cmd-flow.py` pinned
  the hand-over as `"!GN!" --open --model ...`; they now pin
  `"!GN!" !GN_OPEN! --model ...` and the `--open` default.
- `tests/console/1.8.0-round-3.js`: flips the setting from the page and puts it
  back, on the PC and on another device.

Run against the round-2 tree, the launcher test fails: the old launcher opens a
browser with `open_browser = false`.

Not run here: `launch.bat` in a Windows console (its new lines are checked
statically), and a desktop session for the Linux dialog.
