//go:build !windows

package supervisor

import (
	"os/exec"
	"syscall"
)

// configureProcessGroup puts the child in its own process group.
//
// This is not optional. llama-server spawns helpers, and without a process
// group a kill aimed at the parent leaves those children alive — holding the
// listening port and, far worse, several gigabytes of VRAM. The replacement
// server then fails to bind, exits within milliseconds, and /swap-status sits at
// "starting" until it times out, which looks exactly like a model that is slow
// to load. Killing the whole group is what makes a swap deterministic.
func configureProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// terminateGroup signals the child's entire process group.
//
// The negative PID is the whole point: kill(-pgid) reaches every descendant.
func terminateGroup(cmd *exec.Cmd, force bool) error {
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	sig := syscall.SIGTERM
	if force {
		sig = syscall.SIGKILL
	}
	pgid, err := syscall.Getpgid(cmd.Process.Pid)
	if err != nil {
		// The process is already gone, or we never got a group. Fall back to
		// signalling the process itself.
		return cmd.Process.Signal(sig)
	}
	return syscall.Kill(-pgid, sig)
}
