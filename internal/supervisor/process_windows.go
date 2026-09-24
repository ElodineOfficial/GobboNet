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
	if owned, err := terminateJob(pgid); owned {
		return err
	}
	if pgid <= 0 {
		return nil
	}
	// THE POLITE ATTEMPT CANNOT WORK HERE, so it is not allowed to cost time.
	//
	// `taskkill /PID n /T` without /F asks by posting WM_CLOSE, which needs a
	// window and a message loop. llama-server is a console program started
	// detached; it has neither, so the request is always refused with exit 255.
	//
	// The caller does not know that. It treated the refusal as "maybe it is
	// shutting down", waited its five-second grace period, tried again, waited
	// again, and only then forced -- so in a real session every model swap cost
	// about eleven extra seconds and printed two lines that read like failures:
	//
	//   [swap] SIGTERM to process group failed: exit status 255
	//   [swap] llama-server did not exit in 5s; forcing
	//   [swap] SIGTERM to process group failed: exit status 255
	//   [swap] process group 10104 outlived SIGTERM; forcing
	//
	// Nothing was wrong. So the polite form is still tried -- a future
	// llama-server with a message loop would honour it -- but a refusal
	// escalates here and now instead of being reported upwards as trouble.
	polite := exec.Command("taskkill", "/PID", strconv.Itoa(pgid), "/T").Run()
	if polite == nil || !groupAlive(pgid) {
		return nil
	}
	if !force {
		// Escalate immediately rather than handing back an error that buys a
		// grace period the process was never going to use.
		if err := exec.Command("taskkill", "/PID", strconv.Itoa(pgid), "/T", "/F").Run(); err != nil {
			if !groupAlive(pgid) {
				return nil
			}
			return err
		}
		return nil
	}
	err := exec.Command("taskkill", "/PID", strconv.Itoa(pgid), "/T", "/F").Run()
	if err != nil && !groupAlive(pgid) {
		return nil
	}
	return err
}

// groupAlive reports whether the root process still exists.
func groupAlive(pgid int) bool {
	if alive, owned := jobAlive(pgid); owned {
		return alive
	}
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
