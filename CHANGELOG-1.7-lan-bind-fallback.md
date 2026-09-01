# v1.7 — LAN bind fallback

*Ports PR #10 ("Fall back to loopback when the LAN bind is denied") to the Go
server. The PR was written against `fileserver.ps1`, which 1.7 replaced; the
behaviour it asked for is what got carried over, not the diff.*

---

## The problem

The server binds `listen_host`, which defaults to `0.0.0.0`, so a phone on the
same network can reach it. When the machine refuses that bind, **the whole app
died there.**

That is the wrong outcome, because the file server serves the chat page. A user
whose machine would not allow a wide bind lost desktop chat entirely, while
llama.cpp on its own port stayed perfectly healthy — which reads as a front-end
bug and is close to impossible to report usefully. Phone access genuinely needs
the wide bind. Chat on this machine never did.

## What changed

When a network-facing bind is refused, the server now binds loopback instead and
keeps running. Desktop chat works. The banner says plainly that LAN access is
off, prints the real OS error, and lists what to try.

```
 [!]  LAN access is OFF -- this machine could not bind a network address.
      listen tcp 192.0.2.1:9066: bind: cannot assign requested address

 [OK] serving on http://127.0.0.1:9066/  (this machine only)

      To reach this from your phone, try, in order:

        1. Windows: check whether the port sits in a reserved range --
             netsh interface ipv4 show excludedportrange protocol=tcp
           If it does, pick a port outside every listed range:
             gobbonet config set listen_port 9067   (writes ...)

        2. Windows: run setup-lan.bat as Administrator to open the firewall.

        3. Linux/macOS: ports below 1024 need root. Use a higher one.
```

**The fallback only ever narrows what is exposed.** There is no path from
loopback out to the network, so a machine configured to stay local cannot be
widened by a failure. `TestWideBindIsPreferred` guards the other direction: a
machine that *can* bind the network still does, because a fallback that fired
when it was not needed would quietly take phone access away.

## Which failures fall back, and which do not

| Failure | Falls back? | Why |
|---|---|---|
| `EACCES` / `WSAEACCES` (10013) | yes | policy, privileged port, or a reserved range — all properties of the address |
| `EADDRNOTAVAIL` / 10049 | yes | `listen_host` pinned to a LAN address DHCP later moved |
| `EAFNOSUPPORT` / 10047 | yes | `::` on a machine with IPv6 switched off |
| `EADDRINUSE` / 10048 | **no** | the port is occupied; the user needs to hear that |

`EADDRINUSE` staying out is load-bearing. Moving to a narrower address there
would hide "something already holds this port", which is the most common startup
failure and already has a message written for it.

When the configured host is already loopback, there is nothing to fall back to
and the error is returned unchanged.

## A misdiagnosis this fixes on the way past

`isAddrInUse` counted **WSAEACCES (10013)** as "that port is taken". It can mean
that — an exclusive-use binding produces it — but it is also what a reserved port
range and a firewall policy produce, and those are the common cases.

So a Windows user whose port fell inside a Hyper-V, WSL or Docker Desktop
reserved range was told to go find and kill the process holding it. **There is no
such process.** `netstat` shows nothing listening because nothing is: the range
is *reserved*, not *occupied*. The advice sent them straight past
`netsh interface ipv4 show excludedportrange protocol=tcp`, the one command that
would have shown the real cause.

10013 is now classified as a permission failure and gets the reserved-range
check. `TestWSAEACCESIsNotReportedAsInUse` pins it.

The fallback also disambiguates 10013 on its own: a refusal that follows the port
onto loopback as well is a reserved range, while one that clears on loopback was
about the wide address. That is why the permission message leads with the range
check — by the time it prints, both addresses have already been refused.

## Reported over HTTP, not just at startup

`/health-fileserver` now carries `listen_host`, `listen_port`, `lan_access`, and
`lan_bind_denied` when a fallback happened:

```json
{
  "lan_access": false,
  "lan_bind_denied": "listen tcp 192.0.2.1:9066: bind: cannot assign requested address",
  "listen_host": "127.0.0.1",
  "listen_port": 9066
}
```

The banner scrolls away, and "I can't reach it from my phone" arrives days later.
A user who cannot read a terminal can still open this in a browser — the same
reason the build stamp is served there.

The fields are **omitted** rather than guessed at when no bind has been
published, so a Server driven by a test harness does not report LAN access as
off when it simply does not know.

## Not changed

- `.gobbonet-port` still records `listen_port`. A fallback changes the host, not
  the port, so what `setup-lan.bat` reads is still correct.
- `--no-auth` is unaffected. It was always advisory ("only sensible on
  loopback"), and a fallback can only move a server *toward* the case it
  describes.

## Tests

`internal/server/bind_test.go`, `cmd/gobbonet/bind_error_test.go`.

`TestFallbackOnUnavailableAddress` drives the real recovery through
`EADDRNOTAVAIL`, which reproduces at any privilege level.
`TestBothBindsDeniedReportsTheWideError` covers a privileged port, where the
fallback cannot help and the *wide* error must come back rather than the
loopback attempt's — the loopback bind is diagnosis, and reporting its failure
would name an address the user never configured. It skips as root, where the
bind succeeds and there is no denial to observe.
