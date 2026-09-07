package server

import (
	"net"
	"testing"
)

// The machines below are the ones that generated reports. None of them is a CI
// box, which is exactly why the old single-address guess survived to a user:
// on one NIC with one default route it is right every time.

// withIfaces substitutes a machine for the duration of a test.
func withIfaces(t *testing.T, def string, ifaces ...ifaceView) {
	t.Helper()
	realEnum, realDef := enumerateIfaces, defaultRouteIP
	enumerateIfaces = func() []ifaceView { return ifaces }
	defaultRouteIP = func() net.IP { return net.ParseIP(def) }
	t.Cleanup(func() { enumerateIfaces, defaultRouteIP = realEnum, realDef })
}

func up(name string, ips ...string) ifaceView {
	v := ifaceView{Name: name, Flags: net.FlagUp}
	for _, s := range ips {
		v.IPs = append(v.IPs, net.ParseIP(s))
	}
	return v
}

// TestSingleAdapterIsUnchanged is the regression guard on the majority case.
// Most machines have one adapter and one default route, the old guess was right
// for them, and a fix that reordered their banner would trade a rare failure for
// a common one.
func TestSingleAdapterIsUnchanged(t *testing.T) {
	withIfaces(t, "192.168.1.24", up("Wi-Fi", "192.168.1.24"))

	addrs := LANAddrsFor("0.0.0.0")
	if len(addrs) != 1 {
		t.Fatalf("got %d addresses, want 1: %+v", len(addrs), addrs)
	}
	if addrs[0].IP != "192.168.1.24" {
		t.Errorf("IP = %q, want 192.168.1.24", addrs[0].IP)
	}
	if got := LANIP(); got != "192.168.1.24" {
		t.Errorf("LANIP() = %q, want 192.168.1.24", got)
	}
}

// TestWiredDefaultDoesNotHideWireless is the reported bug.
//
// Ethernet holds the default route (lower metric, which is Windows' default) so
// the old code printed only the Ethernet address. The phone was on the Wi-Fi
// network, which the Ethernet side does not serve, and the user had to go find
// the right address themselves. Both must be offered.
func TestWiredDefaultDoesNotHideWireless(t *testing.T) {
	withIfaces(t, "192.168.1.24",
		up("Ethernet", "192.168.1.24"),
		up("Wi-Fi", "10.0.0.57"),
	)

	addrs := LANAddrsFor("0.0.0.0")
	if len(addrs) != 2 {
		t.Fatalf("got %d addresses, want both: %+v", len(addrs), addrs)
	}
	// The default route still leads: it is right far more often than not.
	if addrs[0].IP != "192.168.1.24" || !addrs[0].Default {
		t.Errorf("first = %+v, want the default-route address first", addrs[0])
	}
	// But the one the user had to find by hand is now on screen.
	if addrs[1].IP != "10.0.0.57" || addrs[1].Iface != "Wi-Fi" {
		t.Errorf("second = %+v, want the Wi-Fi address labelled Wi-Fi", addrs[1])
	}
}

// TestVPNDoesNotOutrankTheRealLAN is the case where the old guess was not just
// incomplete but actively wrong: the tunnel holds the default route, so the
// ONLY address printed was one nothing on the house network can reach.
//
// Kind sorts ahead of Default for exactly this. A VPN address is still listed,
// because occasionally it is what the user wants, but it cannot lead.
func TestVPNDoesNotOutrankTheRealLAN(t *testing.T) {
	withIfaces(t, "100.101.102.103",
		up("Tailscale", "100.101.102.103"),
		up("Wi-Fi", "192.168.1.24"),
	)

	addrs := LANAddrsFor("0.0.0.0")
	if len(addrs) != 2 {
		t.Fatalf("got %d addresses, want 2: %+v", len(addrs), addrs)
	}
	if addrs[0].IP != "192.168.1.24" {
		t.Errorf("first = %+v, want the physical LAN address ahead of the tunnel", addrs[0])
	}
	if addrs[1].Kind != LANTunnel {
		t.Errorf("Tailscale classified as %v, want LANTunnel", addrs[1].Kind)
	}
	if got := LANIP(); got != "192.168.1.24" {
		t.Errorf("LANIP() = %q, want the LAN address, not the tunnel", got)
	}
}

// TestHypervisorBridgesSortBelowRealAdapters covers the WSL2/Docker/Hyper-V
// machine. Their vEthernet adapters are up and routable and look like ordinary
// private addresses, which is why they are convincing and wrong.
func TestHypervisorBridgesSortBelowRealAdapters(t *testing.T) {
	withIfaces(t, "172.26.0.1",
		up("vEthernet (WSL (Hyper-V firewall))", "172.26.0.1"),
		up("vEthernet (Default Switch)", "172.17.240.1"),
		up("Wi-Fi", "192.168.1.24"),
	)

	addrs := LANAddrsFor("0.0.0.0")
	if addrs[0].IP != "192.168.1.24" {
		t.Fatalf("first = %+v, want the Wi-Fi address", addrs[0])
	}
	for _, a := range addrs[1:] {
		if a.Kind != LANVirtual {
			t.Errorf("%s on %q classified as %v, want LANVirtual", a.IP, a.Iface, a.Kind)
		}
	}
}

