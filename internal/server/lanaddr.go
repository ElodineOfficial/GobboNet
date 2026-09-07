package server

import (
	"net"
	"sort"
	"strings"
)

// Which address to put in front of a user who wants to reach this machine from
// their phone.
//
// LANIP used to answer this by opening a UDP socket to a routable address and
// reading back the source the kernel chose. That is a real technique and it
// answers a real question -- "which interface would reach the internet" -- but
// it is NOT the question the banner asks. The banner asks which address a phone
// on the house Wi-Fi can reach, and on any machine with more than one usable
// adapter those two answers come apart:
//
//   - Ethernet and Wi-Fi both up. Windows routes over whichever has the lower
//     metric, usually Ethernet. If the phone is on a Wi-Fi network the Ethernet
//     side does not serve, the printed address is on the wrong subnet.
//   - A VPN is connected. Tailscale, WireGuard and every corporate client take
//     the default route, so the printed address is the tunnel's -- reachable
//     from nothing on the LAN.
//   - Hyper-V, WSL2 or Docker Desktop. Their vEthernet adapters can win route
//     selection and hand back a 172.x address nothing else on the house network
//     has ever heard of.
//
// In each case the guess is confidently wrong and there is no second line to
// try, which is what turns it into an unreportable bug: the user is told one
// address, it does not work, and nothing on screen suggests another exists.
//
// So this file stops guessing. It enumerates every address a phone could
// plausibly use, orders them most-likely-first, and names the adapter each one
// belongs to so the user can recognise their own Wi-Fi. The default route still
// sorts first among equals, which keeps the single-subnet case -- the majority
// -- printing exactly what it printed before.

// LANKind is how much a given adapter looks like the one the house Wi-Fi is on.
// It exists to order the list, not to hide anything: a tunnel address is still
// printed, just last, because occasionally it is the right answer.
type LANKind int

const (
	// LANPhysical is an ordinary network adapter: Wi-Fi, Ethernet.
	LANPhysical LANKind = iota
	// LANVirtual is a hypervisor or container bridge -- vEthernet (WSL),
	// docker0, vboxnet. Real, routable, and almost never how a phone arrives.
	LANVirtual
	// LANTunnel is a VPN or point-to-point link. Reachable only by whatever is
	// on the far end of the tunnel, which is not the sofa.
	LANTunnel
)

func (k LANKind) String() string {
	switch k {
	case LANVirtual:
		return "virtual adapter"
	case LANTunnel:
		return "VPN or tunnel"
	}
	return "network adapter"
}

// LANAddr is one address a device on the local network might reach us at.
//
// Iface is carried because it is the field that actually resolves the reported
// failure. An address on its own gives the user nothing to reason about; an
// address labelled "Wi-Fi" next to one labelled "Ethernet" lets someone who
// knows which network their phone is on pick correctly without understanding
// routing at all.
type LANAddr struct {
	IP    string
	Iface string
	Kind  LANKind

	// Default reports whether this address sits on the interface the kernel
	// would use to reach the internet -- the old LANIP answer, demoted from
	// "the answer" to "one signal used for ordering".
	Default bool
}

// URL renders the address as something typeable into a phone's address bar.
func (a LANAddr) URL(port int) string {
	host := a.IP
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	return "http://" + host + ":" + itoa(port) + "/"
}

// ifaceView is the part of net.Interface this file uses, extracted so the
// ordering can be tested against machines we do not have. The reported failures
// are all multi-adapter, and none of them reproduce on a CI box with one NIC --
// which is the whole reason this bug survived to a user report.
type ifaceView struct {
	Name  string
	Flags net.Flags
	IPs   []net.IP
}

// enumerateIfaces is a variable so tests can substitute a machine. Production
// always uses realIfaces.
var enumerateIfaces = realIfaces

func realIfaces() []ifaceView {
	ifs, err := net.Interfaces()
	if err != nil {
		return nil
	}
	out := make([]ifaceView, 0, len(ifs))
	for _, i := range ifs {
		addrs, err := i.Addrs()
		if err != nil {
			// One unreadable adapter must not cost us the others. This happens
			// on Windows for adapters that are disappearing as we look at them.
			continue
		}
		v := ifaceView{Name: i.Name, Flags: i.Flags}
		for _, a := range addrs {
			if ipnet, ok := a.(*net.IPNet); ok {
				v.IPs = append(v.IPs, ipnet.IP)
			}
		}
		out = append(out, v)
	}
	return out
}

