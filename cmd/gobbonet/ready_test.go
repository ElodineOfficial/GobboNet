package main

import (
	"bytes"
	"errors"
	"github.com/ElodineOfficial/GobboNet/internal/config"
	"github.com/ElodineOfficial/GobboNet/internal/server"
	"strings"
	"testing"
)

func TestReadyPanelAddressesReflectActualListener(t *testing.T) {
	addrs := []server.LANAddr{
		{IP: "10.8.0.2", Iface: "VPN", Kind: server.LANTunnel},
		{IP: "192.168.1.20", Iface: "Wi-Fi", Kind: server.LANPhysical},
		{IP: "192.168.2.20", Iface: "Ethernet", Kind: server.LANPhysical},
	}
	var b bytes.Buffer
	printReadyPanel(&b, config.Config{}, &server.Bind{Host: "0.0.0.0", Port: 9067}, addrs)
	out := b.String()
	for _, want := range []string{"http://127.0.0.1:9067/", "Wi-Fi\n      http://192.168.1.20:9067/", "Ethernet\n      http://192.168.2.20:9067/", "http://10.8.0.2:9067/"} {
		if !strings.Contains(out, want) {
			t.Fatalf("missing %q in %s", want, out)
		}
	}
	if strings.Index(out, "192.168.1.20") > strings.Index(out, "10.8.0.2") {
		t.Fatal("VPN appeared ahead of phone addresses")
	}
	b.Reset()
	printReadyPanel(&b, config.Config{}, &server.Bind{Host: "127.0.0.1", Port: 9067, FellBack: true, WideErr: errors.New("denied")}, addrs)
	if !strings.Contains(b.String(), "LAN ACCESS IS OFF") || strings.Contains(b.String(), "192.168.1.20") {
		t.Fatal("fallback advertised an unreachable LAN address")
	}
	b.Reset()
	printReadyPanel(&b, config.Config{}, &server.Bind{Host: "192.168.1.20", Port: 9067}, addrs[1:2])
	if strings.Contains(b.String(), "127.0.0.1") {
		t.Fatal("specific interface bind advertised unbound loopback")
	}
}
