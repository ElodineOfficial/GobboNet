# 1.7.9 — Loopback fallback, verified for closing PR #10

*Patch step 1 of 1.7.9. PR #10 (wizzense), "Fall back to loopback when the LAN
bind is denied, so desktop chat still works", can be closed. The behaviour it
asked for was ported to the Go server in 1.7 (see
`CHANGELOG-1.7-lan-bind-fallback.md`). This step confirms it still holds and adds
a browser-side check.*

## What PR #10 asked for, and where it is

| PR #10 asked | In 1.7.8 |
| --- | --- |
| Fall back to `127.0.0.1` when the LAN bind is refused, instead of exiting | `internal/server` bind logic: refused, unavailable and unsupported-family errors fall back; "port in use" deliberately does not |
| Show the real failure reason | the banner prints the OS error and what to try |
| Say plainly that LAN access is off | the banner, plus `lan_access: false` and `lan_bind_denied` in `/health-fileserver` |
| Report the address actually bound | the banner and `/health-fileserver` |
| A port setting to avoid Windows' reserved ranges | `listen_port`, settable with `gobbonet config set listen_port` |

The fallback only ever narrows exposure. `TestWideBindIsPreferred` guards the
other direction: a machine that can bind the network still does.

## Not changed

The legacy `fileserver.ps1` path, used only when `gobbonet.exe` is missing,
still exits on a refused bind. It is not patched, because it is deprecated in
1.7.9 (step 7) and removed in 1.8.

## Tests

- The existing Go tests pass: `TestWideBindIsPreferred`,
  `TestConfiguredLoopbackIsNotAFallback`, `TestBindErrorsWrapTheCause`.
- Run here: `gobbonet serve --host 192.0.2.1` (an address the machine does not
  have) served the page on `127.0.0.1` with HTTP 200 and reported
  `lan_bind_denied: listen tcp 192.0.2.1:19166: bind: cannot assign requested
  address`.
- `tests/console/1.7.9-steps-1-3.js`: on that instance, "LAN bind was refused and
  the page is still served on 127.0.0.1" passes.

**Not run:** the Windows `WSAEACCES` (10013) reserved-range case in a Windows
console.
