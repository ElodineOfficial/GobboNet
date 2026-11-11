//go:build windows

package main

import (
	"os"
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"
)

// restartInto starts the updated program in this console window and returns;
// main then exits. Windows has no exec, so the new program is a new process,
// sharing the console -- the window stays open on it, and Ctrl+C or closing it
// stops the new one as it stopped this one.
//
// Outside any job this process is in: GobboNet's own jobs (internal/procjob,
// and `launch` running launch.bat) end everything in them when their owner
// exits, which would be this process's parent and, with it, the new program.
// A job that does not allow breakaway refuses the flag; it is started
// without, which is what an ordinary start does.
func restartInto(r errRestart) error {
	start := func(flags uint32) error {
		cmd := exec.Command(r.path, r.args...)
		// A program started with no console has no standard handles, and os
		// leaves those nil; handing a nil *os.File on would fail the start.
		if os.Stdin != nil {
			cmd.Stdin = os.Stdin
		}
		if os.Stdout != nil {
			cmd.Stdout = os.Stdout
		}
		if os.Stderr != nil {
			cmd.Stderr = os.Stderr
		}
		cmd.Env = restartEnv()
		cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: flags}
		return cmd.Start()
	}
	if err := start(windows.CREATE_BREAKAWAY_FROM_JOB); err == nil {
		return nil
	}
	return start(0)
}
