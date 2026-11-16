package main

import (
	"fmt"
	"github.com/ElodineOfficial/GobboNet/internal/config"
	"github.com/ElodineOfficial/GobboNet/internal/server"
	"golang.org/x/term"
	"io"
	"os"
	"path/filepath"
	"runtime"
)

// The platform and console the ready panel is written for. Variables so the
// tests can pin each case.
//
// The panel used to be the Windows text everywhere (issue #63): Linux users
// were told to run setup-lan.bat, which does not exist there, and a server
// started by the desktop launcher or at login -- output going to a log file,
// no terminal -- was told to keep its window open and press Ctrl+C.
var (
	panelGOOS       = runtime.GOOS
	panelOnTerminal = func() bool { return term.IsTerminal(int(os.Stdout.Fd())) }
	// panelProgram is the process name `pkill -x` has to be given. It is
	// "gobbonet" in every package except the macOS app, whose program file is
	// gobbonet-bin: the bundle's own executable is the launcher script, and
	// the two cannot differ only by case on a default Mac disk.
	panelProgram = func() string {
		if exe, err := os.Executable(); err == nil {
			if base := filepath.Base(exe); base == "gobbonet-bin" {
				return base
			}
		}
		return "gobbonet"
	}
)

// Present the socket we actually bound, not a configured address that failed.
// Full URLs get their own lines so adapter names do not push them off-screen.
func printReadyPanel(w io.Writer, cfg config.Config, bind *server.Bind, addrs []server.LANAddr) {
	// Loopback whenever it is served -- including beside a pinned address, which
	// used to print the pinned address here.
	local := bind.LocalURL()
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
			for _, line := range lanBindHelpFor(panelGOOS, cfg) {
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
			// Typed without the scheme, iOS Safari (and others) upgrade to
			// https, which this plain-HTTP server cannot answer, and the error
			// page never mentions GobboNet.
			fmt.Fprintln(w, "    Type it exactly as shown, http:// included.")
			fmt.Fprintln(w, "    If there are several, try the matching adapter first.")
			if panelGOOS == "windows" {
				fmt.Fprintln(w, "    Can't connect? Run LAN Setup (setup-lan.bat) once.")
			} else {
				fmt.Fprintln(w, "    Can't connect? gobbonet doctor checks the firewall.")
			}
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
	if panelGOOS == "windows" || panelOnTerminal() {
		fmt.Fprintln(w, "  Keep this window open while using GobboNet.")
		fmt.Fprintln(w, "  You can minimize it; press Ctrl+C to stop.")
	} else {
		// SIGTERM stops the server the same way Ctrl+C does, managed
		// llama-server included. The Linux launcher waiting on it then exits,
		// and its EXIT trap stops the embedding engine too.
		fmt.Fprintln(w, "  Running in the background, with no terminal attached.")
		fmt.Fprintf(w, "  To stop it: pkill -x %s\n", panelProgram())
	}
	fmt.Fprintln(w, " ====================================================")
	fmt.Fprintln(w)
}
