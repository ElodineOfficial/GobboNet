# 1.7.9 — LAN setup opens only what it needs

*Patch step 8 of 1.7.9. Finishes PR #7 (neoliminal), "Scope the URL ACLs to one
account and stop widening system firewall rules". 1.7.3 already removed the
11434/11435 rules and reservations the PR flagged. These are the other two
points, plus three things found on the way.*

## What was happening

`setup-lan.bat` runs as Administrator. It still:

1. **Granted the URL reservation to Everyone** (`sddl=D:(A;;GX;;;WD)`). Any
   account on the PC could claim the chat's address through HTTP.SYS and serve
   its own page there, a fake sign-in page say, to every phone on the network.
2. **Opened GobboNet on Public networks**, the profile Windows uses for cafes,
   hotels and airports. Every rule said `profile=domain,private,public`. The
   chat is behind a password but not encrypted.
3. **Re-scoped Windows' own `mDNS (UDP-In)` rules to every profile.** Those are
   rules other programs rely on, changed on networks the user never chose.

## The change

**The firewall covers home and work networks (Private and Domain) by default.**
Public is a choice. Windows often labels a home Wi-Fi network Public, and
closing it without a word would break phone access for exactly the people who
need setup to be easy. So when the network the PC is on right now is Public,
`setup-lan.bat` says so and asks:

| Key | Does |
| --- | --- |
| **P** | makes this network Private, the right fix for a home network (`Set-NetConnectionProfile`) |
| **A** | allows Public networks too, the pre-1.7.9 behaviour, with a one-line warning |
| **S** | skips; phones on this network cannot connect until it is Private |

- The question times out to **S** after 60 seconds, so an unattended run never
  widens anything.
- `setup-lan.bat /public` chooses **A** without asking. It is never hard-coded
  closed.
- Re-running repairs a 1.7.8 rule that covered Public without being asked.

**The built-in mDNS rules are switched on, never re-scoped.** For each profile
in the choice, the script enables Windows' `mDNS (UDP-In)` rule for that
profile and leaves which networks it covers as Windows set it. If none exists,
it adds a `GobboNet-mDNS` rule for the same profiles, local subnet only, as
before.

**The URL reservation belongs to one account**: the person signed in at the
console, found through `Win32_ComputerSystem.UserName`. If none is found, such
as in a remote desktop session, it uses the account running the script.

- Who that is gets printed, so the wrong-admin case PR #7 described is visible.
- The SID goes into the SDDL, so the 1.7.3 locale fix holds: no account name
  passes through netsh.
- An existing reservation is replaced, never kept, so a 1.7.8 Everyone grant
  goes away on re-run.
- If no account can be found, no reservation is made. `gobbonet.exe` binds
  with Winsock and does not need one; only the deprecated PowerShell server
  does.

**`gobbonet doctor` explains the Public-network case.** With a GobboNet-Web
rule present and the active network Public, LAN ACCESS now says the rule covers
home and work networks only, and gives the three fixes. Without this, every
line doctor prints would read as a working firewall while the phone is
refused.

## Found on the way

- **The block-rule check probably never found anything.** It ran a
  PowerShell pipeline from `for /f` with `^|` *inside* double quotes. cmd does
  not unescape carets inside quotes, so PowerShell most likely received a
  literal `^`. That command does not parse (5 errors), and the result always
  read as "no blocking rules", which hid the exact Block rules the step was
  written to find. All PowerShell calls in the script are now written without
  pipes, so this escaping question cannot arise. This needs confirming on
  Windows: if cmd does strip those carets, the old check worked and the new
  one is simply equivalent.
- **Unescaped parentheses in `echo` lines inside blocks.** For example:

  ```
  echo  [OK] Firewall rule added: GobboNet-Web (port 9066, ...)
  ```

  inside an `if ( ... )` block. The `)` can end the block early. All of these
  are now escaped, and the test now checks for them. On 1.7.8 it finds them.
- **SECURITY.md** quoted the Everyone grant as current. Corrected.

`teardown-lan.bat` needed no change. It removes rules and reservations by name
and port, whatever their profile or owner. One thing it cannot undo: built-in
mDNS rules that an older `setup-lan.bat` re-scoped to every profile keep that
scope. Windows' own defaults can be restored in Windows Defender Firewall →
Restore defaults, which also resets every other rule.

## Tests

- `tests/test-setup-lan.py`, extended. It checks:
  - the default profiles are `domain,private`, and every rule takes its
    profiles from the choice;
  - Public appears only on the `/public` and **A** path;
  - a Public network is detected and the user asked; the question times out
    to skip; **P** sets the network Private;
  - the mDNS rules are enabled and never re-scoped;
  - no Everyone grant; the SID is validated and printed; no SID means no
    reservation; an existing reservation is replaced;
  - no pipe in any PowerShell call, and no unescaped parenthesis in an `echo`
    inside a block.

  On the 1.7.8 script it fails 25 checks.
- Every PowerShell command in both LAN scripts was extracted as PowerShell
  receives it and parsed by PowerShell 7's parser: 9 of 9 parse. The old
  block-rule command does not (5 errors).
- `cmd/gobbonet`: `TestReportNetworkProfile` covers a Public network with and
  without a Public rule, several networks, Private, Domain, and no rule.
- `tests/console/1.7.9-step-8.js`: whether LAN access is on and the page came
  over the network, plus the by-hand Windows checklist.

**Not run:** `setup-lan.bat` and `teardown-lan.bat` in a Windows console, as
Administrator. They change system firewall state, and only a real Windows
machine can show what they did. The checklist is in the console block.
