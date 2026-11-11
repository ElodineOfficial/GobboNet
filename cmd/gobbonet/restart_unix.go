//go:build !windows

package main

import (
	"syscall"
)

// restartInto replaces this process with the updated program. exec keeps the
// process ID, the terminal and the output it was writing to, so whatever
// started GobboNet -- a terminal, the desktop launcher waiting on this PID, a
// service manager -- goes on watching the same process. It only returns on
// failure.
func restartInto(r errRestart) error {
	return syscall.Exec(r.path, append([]string{r.path}, r.args...), restartEnv())
}
