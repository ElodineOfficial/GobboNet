package main

import (
	"fmt"
	"github.com/ElodineOfficial/GobboNet/internal/config"
	"github.com/ElodineOfficial/GobboNet/internal/server"
	"io"
)

// Present the socket we actually bound, not a configured address that failed.
// Full URLs get their own lines so adapter names do not push them off-screen.
func printReadyPanel(w io.Writer, cfg config.Config, bind *server.Bind, addrs []server.LANAddr) {
	host := bind.Host
	switch host {
	case "", "0.0.0.0":
		host = "127.0.0.1"
	case "::":
		host = "::1"
	}
	local := (server.LANAddr{IP: host}).URL(bind.Port)
	fmt.Fprintln(w, "\n ====================================================")
	fmt.Fprintln(w, "      GOBBONET IS RUNNING - CONNECTION ADDRESSES")
	fmt.Fprintln(w, " ====================================================")
	fmt.Fprintln(w, "\n  ON THIS PC")
	fmt.Fprintln(w, "    "+local)
	fmt.Fprintln(w, "\n  ON YOUR PHONE / ANOTHER DEVICE")
	if !bind.LANReachable() {
		fmt.Fprintln(w, "    LAN ACCESS IS OFF - this PC only.")
		if bind.FellBack {
			fmt.Fprintf(w, "    Network bind failed: %v\n", bind.WideErr)
			for _, line := range lanBindHelp(cfg) {
				fmt.Fprintln(w, "    "+line)
			}
		} else {
			fmt.Fprintln(w, "    The server is configured to listen on loopback only.")
		}
	} else {
		physical := false
		for _, a := range addrs {
			if a.Kind != server.LANPhysical {
				continue
			}
			physical = true
			fmt.Fprintf(w, "\n    %s\n      %s\n", a.Iface, a.URL(bind.Port))
		}
		if !physical {
			fmt.Fprintln(w, "    No Wi-Fi / Ethernet address was found.")
			fmt.Fprintln(w, "    Run gobbonet doctor for network details.")
		} else {
			fmt.Fprintln(w, "\n    Connect to the same Wi-Fi / home network as this PC.")
			fmt.Fprintln(w, "    Open one of the addresses above in your browser.")
			fmt.Fprintln(w, "    If there are several, try the matching adapter first.")
			fmt.Fprintln(w, "    Can't connect? Run LAN Setup (setup-lan.bat) once.")
		}
		alternatives := false
		for _, a := range addrs {
			if a.Kind == server.LANPhysical {
				continue
			}
			if !alternatives {
				fmt.Fprintln(w, "\n  OTHER ADAPTERS - usually not your phone's connection")
				alternatives = true
			}
			fmt.Fprintf(w, "    %s\n      %s\n", lanAddrNote(a), a.URL(bind.Port))
		}
	}
	fmt.Fprintln(w, "\n ----------------------------------------------------")
	fmt.Fprintln(w, "  Keep this window open while using GobboNet.")
	fmt.Fprintln(w, "  You can minimize it; press Ctrl+C to stop.")
	fmt.Fprintln(w, " ====================================================")
	fmt.Fprintln(w)
}
