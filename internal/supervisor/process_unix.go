//go:build !windows

package supervisor

import (
	"errors"
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

// processGroupID records the group to signal later. Setpgid makes the child its
// own group leader, so the group id is the child's PID.
//
// It must be captured at launch and kept. Deriving it later with Getpgid does
// not work: once the reaper has Wait()ed the child, its PID is gone from the
// table and Getpgid fails with ESRCH — even though the rest of the group is
// still running. That is not a corner case, it is the exact shape of the leak
// process groups exist to prevent: llama-server exits or crashes, its helpers
// outlive it, and nothing can reach them any more.
func processGroupID(cmd *exec.Cmd) int {
	if cmd == nil || cmd.Process == nil {
		return 0
	}
	return cmd.Process.Pid
}

// terminateGroup signals every process in the group.
//
// The negative PID is the whole point: kill(-pgid) reaches every member,
// including processes reparented to init after their own parent died.
func terminateGroup(pgid int, force bool) error {
	if pgid <= 0 {
		return nil
	}
	sig := syscall.SIGTERM
	if force {
		sig = syscall.SIGKILL
	}
	err := syscall.Kill(-pgid, sig)
	if errors.Is(err, syscall.ESRCH) {
		// No members left. That is the goal, not a failure.
		return nil
	}
	return err
}

// groupAlive reports whether any process in the group still exists.
//
// Signal 0 performs the permission and existence checks without delivering
// anything, which makes it the cheap, race-free way to ask "is the tree gone
// yet" — far better than inferring it from the leader's exit, which says
// nothing about the helpers.
func groupAlive(pgid int) bool {
	if pgid <= 0 {
		return false
	}
	err := syscall.Kill(-pgid, 0)
	if err == nil {
		return true
	}
	// EPERM means members exist that we may not signal; only ESRCH means empty.
	return errors.Is(err, syscall.EPERM)
}
