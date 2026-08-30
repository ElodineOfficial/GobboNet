package main

import (
	"flag"
	"fmt"

	"github.com/jmccardle/gobbonet/internal/autostart"
)

// cmdAutostart is the manual door onto the same setting the wizard offers, for
// people who would rather not re-run setup to change one checkbox.
func cmdAutostart(argv []string) error {
	fs := flag.NewFlagSet("gobbonet autostart", flag.ContinueOnError)
	enable := fs.Bool("enable", false, "start GobboNet when you log in")
	disable := fs.Bool("disable", false, "stop starting GobboNet at login")
	status := fs.Bool("status", false, "report whether it is on")
	if err := fs.Parse(argv); err != nil {
		return err
	}
	if *enable && *disable {
		return fmt.Errorf("--enable and --disable contradict each other")
	}

	switch {
	case *enable:
		if err := autostart.Enable(); err != nil {
			return err
		}
		fmt.Println("  [OK] GobboNet will start when you log in.")
		fmt.Printf("       %s\n", autostart.Path())
		fmt.Println("       It starts the server only — no browser window opens at login.")
	case *disable:
		if err := autostart.Disable(); err != nil {
			return err
		}
		fmt.Println("  [OK] GobboNet will no longer start at login.")
	default:
		// Bare `gobbonet autostart` reports rather than changing anything.
		// Guessing at an action for a command that alters login behaviour is
		// not a good trade.
		_ = status
		if autostart.Enabled() {
			fmt.Println("  Autostart is ON.")
			fmt.Printf("  %s\n", autostart.Path())
		} else {
			fmt.Println("  Autostart is OFF.")
			fmt.Println("  Turn it on with:  gobbonet autostart --enable")
		}
	}
	return nil
}
