# v1.7.3 — the address we print, and the firewall we never checked

*Two LAN reports that look like one problem and are not. Neither reproduced in
house, which is itself the finding: both need a machine shape our test boxes do
not have.*

---

## The two reports

**A — "it wouldn't let me connect thru LAN on my phone using ip addresses in
gobbonet cmd thingy. typing my wifi router's address in the search bar instead
of the suggested one solved the issue."**

The launcher printed an address. It did not work. A different address for the
same machine did. The user found it themselves.

**B — a wider bucket of "LAN setup doesn't work for me", against a setup path
that works on every machine we own.**

They share a symptom and nothing else. A is the launcher naming the wrong
address; the firewall was fine and the server was reachable the whole time. B is
the firewall, the port, or the docs, on a machine where the printed address was
correct. Triaging them together is how both stay open, so they are separated
below.

---

## Report A: we answered the wrong question

`LANIP` picked the address to print like this:

```go
conn, err := net.Dial("udp", "192.0.2.1:53")
// ... read back conn.LocalAddr()
```

Nothing is sent; the dial makes the kernel run a route lookup and reveal which
source address it would use. It is a real technique and it correctly answers
**"which interface reaches the internet."**

That is not the question the banner asks. The banner asks **"which address can a
phone on the sofa reach."** On a machine with one adapter those are the same
answer, which is why this shipped and why it survived. On a machine with two
they come apart:

