//go:build windows

package supervisor

import (
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

// configureProcessGroup puts the child at the head of a new process group so
// the whole tree can be signalled at once.
//
// The Unix build uses Setpgid for the same reason: without it, llama-server's
// children outlive the kill, keep the port bound and keep VRAM allocated, and
// the replacement server dies on bind while /swap-status reports "starting".
func configureProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP,
	}
}

// processGroupID records the root PID of the tree to kill later.
//
// Captured at launch and kept, for the same reason as the Unix build: after the
// child has been reaped its handle is useless, but its descendants may still be
// running and holding VRAM.
func processGroupID(cmd *exec.Cmd) int {
	if cmd == nil || cmd.Process == nil {
		return 0
	}
	return cmd.Process.Pid
}

// terminateGroup ends the child tree.
//
// Windows has no signal that reliably reaches a detached console-less child, so
// this uses taskkill /T (tree) — the documented way to end a process and its
// descendants, and what fileserver.ps1's Stop-Process approach was reaching for.
//
// taskkill exits non-zero when the PID is already gone, which is success here,
// so an error is only reported when the tree is demonstrably still present.
func terminateGroup(pgid int, force bool) error {
	if pgid <= 0 {
		return nil
	}
	args := []string{"/PID", strconv.Itoa(pgid), "/T"}
	if force {
		args = append(args, "/F")
	}
	err := exec.Command("taskkill", args...).Run()
	if err != nil && !groupAlive(pgid) {
		return nil
	}
	return err
}

// groupAlive reports whether the root process still exists.
func groupAlive(pgid int) bool {
	if pgid <= 0 {
		return false
	}
	out, err := exec.Command("tasklist", "/FI", "PID eq "+strconv.Itoa(pgid), "/NH").Output()
	if err != nil {
		// Can't tell. Report alive so the caller escalates rather than assuming
		// a clean exit it has not observed.
		return true
	}
	return strings.Contains(string(out), strconv.Itoa(pgid))
}