// TestUnusableAddressesAreDropped. APIPA means DHCP failed and the address
// cannot carry a connection; fe80:: needs a zone index that is meaningless on
// the phone doing the typing. Offering either sends someone chasing a
// connection that was never going to happen.
func TestUnusableAddressesAreDropped(t *testing.T) {
	withIfaces(t, "192.168.1.24",
		up("Wi-Fi", "192.168.1.24", "fe80::1c2d:3e4f:5a6b:7c8d"),
		up("Ethernet 2", "169.254.11.9"),
	)

	addrs := LANAddrsFor("::")
	if len(addrs) != 1 {
		t.Fatalf("got %+v, want only the routable address", addrs)
	}
	if addrs[0].IP != "192.168.1.24" {
		t.Errorf("kept %q", addrs[0].IP)
	}
}

// TestWildcardFamilyIsRespected. 0.0.0.0 is the IPv4 wildcard and binds v4
// ONLY -- ":9066" is the dual-stack spelling. Advertising a v6 address for a
// v4-only socket sends the user to a port nothing is accepting on, which is
// indistinguishable from the firewall problem and would be triaged as one.
func TestWildcardFamilyIsRespected(t *testing.T) {
	machine := []ifaceView{up("Wi-Fi", "192.168.1.24", "2001:db8::5")}

	withIfaces(t, "192.168.1.24", machine...)
	for _, a := range LANAddrsFor("0.0.0.0") {
		if net.ParseIP(a.IP).To4() == nil {
			t.Errorf("0.0.0.0 bind offered the v6 address %q", a.IP)
		}
	}

	withIfaces(t, "192.168.1.24", machine...)
	if len(LANAddrsFor("::")) != 2 {
		t.Error("dual-stack bind dropped an address it is listening on")
	}
}

// TestPinnedHostReportsOnlyItself. The user named an address; offering
// alternatives we are not listening on would be noise, and worse, would be
// noise that looks like a working option.
func TestPinnedHostReportsOnlyItself(t *testing.T) {
	withIfaces(t, "192.168.1.24",
		up("Wi-Fi", "192.168.1.24"),
		up("Ethernet", "10.0.0.9"),
	)

	addrs := LANAddrsFor("10.0.0.9")
	if len(addrs) != 1 || addrs[0].IP != "10.0.0.9" {
		t.Fatalf("got %+v, want only 10.0.0.9", addrs)
	}
	if addrs[0].Iface != "Ethernet" {
		t.Errorf("Iface = %q, want the adapter holding it", addrs[0].Iface)
	}
}

// TestDownAndLoopbackAdaptersAreSkipped. A disconnected adapter keeps its
// address on Windows, so "has an IP" is not "can carry a connection".
func TestDownAndLoopbackAdaptersAreSkipped(t *testing.T) {
	withIfaces(t, "192.168.1.24",
		ifaceView{Name: "Ethernet", IPs: []net.IP{net.ParseIP("10.0.0.9")}}, // no FlagUp
		ifaceView{Name: "lo", Flags: net.FlagUp | net.FlagLoopback, IPs: []net.IP{net.ParseIP("127.0.0.1")}},
		up("Wi-Fi", "192.168.1.24"),
	)

	addrs := LANAddrsFor("0.0.0.0")
	if len(addrs) != 1 || addrs[0].IP != "192.168.1.24" {
		t.Fatalf("got %+v, want only the up, non-loopback address", addrs)
	}
}

// TestNoUsableAddressYieldsNothing. An offline machine with only a Hyper-V
// bridge has no answer, and the banner has a branch for that. Returning
// 127.0.0.1 here instead would put loopback under a "phone / LAN" label, which
// is a promise the socket cannot keep.
func TestNoUsableAddressYieldsNothing(t *testing.T) {
	withIfaces(t, "", ifaceView{Name: "lo", Flags: net.FlagUp | net.FlagLoopback})

	if addrs := LANAddrsFor("0.0.0.0"); len(addrs) != 0 {
		t.Fatalf("got %+v, want none", addrs)
	}
	if got := LANIP(); got != "127.0.0.1" {
		t.Errorf("LANIP() = %q, want the 127.0.0.1 fallback", got)
	}
}

// TestPointToPointIsATunnel covers VPN clients that do not announce themselves
// in the adapter name. The flag is the reliable signal; the name list is the
// backstop for Windows clients that present as ordinary adapters.
func TestPointToPointIsATunnel(t *testing.T) {
	withIfaces(t, "192.168.1.24",
		ifaceView{
			Name:  "Local Area Connection 4",
			Flags: net.FlagUp | net.FlagPointToPoint,
			IPs:   []net.IP{net.ParseIP("10.8.0.6")},
		},
		up("Wi-Fi", "192.168.1.24"),
	)

	addrs := LANAddrsFor("0.0.0.0")
	if addrs[0].IP != "192.168.1.24" {
		t.Errorf("first = %+v, want the physical adapter", addrs[0])
	}
	if addrs[1].Kind != LANTunnel {
		t.Errorf("point-to-point classified as %v, want LANTunnel", addrs[1].Kind)
	}
}

// TestURLBracketsIPv6 -- an unbracketed v6 address in a URL is not parseable,
// so a user copying it out of the banner gets an error from their browser
// rather than a connection.
func TestURLBracketsIPv6(t *testing.T) {
	got := LANAddr{IP: "2001:db8::5"}.URL(9066)
	if got != "http://[2001:db8::5]:9066/" {
		t.Errorf("URL = %q", got)
	}
	if got := (LANAddr{IP: "192.168.1.24"}).URL(9066); got != "http://192.168.1.24:9066/" {
		t.Errorf("URL = %q", got)
	}
}