// LANAddrsFor returns the addresses worth offering, best first, for a server
// bound to boundHost.
//
// boundHost is not decoration. A server bound to 0.0.0.0 is listening on IPv4
// ONLY -- that is what the wildcard means, and `net.Listen("tcp", ":9066")`
// would be the dual-stack spelling -- so advertising a v6 address there sends
// the user to a port nothing is accepting on. Filtering by the family we
// actually bound is the difference between a list of candidates and a list of
// candidates half of which cannot work.
//
// A pinned listen_host returns itself and nothing else. The user named an
// address; offering alternatives we are not listening on would be noise.
func LANAddrsFor(boundHost string) []LANAddr {
	wantV4, wantV6 := familiesFor(boundHost)
	if !wantV4 && !wantV6 {
		// A specific address. Report it as-is; it is the only thing bound.
		if ip := net.ParseIP(boundHost); ip != nil && !ip.IsLoopback() {
			return []LANAddr{{IP: ip.String(), Iface: ifaceHolding(ip), Kind: LANPhysical, Default: true}}
		}
		return nil
	}

	def := defaultRouteIP()
	var out []LANAddr
	for _, iface := range enumerateIfaces() {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		kind := classifyIface(iface)
		for _, ip := range iface.IPs {
			if !usableLANIP(ip, wantV4, wantV6) {
				continue
			}
			out = append(out, LANAddr{
				IP:      ip.String(),
				Iface:   iface.Name,
				Kind:    kind,
				Default: def != nil && def.Equal(ip),
			})
		}
	}

	// Physical before virtual before tunnel; within a kind, the default route
	// first. Ordering kind ahead of the default route is deliberate: when a VPN
	// holds the default route, the physical LAN address is the one that works,
	// and putting the tunnel first is precisely the old bug.
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Kind != out[j].Kind {
			return out[i].Kind < out[j].Kind
		}
		if out[i].Default != out[j].Default {
			return out[i].Default
		}
		return false
	})
	return out
}

// familiesFor reports which address families a bind on host is accepting.
// The two bools are false together when host names one specific address, which
// the caller handles separately.
func familiesFor(host string) (v4, v6 bool) {
	switch host {
	case "", "::", "[::]":
		// The empty host and :: are the dual-stack wildcard.
		return true, true
	case "0.0.0.0":
		return true, false
	}
	return false, false
}

// usableLANIP filters to addresses a person could actually type into a phone.
//
// Link-local is excluded in both families and for different reasons. IPv4
// 169.254.x.x is APIPA: it means DHCP failed, and offering it as a way in sends
// someone chasing a connection that was never going to happen. IPv6 fe80:: is
// worse than useless -- it needs a zone index (%eth0) that has no meaning on the
// phone doing the typing, so the URL cannot be transcribed at all.
func usableLANIP(ip net.IP, wantV4, wantV6 bool) bool {
	if ip == nil || ip.IsLoopback() || ip.IsUnspecified() || ip.IsMulticast() {
		return false
	}
	if ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
		return false
	}
	if ip.To4() != nil {
		return wantV4
	}
	return wantV6
}

// virtualIfaceNames are the adapters a phone essentially never arrives on.
// Matched as substrings, lowercased, because the Windows friendly name carries
// the interesting part in the middle: "vEthernet (WSL (Hyper-V firewall))".
var virtualIfaceNames = []string{
	"vethernet", "hyper-v", "default switch", "wsl",
	"docker", "br-", "veth", "virbr",
	"vmnet", "vmware", "vboxnet", "virtualbox",
	"loopback pseudo", "npcap", "bluetooth",
}

// tunnelIfaceNames are VPN and point-to-point adapters. FlagPointToPoint catches
// most of them, but not all: Tailscale and WireGuard on Windows present as
// ordinary adapters, and Tailscale in particular is common enough among the
// people who self-host something like this to be worth naming.
var tunnelIfaceNames = []string{
	"tun", "tap", "ppp", "utun", "wg", "wireguard",
	"tailscale", "zerotier", "zt", "nordlynx", "proton", "openvpn",
	"expressvpn", "mullvad", "wintun",
}

func classifyIface(i ifaceView) LANKind {
	name := strings.ToLower(i.Name)
	if i.Flags&net.FlagPointToPoint != 0 {
		return LANTunnel
	}
	for _, s := range tunnelIfaceNames {
		if strings.Contains(name, s) {
			return LANTunnel
		}
	}
	for _, s := range virtualIfaceNames {
		if strings.Contains(name, s) {
			return LANVirtual
		}
	}
	return LANPhysical
}

// ifaceHolding names the adapter an address is configured on, for the pinned
// listen_host case. Empty when we cannot tell, which the caller prints as
// nothing rather than as a guess.
func ifaceHolding(ip net.IP) string {
	for _, iface := range enumerateIfaces() {
		for _, have := range iface.IPs {
			if have.Equal(ip) {
				return iface.Name
			}
		}
	}
	return ""
}

// defaultRouteIP is the old LANIP, kept as an ordering signal rather than as an
// answer. Opening a UDP socket makes the kernel run its route lookup; nothing is
// sent. 192.0.2.1 is TEST-NET-1, which exists to be used like this.
//
// nil when there is no default route at all -- an offline machine, which is a
// supported way to run GobboNet and must not be treated as a failure.
var defaultRouteIP = func() net.IP {
	conn, err := net.Dial("udp", "192.0.2.1:53")
	if err != nil {
		return nil
	}
	defer conn.Close()
	if addr, ok := conn.LocalAddr().(*net.UDPAddr); ok {
		return addr.IP
	}
	return nil
}

// itoa avoids pulling strconv in for one call site.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}
