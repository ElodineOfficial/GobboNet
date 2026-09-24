# Windows launcher presentation

Restores the familiar green-on-black console and GobboNet window title when
starting the Go executable directly, including installed shortcuts. Uses native
Windows console calls; redirected output and non-Windows terminals are unchanged.
No new packages, windows, hidden processes or network requests. Console attributes
are restored on an ordinary return to a calling terminal.

The batch launcher marks its already-printed banner at handoff, so Go does not
print a second one. Diagnostics remain above a framed CONNECTION ADDRESSES panel.
Each Wi-Fi/Ethernet adapter and full URL gets its own lines. VPN/virtual adapters
remain visible in a separate section below, not mixed into the phone addresses.
The panel uses the actual bound port and explains when LAN access is off. A bind
to one specific interface no longer advertises loopback as reachable.

The address panel stays visible: there is no automatic minimize or screen clear.
The user can minimize manually; ongoing diagnostics continue in the same window.
Full logs and existing engine-output settings are unchanged.

Checks: address-panel tests cover multiple adapters, VPN ordering, actual ports,
loopback fallback and interface-specific binding. Go CLI tests and Windows cross-
compilation are checked. Actual Windows terminal colors/title still need a Windows
runtime check; this environment is Linux.

This update includes the prior PR #60 integration and corrective patch unchanged
apart from the additional startup presentation code. No GitHub push or merge.