| Machine | Default route | What a phone needs | Old output |
|---|---|---|---|
| Ethernet + Wi-Fi, different subnets | Ethernet (lower metric — Windows' default) | the Wi-Fi address | Ethernet only |
| VPN connected (Tailscale, WireGuard, corporate) | the tunnel | the physical LAN address | **the tunnel only** |
| Hyper-V / WSL2 / Docker Desktop | can be a `vEthernet` bridge | the physical LAN address | **the bridge only** |

Report A is row one. Rows two and three are worse: the printed address is not
merely one of several, it is reachable from nothing on the house network.

The failure had no second line. One address, wrong, and nothing on screen
suggesting another existed — so the only route forward was the one the reporter
took, which was to go and find it by hand. That is why this arrived as a vague
report rather than a precise one, and why it did not reproduce.

### What changed

The launcher stops guessing. `internal/server/lanaddr.go` enumerates every
address a phone could plausibly use, orders them, and **names the adapter each
one belongs to**:

```
 [OK] serving on http://192.168.1.24:9066/
      this machine:  http://127.0.0.1:9066/
      phone / LAN:   http://192.168.1.24:9066/    (Ethernet)
                     http://10.0.0.57:9066/       (Wi-Fi)

      More than one, because this machine has more than one network
      adapter and only your phone knows which one it shares. Try them
      top down; the one matching the Wi-Fi your phone is on is the one
      that works.
```

The adapter name is the load-bearing part. Someone who cannot read a routing
table can still recognise which line says Wi-Fi — and on Windows that column is
the OS friendly name, so it matches what they see in their own network settings.

Ordering is **physical, then virtual, then tunnel**; within a kind, the
default-route address leads. Kind sorting ahead of the default route is the fix
for rows two and three: when a VPN holds the default route the physical LAN
address is the one that works, and leading with the tunnel is precisely the old
bug. Nothing is hidden — a tunnel address is still listed, last, labelled, and
occasionally it is what someone wants:

```
      phone / LAN:   http://192.168.1.24:9066/    (Wi-Fi)
                     http://172.26.0.1:9066/      (vEthernet (WSL ...) -- virtual adapter, unlikely)
                     http://100.101.102.103:9066/ (Tailscale -- VPN or tunnel, unlikely)
```

**Single-adapter machines see no change at all.** They get one line, the same
line as before. `TestSingleAdapterIsUnchanged` pins that: this trades a rare
failure for nothing, not for a common one.

### Filtered out, and why

- **169.254.x.x (APIPA).** DHCP failed. The address cannot carry a connection,
  and offering it sends someone chasing one that was never going to happen.
- **fe80:: (IPv6 link-local).** Needs a zone index (`%eth0`) that is meaningless
  on the phone doing the typing, so the URL cannot be transcribed at all.
- **Down and loopback adapters.** A disconnected adapter keeps its address on
  Windows, so "has an IP" is not "can carry a connection".
- **The wrong address family.** `listen_host = "0.0.0.0"` is the IPv4 wildcard
  and binds **v4 only** — `":9066"` is the dual-stack spelling. Advertising a v6
  address on a v4-only socket sends the user to a port nothing is accepting on,
  which is indistinguishable from a firewall block and would be triaged as one.

### Also reported over HTTP

`/health-fileserver` now carries `lan_addresses` alongside the existing bind
fields, for the reason the bind is there at all — the banner scrolls away and
"it wouldn't connect from my phone" arrives days later:

```json
"lan_addresses": [
  {"url": "http://192.168.1.24:9066/", "ip": "192.168.1.24",
   "interface": "Wi-Fi", "kind": "network adapter", "default": true},
  {"url": "http://100.101.102.103:9066/", "ip": "100.101.102.103",
   "interface": "Tailscale", "kind": "VPN or tunnel", "default": false}
]
```

### Tests

`internal/server/lanaddr_test.go`. The interface enumeration is behind a
variable so the ordering can be driven against machines we do not have — a
CI box with one NIC and one default route gets the old answer right every time,
which is exactly how this reached a user.

---

## Report B: the firewall, and why nothing on the machine would say so

No single cause. What the code does say is that **triage was pointed at the
wrong half of the LAN path**, which is enough to explain why B is a bucket
rather than a bug.

`setup-lan.bat` was written for `fileserver.ps1`, whose `HttpListener` goes
through HTTP.SYS and genuinely needs a URL reservation. `gobbonet.exe` calls
`net.Listen` and never touches HTTP.SYS. So for the installer path:

- The **URL ACL** work — locale-independent SDDL, verify-after-add, stale
  reservation cleanup, most of the script's length — is **a no-op**.
- The **firewall rule** is the only thing standing between a bound socket and
  the phone, and it was added and never verified.
- `doctor` reported the URL reservation and **said nothing about the firewall
  rule at all.**

Both servers still ship, so the script must keep doing both. But a diagnostic
that reports the irrelevant half and omits the decisive one sends every report
down the wrong path.

### What changed

`gobbonet doctor` gains a **LAN ACCESS** section, printed before the URL
reservation section rather than instead of it:

```
LAN ACCESS
  addresses a phone could try, best first:
    http://192.168.1.24:9066/    (Wi-Fi)
    http://172.26.0.1:9066/      (vEthernet (WSL) -- virtual adapter, unlikely)
               listen_host is 0.0.0.0, which accepts IPv4 only. If a
               .local name fails while the numeric address works, that
               is why. `gobbonet config set listen_host "::"` accepts both.
  firewall:    NO RULE for this port.
               Either setup-lan.bat was never run, or it ran before
               the port was settled and opened a different one. ...
  [!] BLOCK RULES: 2 inbound rule(s) name gobbonet and block it.
```

Three things it now answers that nothing on the machine answered before:

1. **Is there a rule, and is it on the port we actually bind.**
2. **Is something blocking us anyway.** Windows writes program-scoped **Block**
   rules when the "Allow access?" prompt is dismissed — and the install is
   deliberately non-admin, so that prompt appears at first launch with no way to
   answer it correctly. **Block beats Allow**, so those rules override the port
   rule `setup-lan.bat` adds, and `setup-lan.bat` still reports `[OK]` for
   everything it did. This is the highest-value line in the section: it is
   invisible, common, and permanent, and whoever set this up on their own
   machine clicked *Allow* once and has never seen it since.
3. **That `LocalSubnet` is not "the house".** It is computed per-interface, so a
   phone on a guest network, a mesh node with its own DHCP scope, or a different
   band on a split-SSID router is off-subnet and dropped by a rule that looks
   correct in every listing.

The block-rule parse keys on the program path and the `Block` keyword, not on
netsh's field labels, which Windows translates. `setup-lan.bat` carries a long
comment about having shipped a check that matched an English netsh header and
therefore reported success on every localised Windows; `TestSurvivesLocalisedLabels`
stops that repeating here.

### Tests

`cmd/gobbonet/doctor_firewall_test.go`.

---

## Report B: what actually changed

### The port the rule lands on

`setup-lan.bat` resolved the port from `.gobbonet-port` — which the server
writes only **after** a successful bind. The installer's finish page starts
`gobbonet.exe` and this script in the same second, so on a first run the file
has never existed and we always fell through to the 9066 default.

That was harmless on a fresh install and silently wrong for everyone else:

- **Upgraders.** 1.5.5 moved the default 8080 → 9066, but a config written
  before that carries 8080 explicitly, and `config.toml` lives in
  `%USERPROFILE%\.config`, outside the install folder, where no uninstaller
  touches it. So the server was on 8080, the rule went on 9066, and reinstalling
  changed nothing — as many times as anyone cared to try.
- **Anyone following our own deprecation.** Only `GEMMA_LISTEN_PORT` was read
  here; the binary prefers `GOBBONET_LISTEN_PORT`. Using the current spelling
  moved the server without moving the firewall.

All three are one bug — the rule on a port nothing listens on — and all three go
away by not reproducing the resolution:

```bat
gobbonet.exe config get listen_port
```

That resolves the config file plus `GOBBONET_*` / `GEMMA_*` overrides exactly as
the server will, and it is correct **before the server has ever run**.
`.gobbonet-port` remains the fallback for the `launch.bat` / `fileserver.ps1`
path, which has no binary to ask.

### Block rules

Windows raises *"Windows Defender Firewall has blocked some features of this
app"* the first time `gobbonet.exe` binds. The install is deliberately per-user
and non-elevated, so that prompt arrives with no way to answer it correctly —
stacked, on the installer's finish page, under a UAC prompt for this very
script.

Dismiss it and Windows writes program-scoped **Block** rules. Block beats Allow,
so they override the port rule, `setup-lan.bat` goes on printing `[OK]` for
everything it did (everything it did succeeded), and the rules are machine-wide
so they survive reinstalling. Nothing on the machine said otherwise.

`setup-lan.bat` now finds and removes them, then adds an explicit
program-scoped allow rule so the prompt has its answer in advance and cannot
recur. The program rule is guarded on `gobbonet.exe` existing: the `launch.bat`
path serves from `powershell.exe`, and a rule for *that* would open every
PowerShell script on the machine to inbound LAN connections.

### Domain profile

Every rule was `profile=private,public`. A domain-joined machine — a work or
school laptop, and people do run this on one — got no rule at all and no message
saying so. Now `domain,private,public`, including the mDNS rules. Scope stays
`LocalSubnet` on every profile, so this widens nothing.

### Linux

The `.deb` ships no firewall handling at all, and `postinst` deliberately
touches nothing outside the package — which is right, and also means a user with
`ufw` enabled gets the identical symptom: the server binds `0.0.0.0`, the banner
prints an address, and the phone is refused by something no part of GobboNet
mentions. Ubuntu denies inbound by default the moment `ufw` is switched on.

`gobbonet doctor` now detects `ufw` and `firewalld` and prints the exact command
to open the port to the local subnet. It **only reports** — doctor changes
nothing by contract, and a diagnostic that quietly punched a hole in someone's
firewall would be a worse surprise than the one it fixed. `ufw` is read from
`/etc/ufw/ufw.conf`, which is world-readable, because `ufw status` needs root
and a check that only works under `sudo` is a check most people never run.

### Tests

`cmd/gobbonet/doctor_firewall_test.go` covers both platforms' parsers, including
localised `netsh` output and the substring trap that would report `19066` as an
open `9066`.

`tests/test-setup-lan.py` pins the batch arrangement — neither script can run on
CI, since they need Administrator and a real firewall. It checks the resolution
order, the profile scoping, that no allow rule is ever wider than `LocalSubnet`,
that every rule added has a matching removal in `teardown-lan.bat`, and that no
`%VAR%` read sits inside a parenthesised block. It caught the `domain` omission
on the two mDNS rules during this change.

---

## Still open — not fixed here, ranked

These came out of the same read and need decisions rather than patches.

**1. The installer's finish page still races itself.** `FinishPageLeave` does
`Exec gobbonet.exe` and then immediately `ExecShell "runas" setup-lan.bat`. The
port resolution no longer depends on that ordering, so the damage is contained —
but two elevation/permission dialogs still land stacked in the same second, and
the Windows Firewall prompt is the one that must not be dismissed. Worth
sequencing properly: run the LAN step after the first successful bind, or gate
it behind its own page.

**2. `LocalSubnet` is not "the house".** It is computed per-interface, so a
phone on a guest network, a mesh node with its own DHCP scope, or a different
band on a split-SSID router is off-subnet and dropped by a rule that looks
correct in every listing. `doctor` now says so; the rule itself is unchanged,
because widening it means picking a subnet for the user and the chat is not
encrypted. Probably wants a prompt in `setup-lan.bat` offering the detected
adapter subnets.

**3. `doctor` prints the configured host, not the bound one.** `doctor.go:101`
reports `cfg.ListenHost`. If the running server fell back to loopback, doctor
still says `0.0.0.0`. It is the one place the `Bind`/`FellBack` distinction gets
dropped; `/health-fileserver` has it right and doctor already probes that
endpoint, so this is a small fix that was left out to keep this change reviewable.

**4. Two servers, one setup script.** `launch.bat` still runs `fileserver.ps1`
(HTTP.SYS, needs the URL reservation) while the installer runs `gobbonet.exe`
(raw socket, does not). `setup-lan.bat` must therefore keep doing both, and
README:87 still tells manual-ZIP users the paths are interchangeable. For LAN
they are not. Either the PowerShell server goes, or that line needs a caveat.

---

## What to ask the next reporter

The fix for A is also a triage tool: the banner now prints the list, so "which
one did you have to use" is answerable. For B, `gobbonet doctor` output now
contains the decisive section. Beyond that:

```
netsh advfirewall firewall show rule name=all dir=in | findstr /i gobbonet
netsh advfirewall show currentprofile
```

Plus: phone OS; whether the numeric address works when `.local` does not (that
separates the IPv4-only bind from a firewall block); and whether they ever ran a
build older than 1.5.5 (that separates item 1 from everything else).
